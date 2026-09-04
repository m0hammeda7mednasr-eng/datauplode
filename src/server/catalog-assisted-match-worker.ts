import { prisma } from './db.js';
import { ShopifyService } from './services/shopify.js';
import { dabBrandCode, dabProductCode } from './services/dabSku.js';
import { loadGoogleSheetRows, type GoogleSheetRow } from './api.js';

const CACHE_TABLE = 'ShopifyCatalogIndexV2';
const JOB_TYPE = 'CATALOG_ASSISTED_MATCH:2026-09-04-v1';
const BIG_SPREADSHEET_ID = '1fCbPajWL3nukX0TdoN1m2X8LV3pfPsxSMLBb0yWug2w';
const LEGACY_SPREADSHEET_ID = '13JSw5k_wX8RAd98P-TWLT-938ImshAtrukjjA4n-lkI';
const CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.CATALOG_ASSISTED_MATCH_CONCURRENCY || 4)));
const LIMIT = Math.max(1, Number(process.env.CATALOG_ASSISTED_MATCH_LIMIT || 10000));

const SHEETS = [
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: 'dap_data', sheetName: 'الورقة1', gid: 0, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: 'dap_data', sheetName: 'الورقة2', gid: 531292068, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: 'dap_data', sheetName: 'الورقة15', gid: 242585683, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: 'dap_data', sheetName: 'الورقة10', gid: 1991302797, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: 'dap_data', sheetName: 'الورقة6', gid: 1951926772, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: 'dap_data', sheetName: 'الورقة7', gid: 93159589, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: 'dap_data', sheetName: 'الورقة8', gid: 916372394, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: 'dap_data', sheetName: 'الورقة20', gid: 202697256, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: 'dap_data', sheetName: 'الورقة9', gid: 1264806944, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: 'dap_data', sheetName: 'الورقة11', gid: 106757984, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: 'dap_data', sheetName: 'الورقة12', gid: 1841878091, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: 'dap_data', sheetName: 'الورقة13', gid: 1219566712, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: 'dap_data', sheetName: 'الورقة16', gid: 1526682180, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: 'dap_data', sheetName: 'الورقة18', gid: 1122116162, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: 'dap_data', sheetName: 'الورقة19', gid: 16172014, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: 'dap_data', sheetName: 'الورقة21', gid: 1993452910, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: 'dap_data', sheetName: 'الورقة22', gid: 282692873, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: 'dap_data', sheetName: 'الورقة23', gid: 770232216, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: 'dap_data', sheetName: 'الورقة24', gid: 1210585516, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: 'dap_data', sheetName: 'الورقة25', gid: 307824540, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: 'dap_data', sheetName: 'الورقة26', gid: 1459453928, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: 'dap_data', sheetName: 'الورقة27', gid: 4356284, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: 'dap_data', sheetName: 'الورقة28', gid: 422632561, priority: 0 },
  { spreadsheetId: LEGACY_SPREADSHEET_ID, spreadsheetName: 'legacy_4_sheet', sheetName: 'الورقة1', gid: 0, priority: 1 },
  { spreadsheetId: LEGACY_SPREADSHEET_ID, spreadsheetName: 'legacy_4_sheet', sheetName: 'الورقة2', gid: 1503940200, priority: 1 },
  { spreadsheetId: LEGACY_SPREADSHEET_ID, spreadsheetName: 'legacy_4_sheet', sheetName: 'الورقة3', gid: 635942262, priority: 1 },
  { spreadsheetId: LEGACY_SPREADSHEET_ID, spreadsheetName: 'legacy_4_sheet', sheetName: 'الورقة4', gid: 1210175544, priority: 1 },
] as const;

type SheetRow = GoogleSheetRow & {
  spreadsheetId: string;
  spreadsheetName: string;
  sheetName: string;
  gid: number;
  sheetUrl: string;
  priority: number;
  canonicalUrl: string;
  vendorKey: string;
  titleKey: string;
  sourceCode: string;
  dabPrefix: string;
};

type CacheRow = {
  shopifyId: string;
  title: string;
  handle: string | null;
  vendor: string | null;
  primarySku: string | null;
  price: number | null;
  explicitSourceUrls: string | null;
  matchStatus: string;
};

