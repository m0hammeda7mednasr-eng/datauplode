import { prisma } from './db.js';
import { ShopifyService } from './services/shopify.js';

const TARGET_VENDOR = 'Juniors';
const PERMANENT_FAILURE_ACTION = 'SOURCE_AUTHORITY_PERMANENT_FAILURE';
const RUN_ACTION = 'BLOCKED_VENDOR_PURGE';
const START_DELAY_MS = 5_000;
const VERIFY_INTERVAL_MS = 30 * 60 * 1000;
const MAX_BULK_PASSES = 5;
const BULK_POLL_MS = 2_000;
const BULK_TIMEOUT_MS = 12 * 60 * 1000;
const LOCAL_DELETE_BATCH_SIZE = 100;

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
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

function deployedRevisionMatches() {
  const expected = clean(process.env.JUNIORS_PURGE_REVISION).toLowerCase();
  const deployed = clean(process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA).toLowerCase();
  return /^[a-f0-9]{40}$/.test(expected) && expected === deployed;
}

async function juniorsCount(client: any) {
  const data = await client.request(`
    query JuniorsVendorCount {
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
      query JuniorsVendorIds($after: String) {
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

async function waitForMutationSlot(client: any) {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const data = await client.request(`
      query CurrentMutationBulkOperation {
        currentBulkOperation(type: MUTATION) { id status errorCode }
      }
    `);
    const operation = data?.currentBulkOperation;
    const status = clean(operation?.status).toUpperCase();
    if (!operation || !['CREATED', 'RUNNING', 'CANCELING'].includes(status)) return;
    console.log(`[juniors-purge] waiting for existing bulk mutation ${operation.id} status=${status}`);
    await sleep(5_000);
  }
  throw new Error('Timed out waiting for the Shopify bulk-mutation slot');
}

async function stageJsonl(client: any, jsonl: string, filename: string) {
  const staged = await client.request(`
    mutation JuniorsPurgeStage($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }
  `, {
    input: [{
      resource: 'BULK_MUTATION_VARIABLES',
      filename,
      mimeType: 'text/jsonl',
      httpMethod: 'POST',
    }],
  });

  const payload = staged?.stagedUploadsCreate;
  const errors = Array.isArray(payload?.userErrors) ? payload.userErrors : [];
  if (errors.length) {
    throw new Error(`stagedUploadsCreate failed: ${errors.map((entry: any) => clean(entry.message)).join('; ')}`);
  }
  const target = payload?.stagedTargets?.[0];
  if (!target?.url || !Array.isArray(target.parameters)) {
    throw new Error('Shopify did not return a staged upload target');
  }

  const form = new FormData();
  for (const parameter of target.parameters) {
    form.append(String(parameter.name), String(parameter.value));
  }
  form.append('file', new Blob([jsonl], { type: 'text/jsonl' }), filename);
  const response = await fetch(target.url, { method: 'POST', body: form });
  if (!response.ok) {
    const body = (await response.text().catch(() => '')).slice(0, 500);
    throw new Error(`Staged JSONL upload failed with HTTP ${response.status}: ${body}`);
  }

  const stagedUploadPath = target.parameters.find((entry: any) => entry?.name === 'key')?.value;
  if (!stagedUploadPath) throw new Error('Shopify staged upload did not include the key parameter');
  return String(stagedUploadPath);
}

async function startBulkDelete(client: any, ids: string[], pass: number) {
  const filename = `juniors-delete-${Date.now()}-${pass}.jsonl`;
  const jsonl = ids.map((id) => JSON.stringify({ id })).join('\n') + '\n';
  const stagedUploadPath = await stageJsonl(client, jsonl, filename);
  await waitForMutationSlot(client);

  const mutation = `mutation JuniorsDeleteOne($id: ID!) {
    productDelete(input: { id: $id }, synchronous: true) {
      deletedProductId
      userErrors { field message }
    }
  }`;

  const data = await client.request(`
    mutation JuniorsPurgeRun($mutation: String!, $stagedUploadPath: String!) {
      bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }
  `, { mutation, stagedUploadPath });

  const payload = data?.bulkOperationRunMutation;
  const errors = Array.isArray(payload?.userErrors) ? payload.userErrors : [];
  if (errors.length) {
    throw new Error(`bulkOperationRunMutation failed: ${errors.map((entry: any) => clean(entry.message)).join('; ')}`);
  }
  const operationId = clean(payload?.bulkOperation?.id);
  if (!operationId) throw new Error('Shopify did not return a bulk operation ID');
  return operationId;
}

async function waitForBulkDelete(client: any, operationId: string) {
  const deadline = Date.now() + BULK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const data = await client.request(`
      query JuniorsPurgeBulkStatus($id: ID!) {
        node(id: $id) {
          ... on BulkOperation {
            id
            status
            errorCode
            objectCount
            rootObjectCount
            url
            partialDataUrl
          }
        }
      }
    `, { id: operationId });
    const operation = data?.node;
    const status = clean(operation?.status).toUpperCase();
    if (status === 'COMPLETED') return operation;
    if (['FAILED', 'CANCELED', 'EXPIRED'].includes(status)) {
      throw new Error(`Juniors bulk delete ended with status=${status} errorCode=${clean(operation?.errorCode) || 'unknown'}`);
    }
    console.log(`[juniors-purge] bulk=${operationId} status=${status || 'unknown'} objects=${operation?.objectCount ?? 0}`);
    await sleep(BULK_POLL_MS);
  }
  throw new Error(`Timed out waiting for Juniors bulk delete ${operationId}`);
}

async function tombstoneAndPurgeLocalLinks(shopifyIds: string[]) {
  let sourcePurged = 0;
  for (const shopifyBatch of chunks(shopifyIds, LOCAL_DELETE_BATCH_SIZE)) {
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
    sourcePurged += await prisma.$transaction(async (tx) => {
      const localShopifyProducts = await tx.shopifyProduct.findMany({
        where: { sourceProductId: { in: sourceIds } },
        select: { id: true },
      });
      const localShopifyProductIds = localShopifyProducts.map((entry) => entry.id);
      if (localShopifyProductIds.length) {
        await tx.shopifyVariant.deleteMany({ where: { shopifyProductId: { in: localShopifyProductIds } } });
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
  return sourcePurged;
}

export async function runJuniorsVendorPurge() {
  if (running) return;
  running = true;
  const startedAt = new Date();
  let initialCount = 0;
  let finalCount = 0;
  let shopifyIdsSeen = 0;
  let localSourcesPurged = 0;
  let passes = 0;
  let status = 'completed';
  let errorMessage = '';

  try {
    const client = await ShopifyService.getClientFromDb(prisma);
    initialCount = await juniorsCount(client);
    console.log(`[juniors-purge] starting vendor=${TARGET_VENDOR} exactCount=${initialCount}`);

    for (let pass = 1; pass <= MAX_BULK_PASSES; pass += 1) {
      const ids = await loadAllJuniorsIds(client);
      finalCount = ids.length;
      if (!ids.length) break;
      passes = pass;
      shopifyIdsSeen += ids.length;
      console.log(`[juniors-purge] pass=${pass} deleting=${ids.length}`);
      const operationId = await startBulkDelete(client, ids, pass);
      const operation = await waitForBulkDelete(client, operationId);
      console.log(`[juniors-purge] pass=${pass} completed operation=${operationId} objects=${operation?.objectCount ?? 0}`);
      localSourcesPurged += await tombstoneAndPurgeLocalLinks(ids);
      finalCount = await juniorsCount(client);
      console.log(`[juniors-purge] pass=${pass} remaining=${finalCount} localSourcesPurged=${localSourcesPurged}`);
      if (finalCount === 0) break;
    }

    finalCount = await juniorsCount(client);
    if (finalCount !== 0) {
      status = 'failed';
      errorMessage = `Juniors vendor cleanup stopped with ${finalCount} products remaining`;
      throw new Error(errorMessage);
    }
  } catch (error: any) {
    status = 'failed';
    errorMessage = clean(error?.message || error);
    console.error(`[juniors-purge] failed: ${errorMessage}`);
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
          shopifyIdsSeen,
          localSourcesPurged,
          passes,
          error: errorMessage || null,
          durationMs: Date.now() - startedAt.getTime(),
        }),
      },
    }).catch(() => undefined);
    running = false;
  }
}

export function startJuniorsVendorPurgeWorker() {
  if (started) return;
  started = true;
  if (!enabled('JUNIORS_PURGE_AUTOSTART', false)) {
    console.log('[juniors-purge] autostart disabled');
    return;
  }
  if (!enabled('SYNC_RUNTIME_WRITE_ENABLED', false)) {
    console.log('[juniors-purge] blocked because global runtime writes are disabled');
    return;
  }
  if (!deployedRevisionMatches()) {
    console.log('[juniors-purge] blocked because exact deployed revision is not authorized');
    return;
  }

  console.log('[juniors-purge] authorized for exact vendor Juniors');
  setTimeout(() => void runJuniorsVendorPurge(), START_DELAY_MS);
  setInterval(() => void runJuniorsVendorPurge(), VERIFY_INTERVAL_MS);
}

startJuniorsVendorPurgeWorker();
