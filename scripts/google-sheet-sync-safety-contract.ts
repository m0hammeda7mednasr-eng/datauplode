import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  APPROVED_CATALOG_SHEETS,
  filterUnseenGoogleSheetRows,
  googleSheetRowFingerprint,
  normalizeGoogleSheetUrl,
  orderGoogleSheetRowsExistingFirst,
  parseHeaderlessGoogleSheetRows,
  shouldDeferMissingCatalogRow,
  type GoogleSheetRow,
} from "../src/server/api.js";
import { applyDeterministicDabSkus } from "../src/server/services/dabSku.js";
import type { NormalizedProduct } from "../src/server/services/scraper.js";
import {
  configuredScraperApiKeyCount,
  CentrepointScraper,
  HmScraper,
  NextScraper,
  scraperApiStatusExhaustsKey,
  SheinScraper,
} from "../src/server/services/scraper.js";
import {
  FIRST_EIGHT_CATALOG_SHEETS,
  MAX_CATALOG_TARGET_ROWS,
} from "../src/server/sheet1CatalogAutoSync.js";

const spreadsheetId = "1fCbPajWL3nukX0TdoN1m2X8LV3pfPsxSMLBb0yWug2w";
const apiSource = readFileSync(new URL("../src/server/api.ts", import.meta.url), "utf8");
const scraperSource = readFileSync(new URL("../src/server/services/scraper.ts", import.meta.url), "utf8");
const catalogWorkerSource = readFileSync(
  new URL("../src/server/sheet1CatalogAutoSync.ts", import.meta.url),
  "utf8",
);
const fragmentOnlyUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=93159589`;
assert.equal(
  normalizeGoogleSheetUrl(fragmentOnlyUrl),
  `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=93159589`,
  "fragment-only gid must not silently fall back to Sheet 1",
);
assert.equal(Object.keys(APPROVED_CATALOG_SHEETS).length, 8, "only the approved first eight tabs may use catalog writes");
assert.equal(FIRST_EIGHT_CATALOG_SHEETS.length, 8, "the continuous worker must cover eight tabs");
assert.equal(MAX_CATALOG_TARGET_ROWS, 5000, "the approved run must be hard-capped at 5000 unique products");
assert.equal(
  shouldDeferMissingCatalogRow(true, false, false),
  true,
  "missing approved catalog rows must be deferred without scraping during the update-existing phase",
);
assert.equal(
  shouldDeferMissingCatalogRow(true, false, true),
  false,
  "the publish-missing phase must still process deferred rows",
);
assert.equal(
  shouldDeferMissingCatalogRow(true, true, false),
  false,
  "linked Shopify products must still refresh during the update-existing phase",
);
assert.match(
  apiSource,
  /Blocked source did not have a verified cached product snapshot with title, images, and variants; product was not published\./,
  "blocked-source fallback must fail closed instead of publishing placeholder products",
);
assert.match(
  apiSource,
  /cachedImages\.length > 0[\s\S]*cachedVariants\.length > 0/,
  "blocked-source fallback must require cached images and variants before publish",
);
assert.match(
  scraperSource,
  /catch \(error: any\) \{[\s\S]*if \(!fallbackUsable\)[\s\S]*H&M fallback did not expose a trustworthy AED product price/,
  "H&M live scraping must not return an untrusted fallback product when GraphQL fails",
);
assert.match(
  catalogWorkerSource,
  /SYNC_SHEET1_CATALOG_BLOCKED_HOST_FAST_SKIP_THRESHOLD/,
  "blocked-host fast skip must be controlled by an explicit production env gate",
);
assert.match(
  catalogWorkerSource,
  /product was not published/,
  "blocked-host fast skip must fail closed without publishing unsafe products",
);
assert.match(
  catalogWorkerSource,
  /failed: fastFailed/,
  "blocked-host fast skip rows must be recorded as failed, not verified",
);
assert.match(
  catalogWorkerSource,
  /seedBlockedHostCountsFromRecentIssues/,
  "blocked-host fast skip must carry recent blocked-host memory across deployments and cycles",
);
assert.match(
  catalogWorkerSource,
  /SYNC_SHEET1_CATALOG_BLOCKED_HOST_PROBES_PER_CYCLE[\s\S]*blockedHostRecoveryProbes/,
  "blocked-host fast skip must keep a bounded per-host recovery probe count",
);
assert.match(
  catalogWorkerSource,
  /blockedHostRecoveryProbes\.get\(host\)[\s\S]*blockedHostRecoveryProbeLimit[\s\S]*blockedHostRecoveryProbes\.set\(/,
  "blocked-host fast skip must allow multiple bounded recovery probes before continuing to fast-skip that host",
);
assert.match(
  catalogWorkerSource,
  /blockedHostCounts\.set\(host, 0\)/,
  "blocked-host fast skip must reset a host after a verified successful row",
);
assert.match(
  catalogWorkerSource,
  /isBlockedSourceReason\(entry\.reason\)[\s\S]*blockedHostCounts\.set\(host, \(blockedHostCounts\.get\(host\) \|\| 0\) \+ 1\)[\s\S]*blockedHostCounts\.set\(host, 0\)/,
  "blocked-host fast skip must reset after a non-blocked row-level failure so variant/data errors do not keep the whole host closed",
);
assert.match(
  catalogWorkerSource,
  /Source host\\s\+\(\[a-z0-9\.-\]\+\)\\s\+skipped after\\s\+\(\\d\+\)/,
  "blocked-host memory must only be seeded from explicit failed-closed source-host issues",
);
assert.match(
  catalogWorkerSource,
  /retryableProcessedIssueKeysFromRecentIssues[\s\S]*Product source price is invalid[\s\S]*host\.includes\("hm\.com"\)/,
  "processed unverified rows may only be retried for the narrow H&M price-invalid recovery path",
);
assert.match(
  catalogWorkerSource,
  /retryableProcessedKeys\.has\(entry\.key\)[\s\S]*delete state\.fingerprints\[entry\.key\]/,
  "retryable processed rows must clear their fingerprint so the worker can re-verify them",
);
assert.match(
  catalogWorkerSource,
  /retryableHmPriceIssueKeysFromDatabase[\s\S]*hm\.com[\s\S]*manualReviews[\s\S]*Product source price is invalid/,
  "older H&M price-invalid rows may be retried only when the persisted DB issue documents that exact validation failure",
);
assert.match(
  catalogWorkerSource,
  /hmPriceRetryFingerprints/,
  "H&M price-invalid recovery attempts must be persisted by row fingerprint",
);
assert.match(
  catalogWorkerSource,
  /hmPriceRetryAttempted\(state, entry\)[\s\S]*markHmPriceRetryAttempt\(state, entry\)[\s\S]*delete state\.fingerprints\[entry\.key\]/,
  "H&M price-invalid rows must be retried at most once for the same fingerprint before being failed closed again",
);
assert.match(
  catalogWorkerSource,
  /SYNC_SHEET1_CATALOG_HM_PRICE_RETRY_ROWS_PER_CYCLE[\s\S]*hmPriceRetriesSelected[\s\S]*hmPriceRetriesSelected < hmPriceRetryLimit/,
  "H&M price-invalid recovery must be capped per worker cycle so it cannot monopolize catalog progress",
);
assert.match(
  catalogWorkerSource,
  /blockedHostRetryFingerprints/,
  "blocked-source recovery attempts must be persisted by row fingerprint",
);
assert.match(
  catalogWorkerSource,
  /SYNC_SHEET1_CATALOG_BLOCKED_HOST_RETRY_ROWS_PER_CYCLE[\s\S]*blockedHostRetriesSelected[\s\S]*blockedHostRetriesSelected < blockedHostRetryLimit/,
  "blocked-source recovery must be capped per worker cycle so blocked hosts cannot monopolize catalog progress",
);
assert.match(
  catalogWorkerSource,
  /markBlockedHostRetryAttempt\(state, entry\)[\s\S]*delete state\.fingerprints\[entry\.key\]/,
  "blocked-source rows must clear their fingerprint only after recording the bounded retry attempt",
);
assert.match(
  catalogWorkerSource,
  /SYNC_SHEET1_CATALOG_CENTREPOINT_RECOVERY_REVISION[\s\S]*host\.includes\("centrepointstores\.com"\)[\s\S]*entry\.fingerprint/,
  "Centrepoint parser fixes may unlock one bounded recovery retry without reopening other blocked suppliers",
);
assert.match(
  readFileSync(new URL("../src/server/firstFiveSheetsReconcile.ts", import.meta.url), "utf8"),
  /variantSkuSizeSuffixMatches[\s\S]*skuMatches\.length === 1/,
  "existing-product variant updates may use SKU size fallback only when exactly one source variant matches",
);
assert.match(
  apiSource,
  /retryableCentrepointVariantMap[\s\S]*centrepointstores\.com[\s\S]*Could not map \\d\+\\\/\\d\+ Shopify variants to fresh source variants[\s\S]*reconciliation = await reconcileExisting\(analyzed\)/,
  "Centrepoint existing-product variant mapping failures may retry once with a fresh scrape before failing closed",
);

const sparseRows = parseHeaderlessGoogleSheetRows([
  [],
  ["https://example.com/a", "22", "Dungarees", "DAB-NXT-A-22"],
  ["https://example.com/b", "", "", "", "", "", "", "", "24", "Shoes"],
]);
assert.equal(sparseRows.length, 2, "blank leading rows must not turn a headerless tab into a header-based sheet");
assert.deepEqual(
  sparseRows.map((row) => [row.rowNumber, row.priceMultiplier, row.collection]),
  [[2, 22, "Dungarees"], [3, 24, "Shoes"]],
  "sparse multipliers and collections must be detected anywhere after the URL",
);

const previousPool = process.env.SCRAPERAPI_KEYS;
const previousLegacyKey = process.env.SCRAPERAPI_KEY;
process.env.SCRAPERAPI_KEYS = "dummy-one,dummy-two;dummy-three\ndummy-four";
delete process.env.SCRAPERAPI_KEY;
assert.equal(configuredScraperApiKeyCount(), 4, "four ScraperAPI keys must be recognized without exposing their values");
assert.equal(scraperApiStatusExhaustsKey(429), true, "rate-limited ScraperAPI keys must cool down individually");
assert.equal(scraperApiStatusExhaustsKey(402), true, "exhausted ScraperAPI keys must cool down individually");
assert.equal(scraperApiStatusExhaustsKey(403), false, "target/source 403s must not put healthy ScraperAPI keys into exhausted cooldown");
assert.equal(scraperApiStatusExhaustsKey(500), false, "URL-specific provider failures must not disable a healthy key");
assert.equal(scraperApiStatusExhaustsKey(499), false, "client/URL failures must not pause the whole key pool");
if (previousPool === undefined) delete process.env.SCRAPERAPI_KEYS;
else process.env.SCRAPERAPI_KEYS = previousPool;
if (previousLegacyKey === undefined) delete process.env.SCRAPERAPI_KEY;
else process.env.SCRAPERAPI_KEY = previousLegacyKey;

const rows: GoogleSheetRow[] = Array.from({ length: 1002 }, (_, index) => ({
  rowNumber: index + 1,
  url: `https://example.com/products/${index + 1}`,
  price: null,
  priceMultiplier: 22,
  collection: "test",
}));
const seenMap: Record<string, number> = {};
for (const row of rows.slice(0, 300)) {
  seenMap[googleSheetRowFingerprint(row).hash] = Date.now();
}

