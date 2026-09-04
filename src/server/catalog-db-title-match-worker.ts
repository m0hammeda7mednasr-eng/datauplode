import { prisma } from './db.js';
import { ShopifyService } from './services/shopify.js';

const CACHE_TABLE = 'ShopifyCatalogIndexV2';
const JOB_TYPE = 'CATALOG_DB_TITLE_MATCH:2026-09-04-v1';
const CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.CATALOG_DB_TITLE_MATCH_CONCURRENCY || 4)));
const LIMIT = Math.max(1, Number(process.env.CATALOG_DB_TITLE_MATCH_LIMIT || 10000));

type CacheRow = {
  shopifyId: string;
  title: string;
  handle: string | null;
  vendor: string | null;
  price: number | null;
  matchStatus: string;
};

type SourceRow = {
  id: string;
  url: string;
  title: string;
  brand: string | null;
  productId: string | null;
  price: number;
  raw: string | null;
  supplier: { name: string };
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

function vendorFromUrl(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes('next.')) return 'NEXT';
    if (host.includes('hm.com')) return 'HM';
    if (host.includes('maxfashion')) return 'MAX';
    if (host.includes('centrepoint')) return 'CENTREPOINT';
    if (host.includes('shein')) return 'SHEIN';
    if (host.includes('lefties')) return 'LEFTIES';
    if (host.includes('marksandspencer')) return 'MARKSANDSPENCER';
    if (host.includes('carters')) return 'CARTERS';
    if (host.includes('zara')) return 'ZARA';
    if (host.includes('adidas')) return 'ADIDAS';
    if (host.includes('mothercare')) return 'MOTHERCARE';
    if (host.includes('gap.')) return 'GAP';
    return '';
  } catch {
    return '';
  }
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

function validSourceTitle(value: unknown) {
  const title = clean(value);
  if (!title) return false;
  if (/^(?:excel import issue|blocked source product|unknown product|product\s+\d+|\[?needs source lookup\]?)/i.test(title)) return false;
  const normalized = baseTitle(title);
  const tokens = normalized.split(' ').filter(Boolean);
  return normalized.length >= 12 && tokens.length >= 3;
}

function sourceVendor(source: SourceRow) {
  return vendorKey(source.brand) || vendorKey(source.supplier?.name) || vendorFromUrl(source.url);
}

function key(vendor: string, title: string) {
  return `${vendor}|${title}`;
}

