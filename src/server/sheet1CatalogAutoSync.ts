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
  hmPriceRetryFingerprints: Record<string, string>;
  blockedHostRetryFingerprints: Record<string, string>;
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
    process.env.SYNC_SHEET1_CATALOG_DEPLOYED_REVISION ||
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
    process.env.SYNC_SHEET1_CATALOG_BRANCH ||
      process.env.RAILWAY_GIT_BRANCH ||
      process.env.GIT_BRANCH ||
      "",
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
    enabled("SYNC_POST_CANARY_BROAD_WRITES_ENABLED") &&
    enabled("SYNC_SHEET1_CATALOG_AUTOSTART_ENABLED") &&
    !enabled("SYNC_SHEET1_CATALOG_AUTOSTART_DISABLED") &&
    revisionAuthorized()
  );
}

function sheet1CatalogAutoSyncGateSnapshot() {
  const branch = String(
    process.env.SYNC_SHEET1_CATALOG_BRANCH ||
      process.env.RAILWAY_GIT_BRANCH ||
      process.env.GIT_BRANCH ||
      "",
  )
    .trim()
    .replace(/^refs\/heads\//, "");
  const expected = String(process.env.SYNC_SHEET1_CATALOG_REVISION || "").trim();
  const actual = deployedRevision();
  const railway = Boolean(
    String(process.env.RAILWAY_ENVIRONMENT || "").trim() ||
      String(process.env.RAILWAY_PUBLIC_DOMAIN || "").trim(),
  );
  return {
    production:
      String(process.env.NODE_ENV || "").trim().toLowerCase() === "production",
    railway,
    branch,
    branchOk: branch === "stabilize-supabase-railway",
    runtimeWriteEnabled: enabled("SYNC_RUNTIME_WRITE_ENABLED"),
    postCanaryBroadWritesEnabled: enabled("SYNC_POST_CANARY_BROAD_WRITES_ENABLED"),
    autostartEnabled: enabled("SYNC_SHEET1_CATALOG_AUTOSTART_ENABLED"),
    killSwitchEnabled: enabled("SYNC_SHEET1_CATALOG_AUTOSTART_DISABLED"),
    expectedRevisionOk: /^[0-9a-f]{40}$/i.test(expected),
    actualRevisionOk: /^[0-9a-f]{40}$/i.test(actual),
    revisionMatches:
      expected.toLowerCase() === actual.toLowerCase() &&
      /^[0-9a-f]{40}$/i.test(expected) &&
      /^[0-9a-f]{40}$/i.test(actual),
    actualRevisionPrefix: actual ? actual.slice(0, 8) : "missing",
    expectedRevisionPrefix: expected ? expected.slice(0, 8) : "missing",
  };
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
  const fingerprints =
    previous?.fingerprints && typeof previous.fingerprints === "object"
      ? previous.fingerprints
      : {};
  const hmPriceRetryFingerprints =
    previous?.hmPriceRetryFingerprints &&
    typeof previous.hmPriceRetryFingerprints === "object"
      ? previous.hmPriceRetryFingerprints
      : {};
  const blockedHostRetryFingerprints =
    previous?.blockedHostRetryFingerprints &&
    typeof previous.blockedHostRetryFingerprints === "object"
      ? previous.blockedHostRetryFingerprints
      : {};
  for (const issue of Array.isArray(previous?.issues) ? previous.issues.slice(-200) : []) {
    const reason = String(issue.reason || issue.error || "");
    const host = normalizedUrlHost(issue.url);
    const sheetId = Number(issue.sheetId);
    const rowNumber = Number(issue.rowNumber);
    const key = `${sheetId}:${rowNumber}`;
    const fastSkipMatch = reason.match(
      /Source host\s+([a-z0-9.-]+)\s+skipped after\s+(\d+)\s+blocked scrape failures/i,
    );
    if (
      /Product source price is invalid/i.test(reason) &&
      host.includes("hm.com") &&
      Number.isSafeInteger(sheetId) &&
      Number.isSafeInteger(rowNumber) &&
      fingerprints[key]
    ) {
      hmPriceRetryFingerprints[key] = fingerprints[key];
    }
    if (
      (isBlockedSourceReason(reason) || fastSkipMatch) &&
      !host.includes("hm.com") &&
      Number.isSafeInteger(sheetId) &&
      Number.isSafeInteger(rowNumber) &&
      fingerprints[key]
    ) {
      blockedHostRetryFingerprints[key] = fingerprints[key];
    }
  }
  return {
    stage: "starting",
    cycle: Number(previous?.cycle || 0),
    fingerprints,
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
    hmPriceRetryFingerprints,
    blockedHostRetryFingerprints,
    lastBatchId: previous?.lastBatchId || null,
    lastRunAt: previous?.lastRunAt || null,
    issues: Array.isArray(previous?.issues) ? previous.issues.slice(-200) : [],
  };
}

function numericMax(values: Array<unknown>, fallback = 0): number {
  return values.reduce<number>((max, value) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(max, number) : max;
  }, fallback);
}