const unseenRows = filterUnseenGoogleSheetRows(rows, seenMap, true);
assert.equal(unseenRows.length, 702, "all rows after the first processed 300 must remain eligible");
assert.equal(unseenRows[0].rowNumber, 301, "auto sync must advance past the first 300 rows");

const linkedUrls = new Set([
  rows[499].url,
  rows[899].url,
]);
const ordered = orderGoogleSheetRowsExistingFirst(unseenRows, linkedUrls, 300);
assert.deepEqual(
  ordered.slice(0, 2).map((row) => row.rowNumber),
  [500, 900],
  "linked Shopify products must be processed before missing products",
);
assert.equal(ordered.length, 300, "the per-run safety limit must remain enforced");

const product = (): NormalizedProduct => ({
  source: {
    supplier: "Next",
    url: "https://www.next.ae/en/style/su123456/w90031",
    productId: "W90031",
  },
  title: "Test product",
  currency: "AED",
  price: 10,
  images: [],
  options: [{ name: "Size", values: ["S", "M"] }],
  variants: [
    { size: "S", available: true, stockStatus: "in_stock" },
    { size: "M", available: true, stockStatus: "in_stock" },
  ],
  raw: {},
});
const firstSkuPlan = applyDeterministicDabSkus({
  product: product(),
  url: product().source.url,
  multiplier: 22,
});
const secondProduct = product();
const secondSkuPlan = applyDeterministicDabSkus({
  product: secondProduct,
  url: secondProduct.source.url,
  multiplier: 22,
});
assert.equal(firstSkuPlan.canonicalSku, secondSkuPlan.canonicalSku, "SKU generation must be deterministic");
assert.match(firstSkuPlan.canonicalSku, /^DAB-NXT-W90-031-/);
assert.equal(
  new Set(secondProduct.variants.map((variant) => variant.sku)).size,
  secondProduct.variants.length,
  "every published variant must receive a unique SKU",
);

