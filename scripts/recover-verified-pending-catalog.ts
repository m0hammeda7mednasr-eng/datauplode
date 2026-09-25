import "dotenv/config";
import { prisma } from "../src/server/db.js";
import { ShopifyService } from "../src/server/services/shopify.js";
import { syncFullProductCatalog } from "../src/server/services/fullCatalogSync.js";

const limit = Math.max(1, Math.min(66, Number(process.argv.find((v) => v.startsWith("--limit="))?.split("=")[1] || 10)));
const failureCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

async function main() {
  const candidates = await prisma.$queryRawUnsafe<Array<{ id: string; title: string; url: string }>>(`
    SELECT s."id", s."title", s."url"
    FROM "ShopifyCatalogIndexV2" c
    JOIN "ShopifyProduct" sp ON sp."shopifyId" = c."shopifyId"
    JOIN "SourceProduct" s ON s."id" = sp."sourceProductId"
    WHERE UPPER(COALESCE(c."status", '')) = 'ACTIVE'
      AND (sp."syncEnabled" = FALSE OR s."syncStatus" <> 'active')
      AND EXISTS (
        SELECT 1 FROM "AuditLog" a
        WHERE a."sourceProductId" = s."id"
          AND a."action" IN ('ASSISTED_PRODUCT_LEVEL_LINK', 'LINK_EXISTING_SHOPIFY_CATALOG_REFERENCE_CSV')
      )
      AND NOT EXISTS (
        SELECT 1 FROM "AuditLog" failed
        WHERE failed."sourceProductId" = s."id"
          AND failed."action" = 'SYNC_PRODUCT_CATALOG_FAILED'
          AND failed."createdAt" >= $1
      )
      AND (LOWER(s."url") LIKE '%next.ae%' OR LOWER(s."url") LIKE '%lefties.com%')
    ORDER BY s."lastScrapedAt" ASC
    LIMIT ${limit}
  `, failureCutoff);

  const client = await ShopifyService.getClientFromDb(prisma);
  const location = await ShopifyService.getInventoryLocation(client);
  const results: any[] = [];
  for (const [index, candidate] of candidates.entries()) {
    try {
      const result = await syncFullProductCatalog({ prisma, sourceProductId: candidate.id, client, location });
      results.push({ id: candidate.id, title: candidate.title, ok: true, result });
    } catch (error: any) {
      const message = String(error?.message || error).slice(0, 2000);
      await prisma.auditLog.create({
        data: {
          sourceProductId: candidate.id,
          action: "SYNC_PRODUCT_CATALOG_FAILED",
          details: JSON.stringify({ message, runner: "recover-verified-pending-catalog" }),
        },
      });
      results.push({ id: candidate.id, title: candidate.title, ok: false, error: message });
    }
    console.log(JSON.stringify({ progress: index + 1, total: candidates.length, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length }));
  }
  console.log(JSON.stringify({ selected: candidates.length, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, failures: results.filter((r) => !r.ok).slice(0, 10) }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
