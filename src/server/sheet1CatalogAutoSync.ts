import { prisma } from "./db.js";
import {
  googleSheetRowFingerprint,
  loadGoogleSheetRows,
  processGoogleSheetBatch,
  type GoogleSheetRow,
} from "./api.js";
import {
  googleWriterConfigured,
  writeSkuCellsToSheet,
} from "./firstFiveSheetsReconcile.js";

const SPREADSHEET_ID = "1fCbPajWL3nukX0TdoN1m2X8LV3pfPsxSMLBb0yWug2w";
export const FIRST_EIGHT_CATALOG_SHEETS = [
  { name: "\u0627\u0644\u0648\u0631\u0642\u06291", gid: 0, sheetId: 0 },
  { name: "\u0627\u0644\u0648\u0631\u0642\u06292", gid: 531292068, sheetId: 531292068 },
  { name: "\u0627\u0644\u0648\u0631\u0642\u062915", gid: 242585683, sheetId: 242585683 },
  { name: "\u0627\u0644\u0648\u0631\u0642\u062910", gid: 1991302797, sheetId: 1991302797 },
  { name: "\u0627\u0644\u0648\u0631\u0642\u06296", gid: 1951926772, sheetId: 1951926772 },
  { name: "\u0627\u0644\u0648\u0631\u0642\u06297", gid: 93159589, sheetId: 93159589 },
  { name: "\u0627\u0644\u0648\u0631\u0642\u06298", gid: 916372394, sheetId: 916372394 },
  { name: "\u0627\u0644\u0648\u0631\u0642\u062920", gid: 202697256, sheetId: 202697256 },
] as const;
export const SHEET1_CATALOG_MARKER_TYPE =
  "SHEET1_CATALOG_AUTO_SYNC:2026-08-09-v5-first-eight-5000-key-pool";
const START_DELAY_MS = 20_000;
const DEFAULT_POLL_MS = 30 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 10;
export const MAX_CATALOG_TARGET_ROWS = 5000;
let started = false;

type SheetConfig = (typeof FIRST_EIGHT_CATALOG_SHEETS)[number];
type CatalogRow = {
  sheet: SheetConfig;
  row: GoogleSheetRow;
  key: string;
  fingerprint: string;
};

type WorkerState = {
  stage: string;
  cycle: number;
  fingerprints: Record<string, string>;
  verifiedFingerprints: Record<string, string>;
  totalRows: number;
  targetRows: number;
  candidateRows: number;
  verifiedRows: number;
  remainingRows: number;
  existingUpdated: number;
  published: number;
  failed: number;
  skipped: number;
  sheetCellsWritten: number;
  sheetWritePending: number;
  pendingSkuWrites: Record<string, string>;
  lastBatchId: string | null;
  lastRunAt: string | null;
  issues: Array<Record<string, unknown>>;
};

function enabled(name: string) {
  return ["1", "true", "yes", "on"].includes(
    String(process.env[name] || "").trim().toLowerCase(),
  );
}

function deployedRevision() {
  return String(
    process.env.RAILWAY_GIT_COMMIT_SHA ||
      process.env.SOURCE_VERSION ||
      process.env.GIT_COMMIT_SHA ||
      "",
  ).trim();
}

function revisionAuthorized() {
  const expected = String(process.env.SYNC_SHEET1_CATALOG_REVISION || "").trim();
  const actual = deployedRevision();
  return (
    /^[0-9a-f]{40}$/i.test(expected) &&
    /^[0-9a-f]{40}$/i.test(actual) &&
    expected.toLowerCase() === actual.toLowerCase()
  );
}

