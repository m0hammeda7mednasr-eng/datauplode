import { prisma } from './db.js';
import { ShopifyService } from './services/shopify.js';

const TARGET_VENDOR = 'Juniors';
const PERMANENT_FAILURE_ACTION = 'SOURCE_AUTHORITY_PERMANENT_FAILURE';
const RUN_ACTION = 'BLOCKED_VENDOR_DIRECT_PURGE';
const START_DELAY_MS = 5_000;
const VERIFY_INTERVAL_MS = 30 * 60 * 1000;
const DELETE_BATCH_SIZE = 20;
const LOCAL_BATCH_SIZE = 100;
const MAX_PASSES = 4;

let started = false;
let running = false;

function enabled(name: string, fallback = false) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function clean(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunks<T>(items: T[], size: number) {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

function deployedRevisionMatches() {
  const expected = clean(process.env.JUNIORS_DIRECT_PURGE_REVISION).toLowerCase();
  const deployed = clean(process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA).toLowerCase();
  return /^[a-f0-9]{40}$/.test(expected) && expected === deployed;
}

async function juniorsCount(client: any) {
  const data = await client.request(`
    query JuniorsDirectCount {
      productsCount(query: "vendor:Juniors", limit: null) { count precision }
    }
  `);
  return Number(data?.productsCount?.count || 0);
}

async function loadAllJuniorsIds(client: any) {
  const ids: string[] = [];
  let after: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const data = await client.request(`
      query JuniorsDirectIds($after: String) {
        products(first: 250, after: $after, query: "vendor:Juniors", sortKey: ID) {
          nodes { id }
          pageInfo { hasNextPage endCursor }
        }
      }
    `, { after });
    const connection = data?.products;
    for (const node of connection?.nodes || []) {
      const id = clean(node?.id);
      if (id) ids.push(id);
    }
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor || null;
    if (!after) throw new Error('Juniors pagination reported another page without an endCursor');
  }
  return [...new Set(ids)];
}

async function deleteBatch(client: any, ids: string[]) {
  const definitions: string[] = [];
  const fields: string[] = [];
  const variables: Record<string, string> = {};
  ids.forEach((id, index) => {
    definitions.push(`$id${index}: ID!`);
    fields.push(`p${index}: productDelete(input: { id: $id${index} }, synchronous: true) { deletedProductId userErrors { field message } }`);
    variables[`id${index}`] = id;
  });
  const mutation = `mutation JuniorsDirectDelete(${definitions.join(', ')}) { ${fields.join('\n')} }`;

  let data: any = null;
  let requestError = '';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      data = await client.request(mutation, variables);
      requestError = '';
      break;
    } catch (error: any) {
      requestError = clean(error?.message || error);
      const retryable = /thrott|429|rate limit|temporar|timeout|5\d\d|service unavailable/i.test(requestError);
      if (!retryable || attempt === 7) break;
      await sleep(500 * (attempt + 1));
    }
  }

  if (!data) {
    return { removedOrGone: [] as string[], failed: ids.map((id) => ({ id, error: requestError || 'Delete request failed' })) };
  }

  const removedOrGone: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  ids.forEach((id, index) => {
    const payload = data[`p${index}`];
    const errors = Array.isArray(payload?.userErrors) ? payload.userErrors : [];
    const message = errors.map((entry: any) => clean(entry?.message)).filter(Boolean).join('; ');
    if (payload?.deletedProductId || (!payload?.deletedProductId && /not found|does not exist|already deleted/i.test(message))) {
      removedOrGone.push(id);
    } else if (errors.length) {
      failed.push({ id, error: message || 'Shopify rejected productDelete' });
    } else {
      removedOrGone.push(id);
    }
  });
  return { removedOrGone, failed };
}

async function tombstoneAndPurgeLocalLinks(shopifyIds: string[]) {
  let localSourcesPurged = 0;
  for (const shopifyBatch of chunks(shopifyIds, LOCAL_BATCH_SIZE)) {
    const linked = await prisma.shopifyProduct.findMany({
      where: { shopifyId: { in: shopifyBatch } },
      select: {
        shopifyId: true,
        sourceProductId: true,
        sourceProduct: { select: { url: true } },
      },
    });
    if (!linked.length) continue;

    await prisma.auditLog.createMany({
      data: linked.map((entry) => ({
        action: PERMANENT_FAILURE_ACTION,
        details: JSON.stringify({
          at: new Date().toISOString(),
          url: entry.sourceProduct.url,
          reason: `blocked_vendor:${TARGET_VENDOR}`,
          shopifyProductId: entry.shopifyId,
          sourceProductId: entry.sourceProductId,
        }),
      })),
    });

    const sourceIds = [...new Set(linked.map((entry) => entry.sourceProductId))];
    localSourcesPurged += await prisma.$transaction(async (tx) => {
      const products = await tx.shopifyProduct.findMany({
        where: { sourceProductId: { in: sourceIds } },
        select: { id: true },
      });
      const localProductIds = products.map((entry) => entry.id);
      if (localProductIds.length) {
        await tx.shopifyVariant.deleteMany({ where: { shopifyProductId: { in: localProductIds } } });
      }
      await tx.shopifyProduct.deleteMany({ where: { sourceProductId: { in: sourceIds } } });
      await tx.manualReviewItem.deleteMany({ where: { sourceProductId: { in: sourceIds } } });
      await tx.auditLog.updateMany({ where: { sourceProductId: { in: sourceIds } }, data: { sourceProductId: null } });
      await tx.sourceImage.deleteMany({ where: { sourceProductId: { in: sourceIds } } });
      await tx.sourceVariant.deleteMany({ where: { sourceProductId: { in: sourceIds } } });
      const deleted = await tx.sourceProduct.deleteMany({ where: { id: { in: sourceIds } } });
      return deleted.count;
    });
  }
  return localSourcesPurged;
}

