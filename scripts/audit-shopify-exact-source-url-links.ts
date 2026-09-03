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

const inputPath = process.env.SOURCE_URL_AUDIT_INPUT || "C:/tmp/big-sheet-missing-audit.json";
const outputPath = process.env.SOURCE_URL_AUDIT_OUTPUT || "C:/tmp/shopify-exact-source-url-candidates.json";
const report = JSON.parse(await readFile(inputPath, "utf8")) as { sheets: SheetReport[] };
const rows = report.sheets.flatMap((sheet) =>
  sheet.missingRows.map((row) => ({ ...row, sheetName: sheet.name, gid: sheet.gid, sheetUrl: sheet.sheetUrl })),
);
const rowsByUrl = new Map<string, typeof rows>();
for (const row of rows) {
  const key = canonicalUrl(row.url);
  if (!key) continue;
  const group = rowsByUrl.get(key) || [];
  group.push(row);
  rowsByUrl.set(key, group);
}

const linkedIds = new Set((await prisma.shopifyProduct.findMany({ select: { shopifyId: true } })).map((row) => row.shopifyId));
const client = await ShopifyService.getClientFromDb(prisma);
const matches = new Map<string, any[]>();
let after: string | null = null;
let pages = 0;
let productsRead = 0;

while (true) {
  const data: any = await client.request(`
    query ExactSourceUrlAudit($after: String) {
      products(first: 50, after: $after) {
        nodes {
          id title handle status vendor descriptionHtml
          synclySource: metafield(namespace: "syncly", key: "source_url") { value }
          customSource: metafield(namespace: "custom", key: "source_url") { value }
          variants(first: 250) {
            nodes { id sku price inventoryQuantity selectedOptions { name value } }
            pageInfo { hasNextPage }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `, { after });
  const connection = data?.products;
  for (const product of connection?.nodes || []) {
    productsRead += 1;
    if (linkedIds.has(product.id)) continue;
    const values = [product.descriptionHtml, product.synclySource?.value, product.customSource?.value]
      .map((value) => decodeHtml(String(value || "")));
    const urls = new Set(values.flatMap(extractUrls).map(canonicalUrl).filter(Boolean));
    for (const url of urls) {
      if (!rowsByUrl.has(url)) continue;
      const group = matches.get(url) || [];
      group.push(product);
      matches.set(url, group);
    }
  }
  pages += 1;
  if (!connection?.pageInfo?.hasNextPage) break;
  after = String(connection.pageInfo.endCursor || "");
  if (!after || pages >= 500) throw new Error("Shopify source URL audit could not prove complete pagination");
}

const candidates: any[] = [];
const ambiguous: any[] = [];
for (const [url, products] of matches) {
  const sheetRows = rowsByUrl.get(url) || [];
  if (products.length !== 1 || sheetRows.length !== 1) {
    ambiguous.push({ url, shopifyProductIds: products.map((product) => product.id), rows: sheetRows });
    continue;
  }
  const product = products[0];
  if (product.variants?.pageInfo?.hasNextPage) {
    ambiguous.push({ url, shopifyProductIds: [product.id], rows: sheetRows, reason: "more_than_250_variants" });
    continue;
  }
  candidates.push({
    url,
    row: sheetRows[0],
    shopify: {
      productId: product.id,
      title: product.title,
      handle: product.handle,
      status: product.status,
      vendor: product.vendor,
      variants: product.variants?.nodes || [],
    },
  });
}

const output = {
  generatedAt: new Date().toISOString(),
  readOnly: true,
  productsRead,
  pagesRead: pages,
  exactCandidates: candidates.length,
  activeCandidates: candidates.filter((candidate) => candidate.shopify.status === "ACTIVE").length,
  ambiguous: ambiguous.length,
  candidates,
  ambiguousMatches: ambiguous,
};
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ...output, candidates: undefined, ambiguousMatches: undefined, outputPath }));
await prisma.$disconnect();

function extractUrls(value: string) {
  return value.match(/https?:\/\/[^\s<>"']+/gi) || [];
}

function decodeHtml(value: string) {
  return value.replace(/&amp;/gi, "&").replace(/&#x2F;/gi, "/").replace(/&#47;/gi, "/");
}

function canonicalUrl(value: string) {
  try {
    const parsed = new URL(String(value || "").replace(/[),.;]+$/, ""));
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^m\./, "www.");
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|gclid|fbclid|ref|source)/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return "";
  }
}