type Candidate = { row: SheetRow; method: string };

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

function canonicalUrl(value: unknown) {
  try {
    const parsed = new URL(clean(value).replace(/[),.;]+$/, ''));
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^m\./, 'www.');
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|gclid|fbclid|ref|source)/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return clean(value).replace(/\/$/, '').toLowerCase();
  }
}

function normalizeTitle(value: unknown) {
  return clean(value)
    .replace(/&amp;/gi, ' and ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function vendorKeyFromUrl(url: string) {
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
    return compact(host.replace(/^www\./, '').split('.')[0]);
  } catch {
    return '';
  }
}

function vendorKey(value: unknown) {
  const key = compact(value);
  if (!key) return '';
  if (key === 'NXT') return 'NEXT';
  if (['HM', 'HANDM'].includes(key)) return 'HM';
  if (['MAX', 'MAXFASHION'].includes(key)) return 'MAX';
  if (['CENTREPOINT', 'CENTREPOINTSTORES'].includes(key)) return 'CENTREPOINT';
  if (['MNS', 'MS', 'MARKSANDSPENCER', 'MARKSSPENCER'].includes(key)) return 'MARKSANDSPENCER';
  if (key.startsWith('CARTER')) return 'CARTERS';
  return key;
}

function slugWords(value: string) {
  return normalizeTitle(
    decodeURIComponent(value)
      .replace(/\.html?$/i, '')
      .replace(/^buy-/i, '')
      .replace(/-p-?\d+$/i, '')
      .replace(/-p\d+$/i, '')
      .replace(/c\d+p\d+$/i, '')
      .replace(/-[a-z]\d{5,9}$/i, ''),
  );
}

function titleFromUrl(url: string) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const pIndex = parts.findIndex((part) => part.toLowerCase() === 'p');
    if (pIndex > 0) return slugWords(parts[pIndex - 1]);

    const last = parts.at(-1) || '';
    if (/^-?\d+$/.test(last)) return '';
    if (/^[a-z0-9]{5,18}\.html$/i.test(last) && parts.length > 1) return slugWords(parts.at(-2) || '');

    if (/shein|lefties|zara|carters|hm\.com|mothercare/i.test(parsed.hostname)) return slugWords(last);
    if (/adidas/i.test(parsed.hostname) && parts.length > 1) return slugWords(parts.at(-2) || '');
    if (/maxfashion|centrepoint/i.test(parsed.hostname)) return slugWords(pIndex > 0 ? parts[pIndex - 1] : last);
    return '';
  } catch {
    return '';
  }
}

