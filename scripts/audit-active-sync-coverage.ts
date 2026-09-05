import "dotenv/config";
import { prisma } from "../src/server/db.js";

type CoverageRow = {
  bucket: string;
  count: number;
};

async function main() {
  const configuredRecoverySince = process.env.SYNC_FULL_CATALOG_VERIFIED_PENDING_FAILURE_SINCE;
  const recoverySince = configuredRecoverySince && !Number.isNaN(new Date(configuredRecoverySince).getTime())
    ? new Date(configuredRecoverySince)
    : new Date(0);
  const [rows, cacheStatuses, legacyNumericLinks, missingByMethod, inactiveByOrigin, verifiedPendingByVariantCount, verifiedPendingRecovery, verifiedPendingEligibility, verifiedPendingHosts] = await Promise.all([
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
    prisma.$queryRawUnsafe<CoverageRow[]>(`
      SELECT
        CASE
          WHEN sp."syncEnabled" = TRUE AND s."syncStatus" = 'active' THEN 'recovered_active'
          WHEN EXISTS (
            SELECT 1 FROM "AuditLog" failed
            WHERE failed."sourceProductId" = s."id"
              AND failed."action" = 'SYNC_PRODUCT_CATALOG_FAILED'
              AND failed."createdAt" >= $1
          ) THEN 'attempted_failed_safely'
          ELSE 'waiting_for_attempt'
        END AS bucket,
        COUNT(*)::int AS count
      FROM "ShopifyCatalogIndexV2" c
      JOIN "ShopifyProduct" sp ON sp."shopifyId" = c."shopifyId"
      JOIN "SourceProduct" s ON s."id" = sp."sourceProductId"
      WHERE UPPER(COALESCE(c."status", '')) = 'ACTIVE'
        AND EXISTS (
          SELECT 1 FROM "AuditLog" verified_link
          WHERE verified_link."sourceProductId" = s."id"
            AND verified_link."action" IN ('ASSISTED_PRODUCT_LEVEL_LINK', 'LINK_EXISTING_SHOPIFY_CATALOG_REFERENCE_CSV')
        )
        AND (
          sp."syncEnabled" = FALSE
          OR s."syncStatus" <> 'active'
          OR EXISTS (
            SELECT 1 FROM "AuditLog" recovered
            WHERE recovered."sourceProductId" = s."id"
              AND recovered."action" = 'SYNC_PRODUCT_CATALOG_SET'
              AND recovered."createdAt" >= $1
          )
        )
      GROUP BY 1
      ORDER BY count DESC, bucket
    `, recoverySince),
    prisma.$queryRawUnsafe<CoverageRow[]>(`
      SELECT
        CASE
          WHEN LOWER(s."url") NOT LIKE '%next.ae%'
            AND LOWER(s."url") NOT LIKE '%maxfashion.com%'
            AND LOWER(s."url") NOT LIKE '%centrepointstores.com%'
            THEN 'unsupported_domain'
          WHEN s."raw" NOT LIKE '%sheetPriceMultiplier%' THEN 'missing_sheet_multiplier'
          WHEN EXISTS (
            SELECT 1 FROM "AuditLog" failed
            WHERE failed."sourceProductId" = s."id"
              AND failed."action" = 'SYNC_PRODUCT_CATALOG_FAILED'
              AND failed."createdAt" >= $1
          ) THEN 'attempted_after_recovery'
          ELSE 'eligible_now'
        END AS bucket,
        COUNT(*)::int AS count
      FROM "ShopifyCatalogIndexV2" c
      JOIN "ShopifyProduct" sp ON sp."shopifyId" = c."shopifyId"
      JOIN "SourceProduct" s ON s."id" = sp."sourceProductId"
      WHERE UPPER(COALESCE(c."status", '')) = 'ACTIVE'
        AND (sp."syncEnabled" = FALSE OR s."syncStatus" <> 'active')
        AND EXISTS (
          SELECT 1 FROM "AuditLog" verified_link
          WHERE verified_link."sourceProductId" = s."id"
            AND verified_link."action" IN ('ASSISTED_PRODUCT_LEVEL_LINK', 'LINK_EXISTING_SHOPIFY_CATALOG_REFERENCE_CSV')
        )
      GROUP BY 1
      ORDER BY count DESC, bucket
    `, recoverySince),
    prisma.$queryRawUnsafe<CoverageRow[]>(`
      SELECT
        SPLIT_PART(REGEXP_REPLACE(LOWER(s."url"), '^https?://', ''), '/', 1) AS bucket,
        COUNT(*)::int AS count
      FROM "ShopifyCatalogIndexV2" c
      JOIN "ShopifyProduct" sp ON sp."shopifyId" = c."shopifyId"
      JOIN "SourceProduct" s ON s."id" = sp."sourceProductId"
      WHERE UPPER(COALESCE(c."status", '')) = 'ACTIVE'
        AND (sp."syncEnabled" = FALSE OR s."syncStatus" <> 'active')
        AND EXISTS (
          SELECT 1 FROM "AuditLog" verified_link
          WHERE verified_link."sourceProductId" = s."id"
            AND verified_link."action" IN ('ASSISTED_PRODUCT_LEVEL_LINK', 'LINK_EXISTING_SHOPIFY_CATALOG_REFERENCE_CSV')
        )
      GROUP BY 1
      ORDER BY count DESC, bucket
    `),
  ]);

  const total = rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), recoverySince, total, coverage: rows, cacheStatuses, legacyNumericLinks, missingByMethod, inactiveByOrigin, verifiedPendingByVariantCount, verifiedPendingRecovery, verifiedPendingEligibility, verifiedPendingHosts }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
