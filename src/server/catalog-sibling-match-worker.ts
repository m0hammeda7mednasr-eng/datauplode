import { prisma } from './db.js';
import { ShopifyService } from './services/shopify.js';

const CACHE_TABLE = 'ShopifyCatalogIndexV2';
const JOB_TYPE = 'CATALOG_SIBLING_MATCH:2026-09-04-v1';
const CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.CATALOG_SIBLING_MATCH_CONCURRENCY || 4)));
const LIMIT = Math.max(1, Number(process.env.CATALOG_SIBLING_MATCH_LIMIT || 10000));

const TRUSTED_ANCHOR_METHODS = new Set([
  'database',
  'source_url',
  'exact_sku',
  'dab_product_prefix',
  'source_product_identifier',
  'source_url_title',
  'source_code_in_sku',
  'exact_title_vendor',
  'db_exact_title_vendor',
  'db_base_title_vendor',
]);

type Row = {
  shopifyId: string;
  title: string;
  vendor: string | null;
  status: string | null;
  matchStatus: string;
  matchMethod: string | null;
  matchedSourceUrl: string | null;
  sheetSpreadsheetId: string | null;
  sheetSpreadsheetName: string | null;
  sheetName: string | null;
  sheetGid: number | null;
  sheetRowNumber: number | null;
  sheetSku: string | null;
  sheetMultiplier: number | null;
};