function objectRecord(value: unknown): Record<string, string> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, string>)
    : {};
}

function mergeResumeStates(states: Array<Partial<WorkerState>>): Partial<WorkerState> {
  const validStates = states.filter((state) => state && typeof state === "object");
  if (!validStates.length) return {};

  const latest = validStates[0] || {};
  const merged: Partial<WorkerState> = {
    ...latest,
    cycle: numericMax(validStates.map((state) => state.cycle)),
    existingUpdated: numericMax(validStates.map((state) => state.existingUpdated)),
    published: numericMax(validStates.map((state) => state.published)),
    failed: numericMax(validStates.map((state) => state.failed)),
    skipped: numericMax(validStates.map((state) => state.skipped)),
    sheetCellsWritten: numericMax(validStates.map((state) => state.sheetCellsWritten)),
    fingerprints: {},
    verifiedFingerprints: {},
    pendingSkuWrites: {},
    hmPriceRetryFingerprints: {},
    blockedHostRetryFingerprints: {},
    issues: [],
  };

  for (const state of validStates.slice().reverse()) {
    Object.assign(merged.fingerprints!, objectRecord(state.fingerprints));
    Object.assign(
      merged.verifiedFingerprints!,
      objectRecord(state.verifiedFingerprints),
    );
    Object.assign(merged.pendingSkuWrites!, objectRecord(state.pendingSkuWrites));
    Object.assign(
      merged.hmPriceRetryFingerprints!,
      objectRecord(state.hmPriceRetryFingerprints),
    );
    Object.assign(
      merged.blockedHostRetryFingerprints!,
      objectRecord(state.blockedHostRetryFingerprints),
    );
    if (Array.isArray(state.issues)) {
      merged.issues!.push(...state.issues);
    }
    if (!merged.lastBatchId && state.lastBatchId) merged.lastBatchId = state.lastBatchId;
    if (!merged.lastRunAt && state.lastRunAt) merged.lastRunAt = state.lastRunAt;
  }

  merged.issues = merged.issues!.slice(-200);
  merged.sheetWritePending = Object.keys(merged.pendingSkuWrites || {}).length;
  merged.verifiedRows = Object.keys(merged.verifiedFingerprints || {}).length;
  return merged;
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

function hmPriceRetryAttempted(state: WorkerState, entry: CatalogRow) {
  return state.hmPriceRetryFingerprints[entry.key] === entry.fingerprint;
}

function markHmPriceRetryAttempt(state: WorkerState, entry: CatalogRow) {
  state.hmPriceRetryFingerprints[entry.key] = entry.fingerprint;
}

function blockedHostRetryMarker(entry: CatalogRow) {
  const host = catalogRowHost(entry);
  const centrepointRecoveryRevision = String(
    process.env.SYNC_SHEET1_CATALOG_CENTREPOINT_RECOVERY_REVISION || "",
  )
    .trim()
    .toLowerCase();
  if (
    host.includes("centrepointstores.com") &&
    /^[a-z0-9._:-]{3,80}$/i.test(centrepointRecoveryRevision)
  ) {
    return `${entry.fingerprint}:${centrepointRecoveryRevision}`;
  }
  return entry.fingerprint;
}

function blockedHostRetryAttempted(state: WorkerState, entry: CatalogRow) {
  return (
    state.blockedHostRetryFingerprints[entry.key] ===
    blockedHostRetryMarker(entry)
  );
}

function markBlockedHostRetryAttempt(state: WorkerState, entry: CatalogRow) {
  state.blockedHostRetryFingerprints[entry.key] = blockedHostRetryMarker(entry);
}

function retryableProcessedIssueKeysFromRecentIssues(state: WorkerState) {
  const keys = new Set<string>();
  for (const issue of state.issues.slice(-200)) {
    const reason = String(issue.reason || issue.error || "");
    const host = normalizedUrlHost(issue.url);
    const sheetId = Number(issue.sheetId);
    const rowNumber = Number(issue.rowNumber);
    if (
      /Product source price is invalid/i.test(reason) &&
      host.includes("hm.com") &&
      Number.isSafeInteger(sheetId) &&
      Number.isSafeInteger(rowNumber) &&
      rowNumber > 0
    ) {
      keys.add(`${sheetId}:${rowNumber}`);
    }
  }
  return keys;
}

async function retryableHmPriceIssueKeysFromDatabase(
  state: WorkerState,
  entries: CatalogRow[],
) {
  const byUrl = new Map<string, string[]>();
  for (const entry of entries) {
    if (!processedButUnverified(state, entry)) continue;
    if (hmPriceRetryAttempted(state, entry)) continue;
    const normalizedUrl = googleSheetRowFingerprint(entry.row).normalizedUrl;
    if (!normalizedUrlHost(normalizedUrl).includes("hm.com")) continue;
    const keys = byUrl.get(normalizedUrl) || [];
    keys.push(entry.key);
    byUrl.set(normalizedUrl, keys);
  }

  const urls = [...byUrl.keys()];
  if (!urls.length) return new Set<string>();

  const retryable = new Set<string>();
  for (const urlBatch of chunks(urls, 500)) {
    const products = await prisma.sourceProduct.findMany({
      where: {
        url: { in: urlBatch },
        OR: [
          { raw: { contains: "Product source price is invalid" } },
          {
            manualReviews: {
              some: {
                reason: { contains: "Product source price is invalid" },
              },
            },
          },
        ],
      },
      select: { url: true },
    });
    for (const product of products) {
      for (const key of byUrl.get(product.url) || []) retryable.add(key);
    }
  }

  return retryable;
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

function hmPriceRetryRowsPerCycleLimit() {
  const configured = Number(
    process.env.SYNC_SHEET1_CATALOG_HM_PRICE_RETRY_ROWS_PER_CYCLE || 10,
  );
  return Math.max(
    0,
    Math.min(
      100,
      Number.isFinite(configured) ? Math.floor(configured) : 10,
    ),
  );
}

function blockedHostRetryRowsPerCycleLimit() {
  const configured = Number(
    process.env.SYNC_SHEET1_CATALOG_BLOCKED_HOST_RETRY_ROWS_PER_CYCLE || 20,
  );
  return Math.max(
    0,
    Math.min(
      200,
      Number.isFinite(configured) ? Math.floor(configured) : 20,
    ),
  );
}

function blockedHostRecoveryProbesPerCycleLimit() {
  const configured = Number(
    process.env.SYNC_SHEET1_CATALOG_BLOCKED_HOST_PROBES_PER_CYCLE || 5,
  );
  return Math.max(
    1,
    Math.min(
      25,
      Number.isFinite(configured) ? Math.floor(configured) : 5,
    ),
  );
}

function blockedHostFastSkipThreshold() {
  const configured = Number(
    process.env.SYNC_SHEET1_CATALOG_BLOCKED_HOST_FAST_SKIP_THRESHOLD || 0,
  );
  return Math.max(
    0,
    Math.min(
      250,
      Number.isFinite(configured) ? Math.floor(configured) : 0,
    ),
  );
}

function normalizedUrlHost(url: unknown) {
  try {
    return new URL(String(url || ""))
      .hostname
      .replace(/^www\./i, "")
      .toLowerCase();
  } catch {
    return "";
  }
}

function catalogRowHost(entry: CatalogRow) {
  return normalizedUrlHost(googleSheetRowFingerprint(entry.row).normalizedUrl);
}

function isBlockedSourceReason(reason: unknown) {
  return /blocked automated server access|No usable product HTML returned|ScraperAPI HTTP (?:403|499)|Reader fallbacks failed|Reader fallback returned an access-denied or missing page|Playwright returned non-product HTML|Managed bypass failed|HTTP 429|SHEIN snapshot returned a challenge or rate-limit page/i.test(
    String(reason || ""),
  );
}

function seedBlockedHostCountsFromRecentIssues(
  state: WorkerState,
  threshold: number,
) {
  const counts = new Map<string, number>();
  if (threshold <= 0) return counts;

  for (const issue of state.issues.slice(-200)) {
    const reason = String(issue.reason || issue.error || "");
    const blocked = isBlockedSourceReason(reason);
    const fastSkipMatch = reason.match(
      /Source host\s+([a-z0-9.-]+)\s+skipped after\s+(\d+)\s+blocked scrape failures/i,
    );
    if (!blocked && !fastSkipMatch) continue;

    const host = normalizedUrlHost(issue.url) || fastSkipMatch?.[1]?.toLowerCase() || "";
    if (!host) continue;

    if (fastSkipMatch) {
      counts.set(
        host,
        Math.max(counts.get(host) || 0, Number(fastSkipMatch[2]) || threshold),
      );
    } else {
      counts.set(host, Math.min(250, (counts.get(host) || 0) + 1));
    }
  }

  return counts;
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
  const blockedHostThreshold = blockedHostFastSkipThreshold();
  const blockedHostCounts = seedBlockedHostCountsFromRecentIssues(
    params.state,
    blockedHostThreshold,
  );
  const blockedHostRecoveryProbeLimit = blockedHostRecoveryProbesPerCycleLimit();
  const blockedHostRecoveryProbes = new Map<string, number>();
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
  const batchesBySheet = new Map(
    FIRST_EIGHT_CATALOG_SHEETS.map((sheet) => [
      sheet.gid,
      chunks(
        params.rows.filter((entry) => entry.sheet.gid === sheet.gid),
        batchSize,
      ),
    ]),
  );
  const work: Array<{ sheet: SheetConfig; batchRows: CatalogRow[] }> = [];
  for (let batchIndex = 0; ; batchIndex += 1) {
    let advanced = false;
    for (const sheet of FIRST_EIGHT_CATALOG_SHEETS) {
      const batchRows = batchesBySheet.get(sheet.gid)?.[batchIndex];
      if (!batchRows?.length) continue;
      work.push({ sheet, batchRows });
      advanced = true;
    }
    if (!advanced) break;
  }

  const applyCompleted = async ({
    sheet,
    batchRows,
    result,
  }: {
    sheet: SheetConfig;
    batchRows: CatalogRow[];
    result: Pick<
      Awaited<ReturnType<typeof processGoogleSheetBatch>>,
      "batchId" | "successful" | "skipped" | "failed"
    >;
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
      const host = original ? catalogRowHost(original) : "";
      if (host) blockedHostCounts.set(host, 0);
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
        const host = catalogRowHost(original);
        if (host && isBlockedSourceReason(entry.reason)) {
          blockedHostCounts.set(host, (blockedHostCounts.get(host) || 0) + 1);
        } else if (host) {
          blockedHostCounts.set(host, 0);
        }
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
    const pending = window.map(async ({ sheet, batchRows }) => {
      const activeRows: CatalogRow[] = [];
      const fastFailed: Array<{
        rowNumber: number;
        url: string;
        reason: string;
      }> = [];

      for (const entry of batchRows) {
        const host = catalogRowHost(entry);
        if (
          blockedHostThreshold > 0 &&
          host &&
          (blockedHostCounts.get(host) || 0) >= blockedHostThreshold &&
          (blockedHostRecoveryProbes.get(host) || 0) >=
            blockedHostRecoveryProbeLimit
        ) {
          fastFailed.push({
            rowNumber: entry.row.rowNumber,
            url: googleSheetRowFingerprint(entry.row).normalizedUrl,
            reason:
              `Source host ${host} skipped after ${blockedHostCounts.get(host)} blocked scrape failures in this worker phase; product was not published.`,
          });
        } else {
          if (
            blockedHostThreshold > 0 &&
            host &&
            (blockedHostCounts.get(host) || 0) >= blockedHostThreshold
          ) {
            blockedHostRecoveryProbes.set(
              host,
              (blockedHostRecoveryProbes.get(host) || 0) + 1,
            );
          }
          activeRows.push(entry);
        }
      }

      if (!activeRows.length) {
        return {
          sheet,
          batchRows,
          result: {
            batchId: `blocked-host-fast-skip:${Date.now()}`,
            successful: [],
            skipped: [],
            failed: fastFailed,
          },
        };
      }

      const result = await processGoogleSheetBatch({
        sheetUrl: sheetUrl(sheet),
        rowNumbers: activeRows.map((entry) => entry.row.rowNumber),
        createManualReview: true,
        processOnlyNewRows: false,
        waitForPublishCompletion: true,
        createMissingProducts: params.createMissingProducts,
        mode: "auto_sync",
      });

      return {
        sheet,
        batchRows,
        result: {
          ...result,
          failed: [...result.failed, ...fastFailed],
        },
      };
    });

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
  const hmPriceRetryLimit = hmPriceRetryRowsPerCycleLimit();
  let hmPriceRetriesSelected = 0;
  const blockedHostRetryLimit = blockedHostRetryRowsPerCycleLimit();
  let blockedHostRetriesSelected = 0;
  const retryableProcessedKeys = retryableProcessedIssueKeysFromRecentIssues(state);
  const retryableDbKeys = await retryableHmPriceIssueKeysFromDatabase(
    state,
    [...validBySheet.values()].flat(),
  );
  for (const key of retryableDbKeys) retryableProcessedKeys.add(key);
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
        const normalizedUrl = googleSheetRowFingerprint(entry.row).normalizedUrl;
        const host = normalizedUrlHost(normalizedUrl);
        const hmPriceRetryEntry =
          retryableProcessedKeys.has(entry.key) &&
          host.includes("hm.com");
        if (
          hmPriceRetryEntry &&
          !hmPriceRetryAttempted(state, entry) &&
          hmPriceRetriesSelected < hmPriceRetryLimit
        ) {
          hmPriceRetriesSelected += 1;
          markHmPriceRetryAttempt(state, entry);
          delete state.fingerprints[entry.key];
          delete state.verifiedFingerprints[entry.key];
        } else if (
          host &&
          !host.includes("hm.com") &&
          !blockedHostRetryAttempted(state, entry) &&
          blockedHostRetriesSelected < blockedHostRetryLimit
        ) {
          blockedHostRetriesSelected += 1;
          markBlockedHostRetryAttempt(state, entry);
          delete state.fingerprints[entry.key];
          delete state.verifiedFingerprints[entry.key];
        }
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
          syncStatus: "active",
          shopifyProduct: {
            is: {
              status: "active",
              syncEnabled: true,
            },
          },
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
  const resumeJobs = await prisma.syncJob.findMany({
    where: { type: SHEET1_CATALOG_MARKER_TYPE },
    orderBy: { createdAt: "desc" },
    take: 25,
    select: { result: true },
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
  const state = initialState(
    mergeResumeStates(resumeJobs.map((job) => parseState(job.result))),
  );
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

async function persistedCanaryReadbackReady() {
  const recentCanaries = await prisma.importBatch.findMany({
    where: { target: "catalog_audit", status: "COMPLETED" },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { payloadJson: true },
  });

  for (const run of recentCanaries) {
    let payload: any = {};
    try {
      payload = JSON.parse(run.payloadJson || "{}");
    } catch {
      continue;
    }

    const summary = payload?.summary || {};
    const results = Array.isArray(payload?.results) ? payload.results : [];
    const provenance =
      payload?.provenance && typeof payload.provenance === "object"
        ? payload.provenance
        : {};
    const verifiedResults = results.filter(
      (result: any) =>
        result?.status === "verified" &&
        result?.readbackVerified === true &&
        /^gid:\/\/shopify\/Product\/\d+$/.test(
          String(result?.shopifyProductId || "").trim(),
        ),
    );
    const shopifyProductId = String(
      verifiedResults[0]?.shopifyProductId || "",
    ).trim();

    if (
      summary.dryRun === false &&
      summary.writeSheet !== true &&
      Number(summary.uniqueProductsProcessed || 0) === 1 &&
      Number(summary.verified || 0) === 1 &&
      Number(summary.missing || 0) === 0 &&
      Number(summary.ambiguous || 0) === 0 &&
      Number(summary.errors || 0) === 0 &&
      verifiedResults.length === 1 &&
      Boolean(String(provenance?.dryRunBatchId || "").trim()) &&
      String(provenance?.shopifyProductId || "").trim() === shopifyProductId
    ) {
      return true;
    }
  }

  return false;
}

export function startSheet1CatalogAutoSync() {
  if (!sheet1CatalogAutoSyncEnabled()) {
    console.log(
      "[sheet1-catalog] autostart blocked: requires Railway production branch stabilize-supabase-railway, runtime writes, catalog autostart flag, exact deployed revision, and no kill switch",
      sheet1CatalogAutoSyncGateSnapshot(),
    );
    return;
  }
  if (started) return;
  started = true;
  setTimeout(() => {
    void (async () => {
      const canaryReadbackReady = await persistedCanaryReadbackReady();
      if (!canaryReadbackReady) {
        console.error(
          "[sheet1-catalog] broad worker blocked: no persisted successful one-product canary with Shopify read-back provenance",
        );
        return;
      }
      console.warn(
        "[sheet1-catalog] first-eight-sheet worker ENABLED after persisted one-product canary read-back: 5000 unique rows, update existing first, publish verified missing products, deterministic SKU writeback",
      );
      await runContinuousWorker();
    })().catch((error) => {
      console.error("[sheet1-catalog] fatal worker error", error);
    });
  }, START_DELAY_MS);
}
