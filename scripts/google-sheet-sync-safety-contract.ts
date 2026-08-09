import assert from "node:assert/strict";
import {
  filterUnseenGoogleSheetRows,
  googleSheetRowFingerprint,
  normalizeGoogleSheetUrl,
  orderGoogleSheetRowsExistingFirst,
  type GoogleSheetRow,
} from "../src/server/api.js";
import { applyDeterministicDabSkus } from "../src/server/services/dabSku.js";
import type { NormalizedProduct } from "../src/server/services/scraper.js";
import { NextScraper } from "../src/server/services/scraper.js";

const spreadsheetId = "1fCbPajWL3nukX0TdoN1m2X8LV3pfPsxSMLBb0yWug2w";
const fragmentOnlyUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=93159589`;
assert.equal(
  normalizeGoogleSheetUrl(fragmentOnlyUrl),
  `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=93159589`,
  "fragment-only gid must not silently fall back to Sheet 1",
);

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

console.log("Google Sheet sync safety contract passed");