function enabled(name: string, fallback = false) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function clean(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function compact(value: unknown) {
  return clean(value).toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

function vendorKey(value: unknown) {
  const key = compact(value);
  if (!key) return '';
  if (['NXT', 'NEXT'].includes(key)) return 'NEXT';
  if (['HM', 'HANDM'].includes(key)) return 'HM';
  if (['MAX', 'MAXFASHION'].includes(key)) return 'MAX';
  if (['CENTREPOINT', 'CENTREPOINTSTORES'].includes(key)) return 'CENTREPOINT';
  if (['MNS', 'MS', 'MARKSANDSPENCER', 'MARKSSPENCER'].includes(key)) return 'MARKSANDSPENCER';
  if (key.startsWith('CARTER')) return 'CARTERS';
  return key;
}

function normalizeTitle(value: unknown) {
  return clean(value)
    .replace(/&amp;/gi, ' and ')
    .replace(/&/g, ' and ')
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function baseTitle(value: unknown) {
  let title = clean(value);
  title = title
    .replace(/\s*[-–—|]\s*size\s+.+$/i, '')
    .replace(/\s*\(\s*size\s*[:=-]?.+\)\s*$/i, '')
    .replace(/\s*[-–—|]\s*(?:size\s*)?(?:newborn|tiny baby|premature|preemie|\d+\s*(?:-|to)\s*\d+\s*(?:months?|mths?|years?|yrs?)).*$/i, '')
    .trim();
  return normalizeTitle(title);
}

function strongBaseTitle(value: unknown) {
  const normalized = baseTitle(value);
  const tokens = normalized.split(' ').filter(Boolean);
  return normalized.length >= 14 && tokens.length >= 3 ? normalized : '';
}

function key(vendor: string, base: string) {
  return `${vendor}|${base}`;
}

async function runWorker() {
  const activeJob = await prisma.syncJob.findFirst({
    where: { type: JOB_TYPE, status: 'running', createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } },
    orderBy: { createdAt: 'desc' },
  });
  if (activeJob) {
    console.log(`[sibling-match] existing worker ${activeJob.id} already running`);
    return;
  }

  const job = await prisma.syncJob.create({
    data: { type: JOB_TYPE, status: 'running', startedAt: new Date(), result: JSON.stringify({ stage: 'loading', linked: 0, failed: 0 }) },
  });

  let processed = 0;
  let linked = 0;
  let failed = 0;
  let skipped = 0;
  try {
    const rows = await prisma.$queryRawUnsafe<Row[]>(`
      SELECT "shopifyId", "title", "vendor", "status", "matchStatus", "matchMethod", "matchedSourceUrl",
             "sheetSpreadsheetId", "sheetSpreadsheetName", "sheetName", "sheetGid", "sheetRowNumber", "sheetSku", "sheetMultiplier"
      FROM "${CACHE_TABLE}"
      WHERE UPPER(COALESCE("status", ''))='ACTIVE'
    `);

    const anchorMap = new Map<string, Row[]>();
    const unresolved: Row[] = [];
    for (const row of rows) {
      if (['needs_link', 'needs_review'].includes(row.matchStatus)) {
        unresolved.push(row);
        continue;
      }
      if (!['linked', 'active'].includes(row.matchStatus)) continue;
      if (!row.matchedSourceUrl || !TRUSTED_ANCHOR_METHODS.has(String(row.matchMethod || ''))) continue;
      const vendor = vendorKey(row.vendor);
      const base = strongBaseTitle(row.title);
      if (!vendor || !base) continue;
      const k = key(vendor, base);
      anchorMap.set(k, [...(anchorMap.get(k) || []), row]);
    }

    const uniqueAnchors = new Map<string, Row>();
    for (const [k, anchors] of anchorMap) {
      const urls = [...new Set(anchors.map((row) => clean(row.matchedSourceUrl)).filter(Boolean))];
      if (urls.length !== 1) continue;
      const anchor = anchors.find((row) => clean(row.matchedSourceUrl) === urls[0]);
      if (anchor) uniqueAnchors.set(k, anchor);
    }

    const candidates: Array<{ unresolved: Row; anchor: Row }> = [];
    for (const row of unresolved.slice(0, LIMIT)) {
      const vendor = vendorKey(row.vendor);
      const base = strongBaseTitle(row.title);
      if (!vendor || !base) continue;
      const anchor = uniqueAnchors.get(key(vendor, base));
      if (!anchor || anchor.shopifyId === row.shopifyId) continue;
      candidates.push({ unresolved: row, anchor });
    }

    console.log(`[sibling-match] active=${rows.length} unresolved=${unresolved.length} uniqueAnchorKeys=${uniqueAnchors.size} candidates=${candidates.length}`);
    const client = await ShopifyService.getClientFromDb(prisma);

    for (let offset = 0; offset < candidates.length; offset += CONCURRENCY) {
      const batch = candidates.slice(offset, offset + CONCURRENCY);
      await Promise.all(batch.map(async ({ unresolved: row, anchor }) => {
        processed += 1;
        try {
          const live = await ShopifyService.getProductCatalogSnapshot(client, row.shopifyId);
          if (!live || String(live.status).toUpperCase() !== 'ACTIVE') throw new Error('Shopify product missing or inactive');
          if (vendorKey(live.vendor) !== vendorKey(anchor.vendor)) throw new Error('Live Shopify vendor differs from verified sibling');
          if (strongBaseTitle(live.title) !== strongBaseTitle(anchor.title)) throw new Error('Live Shopify base title differs from verified sibling');
          const sourceUrl = clean(anchor.matchedSourceUrl);
          if (!sourceUrl) throw new Error('Verified sibling source URL is missing');

          await prisma.$executeRawUnsafe(`
            UPDATE "${CACHE_TABLE}"
            SET "matchStatus"='linked',
                "matchMethod"='shared_source_sibling_title_vendor',
                "matchedSourceUrl"=$2,
                "sheetSpreadsheetId"=$3,
                "sheetSpreadsheetName"=$4,
                "sheetName"=$5,
                "sheetGid"=$6,
                "sheetRowNumber"=$7,
                "sheetSku"=COALESCE("sheetSku", $8),
                "sheetMultiplier"=COALESCE("sheetMultiplier", $9),
                "reason"='Verified Shopify sibling has the same vendor and base product title; shared source link recorded at catalog level; variants pending',
                "evidence"=$10,
                "updatedAt"=NOW()
            WHERE "shopifyId"=$1 AND "matchStatus" IN ('needs_link','needs_review')
          `,
            live.id,
            sourceUrl,
            anchor.sheetSpreadsheetId,
            anchor.sheetSpreadsheetName,
            anchor.sheetName,
            anchor.sheetGid,
            anchor.sheetRowNumber,
            anchor.sheetSku,
            anchor.sheetMultiplier,
            JSON.stringify(['verified_sibling_anchor', 'exact_base_title', 'exact_vendor', 'live_shopify_readback']),
          );
          linked += 1;
        } catch (error: any) {
          failed += 1;
          console.warn(`[sibling-match] ${row.shopifyId} skipped: ${clean(error?.message || error)}`);
        }
      }));

      if (processed % 25 < CONCURRENCY || offset + CONCURRENCY >= candidates.length) {
        await prisma.syncJob.update({
          where: { id: job.id },
          data: { result: JSON.stringify({ stage: 'linking', unresolved: unresolved.length, uniqueAnchorKeys: uniqueAnchors.size, candidates: candidates.length, processed, linked, failed, skipped, scraperApiCreditsUsed: 0 }) },
        });
        console.log(`[sibling-match] processed=${processed}/${candidates.length} linked=${linked} failed=${failed}`);
      }
    }

    await prisma.syncJob.update({
      where: { id: job.id },
      data: { status: 'completed', completedAt: new Date(), result: JSON.stringify({ stage: 'completed', unresolved: unresolved.length, uniqueAnchorKeys: uniqueAnchors.size, candidates: candidates.length, processed, linked, failed, skipped, scraperApiCreditsUsed: 0 }) },
    });
    console.log(`[sibling-match] completed linked=${linked} failed=${failed}`);
  } catch (error: any) {
    await prisma.syncJob.update({
      where: { id: job.id },
      data: { status: 'failed', completedAt: new Date(), result: JSON.stringify({ stage: 'failed', processed, linked, failed, skipped, error: clean(error?.message || error), scraperApiCreditsUsed: 0 }) },
    }).catch(() => undefined);
    console.error('[sibling-match] failed', error);
  }
}

if (enabled('CATALOG_SIBLING_MATCH_AUTOSTART', false)) {
  setTimeout(() => void runWorker(), 4000);
} else {
  console.log('[sibling-match] autostart disabled');
}
