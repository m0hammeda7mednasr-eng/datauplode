import { prisma } from "../src/server/db.js";
import { ShopifyService } from "../src/server/services/shopify.js";

const batchSize = Math.max(1, Math.min(100, Number(process.env.DEFAULT_VARIANT_AUDIT_BATCH_SIZE || 50)));
const limit = Math.max(1, Number(process.env.DEFAULT_VARIANT_AUDIT_LIMIT || 20_000));

type Candidate = {
  sourceProductId: string;
  shopifyId: string;
  title: string;
  url: string;
  raw: string | null;
  storedVariantCount: number;
};

const candidates = await prisma.$queryRawUnsafe<Candidate[]>(`
  SELECT s."id" AS "sourceProductId", sp."shopifyId", s."title", s."url", s."raw",
         COUNT(sv."id")::int AS "storedVariantCount"
  FROM "SourceProduct" s
  JOIN "ShopifyProduct" sp ON sp."sourceProductId"=s."id"
  LEFT JOIN "SourceVariant" sv ON sv."sourceProductId"=s."id"
  WHERE sp."status"='active' AND sp."syncEnabled"=TRUE
  GROUP BY s."id", sp."shopifyId", s."title", s."url", s."raw"
  HAVING COUNT(sv."id") <= 1
  ORDER BY s."updatedAt" ASC
  LIMIT ${limit}
`);

function chunks<T>(values: T[], size: number) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
}

function clean(value: unknown) { return String(value ?? "").replace(/\s+/g, " ").trim(); }
function domain(value: string) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); } catch { return "invalid"; }
}
function multiplier(raw: string | null) {
  try { return Number(JSON.parse(raw || "{}")?.import?.sheetPriceMultiplier || 0); } catch { return 0; }
}
function isDefault(value: unknown) {
  return /^(?:default(?: title| 1)?|title)$/i.test(clean(value));
}

const client = await ShopifyService.getClientFromDb(prisma);
const defaultProducts: Array<Record<string, unknown>> = [];
const singleRealProducts: Array<Record<string, unknown>> = [];
const missingProducts: Array<Record<string, unknown>> = [];

for (const batch of chunks(candidates, batchSize)) {
  const data: any = await client.request(`
    query DefaultVariantAudit($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id title vendor status
          options { name values }
          variants(first: 2) {
            nodes { id title sku price inventoryQuantity selectedOptions { name value } }
            pageInfo { hasNextPage }
          }
        }
      }
    }
  `, { ids: batch.map((item) => item.shopifyId) });
  const liveById = new Map((data?.nodes || []).filter(Boolean).map((item: any) => [item.id, item]));
  for (const row of batch) {
    const live: any = liveById.get(row.shopifyId);
    if (!live || String(live.status).toUpperCase() !== "ACTIVE") {
      missingProducts.push({ sourceProductId: row.sourceProductId, shopifyId: row.shopifyId, title: row.title });
      continue;
    }
    const variants = live.variants?.nodes || [];
    const oneVariant = variants.length === 1 && live.variants?.pageInfo?.hasNextPage !== true;
    if (!oneVariant) continue;
    const variant = variants[0];
    const optionValues = (variant.selectedOptions || []).map((option: any) => option.value);
    const optionNames = (live.options || []).map((option: any) => option.name);
    const rowData = {
      sourceProductId: row.sourceProductId,
      shopifyId: row.shopifyId,
      title: clean(live.title),
      vendor: clean(live.vendor),
      url: row.url,
      domain: domain(row.url),
      multiplier: multiplier(row.raw),
      sku: clean(variant.sku),
      variantTitle: clean(variant.title),
      optionNames,
      optionValues,
      price: Number(variant.price || 0),
      inventoryQuantity: Number(variant.inventoryQuantity || 0),
    };
    if (isDefault(variant.title) || optionValues.some(isDefault) || optionNames.every(isDefault)) defaultProducts.push(rowData);
    else singleRealProducts.push(rowData);
  }
}

const byDomain = (rows: Array<Record<string, unknown>>) => Object.fromEntries(
  [...new Set(rows.map((row) => String(row.domain)))].sort().map((key) => [key, rows.filter((row) => row.domain === key).length]),
);
const report = {
  auditedAt: new Date().toISOString(),
  readOnly: true,
  databaseCandidatesWithAtMostOneStoredVariant: candidates.length,
  liveDefaultVariantProducts: defaultProducts.length,
  liveSingleRealVariantProducts: singleRealProducts.length,
  missingOrInactive: missingProducts.length,
  defaultByDomain: byDomain(defaultProducts),
  approvedMultiplierDefaults: defaultProducts.filter((row) => [22, 23, 24].includes(Number(row.multiplier))).length,
  sampleByDomain: Object.fromEntries(
    [...new Set(defaultProducts.map((row) => String(row.domain)))].sort()
      .map((key) => [key, defaultProducts.filter((row) => row.domain === key).slice(0, 3)]),
  ),
  sample: defaultProducts.slice(0, 30),
};
console.log(JSON.stringify(report));
await prisma.$disconnect();
