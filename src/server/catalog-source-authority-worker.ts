import { prisma } from './db.js';
import {
  loadGoogleSheetRows,
  processGoogleSheetBatch,
  type GoogleSheetRow,
} from './api.js';
import { ShopifyService } from './services/shopify.js';

const BIG_SPREADSHEET_ID = '1fCbPajWL3nukX0TdoN1m2X8LV3pfPsxSMLBb0yWug2w';
const JOB_TYPE = 'CATALOG_SOURCE_AUTHORITY:2026-09-09-v1';
const PERMANENT_FAILURE_ACTION = 'SOURCE_AUTHORITY_PERMANENT_FAILURE';
const START_DELAY_MS = 45_000;
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_NEW_ROWS_PER_CYCLE = 50;
const DEFAULT_MIN_AUTHORITATIVE_ROWS = 5_000;
const DEFAULT_MAX_MISSING_RATIO = 0.35;
const LOCAL_DELETE_BATCH_SIZE = 50;
const SHOPIFY_DELETE_BATCH_SIZE = 20;

const SHEETS = [
  { name: 'الورقة1', gid: 0 },
  { name: 'الورقة2', gid: 531292068 },
  { name: 'الورقة15', gid: 242585683 },
  { name: 'الورقة10', gid: 1991302797 },
  { name: 'الورقة6', gid: 1951926772 },
  { name: 'الورقة7', gid: 93159589 },
  { name: 'الورقة8', gid: 916372394 },
  { name: 'الورقة20', gid: 202697256 },
  { name: 'الورقة9', gid: 1264806944 },
  { name: 'الورقة11', gid: 106757984 },
  { name: 'الورقة12', gid: 1841878091 },
  { name: 'الورقة13', gid: 1219566712 },
  { name: 'الورقة16', gid: 1526682180 },
  { name: 'الورقة18', gid: 1122116162 },
  { name: 'الورقة19', gid: 16172014 },
  { name: 'الورقة21', gid: 1993452910 },
  { name: 'الورقة22', gid: 282692873 },
  { name: 'الورقة23', gid: 770232216 },
  { name: 'الورقة24', gid: 1210585516 },
  { name: 'الورقة25', gid: 307824540 },
  { name: 'الورقة26', gid: 1459453928 },
  { name: 'الورقة27', gid: 4356284 },
  { name: 'الورقة28', gid: 422632561 },
] as const;

type SheetConfig = (typeof SHEETS)[number];
type CatalogRow = {
  sheet: SheetConfig;
  sheetUrl: string;
  row: GoogleSheetRow;
  canonicalUrl: string;
};

type MaintenanceSummary = {
  stage: string;
  sheetsLoaded: number;
  sheetsFailed: number;
  authoritativeRows: number;
  uniqueAuthoritativeUrls: number;
  shopifyDraftDeleted: number;
  shopifyDraftDeleteFailed: number;
  localDraftLinksPurged: number;
  failedSourcePurged: number;
  missingSourcePurged: number;
  missingSourceGuarded: boolean;
  newRowsQueued: number;
  newRowsAttempted: number;
  newPublished: number;
  newSkipped: number;
  newFailed: number;
  permanentFailures: number;
  issues: Array<Record<string, unknown>>;
  startedAt: string;
  completedAt: string | null;
};

let started = false;
let running = false;

function enabled(name: string, fallback = false) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function positiveInteger(name: string, fallback: number, max = 100_000) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value <= 0) return fallback;
  return Math.min(value, max);
}