export function sheet1CatalogAutoSyncEnabled() {
  const branch = String(
    process.env.RAILWAY_GIT_BRANCH || process.env.GIT_BRANCH || "",
  )
    .trim()
    .replace(/^refs\/heads\//, "");
  const railway = Boolean(
    String(process.env.RAILWAY_ENVIRONMENT || "").trim() ||
      String(process.env.RAILWAY_PUBLIC_DOMAIN || "").trim(),
  );
  return (
    String(process.env.NODE_ENV || "").trim().toLowerCase() === "production" &&
    railway &&
    branch === "stabilize-supabase-railway" &&
    enabled("SYNC_RUNTIME_WRITE_ENABLED") &&
    enabled("SYNC_SHEET1_CATALOG_AUTOSTART_ENABLED") &&
    !enabled("SYNC_SHEET1_CATALOG_AUTOSTART_DISABLED") &&
    revisionAuthorized()
  );
}

function parseState(value: string | null | undefined): Partial<WorkerState> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function initialState(previous?: Partial<WorkerState>): WorkerState {
  const verifiedFingerprints =
    previous?.verifiedFingerprints && typeof previous.verifiedFingerprints === "object"
      ? previous.verifiedFingerprints
      : {};
  return {
    stage: "starting",
    cycle: Number(previous?.cycle || 0),
    fingerprints:
      previous?.fingerprints && typeof previous.fingerprints === "object"
        ? previous.fingerprints
        : {},
    verifiedFingerprints,
    totalRows: 0,
    targetRows: 0,
    candidateRows: 0,
    verifiedRows: Object.keys(verifiedFingerprints).length,
    remainingRows: 0,
    existingUpdated: Number(previous?.existingUpdated || 0),
    published: Number(previous?.published || 0),
    failed: Number(previous?.failed || 0),
    skipped: Number(previous?.skipped || 0),
    sheetCellsWritten: Number(previous?.sheetCellsWritten || 0),
    sheetWritePending: Number(previous?.sheetWritePending || 0),
    pendingSkuWrites:
      previous?.pendingSkuWrites && typeof previous.pendingSkuWrites === "object"
        ? previous.pendingSkuWrites
        : {},
    lastBatchId: previous?.lastBatchId || null,
    lastRunAt: previous?.lastRunAt || null,
    issues: Array.isArray(previous?.issues) ? previous.issues.slice(-200) : [],
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function sheetUrl(sheet: SheetConfig) {
  return `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit?gid=${sheet.gid}`;
}

function rowKey(sheet: SheetConfig, rowNumber: number) {
  return `${sheet.sheetId}:${rowNumber}`;
}

function processedButUnverified(state: WorkerState, entry: CatalogRow) {
  return (
    state.fingerprints[entry.key] === entry.fingerprint &&
    state.verifiedFingerprints[entry.key] !== entry.fingerprint
  );
}

function targetRowLimit() {
  const configured = Number(
    process.env.SYNC_SHEET1_CATALOG_TARGET_ROWS || MAX_CATALOG_TARGET_ROWS,
  );
  return Math.min(
    MAX_CATALOG_TARGET_ROWS,
    Math.max(1, Number.isFinite(configured) ? Math.floor(configured) : MAX_CATALOG_TARGET_ROWS),
  );
}

function missingRowsPerCycleLimit(totalRows: number) {
  const configured = Number(
    process.env.SYNC_SHEET1_CATALOG_MISSING_ROWS_PER_CYCLE || totalRows,
  );
  return Math.min(
    totalRows,
    Math.max(1, Number.isFinite(configured) ? Math.floor(configured) : totalRows),
  );
}

function refreshProgress(state: WorkerState) {
  state.verifiedRows = Object.keys(state.verifiedFingerprints).length;
  state.remainingRows = Math.max(0, state.targetRows - state.verifiedRows);
}

async function persist(markerId: string, state: WorkerState) {
  refreshProgress(state);
  await prisma.syncJob.update({
    where: { id: markerId },
    data: { result: JSON.stringify(state) },
  });
}

async function writeSuccessfulSkus(
  successful: Array<{ rowNumber: number; sku?: string }>,
  sheet: SheetConfig,
  rowsByNumber: Map<number, CatalogRow>,
  state: WorkerState,
) {
  for (const entry of successful) {
    if (!entry.sku) continue;
    const key = rowKey(sheet, entry.rowNumber);
    const existingSku = String(rowsByNumber.get(entry.rowNumber)?.row.sku || "")
      .trim()
      .toUpperCase();
    if (existingSku === entry.sku.trim().toUpperCase()) {
      delete state.pendingSkuWrites[key];
    } else {
      state.pendingSkuWrites[key] = entry.sku;
    }
  }
  state.sheetWritePending = Object.keys(state.pendingSkuWrites).length;
  await flushPendingSkuWrites(state);
}

async function flushPendingSkuWrites(state: WorkerState) {
  const updates = Object.entries(state.pendingSkuWrites)
    .map(([key, sku]) => {
      const [sheetId, rowNumber] = key.split(":").map(Number);
      return { key, sheetId, rowNumber, sku };
    })
    .filter(
      (entry) =>
        Number.isSafeInteger(entry.sheetId) &&
        Number.isSafeInteger(entry.rowNumber) &&
        entry.rowNumber > 0,
    );
  if (!updates.length) {
    state.sheetWritePending = 0;
    return;
  }
  if (!googleWriterConfigured()) {
    state.sheetWritePending = updates.length;
    return;
  }
  try {
    for (const batch of chunks(updates, 100)) {
      state.sheetCellsWritten += await writeSkuCellsToSheet(batch);
      for (const entry of batch) delete state.pendingSkuWrites[entry.key];
    }
    state.sheetWritePending = Object.keys(state.pendingSkuWrites).length;
  } catch (error: any) {
    state.sheetWritePending = Object.keys(state.pendingSkuWrites).length;
    state.issues.push({
      stage: "sheet_writeback",
      error: String(error?.message || error).slice(0, 1000),
    });
  }
}

async function runPhase(params: {
  markerId: string;
  state: WorkerState;
  rows: CatalogRow[];
  createMissingProducts: boolean;
}) {
  const deferred: CatalogRow[] = [];
  const batchSize = Math.max(
    1,
    Math.min(
      50,
      Number(process.env.SYNC_SHEET1_CATALOG_BATCH_SIZE || DEFAULT_BATCH_SIZE) ||
      DEFAULT_BATCH_SIZE,
    ),
  );
  const concurrency = Math.max(
    1,
    Math.min(
      4,
      Number(process.env.SYNC_SHEET1_CATALOG_CONCURRENCY || 3) || 3,
    ),
  );
  const work = FIRST_EIGHT_CATALOG_SHEETS.flatMap((sheet) =>
    chunks(
      params.rows.filter((entry) => entry.sheet.gid === sheet.gid),
      batchSize,
    ).map((batchRows) => ({ sheet, batchRows })),
  );

  const applyCompleted = async ({
    sheet,
    batchRows,
    result,
  }: {
    sheet: SheetConfig;
    batchRows: CatalogRow[];
    result: Awaited<ReturnType<typeof processGoogleSheetBatch>>;
  }) => {
    params.state.lastBatchId = result.batchId;
    const batchByRow = new Map(
      batchRows.map((entry) => [entry.row.rowNumber, entry] as const),
    );
    await writeSuccessfulSkus(
      result.successful,
      sheet,
      batchByRow,
      params.state,
    );

    for (const entry of result.successful) {
      const original = batchByRow.get(entry.rowNumber);
      if (!original) continue;
      params.state.fingerprints[original.key] = original.fingerprint;
      params.state.verifiedFingerprints[original.key] = original.fingerprint;
      if (entry.action === "reconciled_existing" || entry.action === "synced_existing") {
        params.state.existingUpdated += 1;
      } else {
        params.state.published += 1;
      }
    }
    for (const entry of result.skipped) {
      const original = batchByRow.get(entry.rowNumber);
      if (entry.reason === "missing_product_deferred_for_publish_phase" && original) {
        deferred.push(original);
      } else {
        if (original) {
          params.state.fingerprints[original.key] = original.fingerprint;
          delete params.state.verifiedFingerprints[original.key];
        }
        params.state.skipped += 1;
        params.state.issues.push({
          stage: params.state.stage,
          sheetId: sheet.sheetId,
          sheetName: sheet.name,
          ...entry,
        });
      }
    }
    for (const entry of result.failed) {
      const original = batchByRow.get(entry.rowNumber);
      if (original) {
        params.state.fingerprints[original.key] = original.fingerprint;
        delete params.state.verifiedFingerprints[original.key];
      }
      params.state.failed += 1;
      params.state.issues.push({
        stage: params.state.stage,
        sheetId: sheet.sheetId,
        sheetName: sheet.name,
        ...entry,
      });
    }
    params.state.issues = params.state.issues.slice(-200);
    await persist(params.markerId, params.state);
  };

  for (const window of chunks(work, concurrency)) {
    const pending = window.map(async ({ sheet, batchRows }) => ({
      sheet,
      batchRows,
      result: await processGoogleSheetBatch({
        sheetUrl: sheetUrl(sheet),
        rowNumbers: batchRows.map((entry) => entry.row.rowNumber),
        createManualReview: true,
        processOnlyNewRows: false,
        waitForPublishCompletion: true,
        createMissingProducts: params.createMissingProducts,
        mode: "auto_sync",
      }),
    }));

    // Apply each batch as soon as it completes, while keeping state writes
    // sequential so a slow neighboring batch cannot delay fresh progress.
    while (pending.length) {
      const { index, value } = await Promise.race(
        pending.map((promise, index) =>
          promise.then((value) => ({ index, value })),
        ),
      );
      pending.splice(index, 1);
      await applyCompleted(value);
    }
    await sleep(500);
  }
  return deferred;
}

async function loadTargetRows(state: WorkerState) {
  const loaded = await Promise.all(
    FIRST_EIGHT_CATALOG_SHEETS.map(async (sheet) => ({
      sheet,
      data: await loadGoogleSheetRows(sheetUrl(sheet)),
    })),
  );
  const validBySheet = new Map<number, CatalogRow[]>();

  for (const { sheet, data } of loaded) {
    const validRows: CatalogRow[] = [];
    for (const row of data.rows) {
      const key = rowKey(sheet, row.rowNumber);
      const fingerprint = googleSheetRowFingerprint(row);
      const pendingSku = state.pendingSkuWrites[key];
      if (
        pendingSku &&
        String(row.sku || "").trim().toUpperCase() === pendingSku.trim().toUpperCase()
      ) {
        delete state.pendingSkuWrites[key];
      }
      const issueOnce = (reason: string) => {
        if (state.fingerprints[key] === fingerprint.hash) return;
        state.failed += 1;
        state.issues.push({
          stage: "sheet_validation",
          sheetId: sheet.sheetId,
          sheetName: sheet.name,
          rowNumber: row.rowNumber,
          url: row.url,
          reason,
        });
        state.fingerprints[key] = fingerprint.hash;
      };

      if (!/^https?:\/\//i.test(fingerprint.normalizedUrl)) {
        issueOnce("Invalid product URL");
        continue;
      }
      if (row.priceMultiplier === null) {
        issueOnce("Missing or invalid price multiplier; product was not published");
        continue;
      }
      validRows.push({ sheet, row, key, fingerprint: fingerprint.hash });
    }
    validBySheet.set(sheet.gid, validRows);
  }

  // Interleave rows so the 5000-product target genuinely covers all eight tabs
  // instead of being consumed by the first large tab alone.
  const selected: CatalogRow[] = [];
  const seenUrls = new Set<string>();
  const cursors = new Map<number, number>();
  while (selected.length < targetRowLimit()) {
    let advanced = false;
    for (const sheet of FIRST_EIGHT_CATALOG_SHEETS) {
      const rows = validBySheet.get(sheet.gid) || [];
      const cursor = cursors.get(sheet.gid) || 0;
      if (cursor >= rows.length) continue;
      advanced = true;
      const entry = rows[cursor];
      cursors.set(sheet.gid, cursor + 1);
      if (processedButUnverified(state, entry)) {
        continue;
      }
      const normalizedUrl = googleSheetRowFingerprint(entry.row).normalizedUrl;
      if (seenUrls.has(normalizedUrl)) {
        if (state.fingerprints[entry.key] !== entry.fingerprint) {
          state.skipped += 1;
          state.issues.push({
            stage: "sheet_validation",
            sheetId: sheet.sheetId,
            sheetName: sheet.name,
            rowNumber: entry.row.rowNumber,
            url: entry.row.url,
            reason: "Duplicate URL across the first eight sheets",
          });
          state.fingerprints[entry.key] = entry.fingerprint;
        }
        continue;
      }
      seenUrls.add(normalizedUrl);
      selected.push(entry);
      if (selected.length >= targetRowLimit()) break;
    }
    if (!advanced) break;
  }
  state.sheetWritePending = Object.keys(state.pendingSkuWrites).length;
  return selected;
}

async function findLinkedCatalogUrls(rows: CatalogRow[]) {
  const urls = [
    ...new Set(
      rows.map(
        (entry) => googleSheetRowFingerprint(entry.row).normalizedUrl,
      ),
    ),
  ];
  const found = await Promise.all(
    chunks(urls, 500).map((urlBatch) =>
      prisma.sourceProduct.findMany({
        where: {
          url: { in: urlBatch },
          shopifyProduct: { isNot: null },
        },
        select: { url: true },
      }),
    ),
  );
  return new Set(found.flat().map((entry) => entry.url));
}

async function runCycle(markerId: string, state: WorkerState) {
  await flushPendingSkuWrites(state);
  const targetRows = await loadTargetRows(state);
  state.verifiedFingerprints = Object.fromEntries(
    targetRows
      .filter(
        (entry) =>
          state.verifiedFingerprints[entry.key] === entry.fingerprint,
      )
      .map((entry) => [entry.key, entry.fingerprint]),
  );
  const candidates = targetRows.filter(
    (entry) => state.fingerprints[entry.key] !== entry.fingerprint,
  );
  state.cycle += 1;
  state.totalRows = targetRows.length;
  state.targetRows = targetRows.length;
  state.candidateRows = candidates.length;
  state.lastRunAt = new Date().toISOString();
  state.stage = "update_existing_first";
  await persist(markerId, state);

  const linkedUrls = await findLinkedCatalogUrls(candidates);
  const existingRows = candidates.filter((entry) =>
    linkedUrls.has(googleSheetRowFingerprint(entry.row).normalizedUrl),
  );
  const initiallyMissingRows = candidates.filter(
    (entry) =>
      !linkedUrls.has(googleSheetRowFingerprint(entry.row).normalizedUrl),
  );
  const newlyDeferredRows = await runPhase({
    markerId,
    state,
    rows: existingRows,
    createMissingProducts: false,
  });
  const missingRows = [
    ...new Map(
      [...initiallyMissingRows, ...newlyDeferredRows].map((entry) => [
        entry.key,
        entry,
      ]),
    ).values(),
  ];
  state.stage = "publish_missing_products";
  await persist(markerId, state);
  const missingRowsForThisCycle = missingRows.slice(
    0,
    missingRowsPerCycleLimit(missingRows.length),
  );
  await runPhase({
    markerId,
    state,
    rows: missingRowsForThisCycle,
    createMissingProducts: true,
  });
  state.stage = state.remainingRows === 0 ? "target_complete_monitoring" : "idle_monitoring";
  state.lastRunAt = new Date().toISOString();
  await persist(markerId, state);
}

async function runContinuousWorker() {
  await prisma.syncJob.updateMany({
    where: {
      type: { startsWith: "SHEET1_CATALOG_AUTO_SYNC:", not: SHEET1_CATALOG_MARKER_TYPE },
      status: { in: ["running", "pending"] },
    },
    data: {
      status: "failed",
      completedAt: new Date(),
      result: JSON.stringify({
        stage: "superseded_by_first_eight_worker",
        reason: "A newer deployment safely took over the catalog worker.",
      }),
    },
  });
  const previous = await prisma.syncJob.findFirst({
    where: { type: SHEET1_CATALOG_MARKER_TYPE },
    orderBy: { createdAt: "desc" },
  });
  if (previous && ["running", "pending"].includes(previous.status)) {
    await prisma.syncJob.update({
      where: { id: previous.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        result: JSON.stringify({
          ...parseState(previous.result),
          stage: "deployment_takeover",
          error: "Previous Railway process stopped; the new deployment resumed safely.",
        }),
      },
    });
  }
  const state = initialState(parseState(previous?.result));
  const marker = await prisma.syncJob.create({
    data: {
      type: SHEET1_CATALOG_MARKER_TYPE,
      status: "running",
      startedAt: new Date(),
      payload: JSON.stringify({
        spreadsheetId: SPREADSHEET_ID,
        sheets: FIRST_EIGHT_CATALOG_SHEETS,
        targetRows: targetRowLimit(),
        updateExistingFirst: true,
        createMissingProducts: true,
        deterministicSku: true,
      }),
      result: JSON.stringify(state),
    },
  });
  const pollMs = Math.max(
    60_000,
    Number(process.env.SYNC_SHEET1_CATALOG_POLL_MS || DEFAULT_POLL_MS) ||
      DEFAULT_POLL_MS,
  );

  while (true) {
    try {
      await runCycle(marker.id, state);
    } catch (error: any) {
      state.stage = "cycle_failed_retrying";
      state.failed += 1;
      state.issues.push({
        stage: "worker",
        error: String(error?.message || error).slice(0, 2000),
      });
      state.issues = state.issues.slice(-200);
      await persist(marker.id, state);
    }
    await sleep(pollMs);
  }
}

export function startSheet1CatalogAutoSync() {
  if (!sheet1CatalogAutoSyncEnabled()) {
    console.log(
      "[sheet1-catalog] autostart blocked: requires Railway production branch stabilize-supabase-railway, runtime writes, catalog autostart flag, exact deployed revision, and no kill switch",
    );
    return;
  }
  if (started) return;
  started = true;
  console.warn(
    "[sheet1-catalog] first-eight-sheet worker ENABLED: 5000 unique rows, update existing first, publish verified missing products, deterministic SKU writeback",
  );
  setTimeout(() => {
    void runContinuousWorker().catch((error) => {
      console.error("[sheet1-catalog] fatal worker error", error);
    });
  }, START_DELAY_MS);
}