const changedSkuRow = { ...rows[0], sku: "DAB-NXT-W90-031-S-22" };
assert.notEqual(
  googleSheetRowFingerprint(rows[0]).hash,
  googleSheetRowFingerprint(changedSkuRow).hash,
  "SKU edits in the sheet must be detected by continuous sync",
);

const nextSnapshot = new NextScraper().scrapeSnapshot(
  "https://www.next.ae/en/style/su814171/w90034",
  [
    "# Ecru Toy Story T-Shirt and Shorts Set (3mths-8yrs)",
    "AED92 - AED114",
    "VAT Included",
    "Product Code: W90-034",
    "Size:",
    "Choose Size",
    "Add to Bag",
    "## Description",
    "Cotton play set.",
  ].join("\n"),
);
assert.equal(nextSnapshot.title, "Ecru Toy Story T-Shirt and Shorts Set (3mths-8yrs)");
assert.equal(nextSnapshot.source.productId, "W90-034");
assert.equal(nextSnapshot.currency, "AED");
assert.equal(nextSnapshot.variants.length, 11, "3mths-8yrs must not collapse to one variant");
assert.equal(nextSnapshot.variants[0].size, "3-6 Months (62-68cm)");
assert.equal(nextSnapshot.variants.at(-1)?.size, "7-8 Years (122-128cm)");
assert.equal(nextSnapshot.variants[0].price, 92);
assert.equal(nextSnapshot.variants.at(-1)?.price, 114);