function boundedRatio(name: string, fallback: number) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0 || value >= 1) return fallback;
  return value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunks<T>(items: T[], size: number) {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

function clean(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
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

function sheetUrl(sheet: SheetConfig) {
  return `https://docs.google.com/spreadsheets/d/${BIG_SPREADSHEET_ID}/edit?gid=${sheet.gid}`;
}

function isManagedBigSheetRaw(raw: string | null | undefined) {
  if (!raw) return false;
  return raw.includes(BIG_SPREADSHEET_ID);
}

function parseDetails(value: string | null | undefined) {
  if (!value) return {} as Record<string, any>;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {} as Record<string, any>;
  }
}

async function updateJob(jobId: string, summary: MaintenanceSummary, status = 'running') {
  await prisma.syncJob.update({
    where: { id: jobId },
    data: {
      status,
      result: JSON.stringify(summary),
      ...(status === 'completed' || status === 'failed'
        ? { completedAt: new Date() }
        : {}),
    },
  });
}

async function loadAuthoritativeCatalog(summary: MaintenanceSummary) {
  const results = await Promise.all(
    SHEETS.map(async (sheet) => {
      const url = sheetUrl(sheet);
      try {
        const data = await loadGoogleSheetRows(url);
        summary.sheetsLoaded += 1;
        return data.rows
          .filter((row) => clean(row.url))
          .map((row) => ({
            sheet,
            sheetUrl: url,
            row,
            canonicalUrl: canonicalUrl(row.url),
          })) as CatalogRow[];
      } catch (error: any) {
        summary.sheetsFailed += 1;
        summary.issues.push({
          stage: 'sheet_load',
          sheet: sheet.name,
          gid: sheet.gid,
          error: clean(error?.message || error),
        });
        return [] as CatalogRow[];
      }
    }),
  );

  const rows = results.flat();
  summary.authoritativeRows = rows.length;
  summary.uniqueAuthoritativeUrls = new Set(rows.map((entry) => entry.canonicalUrl)).size;
  return rows;
}

async function permanentFailureUrls() {
  const logs = await prisma.auditLog.findMany({
    where: { action: PERMANENT_FAILURE_ACTION },
    orderBy: { createdAt: 'desc' },
    take: 20_000,
    select: { details: true },
  });
  const urls = new Set<string>();
  for (const log of logs) {
    const details = parseDetails(log.details);
    const url = canonicalUrl(details.url);
    if (url) urls.add(url);
  }
  return urls;
}

async function rememberPermanentFailure(url: string, reason: string, extra: Record<string, unknown> = {}) {
  await prisma.auditLog.create({
    data: {
      action: PERMANENT_FAILURE_ACTION,
      details: JSON.stringify({
        at: new Date().toISOString(),
        url,
        reason,
        ...extra,
      }),
    },
  });
}

async function purgeLocalSourceProducts(sourceProductIds: string[]) {
  let deleted = 0;
  for (const batch of chunks([...new Set(sourceProductIds)].filter(Boolean), LOCAL_DELETE_BATCH_SIZE)) {
    if (!batch.length) continue;
    const batchDeleted = await prisma.$transaction(async (tx) => {
      const shopifyProducts = await tx.shopifyProduct.findMany({
        where: { sourceProductId: { in: batch } },
        select: { id: true },
      });
      const shopifyProductIds = shopifyProducts.map((entry) => entry.id);
      if (shopifyProductIds.length) {
        await tx.shopifyVariant.deleteMany({
          where: { shopifyProductId: { in: shopifyProductIds } },
        });
      }
      await tx.shopifyProduct.deleteMany({
        where: { sourceProductId: { in: batch } },
      });
      await tx.manualReviewItem.deleteMany({
        where: { sourceProductId: { in: batch } },
      });
      await tx.auditLog.updateMany({
        where: { sourceProductId: { in: batch } },
        data: { sourceProductId: null },
      });
      await tx.sourceImage.deleteMany({
        where: { sourceProductId: { in: batch } },
      });
      await tx.sourceVariant.deleteMany({
        where: { sourceProductId: { in: batch } },
      });
      const result = await tx.sourceProduct.deleteMany({
        where: { id: { in: batch } },
      });
      return result.count;
    });
    deleted += batchDeleted;
  }
  return deleted;
}

async function readShopifyDraftIds(client: any) {
  const data = await client.request(`
    query SourceAuthorityDraftProducts {
      products(first: 100, query: "status:draft", sortKey: ID) {
        nodes { id }
      }
    }
  `);
  return (data?.products?.nodes || []).map((entry: any) => String(entry.id)).filter(Boolean) as string[];
}

async function deleteShopifyDraftBatch(client: any, productIds: string[]) {
  if (!productIds.length) return { deleted: [] as string[], failed: [] as Array<{ id: string; error: string }> };
  const variableDefinitions: string[] = [];
  const mutationFields: string[] = [];
  const variables: Record<string, string> = {};
  productIds.forEach((id, index) => {
    variableDefinitions.push(`$id${index}: ID!`);
    mutationFields.push(`d${index}: productDelete(id: $id${index}) { deletedProductId userErrors { field message } }`);
    variables[`id${index}`] = id;
  });
  const mutation = `mutation SourceAuthorityDeleteDrafts(${variableDefinitions.join(', ')}) { ${mutationFields.join('\n')} }`;

  let data: any;
  let lastError = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      data = await client.request(mutation, variables);
      lastError = '';
      break;
    } catch (error: any) {
      lastError = clean(error?.message || error);
      if (!/thrott|429|rate limit/i.test(lastError) || attempt === 4) break;
      await sleep(800 * (attempt + 1));
    }
  }

  if (!data) {
    return {
      deleted: [] as string[],
      failed: productIds.map((id) => ({ id, error: lastError || 'Shopify delete request failed' })),
    };
  }

  const deleted: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  productIds.forEach((id, index) => {
    const result = data[`d${index}`];
    const errors = Array.isArray(result?.userErrors) ? result.userErrors : [];
    if (result?.deletedProductId && errors.length === 0) deleted.push(id);
    else failed.push({ id, error: errors.map((entry: any) => clean(entry.message)).filter(Boolean).join('; ') || 'Delete was not confirmed' });
  });
  return { deleted, failed };
}

