import { prisma } from './db.js';
import { ShopifyService } from './services/shopify.js';

function clean(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

async function fetchAllShopifyProducts(client: any) {
  const products: Array<{ id: string; title: string; status: string; handle: string; createdAt: string }> = [];
  let after: string | null = null;
  let pages = 0;
  while (pages < 100) {
    const data = await client.request(
      `query OrphanScan($first: Int!, $after: String) {
        products(first: $first, after: $after, sortKey: ID) {
          nodes { id title status handle createdAt }
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
        handle: clean(node.handle),
        createdAt: clean(node.createdAt),
      });
    }
    pages += 1;
    if (!connection?.pageInfo?.hasNextPage || !connection?.pageInfo?.endCursor) break;
    after = String(connection.pageInfo.endCursor);
  }
  return { products, pages };
}

async function run() {
  try {
    const client = await ShopifyService.getClientFromDb(prisma);
    const [linkedRows, shopify] = await Promise.all([
      prisma.shopifyProduct.findMany({ select: { shopifyId: true } }),
      fetchAllShopifyProducts(client),
    ]);
    const linkedIds = new Set(linkedRows.map((row) => clean(row.shopifyId)).filter(Boolean));
    const orphans = shopify.products.filter((product) => !linkedIds.has(product.id));
    const details = orphans.map((product) => ({
      id: product.id,
      title: product.title,
      status: product.status,
      handle: product.handle,
      createdAt: product.createdAt,
    }));

    await prisma.auditLog.create({
      data: {
        action: 'SHOPIFY_ORPHAN_SCAN_ONCE',
        userId: 'System',
        details: JSON.stringify({
          scannedShopify: shopify.products.length,
          linkedLocal: linkedIds.size,
          orphanCount: details.length,
          pages: shopify.pages,
          orphans: details,
          scannedAt: new Date().toISOString(),
        }),
      },
    });

    console.log(JSON.stringify({
      worker: 'shopify-orphan-scan-once',
      scannedShopify: shopify.products.length,
      linkedLocal: linkedIds.size,
      orphanCount: details.length,
      pages: shopify.pages,
      orphans: details,
    }));
  } catch (error: any) {
    console.error('[shopify-orphan-scan-once] failed:', clean(error?.message || error));
  }
}

setTimeout(() => { void run(); }, 15_000).unref?.();