assert.throws(
  () =>
    new HmScraper().scrapeSnapshot(
      "https://ae.hm.com/en/buy-5-pack-motif-detail-socks-white-hello-kitty",
      [
        "# 5-pack motif-detail socks",
        "TRY 5",
        "Product code: 123456",
        "Add to bag",
      ].join("\n"),
    ),
  /trustworthy AED product price/,
  "H&M UAE snapshots must reject non-AED fallback prices instead of publishing wrong products",
);

assert.throws(
  () =>
    new SheinScraper().scrapeSnapshot(
      "https://ar.shein.com/SHEIN-3pcs-Newborn-Baby-Unisex-Cute-Cartoon-Print-Long-Sleeve-Footed-Jumpsuit-Pajama-Set-p-169508305.html",
      [
        "# You have too many requests, which exceeds our limit.",
        "TRY 5",
        "Add to bag",
      ].join("\n"),
    ),
  /challenge or rate-limit page|trusted product currency/,
  "SHEIN challenge/rate-limit snapshots must fail closed instead of publishing placeholder products",
);

const centrepointGlyphSnapshot = new CentrepointScraper().scrapeSnapshot(
  "https://www.centrepointstores.com/ae/en/buy-pack-of-2-juniors-round-neck-short-sleeve-dress-with-floral-print/p/K35-A13-07-154MULTICOLORMULTISHADE",
  [
    "Title: Buy Pack of 2 Juniors Round Neck Short Sleeve Dress with Floral Print Online | Centrepoint UAE",
    "1/8",
    "\uE902 45",
    "Pack of 2 Juniors Round Neck Short Sleeve Dress with Floral Print",
    "Size:",
    "0-3 MTHS",
    "3-6 MTHS",
    "![Product image](https://media.centrepointstores.com/i/centrepoint/K35-A13-07-154MULTICOLORMULTISHADE_01-2100.jpg)",
  ].join("\n"),
);
assert.equal(
  centrepointGlyphSnapshot.currency,
  "AED",
  "Centrepoint private-use currency glyph must be interpreted as AED only for Centrepoint snapshots",
);
assert.equal(
  centrepointGlyphSnapshot.price,
  45,
  "Centrepoint private-use currency glyph snapshots must preserve the visible product price",
);

console.log("Google Sheet sync safety contract passed");