async function purgeShopifyDrafts(client: any, summary: MaintenanceSummary) {
  let emptyPasses = 0;
  let passes = 0;
  const maxPasses = positiveInteger('CATALOG_SOURCE_AUTHORITY_DRAFT_DELETE_MAX_PASSES', 250, 500);

  while (passes < maxPasses) {
    const draftIds = await readShopifyDraftIds(client);
    if (!draftIds.length) {
      emptyPasses += 1;
      if (emptyPasses >= 1) break;
      continue;
    }
    passes += 1;
    emptyPasses = 0;

    const linked = await prisma.shopifyProduct.findMany({
      where: { shopifyId: { in: draftIds } },
      select: { sourceProductId: true, shopifyId: true },
    });
    const sourceByShopifyId = new Map(linked.map((entry) => [entry.shopifyId, entry.sourceProductId]));

    let passProgress = 0;
    for (const batch of chunks(draftIds, SHOPIFY_DELETE_BATCH_SIZE)) {
      const result = await deleteShopifyDraftBatch(client, batch);
      summary.shopifyDraftDeleted += result.deleted.length;
      summary.shopifyDraftDeleteFailed += result.failed.length;
      passProgress += result.deleted.length;
      for (const failure of result.failed.slice(0, 10)) {
        summary.issues.push({ stage: 'shopify_draft_delete', ...failure });
      }
      const linkedSourceIds = result.deleted
        .map((id) => sourceByShopifyId.get(id))
        .filter(Boolean) as string[];
      if (linkedSourceIds.length) {
        summary.localDraftLinksPurged += await purgeLocalSourceProducts(linkedSourceIds);
      }
      await sleep(120);
    }

    if (passProgress === 0) {
      summary.issues.push({
        stage: 'shopify_draft_delete',
        error: 'Draft cleanup made no progress; stopping to avoid an infinite retry loop.',
      });
      break;
    }
  }
}

async function purgeFailedSourceProducts(summary: MaintenanceSummary) {
  const failed = await prisma.sourceProduct.findMany({
    where: { syncStatus: 'error' },
    select: { id: true, url: true },
  });
  for (const product of failed) {
    await rememberPermanentFailure(product.url, 'syncStatus=error', { sourceProductId: product.id });
  }
  summary.failedSourcePurged += await purgeLocalSourceProducts(failed.map((entry) => entry.id));
}

