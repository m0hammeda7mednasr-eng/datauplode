import { prisma } from './db.js';

const CACHE_TABLE = 'ShopifyCatalogIndexV2';

async function installVerifiedOverrideGuard() {
  try {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "${CACHE_TABLE}"
      ADD COLUMN IF NOT EXISTS "verifiedOverride" BOOLEAN NOT NULL DEFAULT FALSE
    `);

    await prisma.$executeRawUnsafe(`
      UPDATE "${CACHE_TABLE}"
      SET "verifiedOverride" = TRUE
      WHERE "matchStatus" = 'linked'
        AND "matchMethod" IN (
          'shared_source_sibling_title_vendor',
          'unique_source_url_title_vendor'
        )
    `);

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION preserve_shopify_catalog_verified_override()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."matchStatus" = 'linked'
           AND NEW."matchMethod" IN (
             'shared_source_sibling_title_vendor',
             'unique_source_url_title_vendor'
           ) THEN
          NEW."verifiedOverride" := TRUE;
        END IF;

        IF OLD."verifiedOverride" = TRUE
           AND NEW."matchStatus" IN ('needs_link', 'needs_review', 'matched') THEN
          NEW."matchStatus" := OLD."matchStatus";
          NEW."matchMethod" := OLD."matchMethod";
          NEW."matchedSourceUrl" := OLD."matchedSourceUrl";
          NEW."sheetSpreadsheetId" := OLD."sheetSpreadsheetId";
          NEW."sheetSpreadsheetName" := OLD."sheetSpreadsheetName";
          NEW."sheetName" := OLD."sheetName";
          NEW."sheetGid" := OLD."sheetGid";
          NEW."sheetRowNumber" := OLD."sheetRowNumber";
          NEW."sheetSku" := OLD."sheetSku";
          NEW."sheetMultiplier" := OLD."sheetMultiplier";
          NEW."reason" := OLD."reason";
          NEW."evidence" := OLD."evidence";
          NEW."verifiedOverride" := TRUE;
        END IF;

        IF NEW."matchStatus" IN ('active', 'linked')
           AND NEW."matchMethod" = 'database' THEN
          NEW."verifiedOverride" := FALSE;
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await prisma.$executeRawUnsafe(`
      DROP TRIGGER IF EXISTS "ShopifyCatalogIndexV2_verified_override_guard"
      ON "${CACHE_TABLE}"
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "ShopifyCatalogIndexV2_verified_override_guard"
      BEFORE UPDATE ON "${CACHE_TABLE}"
      FOR EACH ROW
      EXECUTE FUNCTION preserve_shopify_catalog_verified_override()
    `);

    console.log('[catalog-guard] verified catalog override guard active');
  } catch (error) {
    console.error('[catalog-guard] failed to install verified override guard', error);
  }
}

setTimeout(() => void installVerifiedOverrideGuard(), 1000);
