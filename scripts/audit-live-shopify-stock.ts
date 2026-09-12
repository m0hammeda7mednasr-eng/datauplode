import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API_BASE = String(process.env.CATALOG_API_BASE || 'https://datauplode-production.up.railway.app').replace(/\/$/, '');
const STOREFRONT_BASE = String(process.env.SHOPIFY_STOREFRONT_BASE || 'https://dabdoobkidz.com').replace(/\/$/, '');
const REQUEST_DELAY_MS = Math.max(0, Number(process.env.STOCK_AUDIT_REQUEST_DELAY_MS || 0) || 0);
const RETRY_REPORT = clean(process.env.STOCK_AUDIT_RETRY_REPORT);

type CatalogVariant = {
  sku?: string | null;
  size?: string | null;
  color?: string | null;
  available?: boolean;
  price?: number | null;
};

type CatalogItem = {
  shopifyProductId: string;
  shopifyHandle: string;
  title: string;
  sourceUrl?: string | null;
  variants: CatalogVariant[];
};

type StorefrontVariant = {
  id: number;
  title: string;
  sku?: string | null;
  available: boolean;
  price: string | number;
};

type StorefrontProduct = {
  id: number;
  title: string;
  handle: string;
  variants: StorefrontVariant[];
};

function clean(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function moneyEqual(left: unknown, right: unknown) {
  return Math.abs(Number(left) - Number(right)) < 0.01;
}

async function fetchJson<T>(url: string, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'SynclyStockAudit/1.0' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        if (response.status === 429 && attempt < attempts) {
          const retryAfterSeconds = Math.max(1, Number(response.headers.get('retry-after') || 1) || 1);
          await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds * 1000 + attempt * 250));
          continue;
        }
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json() as T;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

async function loadCatalog() {
  const limit = 250;
  type CatalogPage = {
    success: boolean;
    counts: { shopifyTotal: number };
    items: CatalogItem[];
    hasMore: boolean;
  };
  const first = await fetchJson<CatalogPage>(`${API_BASE}/api/shopify-catalog/link-state?offset=0&limit=${limit}`);
  if (!first.success) throw new Error('Catalog API failed at offset 0');
  const total = Number(first.counts?.shopifyTotal || first.items.length);
  const offsets = Array.from({ length: Math.max(0, Math.ceil(total / limit) - 1) }, (_, index) => (index + 1) * limit);
  const pages = new Map<number, CatalogItem[]>();
  let cursor = 0;
  async function pageWorker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= offsets.length) return;
      const offset = offsets[index];
      const page = await fetchJson<CatalogPage>(`${API_BASE}/api/shopify-catalog/link-state?offset=${offset}&limit=${limit}`);
      if (!page.success) throw new Error(`Catalog API failed at offset ${offset}`);
      pages.set(offset, page.items);
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, offsets.length) }, () => pageWorker()));
  const items = [first.items, ...offsets.map((offset) => pages.get(offset) || [])].flat();
  if (items.length !== total) throw new Error(`Catalog API returned ${items.length} of ${total} products`);
  return items;
}

async function loadStorefrontCatalog() {
  const products: StorefrontProduct[] = [];
  const limit = 250;
  for (let page = 1; ; page += 1) {
    const response = await fetchJson<{ products?: StorefrontProduct[] }>(
      `${STOREFRONT_BASE}/products.json?limit=${limit}&page=${page}`,
      8,
    );
    const batch = Array.isArray(response.products) ? response.products : [];
    products.push(...batch);
    console.log(JSON.stringify({ storefrontPage: page, loaded: products.length }));
    if (batch.length < limit) break;
    if (REQUEST_DELAY_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
    }
  }
  return products;
}