async function purgeMissingManagedProducts(rows: CatalogRow[], summary: MaintenanceSummary) {
  if (summary.sheetsFailed > 0) {
    summary.missingSourceGuarded = true;
    summary.issues.push({
      stage: 'missing_source_guard',
      error: 'At least one authoritative sheet failed to load; missing-source deletion was skipped for safety.',
    });
    return;
  }

  const minimumRows = positiveInteger(
    'CATALOG_SOURCE_AUTHORITY_MIN_ROWS',
    DEFAULT_MIN_AUTHORITATIVE_ROWS,
    100_000,
  );
  if (summary.uniqueAuthoritativeUrls < minimumRows) {
    summary.missingSourceGuarded = true;
    summary.issues.push({
      stage: 'missing_source_guard',
      error: `Authoritative catalog has only ${summary.uniqueAuthoritativeUrls} unique URLs; minimum is ${minimumRows}.`,
    });
    return;
  }

  const authoritative = new Set(rows.map((entry) => entry.canonicalUrl));
  const sourceProducts = await prisma.sourceProduct.findMany({
    select: { id: true, url: true, raw: true },
  });
  const managed = sourceProducts.filter((product) => isManagedBigSheetRaw(product.raw));
  const missing = managed.filter((product) => !authoritative.has(canonicalUrl(product.url)));
  if (!missing.length) return;

  const maxRatio = boundedRatio(
    'CATALOG_SOURCE_AUTHORITY_MAX_MISSING_RATIO',
    DEFAULT_MAX_MISSING_RATIO,
  );
  const ratio = managed.length ? missing.length / managed.length : 0;
  if (managed.length > 100 && ratio > maxRatio) {
    summary.missingSourceGuarded = true;
    summary.issues.push({
      stage: 'missing_source_guard',
      managed: managed.length,
      missing: missing.length,
      ratio,
      maxRatio,
      error: 'Missing-source deletion exceeded the safety ratio and was skipped.',
    });
    return;
  }

  summary.missingSourcePurged += await purgeLocalSourceProducts(missing.map((entry) => entry.id));
}

async function importNewRows(rows: CatalogRow[], summary: MaintenanceSummary) {
  const sourceProducts = await prisma.sourceProduct.findMany({ select: { url: true } });
  const existing = new Set(sourceProducts.map((entry) => canonicalUrl(entry.url)));
  const tombstones = await permanentFailureUrls();
  summary.permanentFailures = tombstones.size;

  const uniqueRows = new Map<string, CatalogRow>();
  for (const entry of rows) {
    if (!entry.canonicalUrl || existing.has(entry.canonicalUrl) || tombstones.has(entry.canonicalUrl)) continue;
    if (!uniqueRows.has(entry.canonicalUrl)) uniqueRows.set(entry.canonicalUrl, entry);
  }

  const candidates = [...uniqueRows.values()];
  summary.newRowsQueued = candidates.length;
  const limit = positiveInteger(
    'CATALOG_SOURCE_AUTHORITY_NEW_ROWS_PER_CYCLE',
    DEFAULT_NEW_ROWS_PER_CYCLE,
    2_000,
  );
  const selected = candidates.slice(0, limit);

  const bySheet = new Map<number, CatalogRow[]>();
  for (const entry of selected) {
    const bucket = bySheet.get(entry.sheet.gid) || [];
    bucket.push(entry);
    bySheet.set(entry.sheet.gid, bucket);
  }

  for (const entries of bySheet.values()) {
    for (const batch of chunks(entries, 10)) {
      const first = batch[0];
      if (!first) continue;
      try {
        const result = await processGoogleSheetBatch({
          sheetUrl: first.sheetUrl,
          rowNumbers: batch.map((entry) => entry.row.rowNumber),
          createManualReview: false,
          processOnlyNewRows: false,
          waitForPublishCompletion: true,
          createMissingProducts: true,
          skipExistingProducts: true,
          allowBlockedSheetFallback: false,
          mode: 'sheet_link',
        });
        summary.newRowsAttempted += batch.length;
        summary.newPublished += (result.successful || []).filter((entry: any) => entry?.action === 'published').length;
        summary.newSkipped += (result.skipped || []).length;
        summary.newFailed += (result.failed || []).length;

        for (const failure of result.failed || []) {
          const matching = batch.find((entry) => entry.row.rowNumber === failure.rowNumber);
          if (!matching) continue;
          const reason = clean(failure.reason || failure.error || 'Source row failed to sync');
          await rememberPermanentFailure(matching.row.url, reason, {
            sheet: matching.sheet.name,
            gid: matching.sheet.gid,
            rowNumber: matching.row.rowNumber,
          });
          const failedLocal = await prisma.sourceProduct.findFirst({
            where: { url: matching.row.url },
            select: { id: true },
          });
          if (failedLocal?.id) {
            summary.failedSourcePurged += await purgeLocalSourceProducts([failedLocal.id]);
          }
          summary.issues.push({
            stage: 'new_row_sync',
            sheet: matching.sheet.name,
            rowNumber: matching.row.rowNumber,
            url: matching.row.url,
            error: reason,
          });
        }
      } catch (error: any) {
        summary.newRowsAttempted += batch.length;
        summary.newFailed += batch.length;
        const reason = clean(error?.message || error);
        for (const entry of batch) {
          await rememberPermanentFailure(entry.row.url, reason, {
            sheet: entry.sheet.name,
            gid: entry.sheet.gid,
            rowNumber: entry.row.rowNumber,
          });
        }
        summary.issues.push({
          stage: 'new_row_batch',
          sheet: first.sheet.name,
          rows: batch.map((entry) => entry.row.rowNumber),
          error: reason,
        });
      }
    }
  }
}