async function runWorker() {
  const existing = await prisma.syncJob.findFirst({
    where: { type: JOB_TYPE, status: 'running', createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) {
    console.log(`[db-title-match] worker ${existing.id} already running`);
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
    const [cacheRows, sources] = await Promise.all([
      prisma.$queryRawUnsafe<CacheRow[]>(`
        SELECT "shopifyId", "title", "handle", "vendor", "price", "matchStatus"
        FROM "${CACHE_TABLE}"
        WHERE UPPER(COALESCE("status", ''))='ACTIVE'
          AND "matchStatus" IN ('needs_link','needs_review')
        ORDER BY "shopifyId" ASC
        LIMIT ${LIMIT}
      `),
      prisma.sourceProduct.findMany({
        where: { shopifyProduct: null },
        select: {
          id: true, url: true, title: true, brand: true, productId: true, price: true, raw: true,
          supplier: { select: { name: true } },
        },
      }) as Promise<SourceRow[]>,
    ]);

    const byBaseTitleVendor = new Map<string, SourceRow[]>();
    const byExactTitleVendor = new Map<string, SourceRow[]>();
    for (const source of sources) {
      if (!validSourceTitle(source.title)) continue;
      const vendor = sourceVendor(source);
      if (!vendor) continue;
      const base = baseTitle(source.title);
      const exact = normalizeTitle(source.title);
      if (base) byBaseTitleVendor.set(key(vendor, base), [...(byBaseTitleVendor.get(key(vendor, base)) || []), source]);
      if (exact) byExactTitleVendor.set(key(vendor, exact), [...(byExactTitleVendor.get(key(vendor, exact)) || []), source]);
    }

    const candidates: Array<{ cache: CacheRow; source: SourceRow; method: 'db_exact_title_vendor' | 'db_base_title_vendor' }> = [];
    for (const cache of cacheRows) {
      const vendor = vendorKey(cache.vendor);
      if (!vendor) continue;
      const exactMatches = byExactTitleVendor.get(key(vendor, normalizeTitle(cache.title))) || [];
      const exactUrls = [...new Set(exactMatches.map((item) => item.url))];
      if (exactUrls.length === 1) {
        candidates.push({ cache, source: exactMatches[0], method: 'db_exact_title_vendor' });
        continue;
      }
      const base = baseTitle(cache.title);
      if (base.split(' ').length < 3) continue;
      const baseMatches = byBaseTitleVendor.get(key(vendor, base)) || [];
      const baseUrls = [...new Set(baseMatches.map((item) => item.url))];
      if (baseUrls.length === 1) {
        candidates.push({ cache, source: baseMatches[0], method: 'db_base_title_vendor' });
      }
    }

    console.log(`[db-title-match] unresolved=${cacheRows.length} unownedSources=${sources.length} candidates=${candidates.length}`);
    const client = await ShopifyService.getClientFromDb(prisma);

    for (let offset = 0; offset < candidates.length; offset += CONCURRENCY) {
      const batch = candidates.slice(offset, offset + CONCURRENCY);
      await Promise.all(batch.map(async ({ cache, source, method }) => {
        processed += 1;
        try {
          const live = await ShopifyService.getProductCatalogSnapshot(client, cache.shopifyId);
          if (!live || String(live.status).toUpperCase() !== 'ACTIVE') throw new Error('Shopify product missing or inactive');

          const expectedVendor = sourceVendor(source);
          const liveVendor = vendorKey(live.vendor);
          if (!expectedVendor || !liveVendor || expectedVendor !== liveVendor) throw new Error('Live vendor mismatch');
          if (method === 'db_exact_title_vendor' && normalizeTitle(live.title) !== normalizeTitle(source.title)) throw new Error('Live exact title mismatch');
          if (method === 'db_base_title_vendor' && baseTitle(live.title) !== baseTitle(source.title)) throw new Error('Live base title mismatch');

          await prisma.$transaction(async (tx) => {
            const currentShopify = await tx.shopifyProduct.findUnique({ where: { shopifyId: live.id } });
            if (currentShopify) return;
            const currentSource = await tx.sourceProduct.findUnique({ where: { id: source.id }, include: { shopifyProduct: true } });
            if (!currentSource) throw new Error('Source product disappeared');
            if (currentSource.shopifyProduct) throw new Error('Source product was linked concurrently');

            const shopifyPrice = Number(live.variants?.[0]?.price || cache.price || 0);
            await tx.sourceProduct.update({
              where: { id: source.id },
              data: { syncStatus: 'paused' },
            });
            await tx.shopifyProduct.create({
              data: {
                sourceProductId: source.id,
                shopifyId: live.id,
                handle: clean(live.handle) || cache.handle,
                status: String(live.status || 'active').toLowerCase(),
                price: shopifyPrice || null,
                syncEnabled: false,
                syncPrice: false,
                syncInventory: false,
                syncImages: false,
              },
            });
            await tx.manualReviewItem.deleteMany({ where: { sourceProductId: source.id, status: 'pending' } });
            await tx.auditLog.create({
              data: {
                sourceProductId: source.id,
                action: 'DB_TITLE_PRODUCT_LEVEL_LINK',
                details: JSON.stringify({ shopifyProductId: live.id, sourceUrl: source.url, matchMethod: method, variantsPending: true, liveReadbackVerified: true }),
              },
            });
            await tx.$executeRawUnsafe(`
              UPDATE "${CACHE_TABLE}"
              SET "matchStatus"='linked', "matchMethod"=$2, "matchedSourceUrl"=$3,
                  "reason"='Existing source title + vendor verified against live Shopify; variants pending',
                  "evidence"=$4, "updatedAt"=NOW()
              WHERE "shopifyId"=$1
            `, live.id, method, source.url, JSON.stringify([method, 'live_shopify_readback']));
          }, { maxWait: 15000, timeout: 45000 });
          linked += 1;
        } catch (error: any) {
          failed += 1;
          console.warn(`[db-title-match] ${cache.shopifyId} ${method} skipped: ${clean(error?.message || error)}`);
        }
      }));

      if (processed % 20 < CONCURRENCY || offset + CONCURRENCY >= candidates.length) {
        await prisma.syncJob.update({
          where: { id: job.id },
          data: { result: JSON.stringify({ stage: 'linking', unresolved: cacheRows.length, unownedSources: sources.length, candidates: candidates.length, processed, linked, failed, skipped, scraperApiCreditsUsed: 0 }) },
        });
        console.log(`[db-title-match] processed=${processed}/${candidates.length} linked=${linked} failed=${failed}`);
      }
    }

    await prisma.syncJob.update({
      where: { id: job.id },
      data: { status: 'completed', completedAt: new Date(), result: JSON.stringify({ stage: 'completed', unresolved: cacheRows.length, unownedSources: sources.length, candidates: candidates.length, processed, linked, failed, skipped, scraperApiCreditsUsed: 0 }) },
    });
    console.log(`[db-title-match] completed linked=${linked} failed=${failed}`);
  } catch (error: any) {
    await prisma.syncJob.update({ where: { id: job.id }, data: { status: 'failed', completedAt: new Date(), result: JSON.stringify({ stage: 'failed', processed, linked, failed, skipped, error: clean(error?.message || error), scraperApiCreditsUsed: 0 }) } }).catch(() => undefined);
    console.error('[db-title-match] failed', error);
  }
}

if (enabled('CATALOG_DB_TITLE_MATCH_AUTOSTART', false)) {
  setTimeout(() => void runWorker(), 3500);
} else {
  console.log('[db-title-match] autostart disabled');
}