export async function runJuniorsVendorDirectPurge() {
  if (running) return;
  running = true;
  const startedAt = Date.now();
  let initialCount = 0;
  let finalCount = 0;
  let removed = 0;
  let failed = 0;
  let localSourcesPurged = 0;
  let passes = 0;
  let status = 'completed';
  let errorMessage = '';

  try {
    const client = await ShopifyService.getClientFromDb(prisma);
    initialCount = await juniorsCount(client);
    finalCount = initialCount;
    console.log(`[juniors-direct] starting vendor=${TARGET_VENDOR} exactCount=${initialCount}`);

    for (let pass = 1; pass <= MAX_PASSES; pass += 1) {
      const ids = await loadAllJuniorsIds(client);
      if (!ids.length) {
        finalCount = 0;
        break;
      }
      passes = pass;
      console.log(`[juniors-direct] pass=${pass} snapshot=${ids.length}`);

      let batchNumber = 0;
      for (const batch of chunks(ids, DELETE_BATCH_SIZE)) {
        batchNumber += 1;
        const result = await deleteBatch(client, batch);
        removed += result.removedOrGone.length;
        failed += result.failed.length;
        if (result.removedOrGone.length) {
          localSourcesPurged += await tombstoneAndPurgeLocalLinks(result.removedOrGone);
        }
        if (result.failed.length) {
          console.error(`[juniors-direct] pass=${pass} batch=${batchNumber} failed=${result.failed.length} first=${result.failed[0]?.error || 'unknown'}`);
        }
        if (batchNumber % 10 === 0) {
          console.log(`[juniors-direct] pass=${pass} progress=${Math.min(batchNumber * DELETE_BATCH_SIZE, ids.length)}/${ids.length} removed=${removed} failed=${failed}`);
        }
        await sleep(120);
      }

      finalCount = await juniorsCount(client);
      console.log(`[juniors-direct] pass=${pass} remaining=${finalCount} localSourcesPurged=${localSourcesPurged}`);
      if (finalCount === 0) break;
      await sleep(1_000);
    }

    finalCount = await juniorsCount(client);
    if (finalCount !== 0) throw new Error(`Juniors direct cleanup stopped with ${finalCount} products remaining`);
    console.log(`[juniors-direct] completed exactCount=0 removed=${removed} localSourcesPurged=${localSourcesPurged}`);
  } catch (error: any) {
    status = 'failed';
    errorMessage = clean(error?.message || error);
    console.error(`[juniors-direct] failed: ${errorMessage}`);
  } finally {
    await prisma.auditLog.create({
      data: {
        action: RUN_ACTION,
        details: JSON.stringify({
          at: new Date().toISOString(),
          vendor: TARGET_VENDOR,
          status,
          initialCount,
          finalCount,
          removed,
          failed,
          localSourcesPurged,
          passes,
          error: errorMessage || null,
          durationMs: Date.now() - startedAt,
        }),
      },
    }).catch(() => undefined);
    running = false;
  }
}

export function startJuniorsVendorDirectPurgeWorker() {
  if (started) return;
  started = true;
  if (!enabled('JUNIORS_DIRECT_PURGE_AUTOSTART', false)) {
    console.log('[juniors-direct] autostart disabled');
    return;
  }
  if (!enabled('SYNC_RUNTIME_WRITE_ENABLED', false)) {
    console.log('[juniors-direct] blocked because global runtime writes are disabled');
    return;
  }
  if (!deployedRevisionMatches()) {
    console.log('[juniors-direct] blocked because exact deployed revision is not authorized');
    return;
  }

  console.log('[juniors-direct] authorized for exact vendor Juniors');
  setTimeout(() => void runJuniorsVendorDirectPurge(), START_DELAY_MS);
  setInterval(() => void runJuniorsVendorDirectPurge(), VERIFY_INTERVAL_MS);
}

startJuniorsVendorDirectPurgeWorker();
