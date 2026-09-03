import { readFile, writeFile } from "node:fs/promises";
import { prisma } from "../src/server/db.js";
import { ShopifyService } from "../src/server/services/shopify.js";

type MissingRow = {
  rowNumber: number;
  url: string;
  priceMultiplier: number | null;
  collection: string;
  sku: string;
};

type SheetReport = {
  name: string;
  gid: number;
  sheetUrl: string;
  missingRows: MissingRow[];
};

const inputPath = process.env.SHEET_LINK_AUDIT_INPUT || "C:/tmp/big-sheet-missing-audit.json";
const outputPath = process.env.SHEET_LINK_AUDIT_OUTPUT || "C:/tmp/sheet-shopify-link-candidates.json";
const maxPages = boundedInteger(process.env.SHEET_LINK_AUDIT_MAX_PAGES || "250", 1, 500);

const report = JSON.parse(await readFile(inputPath, "utf8")) as { sheets: SheetReport[] };
const rows = report.sheets.flatMap((sheet) =>
  sheet.missingRows.map((row) => ({ ...row, sheetName: sheet.name, gid: sheet.gid, sheetUrl: sheet.sheetUrl })),
);
const rowsBySku = new Map<string, typeof rows>();
for (const row of rows) {
  const sku = normalizeSku(row.sku);
  if (!sku) continue;
  const group = rowsBySku.get(sku) || [];
  group.push(row);
  rowsBySku.set(sku, group);
}

const client = await ShopifyService.getClientFromDb(prisma);
const shopifyBySku = new Map<string, any[]>();
let after: string | null = null;
let pages = 0;
let variantsRead = 0;
let hasNextPage = true;

while (pages < maxPages && hasNextPage) {
  const data: any = await client.request(`
    query SheetLinkProductAudit($after: String) {
      products(first: 50, after: $after) {
        nodes {
          id title handle status vendor
          variants(first: 250) {
            nodes {
              id sku price inventoryQuantity
              selectedOptions { name value }
            }
            pageInfo { hasNextPage }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `, { after });
  const connection = data?.products;
  const products = connection?.nodes || [];
  for (const product of products) {
    if (product?.variants?.pageInfo?.hasNextPage) {
      throw new Error(`Shopify product ${product.id} has more than 250 variants; audit cannot prove completeness`);
    }
    const variants = product?.variants?.nodes || [];
    variantsRead += variants.length;
    for (const variant of variants) {
      const sku = normalizeSku(variant?.sku);
      if (!sku || !rowsBySku.has(sku)) continue;
      const matches = shopifyBySku.get(sku) || [];
      matches.push({ ...variant, product: {
        id: product.id,
        title: product.title,
        handle: product.handle,
        status: product.status,
        vendor: product.vendor,
      } });
      shopifyBySku.set(sku, matches);
    }
  }
  pages += 1;
  hasNextPage = connection?.pageInfo?.hasNextPage === true;
  if (!hasNextPage) break;
  after = String(connection.pageInfo.endCursor || "");
  if (!after) throw new Error("Shopify pagination returned hasNextPage without endCursor");
}

if (pages === maxPages && hasNextPage) {
  throw new Error(`Shopify variant audit exceeded the safe ${maxPages}-page limit`);
}

const alreadyLinked = await prisma.shopifyProduct.findMany({ select: { shopifyId: true } });
const linkedShopifyIds = new Set(alreadyLinked.map((item) => item.shopifyId));
const candidates: any[] = [];
const ambiguous: any[] = [];
const missingSku: any[] = [];

for (const [sku, sheetRows] of rowsBySku) {
  const variants = shopifyBySku.get(sku) || [];
  const productIds = [...new Set(variants.map((variant) => variant.product.id))];
  const urls = [...new Set(sheetRows.map((row) => normalizeUrl(row.url)))];
  if (productIds.length !== 1 || urls.length !== 1 || variants.length !== 1) {
    ambiguous.push({ sku, rows: sheetRows, productIds, variantCount: variants.length, urlCount: urls.length });
    continue;
  }
  const variant = variants[0];
  if (linkedShopifyIds.has(variant.product.id)) continue;
  candidates.push({
    sku,
    row: sheetRows[0],
    shopify: {
      productId: variant.product.id,
      productTitle: variant.product.title,
      handle: variant.product.handle,
      status: variant.product.status,
      vendor: variant.product.vendor,
      variantId: variant.id,
      price: variant.price,
      inventoryQuantity: variant.inventoryQuantity,
      selectedOptions: variant.selectedOptions,
    },
  });
}

for (const row of rows) {
  if (!normalizeSku(row.sku)) missingSku.push(row);
}

const result = {
  generatedAt: new Date().toISOString(),
  readOnly: true,
  sheetRowsMissingDatabaseLink: rows.length,
  rowsWithSku: rows.length - missingSku.length,
  rowsWithoutSku: missingSku.length,
  uniqueSheetSkus: rowsBySku.size,
  shopifyPagesRead: pages,
  shopifyVariantsRead: variantsRead,
  exactUnlinkedCandidates: candidates.length,
  ambiguousSkus: ambiguous.length,
  candidates,
  ambiguous,
};

await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  readOnly: true,
  sheetRowsMissingDatabaseLink: result.sheetRowsMissingDatabaseLink,
  rowsWithSku: result.rowsWithSku,
  rowsWithoutSku: result.rowsWithoutSku,
  uniqueSheetSkus: result.uniqueSheetSkus,
  shopifyPagesRead: result.shopifyPagesRead,
  shopifyVariantsRead: result.shopifyVariantsRead,
  exactUnlinkedCandidates: result.exactUnlinkedCandidates,
  ambiguousSkus: result.ambiguousSkus,
  outputPath,
}));
await prisma.$disconnect();

function normalizeSku(value: unknown) {
  return String(value || "").replace(/\s+/g, "").trim().toUpperCase();
}

function normalizeUrl(value: unknown) {
  try {
    const url = new URL(String(value || "").trim());
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return String(value || "").trim().replace(/\/$/, "").toLowerCase();
  }
}

function boundedInteger(raw: string, min: number, max: number) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Expected an integer between ${min} and ${max}`);
  }
  return value;
}