async function main() {
  const [fullCatalog, storefrontCatalog] = await Promise.all([
    loadCatalog(),
    loadStorefrontCatalog(),
  ]);
  const storefrontByHandle = new Map(
    storefrontCatalog.map((product) => [clean(product.handle), product] as const),
  );
  let retryHandles: Set<string> | null = null;
  if (RETRY_REPORT) {
    const previous = JSON.parse(await readFile(RETRY_REPORT, 'utf8'));
    retryHandles = new Set((Array.isArray(previous?.failures) ? previous.failures : []).map((row: any) => clean(row?.handle)).filter(Boolean));
  }
  const catalog = retryHandles
    ? fullCatalog.filter((item) => retryHandles!.has(clean(item.shopifyHandle)))
    : fullCatalog;
  const mismatches: any[] = [];
  const failures: any[] = [];
  let productsChecked = 0;
  let variantsChecked = 0;
  let stockMismatches = 0;
  let priceMismatches = 0;
  let missingVariants = 0;
  let extraVariants = 0;

  for (const item of catalog) {
    const live = storefrontByHandle.get(clean(item.shopifyHandle));
    if (!live) {
      failures.push({
        shopifyProductId: item.shopifyProductId,
        handle: item.shopifyHandle,
        title: item.title,
        error: 'Product is missing from the published Shopify storefront catalog',
      });
      continue;
    }
    try {
        const expectedBySku = new Map(
          item.variants
            .map((variant) => [clean(variant.sku), variant] as const)
            .filter(([sku]) => Boolean(sku)),
        );
        const liveBySku = new Map(
          live.variants
            .map((variant) => [clean(variant.sku), variant] as const)
            .filter(([sku]) => Boolean(sku)),
        );
        const productIssues: any[] = [];

        for (const [sku, expected] of expectedBySku) {
          const actual = liveBySku.get(sku);
          if (!actual) {
            missingVariants += 1;
            productIssues.push({ type: 'missing_live_variant', sku, expected });
            continue;
          }
          variantsChecked += 1;
          if (Boolean(actual.available) !== Boolean(expected.available)) {
            stockMismatches += 1;
            productIssues.push({
              type: 'stock_mismatch',
              sku,
              expectedAvailable: Boolean(expected.available),
              liveAvailable: Boolean(actual.available),
              size: expected.size,
            });
          }
          const livePrice = Number(actual.price);
          if (Number(expected.price) > 0 && !moneyEqual(livePrice, expected.price)) {
            priceMismatches += 1;
            productIssues.push({
              type: 'price_mismatch',
              sku,
              expectedPrice: Number(expected.price),
              livePrice,
              size: expected.size,
            });
          }
        }

        for (const [sku, actual] of liveBySku) {
          if (!expectedBySku.has(sku)) {
            extraVariants += 1;
            productIssues.push({ type: 'extra_live_variant', sku, actualTitle: actual.title });
          }
        }

        if (productIssues.length) {
          mismatches.push({
            shopifyProductId: item.shopifyProductId,
            handle: item.shopifyHandle,
            title: item.title,
            sourceUrl: item.sourceUrl,
            issues: productIssues,
          });
        }
      productsChecked += 1;
    } catch (error: any) {
      failures.push({
        shopifyProductId: item.shopifyProductId,
        handle: item.shopifyHandle,
        title: item.title,
        error: clean(error?.message || error),
      });
    }

    const done = productsChecked + failures.length;
    if (done > 0 && done % 250 === 0) {
      console.log(JSON.stringify({ progress: done, total: catalog.length, mismatchedProducts: mismatches.length, failures: failures.length }));
    }
  }
  const report = {
    generatedAt: new Date().toISOString(),
    apiBase: API_BASE,
    storefrontBase: STOREFRONT_BASE,
    storefrontProducts: storefrontCatalog.length,
    catalogProducts: fullCatalog.length,
    selectedProducts: catalog.length,
    retryReport: RETRY_REPORT || null,
    productsChecked,
    variantsChecked,
    mismatchedProducts: mismatches.length,
    stockMismatches,
    priceMismatches,
    missingVariants,
    extraVariants,
    requestFailures: failures.length,
    mismatches,
    failures,
  };
  await mkdir('reports', { recursive: true });
  const reportPath = path.resolve('reports', `live-shopify-stock-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ...report, mismatches: undefined, failures: undefined, reportPath }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
