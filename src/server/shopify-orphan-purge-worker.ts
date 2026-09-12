import { prisma } from './db.js';
import { ShopifyService } from './services/shopify.js';

const DELETE_ACTION = 'SHOPIFY_ORPHAN_PRODUCT_DELETED';
const FAILURE_ACTION = 'SHOPIFY_ORPHAN_PRODUCT_DELETE_FAILED';
const SCAN_ACTION = 'SHOPIFY_ORPHAN_SCAN_SUMMARY';

let started = false;
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let pending: Array<{ id: string; title: string; status: string; createdAt: string }> = [];
let lastScanAt = 0;

function clean(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function positiveInt(name: string, fallback: number, min: number, max: number) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

async function fetchAllShopifyProducts(client: any) {
  const products: Array<{ id: string; title: string; status: string; createdAt: string }> = [];
  let after: string | null = null;
  let pages = 0;
  const maxPages = positiveInt('SHOPIFY_ORPHAN_PURGE_MAX_PAGES', 100, 1, 500);

  while (pages < maxPages) {
    const data = await client.request(
      `query OrphanPurgeProducts($first: Int!, $after: String) {
        products(first: $first, after: $after, sortKey: ID) {
          nodes { id title status createdAt }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { first: 100, after },
    );
    const connection = data?.products;
    for (const node of connection?.nodes || []) {
      if (!node?.id) continue;
      products.push({
        id: clean(node.id),
        title: clean(node.title),
        status: clean(node.status).toUpperCase(),
        createdAt: clean(node.createdAt),
      });
    }
    pages += 1;
    if (!connection?.pageInfo?.hasNextPage || !connection?.pageInfo?.endCursor) break;
    after = String(connection.pageInfo.endCursor);
  }

  return { products, pages };
}

async function refreshPending(client: any) {
  const [linkedRows, shopify] = await Promise.all([
    prisma.shopifyProduct.findMany({ select: { shopifyId: true } }),
    fetchAllShopifyProducts(client),
  ]);
  const linkedIds = new Set(linkedRows.map((row) => clean(row.shopifyId)).filter(Boolean));
  const minAgeMinutes = positiveInt('SHOPIFY_ORPHAN_PURGE_MIN_AGE_MINUTES', 15, 1, 1440);
  const cutoff = Date.now() - minAgeMinutes * 60 * 1000;

  pending = shopify.products.filter((product) => {
    if (linkedIds.has(product.id)) return false;
    const createdMs = Date.parse(product.createdAt);
    if (Number.isFinite(createdMs) && createdMs > cutoff) return false;
    return true;
  });
  lastScanAt = Date.now();

  await prisma.auditLog.create({
    data: {
      action: SCAN_ACTION,
      userId: 'System',
      details: JSON.stringify({
        scannedShopify: shopify.products.length,
        linkedLocal: linkedIds.size,
        orphanCandidates: pending.length,
        pages: shopify.pages,
        minAgeMinutes,
        scannedAt: new Date().toISOString(),
      }),
    },
  });

  console.log(JSON.stringify({
    worker: 'shopify-orphan-purge-worker',
    stage: 'scan',
    scannedShopify: shopify.products.length,
    linkedLocal: linkedIds.size,
    orphanCandidates: pending.length,
    pages: shopify.pages,
  }));
}

async function deleteOne(client: any, product: { id: string; title: string; status: string; createdAt: string }) {
  // Re-check immediately before deletion in case a sync linked the product after the scan.
  const local = await prisma.shopifyProduct.findFirst({
    where: { shopifyId: product.id },
    select: { id: true, sourceProductId: true },
  });
  if (local) return { id: product.id, title: product.title, status: 'became_linked' };

  await ShopifyService.deleteProduct(client, product.id);

  let readback: any = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    readback = await ShopifyService.getProductBasic(client, product.id).catch(() => null);
    if (!readback) break;
    await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
  }
  if (readback) throw new Error('Shopify read-back still returns product after delete');

  await prisma.auditLog.create({
    data: {
      action: DELETE_ACTION,
      userId: 'System',
      details: JSON.stringify({
        shopifyProductId: product.id,
        title: product.title,
        previousStatus: product.status,
        createdAt: product.createdAt,
        reason: 'no_local_source_link',
        deleteReadbackVerified: true,
        deletedAt: new Date().toISOString(),
      }),
    },
  });

  return { id: product.id, title: product.title, status: 'deleted' };
}

async function runCycle() {
  if (running) return;
  running = true;
  const startedAt = Date.now();
  try {
    const client = await ShopifyService.getClientFromDb(prisma);
    const rescanMinutes = positiveInt('SHOPIFY_ORPHAN_PURGE_RESCAN_MINUTES', 10, 1, 1440);
    if (!pending.length || Date.now() - lastScanAt >= rescanMinutes * 60 * 1000) {
      await refreshPending(client);
    }

    if (!pending.length) {
      console.log('[shopify-orphan-purge] no orphan Shopify products found');
      return;
    }

    const batchSize = positiveInt('SHOPIFY_ORPHAN_PURGE_BATCH_SIZE', 5, 1, 50);
    const concurrency = positiveInt('SHOPIFY_ORPHAN_PURGE_CONCURRENCY', 1, 1, 5);
    const selected = pending.splice(0, batchSize);
    const results: any[] = [];
    let cursor = 0;

    async function worker() {
      while (cursor < selected.length) {
        const product = selected[cursor++];
        if (!product) return;
        try {
          results.push(await deleteOne(client, product));
        } catch (error: any) {
          const message = clean(error?.message || error).slice(0, 1500);
          await prisma.auditLog.create({
            data: {
              action: FAILURE_ACTION,
              userId: 'System',
              details: JSON.stringify({
                shopifyProductId: product.id,
                title: product.title,
                message,
                failedAt: new Date().toISOString(),
              }),
            },
          }).catch(() => undefined);
          results.push({ id: product.id, title: product.title, status: 'failed', error: message });
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, () => worker()));

    console.log(JSON.stringify({
      worker: 'shopify-orphan-purge-worker',
      selected: selected.length,
      deleted: results.filter((entry) => entry.status === 'deleted').length,
      becameLinked: results.filter((entry) => entry.status === 'became_linked').length,
      failed: results.filter((entry) => entry.status === 'failed').length,
      pending: pending.length,
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      results: results.slice(0, 20),
    }));
  } catch (error: any) {
    console.error('[shopify-orphan-purge] cycle failed:', clean(error?.message || error));
  } finally {
    running = false;
  }
}

function scheduleNext(delayMs: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    await runCycle();
    scheduleNext(positiveInt('SHOPIFY_ORPHAN_PURGE_INTERVAL_SECONDS', 20, 10, 600) * 1000);
  }, delayMs);
  timer.unref?.();
}

export function startShopifyOrphanPurgeWorker() {
  if (started) return;
  started = true;
  if (process.env.SHOPIFY_ORPHAN_PURGE_AUTOSTART !== 'true') {
    console.log('[shopify-orphan-purge] autostart disabled');
    return;
  }
  console.log('[shopify-orphan-purge] enabled');
  scheduleNext(15_000);
}

startShopifyOrphanPurgeWorker();
