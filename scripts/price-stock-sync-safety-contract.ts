import fs from 'node:fs';

const queue = fs.readFileSync('src/server/services/queue.ts', 'utf8');
const server = fs.readFileSync('server.ts', 'utf8');
const railway = fs.readFileSync('.env.railway.example', 'utf8');
const scraper = fs.readFileSync('src/server/services/scraper.ts', 'utf8');
const budget = fs.readFileSync('src/server/services/scraperCreditBudget.ts', 'utf8');

function requireContract(condition: boolean, message: string) {
  if (!condition) throw new Error(`Price/stock sync safety contract failed: ${message}`);
}

const start = queue.indexOf('private static async syncProductPriceStockOnly');
const end = queue.indexOf('private static async queuePriceStockSyncBatch', start);
requireContract(start >= 0 && end > start, 'isolated sync implementation is missing');
const isolated = queue.slice(start, end);

requireContract(
  /await withTimeout\([\s\S]*scraperService\.scrape\(product\.url\)/.test(isolated),
  'supplier must be refreshed before writes',
);
requireContract(
  isolated.includes('Price/stock source scrape timed out before Shopify mutation'),
  'supplier refresh must be bounded before writes',
);
requireContract(isolated.includes('readbackVerified: true'), 'Shopify read-back must be required');
requireContract(isolated.includes('attempt <= 5'), 'Shopify read-back must tolerate bounded inventory propagation delay');
requireContract(isolated.includes('imagesTouched: 0'), 'audit must prove images are untouched');
requireContract(isolated.includes('detailsTouched: 0'), 'audit must prove details are untouched');
requireContract(isolated.includes('variantsRebuilt: 0'), 'audit must prove variants are never rebuilt');
requireContract(!/deleteProduct|updateProductDetails|updateVariantsBulkMedia|addProductToCollection|rebuildLinkedProduct/.test(isolated), 'isolated sync contains a forbidden catalog mutation');
requireContract(/runtimeWritesEnabled\(\)\s*&&\s*envFlag\("SYNC_PRICE_STOCK_AUTOSTART"\)/.test(server), 'autostart must remain behind the global write gate');
requireContract(/^SYNC_PRICE_STOCK_AUTOSTART=false$/m.test(railway), 'Railway template must fail closed');
requireContract(/^SYNC_PRICE_STOCK_MIN_AGE_MINUTES=1440$/m.test(railway), 'default rolling refresh must be bounded to once per day');
requireContract(queue.includes('isPriceStockTargetProduct(product)'), 'every product sync must enforce the two-sheet allowlist');
requireContract(
  queue.includes('SYNC_PRICE_STOCK_TARGET_DOMAINS') &&
    queue.includes('PRICE_STOCK_TARGET_DOMAINS.map') &&
    queue.includes('priceStockDomainRank'),
  'rolling price/stock batches must support a domain allowlist to keep blocked suppliers from clogging the queue',
);
requireContract(
  queue.includes('if (!hasMultiplier || !hasSku) return false') &&
    queue.includes('return hasSheetRow'),
  'legacy sheet products must require row, multiplier, and SKU provenance',
);
requireContract(queue.includes("action: 'SYNC_PRICE_STOCK_FAILED'"), 'failed supplier checks must be audited');
requireContract(scraper.includes('reserveScraperApiCredits(url, credits)'), 'each ScraperAPI attempt must reserve its actual profile credits');
requireContract(scraper.includes('requestHtml(apiKey, buildParams(apiKey, attempt), credits)'), 'ScraperAPI retries must be accounted per attempted request');
requireContract(budget.includes('SCRAPERAPI_MONTHLY_CREDIT_LIMIT'), 'ScraperAPI must support a durable monthly credit cap');
requireContract(budget.includes('SCRAPERAPI_DAILY_CREDIT_LIMIT'), 'ScraperAPI must support a durable daily credit cap');
requireContract(queue.includes('data: { lastScrapedAt: new Date() }'), 'blocked products must move behind the daily rolling queue');
requireContract(railway.includes('1fCbPajWL3nukX0TdoN1m2X8LV3pfPsxSMLBb0yWug2w,13JSw5k_wX8RAd98P-TWLT-938ImshAtrukjjA4n-lkI'), 'Railway must pin both authorized spreadsheets');
requireContract(/^SYNC_PRICE_STOCK_SOURCE_SCRAPE_TIMEOUT_MS=60000$/m.test(railway), 'Railway template must bound price/stock source scrape time');
requireContract(/^SYNC_PRICE_STOCK_TARGET_DOMAINS=$/m.test(railway), 'Railway template must document the price/stock domain allowlist');

console.log(JSON.stringify({ ok: true, isolatedPriceStockWrites: true }, null, 2));
