import fs from 'node:fs';

const queue = fs.readFileSync('src/server/services/queue.ts', 'utf8');
const server = fs.readFileSync('server.ts', 'utf8');
const railway = fs.readFileSync('.env.railway.example', 'utf8');

function requireContract(condition: boolean, message: string) {
  if (!condition) throw new Error(`Price/stock sync safety contract failed: ${message}`);
}

const start = queue.indexOf('private static async syncProductPriceStockOnly');
const end = queue.indexOf('private static async queuePriceStockSyncBatch', start);
requireContract(start >= 0 && end > start, 'isolated sync implementation is missing');
const isolated = queue.slice(start, end);

requireContract(isolated.includes('await scraperService.scrape(product.url)'), 'supplier must be refreshed before writes');
requireContract(isolated.includes('readbackVerified: true'), 'Shopify read-back must be required');
requireContract(isolated.includes('imagesTouched: 0'), 'audit must prove images are untouched');
requireContract(isolated.includes('detailsTouched: 0'), 'audit must prove details are untouched');
requireContract(isolated.includes('variantsRebuilt: 0'), 'audit must prove variants are never rebuilt');
requireContract(!/deleteProduct|updateProductDetails|updateVariantsBulkMedia|addProductToCollection|rebuildLinkedProduct/.test(isolated), 'isolated sync contains a forbidden catalog mutation');
requireContract(/runtimeWritesEnabled\(\)\s*&&\s*envFlag\("SYNC_PRICE_STOCK_AUTOSTART"\)/.test(server), 'autostart must remain behind the global write gate');
requireContract(/^SYNC_PRICE_STOCK_AUTOSTART=false$/m.test(railway), 'Railway template must fail closed');
requireContract(/^SYNC_PRICE_STOCK_MIN_AGE_MINUTES=1440$/m.test(railway), 'default rolling refresh must be bounded to once per day');

console.log(JSON.stringify({ ok: true, isolatedPriceStockWrites: true }, null, 2));
