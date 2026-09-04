import { prisma } from "../src/server/db.js";
import { syncFullProductCatalog } from "../src/server/services/fullCatalogSync.js";
import { ShopifyService } from "../src/server/services/shopify.js";

const confirmation = "SYNC_DEFAULT_VARIANT_CATALOG_BATCH";
if (process.env.CONFIRM_DEFAULT_VARIANT_BATCH !== confirmation) {
  throw new Error(`CONFIRM_DEFAULT_VARIANT_BATCH=${confirmation} is required`);
}
const limit = Math.max(1, Math.min(5, Number(process.env.DEFAULT_VARIANT_BATCH_LIMIT || 5)));
const domain = String(process.env.DEFAULT_VARIANT_BATCH_DOMAIN || "next.ae").toLowerCase().replace(/[^a-z0-9.-]/g, "");
if (!domain) throw new Error("A valid DEFAULT_VARIANT_BATCH_DOMAIN is required");

type Candidate = { id: string; title: string; url: string };
const candidates = await prisma.$queryRawUnsafe<Candidate[]>(`
  SELECT s."id", s."title", s."url"
  FROM "SourceProduct" s
  JOIN "ShopifyProduct" sp ON sp."sourceProductId"=s."id"
  LEFT JOIN "SourceVariant" sv ON sv."sourceProductId"=s."id"
  WHERE LOWER(s."url") LIKE '%${domain}%'
    AND sp."status"='active' AND sp."syncEnabled"=TRUE
    AND s."raw" LIKE '%sheetPriceMultiplier%'
    AND NOT EXISTS (
      SELECT 1 FROM "AuditLog" a WHERE a."sourceProductId"=s."id"
        AND a."action"='SYNC_PRODUCT_CATALOG_SET' AND a."createdAt">NOW()-INTERVAL '30 days'
    )
    AND NOT EXISTS (
      SELECT 1 FROM "AuditLog" a WHERE a."sourceProductId"=s."id"
        AND a."action"='SYNC_PRODUCT_CATALOG_SKIPPED_SINGLE_VARIANT' AND a."createdAt">NOW()-INTERVAL '30 days'
    )
    AND NOT EXISTS (
      SELECT 1 FROM "AuditLog" a WHERE a."sourceProductId"=s."id"
        AND a."action"='SYNC_PRODUCT_CATALOG_FAILED' AND a."createdAt">NOW()-INTERVAL '60 minutes'
    )
  GROUP BY s."id", s."title", s."url", s."updatedAt"
  HAVING COUNT(sv."id") <= 1
    AND COALESCE(MAX(LOWER(TRIM(sv."size"))), '') IN ('', 'default title', 'default 1', 'title')
  ORDER BY s."updatedAt" ASC
  LIMIT ${limit}
`);

const client = await ShopifyService.getClientFromDb(prisma);
const location = await ShopifyService.getInventoryLocation(client);
const results: Array<Record<string, unknown>> = [];
for (const candidate of candidates) {
  try {
    const result = await syncFullProductCatalog({
      prisma,
      sourceProductId: candidate.id,
      client,
      location,
      requireVariantExpansion: true,
    });
    results.push(result);
    if (result.skipped === true) {
      await prisma.auditLog.create({
        data: {
          sourceProductId: candidate.id,
          action: "SYNC_PRODUCT_CATALOG_SKIPPED_SINGLE_VARIANT",
          details: JSON.stringify({ reason: result.reason, sourceVariants: result.sourceVariants, shopifyVariants: result.shopifyVariants }),
        },
      });
    }
    console.log(JSON.stringify({ title: candidate.title, ...result }));
  } catch (error: any) {
    const message = String(error?.message || error).slice(0, 2000);
    await prisma.auditLog.create({
      data: {
        sourceProductId: candidate.id,
        action: "SYNC_PRODUCT_CATALOG_FAILED",
        details: JSON.stringify({ message, defaultVariantBatch: true, shopifyWriteMayHaveStarted: message.includes("could not be verified") }),
      },
    });
    results.push({ success: false, sourceProductId: candidate.id, title: candidate.title, error: message });
    console.error(JSON.stringify(results.at(-1)));
    if (message.includes("Catalog write could not be verified")) break;
  }
}

console.log(JSON.stringify({
  selected: candidates.length,
  completed: results.filter((row) => row.success === true && row.skipped !== true).length,
  skipped: results.filter((row) => row.skipped === true).length,
  failed: results.filter((row) => row.success === false).length,
  readbackVerified: results.filter((row) => row.readbackVerified === true).length,
  results,
}));
await prisma.$disconnect();
