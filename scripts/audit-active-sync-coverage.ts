import "dotenv/config";
import { prisma } from "../src/server/db.js";

type CoverageRow = {
  bucket: string;
  count: number;
};

async function main() {
  const [rows, cacheStatuses, legacyNumericLinks, missingByMethod, inactiveByOrigin, verifiedPendingByVariantCount] = await Promise.all([
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
    prisma.$queryRawUnsafe<Array<{ count: number; samples: string[] }>>(`
      SELECT
        COUNT(*)::int AS count,
        COALESCE((ARRAY_AGG(c."shopifyId" ORDER BY c."shopifyId"))[1:5], ARRAY[]::text[]) AS samples
      FROM "ShopifyCatalogIndexV2" c
      JOIN "ShopifyProduct" legacy
        ON legacy."shopifyId" = REGEXP_REPLACE(c."shopifyId", '^.*/', '')
      LEFT JOIN "ShopifyProduct" exact ON exact."shopifyId" = c."shopifyId"
      WHERE UPPER(COALESCE(c."status", '')) = 'ACTIVE'
        AND exact."id" IS NULL
    `),
    prisma.$queryRawUnsafe<CoverageRow[]>(`
      SELECT COALESCE(c."matchMethod", 'none') AS bucket, COUNT(*)::int AS count
      FROM "ShopifyCatalogIndexV2" c
      LEFT JOIN "ShopifyProduct" sp ON sp."shopifyId" = c."shopifyId"
      WHERE UPPER(COALESCE(c."status", '')) = 'ACTIVE'
        AND sp."id" IS NULL
      GROUP BY COALESCE(c."matchMethod", 'none')
      ORDER BY count DESC, bucket
    `),
    prisma.$queryRawUnsafe<CoverageRow[]>(`
      SELECT
        CASE
          WHEN EXISTS (
            SELECT 1 FROM "AuditLog" a
            WHERE a."sourceProductId" = s."id"
              AND a."action" IN ('ASSISTED_PRODUCT_LEVEL_LINK', 'LINK_EXISTING_SHOPIFY_CATALOG_REFERENCE_CSV')
          ) THEN 'verified_link_pending_catalog'
          ELSE 'other_paused_or_disabled'
        END AS bucket,
        COUNT(*)::int AS count
      FROM "ShopifyCatalogIndexV2" c
      JOIN "ShopifyProduct" sp ON sp."shopifyId" = c."shopifyId"
      JOIN "SourceProduct" s ON s."id" = sp."sourceProductId"
      WHERE UPPER(COALESCE(c."status", '')) = 'ACTIVE'
        AND (sp."syncEnabled" = FALSE OR s."syncStatus" <> 'active')
      GROUP BY 1
      ORDER BY count DESC, bucket
    `),
    prisma.$queryRawUnsafe<CoverageRow[]>(`
      SELECT
        CASE
          WHEN variant_counts.count = 0 THEN '0_variants'
          WHEN variant_counts.count = 1 THEN '1_variant'
          ELSE 'multiple_variants'
        END AS bucket,
        COUNT(*)::int AS count
      FROM "ShopifyCatalogIndexV2" c
      JOIN "ShopifyProduct" sp ON sp."shopifyId" = c."shopifyId"
      JOIN "SourceProduct" s ON s."id" = sp."sourceProductId"
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS count
        FROM "SourceVariant" sv
        WHERE sv."sourceProductId" = s."id"
      ) variant_counts ON TRUE
      WHERE UPPER(COALESCE(c."status", '')) = 'ACTIVE'
        AND (sp."syncEnabled" = FALSE OR s."syncStatus" <> 'active')
        AND EXISTS (
          SELECT 1 FROM "AuditLog" a
          WHERE a."sourceProductId" = s."id"
            AND a."action" IN ('ASSISTED_PRODUCT_LEVEL_LINK', 'LINK_EXISTING_SHOPIFY_CATALOG_REFERENCE_CSV')
        )
      GROUP BY 1
      ORDER BY count DESC, bucket
    `),
  ]);

  const total = rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), total, coverage: rows, cacheStatuses, legacyNumericLinks, missingByMethod, inactiveByOrigin, verifiedPendingByVariantCount }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
