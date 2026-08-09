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
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit?gid=0`;
export const SHEET1_CATALOG_MARKER_TYPE =
  "SHEET1_CATALOG_AUTO_SYNC:2026-08-09-v4-flattened-duplicate-priority";
const START_DELAY_MS = 20_000;
const DEFAULT_POLL_MS = 30 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 20;
let started = false;

type WorkerState = {
  stage: string;
  cycle: number;
  fingerprints: Record<string, string>;
  totalRows: number;
  candidateRows: number;
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
  return {
    stage: "starting",
    cycle: Number(previous?.cycle || 0),
    fingerprints:
      previous?.fingerprints && typeof previous.fingerprints === "object"
        ? previous.fingerprints
        : {},
    totalRows: 0,
    candidateRows: 0,
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

async function persist(markerId: string, state: WorkerState) {
  await prisma.syncJob.update({
    where: { id: markerId },
    data: { result: JSON.stringify(state) },
  });
}

async function writeSuccessfulSkus(
  successful: Array<{ rowNumber: number; sku?: string }>,
  state: WorkerState,
) {
  const updates = successful
    .filter((entry) => entry.sku)
    .map((entry) => ({ sheetId: 0, rowNumber: entry.rowNumber, sku: entry.sku! }));
  if (!updates.length) return;
  for (const update of updates) {
    state.pendingSkuWrites[String(update.rowNumber)] = update.sku;
  }
  state.sheetWritePending = Object.keys(state.pendingSkuWrites).length;
  await flushPendingSkuWrites(state);
}

async function flushPendingSkuWrites(state: WorkerState) {
  const updates = Object.entries(state.pendingSkuWrites).map(([rowNumber, sku]) => ({
    sheetId: 0,
    rowNumber: Number(rowNumber),
    sku,
  }));
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
      for (const entry of batch) {
        delete state.pendingSkuWrites[String(entry.rowNumber)];
      }
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
  rowNumbers: number[];
  rowFingerprints: Record<string, string>;
  rowsByNumber: Record<string, GoogleSheetRow>;
  createMissingProducts: boolean;
}) {
  const deferred: number[] = [];
  const batchSize = Math.max(
    1,
    Number(process.env.SYNC_SHEET1_CATALOG_BATCH_SIZE || DEFAULT_BATCH_SIZE) ||
      DEFAULT_BATCH_SIZE,
  );

  for (const rowNumbers of chunks(params.rowNumbers, batchSize)) {
    const result = await processGoogleSheetBatch({
      sheetUrl: SHEET_URL,
      rowNumbers,
      createManualReview: true,
      processOnlyNewRows: false,
      waitForPublishCompletion: true,
      createMissingProducts: params.createMissingProducts,
      mode: "auto_sync",
    });
    params.state.lastBatchId = result.batchId;
    await writeSuccessfulSkus(result.successful, params.state);

    for (const entry of result.successful) {
      const originalRow = params.rowsByNumber[String(entry.rowNumber)];
      const skuWasWritten =
        Boolean(entry.sku) &&
        !params.state.pendingSkuWrites[String(entry.rowNumber)];
      const fingerprint = originalRow
        ? googleSheetRowFingerprint({
            ...originalRow,
            sku: skuWasWritten ? entry.sku : originalRow.sku,
          }).hash
        : params.rowFingerprints[String(entry.rowNumber)];
      if (fingerprint) {
        params.state.fingerprints[String(entry.rowNumber)] = fingerprint;
      }
      if (entry.action === "reconciled_existing" || entry.action === "synced_existing") {
        params.state.existingUpdated += 1;
      } else {
        params.state.published += 1;
      }
    }
    for (const entry of result.skipped) {
      if (entry.reason === "missing_product_deferred_for_publish_phase") {
        deferred.push(entry.rowNumber);
      } else {
        params.state.skipped += 1;
        params.state.issues.push({ stage: params.state.stage, ...entry });
      }
    }
    for (const entry of result.failed) {
      params.state.failed += 1;
      params.state.issues.push({ stage: params.state.stage, ...entry });
      if (/missing or invalid price multiplier/i.test(entry.reason)) {
        const fingerprint = params.rowFingerprints[String(entry.rowNumber)];
        if (fingerprint) {
          params.state.fingerprints[String(entry.rowNumber)] = fingerprint;
        }
      }
    }
    params.state.issues = params.state.issues.slice(-200);
    await persist(params.markerId, params.state);
    await sleep(500);
  }
  return deferred;
}

async function runCycle(markerId: string, state: WorkerState) {
  await flushPendingSkuWrites(state);
  const sheet = await loadGoogleSheetRows(SHEET_URL);
  const uniqueRows: GoogleSheetRow[] = [];
  const seenUrls = new Set<string>();
  for (const row of sheet.rows) {
    const fingerprint = googleSheetRowFingerprint(row);
    if (!/^https?:\/\//i.test(fingerprint.normalizedUrl)) {
      if (state.fingerprints[String(row.rowNumber)] !== fingerprint.hash) {
        state.failed += 1;
        state.issues.push({
          stage: "sheet_validation",
          rowNumber: row.rowNumber,
          url: row.url,
          reason: "Invalid product URL in Sheet 1",
        });
        state.fingerprints[String(row.rowNumber)] = fingerprint.hash;
      }
      continue;
    }
    if (seenUrls.has(fingerprint.normalizedUrl)) {
      if (state.fingerprints[String(row.rowNumber)] !== fingerprint.hash) {
        state.skipped += 1;
        state.issues.push({
          stage: "sheet_validation",
          rowNumber: row.rowNumber,
          url: row.url,
          reason: "Duplicate URL in Sheet 1",
        });
        state.fingerprints[String(row.rowNumber)] = fingerprint.hash;
      }
      continue;
    }
    seenUrls.add(fingerprint.normalizedUrl);
    uniqueRows.push(row);
  }
  const candidates = uniqueRows.filter(
    (row) =>
      state.fingerprints[String(row.rowNumber)] !==
      googleSheetRowFingerprint(row).hash,
  );
  state.cycle += 1;
  state.totalRows = uniqueRows.length;
  state.candidateRows = candidates.length;
  state.lastRunAt = new Date().toISOString();
  state.stage = "update_existing_first";
  await persist(markerId, state);

  const missingRows = await runPhase({
    markerId,
    state,
    rowNumbers: candidates.map((row) => row.rowNumber),
    rowFingerprints: Object.fromEntries(
      candidates.map((row) => [String(row.rowNumber), googleSheetRowFingerprint(row).hash]),
    ),
    rowsByNumber: Object.fromEntries(
      candidates.map((row) => [String(row.rowNumber), row]),
    ),
    createMissingProducts: false,
  });
  state.stage = "publish_missing_products";
  await persist(markerId, state);
  await runPhase({
    markerId,
    state,
    rowNumbers: missingRows,
    rowFingerprints: Object.fromEntries(
      candidates.map((row) => [String(row.rowNumber), googleSheetRowFingerprint(row).hash]),
    ),
    rowsByNumber: Object.fromEntries(
      candidates.map((row) => [String(row.rowNumber), row]),
    ),
    createMissingProducts: true,
  });
  state.stage = "idle_monitoring";
  state.lastRunAt = new Date().toISOString();
  await persist(markerId, state);
}

async function runContinuousWorker() {
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
        gid: 0,
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
    "[sheet1-catalog] automatic update-existing-first, publish-missing, SKU-writeback worker ENABLED",
  );
  setTimeout(() => {
    void runContinuousWorker().catch((error) => {
      console.error("[sheet1-catalog] fatal worker error", error);
    });
  }, START_DELAY_MS);
}
