import "dotenv/config";
import { prisma } from "../src/server/db.js";

type CoverageRow = {
  bucket: string;
  count: number;
};

async function main() {
  const [rows, cacheStatuses] = await Promise.all([
    prisma.$queryRawUnsafe<CoverageRow[]>(`
    SELECT
      CASE
        WHEN sp."id" IS NULL THEN 'missing_db_link'
        WHEN sp."syncEnabled" = FALSE THEN 'sync_disabled'
        WHEN s."syncStatus" <> 'active' THEN 'source_not_active'
        ELSE 'active_sync'
      END AS bucket,
      COUNT(*)::int AS count
    FROM "ShopifyCatalogIndexV2" c
    LEFT JOIN "ShopifyProduct" sp ON sp."shopifyId" = c."shopifyId"
    LEFT JOIN "SourceProduct" s ON s."id" = sp."sourceProductId"
    WHERE UPPER(COALESCE(c."status", '')) = 'ACTIVE'
    GROUP BY 1
    ORDER BY 1
    `),
    prisma.$queryRawUnsafe<CoverageRow[]>(`
      SELECT "matchStatus" AS bucket, COUNT(*)::int AS count
      FROM "ShopifyCatalogIndexV2"
      WHERE UPPER(COALESCE("status", '')) = 'ACTIVE'
      GROUP BY "matchStatus"
      ORDER BY "matchStatus"
    `),
  ]);

  const total = rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), total, coverage: rows, cacheStatuses }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