export async function runCatalogSourceAuthorityCycle() {
  if (running) return { alreadyRunning: true };
  running = true;

  const summary: MaintenanceSummary = {
    stage: 'starting',
    sheetsLoaded: 0,
    sheetsFailed: 0,
    authoritativeRows: 0,
    uniqueAuthoritativeUrls: 0,
    shopifyDraftDeleted: 0,
    shopifyDraftDeleteFailed: 0,
    localDraftLinksPurged: 0,
    failedSourcePurged: 0,
    missingSourcePurged: 0,
    missingSourceGuarded: false,
    newRowsQueued: 0,
    newRowsAttempted: 0,
    newPublished: 0,
    newSkipped: 0,
    newFailed: 0,
    permanentFailures: 0,
    issues: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
  };

  const job = await prisma.syncJob.create({
    data: {
      type: JOB_TYPE,
      status: 'running',
      startedAt: new Date(),
      payload: JSON.stringify({
        spreadsheetId: BIG_SPREADSHEET_ID,
        sheets: SHEETS.map((sheet) => ({ name: sheet.name, gid: sheet.gid })),
        mode: 'source_authority',
      }),
      result: JSON.stringify(summary),
    },
  });

  try {
    summary.stage = 'load_authoritative_source';
    await updateJob(job.id, summary);
    const rows = await loadAuthoritativeCatalog(summary);

    summary.stage = 'delete_shopify_drafts';
    await updateJob(job.id, summary);
    const client = await ShopifyService.getClientFromDb(prisma);
    await purgeShopifyDrafts(client, summary);

    summary.stage = 'purge_failed_source';
    await updateJob(job.id, summary);
    await purgeFailedSourceProducts(summary);

    summary.stage = 'purge_missing_source';
    await updateJob(job.id, summary);
    await purgeMissingManagedProducts(rows, summary);

    summary.stage = 'import_new_source_rows';
    await updateJob(job.id, summary);
    await importNewRows(rows, summary);

    summary.stage = 'completed';
    summary.completedAt = new Date().toISOString();
    summary.issues = summary.issues.slice(-100);
    await updateJob(job.id, summary, 'completed');
    console.log(`[source-authority] completed ${JSON.stringify(summary)}`);
    return { alreadyRunning: false, jobId: job.id, summary };
  } catch (error: any) {
    summary.stage = 'failed';
    summary.completedAt = new Date().toISOString();
    summary.issues.push({ stage: 'worker', error: clean(error?.message || error) });
    summary.issues = summary.issues.slice(-100);
    await updateJob(job.id, summary, 'failed').catch(() => undefined);
    console.error(`[source-authority] failed: ${clean(error?.message || error)}`);
    return { alreadyRunning: false, jobId: job.id, summary };
  } finally {
    running = false;
  }
}

export function startCatalogSourceAuthorityWorker() {
  if (started) return;
  started = true;
  if (!enabled('CATALOG_SOURCE_AUTHORITY_AUTOSTART', false)) {
    console.log('[source-authority] autostart disabled');
    return;
  }

  const intervalMs = positiveInteger(
    'CATALOG_SOURCE_AUTHORITY_INTERVAL_MS',
    DEFAULT_INTERVAL_MS,
    24 * 60 * 60 * 1000,
  );
  console.log(`[source-authority] enabled intervalMs=${intervalMs}`);
  setTimeout(() => void runCatalogSourceAuthorityCycle(), START_DELAY_MS);
  setInterval(() => void runCatalogSourceAuthorityCycle(), intervalMs);
}

startCatalogSourceAuthorityWorker();