function sourceCodeFromUrl(url: string) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const candidates = [
      path.match(/\/style\/[^/]+\/([^/?#]+)/i)?.[1],
      path.match(/-p-(\d+)\.html/i)?.[1],
      path.match(/\/p\/([^/?#]+)/i)?.[1],
      path.match(/-p(\d+)\.html/i)?.[1],
      path.match(/p(\d+)\.html/i)?.[1],
      path.match(/\/([A-Z0-9]{5,14})\.html$/i)?.[1],
      path.match(/-([A-Z0-9]{6,12})\/?$/i)?.[1],
    ];
    for (const value of candidates) {
      const code = compact(value);
      if (code.length >= 5 && code.length <= 64) return code;
    }
    return '';
  } catch {
    return '';
  }
}

function parseExplicitUrls(raw: string | null) {
  if (!raw) return [] as string[];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(canonicalUrl).filter(Boolean);
  } catch {}
  return (raw.match(/https?:\/\/[^\s<>"']+/gi) || []).map(canonicalUrl).filter(Boolean);
}

function possibleDabPrefixes(sku: string) {
  const normalized = clean(sku).toUpperCase();
  if (!normalized.startsWith('DAB-')) return [] as string[];
  const parts = normalized.split('-').filter(Boolean);
  const out: string[] = [];
  for (let end = 3; end <= Math.max(3, parts.length - 2); end += 1) {
    out.push(`${parts.slice(0, end).join('-')}-`);
  }
  return out;
}

function sourceCurrency(url: string) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (host.endsWith('.ae') || host.includes('ae.hm.com') || /\/en-ae(?:\/|$)/.test(path)) return 'AED';
    if (host.endsWith('.sa') || /\/en-sa(?:\/|$)/.test(path)) return 'SAR';
    if (host.endsWith('.co.uk') || /\/en-gb(?:\/|$)/.test(path)) return 'GBP';
    if (host.endsWith('.us')) return 'USD';
  } catch {}
  return 'UNKNOWN';
}

function supplierName(url: string, liveVendor: string) {
  const key = vendorKeyFromUrl(url);
  const names: Record<string, string> = {
    NEXT: 'Next', HM: 'H&M', MAX: 'Max Fashion', CENTREPOINT: 'Centrepoint', SHEIN: 'SHEIN',
    LEFTIES: 'Lefties', MARKSANDSPENCER: 'Marks & Spencer', CARTERS: "Carter's", ZARA: 'Zara',
    ADIDAS: 'Adidas', MOTHERCARE: 'Mothercare', GAP: 'Gap',
  };
  return names[key] || clean(liveVendor) || key || 'Unknown Supplier';
}

async function loadRows() {
  const rows: SheetRow[] = [];
  for (let offset = 0; offset < SHEETS.length; offset += 4) {
    const batch = SHEETS.slice(offset, offset + 4);
    const results = await Promise.all(batch.map(async (sheet) => {
      const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/edit?gid=${sheet.gid}`;
      try {
        const data = await loadGoogleSheetRows(sheetUrl);
        return { sheet, sheetUrl, rows: data.rows };
      } catch (error: any) {
        console.warn(`[assisted-match] sheet ${sheet.sheetName} skipped: ${clean(error?.message || error)}`);
        return { sheet, sheetUrl, rows: [] as GoogleSheetRow[] };
      }
    }));
    for (const result of results) {
      for (const row of result.rows) {
        if (!clean(row.url)) continue;
        const url = canonicalUrl(row.url);
        let prefix = '';
        try { prefix = `DAB-${dabBrandCode(url)}-${dabProductCode(url)}-`.toUpperCase(); } catch {}
        rows.push({
          ...row,
          spreadsheetId: result.sheet.spreadsheetId,
          spreadsheetName: result.sheet.spreadsheetName,
          sheetName: result.sheet.sheetName,
          gid: result.sheet.gid,
          sheetUrl: result.sheetUrl,
          priority: result.sheet.priority,
          canonicalUrl: url,
          vendorKey: vendorKeyFromUrl(url),
          titleKey: titleFromUrl(url),
          sourceCode: sourceCodeFromUrl(url),
          dabPrefix: prefix,
        });
      }
    }
  }
  return rows;
}

function uniqueByUrl(entries: Candidate[]) {
  const byUrl = new Map<string, Candidate[]>();
  for (const entry of entries) {
    const list = byUrl.get(entry.row.canonicalUrl) || [];
    list.push(entry);
    byUrl.set(entry.row.canonicalUrl, list);
  }
  if (byUrl.size !== 1) return null;
  const entriesForUrl = [...byUrl.values()][0];
  return [...entriesForUrl].sort((a, b) => a.row.priority - b.row.priority || a.row.rowNumber - b.row.rowNumber)[0];
}

async function persistProductLevelLink(cache: CacheRow, candidate: Candidate, live: any) {
  const row = candidate.row;
  const existingShopify = await prisma.shopifyProduct.findUnique({ where: { shopifyId: live.id } });
  if (existingShopify) return { linked: false, alreadyLinked: true };

  const existingSource = await prisma.sourceProduct.findUnique({
    where: { url: row.canonicalUrl },
    include: { shopifyProduct: true },
  });
  if (existingSource?.shopifyProduct && existingSource.shopifyProduct.shopifyId !== live.id) {
    throw new Error('Source URL is already linked to another Shopify product');
  }

  const multiplier = Number(row.priceMultiplier || 0) > 0 ? Number(row.priceMultiplier) : 1;
  const shopifyPrice = Number(live.variants?.[0]?.price || cache.price || 0);
  const sourcePrice = Number(row.price || 0) > 0 ? Number(row.price) : (shopifyPrice > 0 ? shopifyPrice / multiplier : 0);
  const supplierLabel = supplierName(row.canonicalUrl, clean(live.vendor));

  await prisma.$transaction(async (tx) => {
    const concurrentShopify = await tx.shopifyProduct.findUnique({ where: { shopifyId: live.id } });
    if (concurrentShopify) return;
    const currentSource = await tx.sourceProduct.findUnique({ where: { url: row.canonicalUrl }, include: { shopifyProduct: true } });
    if (currentSource?.shopifyProduct && currentSource.shopifyProduct.shopifyId !== live.id) {
      throw new Error('Source URL became owned by another Shopify product');
    }

    const supplier = await tx.supplier.upsert({
      where: { name: supplierLabel },
      update: {},
      create: { name: supplierLabel, baseUrl: (() => { try { return new URL(row.canonicalUrl).origin; } catch { return row.canonicalUrl; } })() },
    });

    const raw = JSON.stringify({
      import: {
        assistedProductLevelLink: true,
        matchMethod: candidate.method,
        spreadsheetId: row.spreadsheetId,
        spreadsheetName: row.spreadsheetName,
        sheetName: row.sheetName,
        sheetId: row.gid,
        excelRowNumber: row.rowNumber,
        sheetUrl: row.sheetUrl,
        sheetSku: clean(row.sku) || null,
        sheetPriceMultiplier: multiplier,
        sourceProductCode: row.sourceCode || null,
        variantsPending: true,
        linkedAt: new Date().toISOString(),
      },
    });

    const source = currentSource
      ? await tx.sourceProduct.update({
          where: { id: currentSource.id },
          data: { supplierId: supplier.id, productId: row.sourceCode || currentSource.productId, title: live.title, brand: live.vendor || supplierLabel, currency: sourceCurrency(row.canonicalUrl), price: sourcePrice, syncStatus: 'paused', raw },
        })
      : await tx.sourceProduct.create({
          data: { supplierId: supplier.id, url: row.canonicalUrl, productId: row.sourceCode || null, title: live.title, description: live.descriptionHtml || null, brand: live.vendor || supplierLabel, currency: sourceCurrency(row.canonicalUrl), price: sourcePrice, syncStatus: 'paused', lastScrapedAt: new Date(0), raw },
        });

    await tx.shopifyProduct.create({
      data: {
        sourceProductId: source.id,
        shopifyId: live.id,
        handle: clean(live.handle) || cache.handle,
        status: clean(live.status || 'active').toLowerCase(),
        collectionIds: clean(row.collection) || null,
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
        action: 'ASSISTED_PRODUCT_LEVEL_LINK',
        details: JSON.stringify({ shopifyProductId: live.id, sourceUrl: row.canonicalUrl, matchMethod: candidate.method, variantsPending: true, liveReadbackVerified: true }),
      },
    });

    await tx.$executeRawUnsafe(`
      UPDATE "${CACHE_TABLE}"
      SET "matchStatus"='linked', "matchMethod"=$2, "matchedSourceUrl"=$3,
          "sheetSpreadsheetId"=$4, "sheetSpreadsheetName"=$5, "sheetName"=$6,
          "sheetGid"=$7, "sheetRowNumber"=$8, "sheetSku"=$9, "sheetMultiplier"=$10,
          "reason"='Product-level link verified; variants pending',
          "evidence"=$11, "updatedAt"=NOW()
      WHERE "shopifyId"=$1
    `, live.id, candidate.method, row.canonicalUrl, row.spreadsheetId, row.spreadsheetName, row.sheetName, row.gid, row.rowNumber, clean(row.sku) || null, multiplier, JSON.stringify([candidate.method, 'live_shopify_readback']));
  }, { maxWait: 15000, timeout: 45000 });

  return { linked: true, alreadyLinked: false };
}

let workerRunning = false;

export async function runCatalogAssistedMatchWorker() {
  if (workerRunning) return;
  workerRunning = true;
  const recent = await prisma.syncJob.findFirst({
    where: { type: JOB_TYPE, status: 'running', createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } },
    orderBy: { createdAt: 'desc' },
  });
  if (recent) {
    console.log(`[assisted-match] existing worker ${recent.id} is already running`);
    workerRunning = false;
    return;
  }

  await prisma.syncJob.updateMany({
    where: { type: JOB_TYPE, status: 'running', createdAt: { lt: new Date(Date.now() - 30 * 60 * 1000) } },
    data: { status: 'failed', completedAt: new Date(), result: JSON.stringify({ stage: 'failed', error: 'Stale assisted matcher marker closed before retry' }) },
  });

  const job = await prisma.syncJob.create({
    data: { type: JOB_TYPE, status: 'running', startedAt: new Date(), result: JSON.stringify({ stage: 'loading_sheets', linked: 0, failed: 0, skipped: 0 }) },
  });

  let linked = 0;
  let failed = 0;
  let skipped = 0;
  let processed = 0;
  try {
    const rows = await loadRows();
    const byUrl = new Map<string, SheetRow[]>();
    const bySku = new Map<string, SheetRow[]>();
    const byPrefix = new Map<string, SheetRow[]>();
    const byTitleVendor = new Map<string, SheetRow[]>();
    const byCodeVendor = new Map<string, SheetRow[]>();

    for (const row of rows) {
      byUrl.set(row.canonicalUrl, [...(byUrl.get(row.canonicalUrl) || []), row]);
      const sku = clean(row.sku).toUpperCase().replace(/\s+/g, '');
      if (sku) bySku.set(sku, [...(bySku.get(sku) || []), row]);
      if (row.dabPrefix) byPrefix.set(row.dabPrefix, [...(byPrefix.get(row.dabPrefix) || []), row]);
      if (row.titleKey && row.vendorKey) {
        const key = `${row.vendorKey}|${row.titleKey}`;
        byTitleVendor.set(key, [...(byTitleVendor.get(key) || []), row]);
      }
      if (row.sourceCode && row.vendorKey) {
        const key = `${row.vendorKey}|${row.sourceCode}`;
        byCodeVendor.set(key, [...(byCodeVendor.get(key) || []), row]);
      }
    }

    const cacheRows = await prisma.$queryRawUnsafe<CacheRow[]>(`
      SELECT "shopifyId", "title", "handle", "vendor", "primarySku", "price", "explicitSourceUrls", "matchStatus"
      FROM "${CACHE_TABLE}"
      WHERE UPPER(COALESCE("status", ''))='ACTIVE'
        AND "matchStatus" IN ('needs_link','needs_review')
      ORDER BY "shopifyId" ASC
      LIMIT ${LIMIT}
    `);

    const candidates: Array<{ cache: CacheRow; candidate: Candidate }> = [];
    for (const cache of cacheRows) {
      const evidence: Candidate[] = [];
      for (const url of parseExplicitUrls(cache.explicitSourceUrls)) {
        for (const row of byUrl.get(url) || []) evidence.push({ row, method: 'source_url' });
      }

      const sku = clean(cache.primarySku).toUpperCase().replace(/\s+/g, '');
      if (sku) {
        for (const row of bySku.get(sku) || []) evidence.push({ row, method: 'exact_sku' });
        for (const prefix of possibleDabPrefixes(sku)) {
          for (const row of byPrefix.get(prefix) || []) evidence.push({ row, method: 'dab_product_prefix' });
        }
        const vKey = vendorKey(cache.vendor);
        const compactSku = compact(sku);
        if (vKey && compactSku) {
          for (const [key, codeRows] of byCodeVendor) {
            if (!key.startsWith(`${vKey}|`)) continue;
            const code = key.slice(vKey.length + 1);
            if (code.length >= 5 && compactSku.includes(code)) {
              for (const row of codeRows) evidence.push({ row, method: 'source_code_in_sku' });
            }
          }
        }
      }

      if (evidence.length === 0) {
        const titleKey = normalizeTitle(cache.title);
        const vKey = vendorKey(cache.vendor);
        if (titleKey && vKey) {
          for (const row of byTitleVendor.get(`${vKey}|${titleKey}`) || []) evidence.push({ row, method: 'exact_title_vendor' });
        }
      }

      const unique = uniqueByUrl(evidence);
      if (unique) candidates.push({ cache, candidate: unique });
    }

    console.log(`[assisted-match] rows=${rows.length} unresolved=${cacheRows.length} deterministicCandidates=${candidates.length}`);
    const client = await ShopifyService.getClientFromDb(prisma);

    for (let offset = 0; offset < candidates.length; offset += CONCURRENCY) {
      const batch = candidates.slice(offset, offset + CONCURRENCY);
      await Promise.all(batch.map(async ({ cache, candidate }) => {
        processed += 1;
        try {
          const live = await ShopifyService.getProductCatalogSnapshot(client, cache.shopifyId);
          if (!live || String(live.status).toUpperCase() !== 'ACTIVE') throw new Error('Shopify product missing or inactive');

          const liveVendor = vendorKey(live.vendor);
          if (candidate.row.vendorKey && liveVendor && candidate.row.vendorKey !== liveVendor) throw new Error('Live Shopify vendor does not match source vendor');

          if (candidate.method === 'exact_title_vendor' && normalizeTitle(live.title) !== candidate.row.titleKey) {
            throw new Error('Live Shopify title changed after candidate selection');
          }
          if (candidate.method === 'exact_sku') {
            const target = clean(candidate.row.sku).toUpperCase().replace(/\s+/g, '');
            const liveSkus = new Set((live.variants || []).map((variant: any) => clean(variant.sku).toUpperCase().replace(/\s+/g, '')).filter(Boolean));
            if (!target || !liveSkus.has(target)) throw new Error('Live Shopify variants do not contain exact sheet SKU');
          }
          if (candidate.method === 'dab_product_prefix') {
            const prefix = candidate.row.dabPrefix;
            const liveSkus = (live.variants || []).map((variant: any) => clean(variant.sku).toUpperCase());
            if (!prefix || !liveSkus.some((value: string) => value.startsWith(prefix))) throw new Error('Live Shopify variants do not contain expected DAB product prefix');
          }
          if (candidate.method === 'source_code_in_sku') {
            const code = candidate.row.sourceCode;
            const liveSkus = (live.variants || []).map((variant: any) => compact(variant.sku));
            if (!code || !liveSkus.some((value: string) => value.includes(code))) throw new Error('Live Shopify variants do not contain source product code');
          }

          const result = await persistProductLevelLink(cache, candidate, live);
          if (result.linked) linked += 1;
          else skipped += 1;
        } catch (error: any) {
          failed += 1;
          console.warn(`[assisted-match] ${cache.shopifyId} ${candidate.method} skipped: ${clean(error?.message || error)}`);
        }
      }));

      if (processed % 20 < CONCURRENCY || offset + CONCURRENCY >= candidates.length) {
        await prisma.syncJob.update({
          where: { id: job.id },
          data: { result: JSON.stringify({ stage: 'linking', rows: rows.length, unresolved: cacheRows.length, deterministicCandidates: candidates.length, processed, linked, failed, skipped, scraperApiCreditsUsed: 0 }) },
        });
        console.log(`[assisted-match] processed=${processed}/${candidates.length} linked=${linked} failed=${failed} skipped=${skipped}`);
      }
    }

    await prisma.syncJob.update({
      where: { id: job.id },
      data: { status: 'completed', completedAt: new Date(), result: JSON.stringify({ stage: 'completed', rows: rows.length, unresolved: cacheRows.length, deterministicCandidates: candidates.length, processed, linked, failed, skipped, scraperApiCreditsUsed: 0 }) },
    });
    console.log(`[assisted-match] completed linked=${linked} failed=${failed} skipped=${skipped}`);
  } catch (error: any) {
    await prisma.syncJob.update({ where: { id: job.id }, data: { status: 'failed', completedAt: new Date(), result: JSON.stringify({ stage: 'failed', processed, linked, failed, skipped, error: clean(error?.message || error), scraperApiCreditsUsed: 0 }) } }).catch(() => undefined);
    console.error('[assisted-match] failed', error);
  } finally {
    workerRunning = false;
  }
}

if (enabled('CATALOG_ASSISTED_MATCH_AUTOSTART', false)) {
  const intervalMinutes = Math.max(15, Number(process.env.CATALOG_ASSISTED_MATCH_INTERVAL_MINUTES || 30));
  const run = () => void runCatalogAssistedMatchWorker();
  const initial = setTimeout(run, 3000);
  initial.unref?.();
  const timer = setInterval(run, intervalMinutes * 60 * 1000);
  timer.unref?.();
  console.log(`[assisted-match] enabled every ${intervalMinutes} minute(s)`);
} else {
  console.log('[assisted-match] autostart disabled');
}
