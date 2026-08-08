import axios from "axios";
import crypto from "crypto";
import { envString, isProduction } from "./config/env.js";
import { prisma } from "./db.js";

const SPREADSHEET_ID = "1fCbPajWL3nukX0TdoN1m2X8LV3pfPsxSMLBb0yWug2w";
const SHEET_GID = 0;
const RUN_CONFIRMATION = "2026-08-09-sheet1-reconcile-v1";
const MARKER_TYPE = `ONE_TIME_SHEET1_RECONCILE:${RUN_CONFIRMATION}`;

const START_DELAY_MS = 20_000;
const BETWEEN_ROWS_MS = 2_500;
const BETWEEN_PASSES_MS = 5 * 60 * 1000;
const FAILED_PASS_RETRY_MS = 60_000;
const RETRY_DELAYS_MS = [0, 10_000, 30_000] as const;

type SheetRow = {
  rowNumber: number;
  url: string;
  multiplier: number;
  sku: string;
};

type ReconcileResponse = {
  success?: boolean;
  batchId?: string;
  summary?: Record<string, any>;
  results?: Array<Record<string, any>>;
  error?: string;
};

type WorkerTotals = {
  attempted: number;
  verified: number;
  rowsProcessed: number;
  missing: number;
  ambiguous: number;
  conflicts: number;
  errors: number;
  retries: number;
  alreadyMarkedInSheet: number;
  previouslyVerified: number;
};

let workerStarted = false;

function clean(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"') {
      if (quoted && next === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }

  row.push(cell);
  if (row.some((value) => clean(value))) rows.push(row);
  return rows;
}

function parseMultiplier(value: unknown) {
  const normalized = clean(value).replace(/,/g, ".");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 100 ? parsed : null;
}

function readJson(value: string | null | undefined) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function loadSheetRows(): Promise<SheetRow[]> {
  const csvUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=csv&gid=${SHEET_GID}`;
  const response = await axios.get(csvUrl, {
    timeout: Number(process.env.GOOGLE_SHEET_FETCH_TIMEOUT_MS || 30_000),
    responseType: "text",
  });

  return parseCsv(String(response.data || ""))
    .map((cells, index): SheetRow | null => {
      const url = clean(cells[0]);
      const multiplier = parseMultiplier(cells[1]);
      if (!/^https?:\/\//i.test(url) || multiplier === null) return null;
      return {
        rowNumber: index + 1,
        url,
        multiplier,
        sku: clean(cells[3]),
      };
    })
    .filter((row): row is SheetRow => Boolean(row))
    .sort((a, b) => a.rowNumber - b.rowNumber);
}

async function loadPreviouslyVerifiedRows() {
  const verified = new Set<number>();
  const runs = await prisma.importBatch.findMany({
    where: { target: "sheet1_reconcile" },
    orderBy: { createdAt: "desc" },
    take: 10_000,
    select: { payloadJson: true },
  });

  for (const run of runs) {
    const payload = readJson(run.payloadJson) as any;
    if (payload?.summary?.dryRun === true) continue;
    const results = Array.isArray(payload?.results) ? payload.results : [];
    for (const result of results) {
      if (result?.status !== "verified" || result?.readbackVerified !== true) continue;
      if (!Array.isArray(result?.rows)) continue;
      for (const rawRow of result.rows) {
        const rowNumber = Number(rawRow);
        if (Number.isSafeInteger(rowNumber) && rowNumber > 0) verified.add(rowNumber);
      }
    }
  }

  return verified;
}

function ensureInternalWriteToken() {
  let token = clean(process.env.CATALOG_AUDIT_WRITE_TOKEN);
  if (!token) {
    token = crypto.randomBytes(32).toString("hex");
    process.env.CATALOG_AUDIT_WRITE_TOKEN = token;
    console.warn("[sheet1-worker] generated ephemeral in-process catalog write token");
  }
  return token;
}

async function postReconcile(port: number, rowNumber: number): Promise<ReconcileResponse> {
  const response = await axios.post(
    `http://127.0.0.1:${port}/api/sheet1-reconcile/run`,
    {
      dryRun: false,
      writeSheet: false,
      rowNumbers: [rowNumber],
    },
    {
      timeout: 8 * 60 * 1000,
      validateStatus: () => true,
      headers: {
        "Content-Type": "application/json",
        "x-catalog-audit-write-token": ensureInternalWriteToken(),
        "x-sheet1-reconcile-run": RUN_CONFIRMATION,
      },
    },
  );

  const body = response.data && typeof response.data === "object"
    ? (response.data as ReconcileResponse)
    : { error: clean(response.data) };

  if (response.status < 200 || response.status >= 300 || body.success !== true) {
    throw new Error(body.error || `Sheet1 reconcile returned HTTP ${response.status}`);
  }
  return body;
}

function resultStatus(response: ReconcileResponse) {
  const results = Array.isArray(response.results) ? response.results : [];
  if (!results.length) return "error";
  if (results.every((result) => result?.status === "verified" && result?.readbackVerified === true)) {
    return "verified";
  }
  if (results.some((result) => result?.status === "conflict")) return "conflict";
  if (results.some((result) => result?.status === "ambiguous")) return "ambiguous";
  if (results.some((result) => result?.status === "missing")) return "missing";
  return "error";
}

function collectIssue(response: ReconcileResponse | null, row: SheetRow, error = "") {
  const result = response?.results?.find((item) => item?.status !== "verified");
  return {
    row: row.rowNumber,
    url: row.url,
    status: clean(result?.status || "error"),
    productCode: clean(result?.productCode || ""),
    reason: clean(result?.reason || error || "Unknown reconcile error").slice(0, 2000),
  };
}

async function processRow(port: number, row: SheetRow, totals: WorkerTotals) {
  let lastResponse: ReconcileResponse | null = null;
  let lastError = "";

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay > 0) {
      totals.retries += 1;
      await sleep(delay);
    }

    try {
      const response = await postReconcile(port, row.rowNumber);
      lastResponse = response;
      const status = resultStatus(response);
      if (status !== "error") return { status, response, error: "" };
      lastError = clean(response.results?.[0]?.reason || "Reconcile returned error status");
    } catch (error: any) {
      lastError = clean(error?.message || error).slice(0, 2000);
    }
  }

  return { status: "error", response: lastResponse, error: lastError };
}

async function updateMarker(markerId: string, result: Record<string, any>) {
  await prisma.syncJob.update({
    where: { id: markerId },
    data: { result: JSON.stringify(result) },
  });
}

async function runPass(port: number) {
  const marker = await prisma.syncJob.create({
    data: {
      type: MARKER_TYPE,
      status: "running",
      startedAt: new Date(),
      payload: JSON.stringify({
        mode: "continuous_existing_products_only",
        spreadsheetId: SPREADSHEET_ID,
        sheetGid: SHEET_GID,
        createProducts: false,
        rebuildProducts: false,
        continueAfterRowErrors: true,
        retryDelaysMs: RETRY_DELAYS_MS,
        betweenRowsMs: BETWEEN_ROWS_MS,
      }),
    },
  });

  const totals: WorkerTotals = {
    attempted: 0,
    verified: 0,
    rowsProcessed: 0,
    missing: 0,
    ambiguous: 0,
    conflicts: 0,
    errors: 0,
    retries: 0,
    alreadyMarkedInSheet: 0,
    previouslyVerified: 0,
  };
  const issues: Array<Record<string, any>> = [];

  try {
    const [rows, previouslyVerified] = await Promise.all([
      loadSheetRows(),
      loadPreviouslyVerifiedRows(),
    ]);

    totals.previouslyVerified = previouslyVerified.size;
    totals.alreadyMarkedInSheet = rows.filter((row) => Boolean(row.sku)).length;

    // Start at the top of Sheet 1 every pass. Rows that already have a SKU in D,
    // or already passed an exact Shopify read-back in a previous run, are checked
    // off immediately; only unresolved rows hit the source/Shopify APIs.
    const pending = rows.filter(
      (row) => !row.sku && !previouslyVerified.has(row.rowNumber),
    );

    await updateMarker(marker.id, {
      stage: "full_run",
      planGroups: pending.length,
      totalBatches: pending.length,
      batch: 0,
      currentRow: null,
      verified: 0,
      rowsProcessed: 0,
      sheetCellsWritten: 0,
      missingMappings: 0,
      ambiguous: 0,
      multiplierConflicts: 0,
      errors: 0,
      createProducts: 0,
      rebuildProducts: 0,
      sheetBackfillRequired: true,
      totals,
      issues: [],
    });

    if (!pending.length) {
      await prisma.syncJob.update({
        where: { id: marker.id },
        data: {
          status: "completed",
          completedAt: new Date(),
          result: JSON.stringify({
            stage: "completed",
            planGroups: 0,
            totalBatches: 0,
            batch: 0,
            verified: 0,
            rowsProcessed: 0,
            errors: 0,
            createProducts: 0,
            rebuildProducts: 0,
            sheetBackfillRequired: true,
            totals,
            issues: [],
          }),
        },
      });
      return;
    }

    for (let index = 0; index < pending.length; index += 1) {
      const row = pending[index];
      totals.attempted += 1;
      const processed = await processRow(port, row, totals);

      if (processed.status === "verified") {
        totals.verified += 1;
        totals.rowsProcessed += 1;
      } else if (processed.status === "missing") {
        totals.missing += 1;
        issues.push(collectIssue(processed.response, row));
      } else if (processed.status === "ambiguous") {
        totals.ambiguous += 1;
        issues.push(collectIssue(processed.response, row));
      } else if (processed.status === "conflict") {
        totals.conflicts += 1;
        issues.push(collectIssue(processed.response, row));
      } else {
        totals.errors += 1;
        issues.push(collectIssue(processed.response, row, processed.error));
      }

      await updateMarker(marker.id, {
        stage: "full_run",
        planGroups: pending.length,
        totalBatches: pending.length,
        batch: index + 1,
        currentRow: row.rowNumber,
        verified: totals.verified,
        rowsProcessed: totals.rowsProcessed,
        sheetCellsWritten: 0,
        missingMappings: totals.missing,
        ambiguous: totals.ambiguous,
        multiplierConflicts: totals.conflicts,
        errors: totals.errors,
        createProducts: 0,
        rebuildProducts: 0,
        sheetBackfillRequired: true,
        totals,
        issues: issues.slice(-200),
      });

      console.log(
        `[sheet1-worker] ${index + 1}/${pending.length} row=${row.rowNumber} status=${processed.status}`,
      );

      // A bad product must never stop the rest of the sheet.
      await sleep(BETWEEN_ROWS_MS);
    }

    await prisma.syncJob.update({
      where: { id: marker.id },
      data: {
        status: "completed",
        completedAt: new Date(),
        result: JSON.stringify({
          stage: "completed",
          planGroups: pending.length,
          totalBatches: pending.length,
          batch: pending.length,
          verified: totals.verified,
          rowsProcessed: totals.rowsProcessed,
          sheetCellsWritten: 0,
          missingMappings: totals.missing,
          ambiguous: totals.ambiguous,
          multiplierConflicts: totals.conflicts,
          errors: totals.errors,
          createProducts: 0,
          rebuildProducts: 0,
          sheetBackfillRequired: true,
          completedWithIssues:
            totals.errors + totals.missing + totals.ambiguous + totals.conflicts > 0,
          totals,
          issues: issues.slice(-500),
        }),
      },
    });
  } catch (error: any) {
    const message = clean(error?.message || error || "Unknown Sheet1 worker failure");
    await prisma.syncJob.update({
      where: { id: marker.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        result: JSON.stringify({
          stage: "failed",
          error: message.slice(0, 5000),
          verified: totals.verified,
          rowsProcessed: totals.rowsProcessed,
          errors: totals.errors + 1,
          createProducts: 0,
          rebuildProducts: 0,
          sheetBackfillRequired: true,
          totals,
          issues: issues.slice(-500),
        }),
      },
    });
    throw error;
  }
}

async function workerLoop(port: number) {
  while (true) {
    try {
      await runPass(port);
      await sleep(BETWEEN_PASSES_MS);
    } catch (error: any) {
      console.error("[sheet1-worker] pass failed; worker will retry without stopping:", clean(error?.message || error));
      await sleep(FAILED_PASS_RETRY_MS);
    }
  }
}

export function startOneTimeSheet1Reconcile(port: number) {
  const isRailway = Boolean(
    envString("RAILWAY_ENVIRONMENT") || envString("RAILWAY_PUBLIC_DOMAIN"),
  );
  if (!isProduction() || !isRailway) {
    console.log("[sheet1-worker] disabled outside Railway production");
    return;
  }
  if (workerStarted) return;
  workerStarted = true;

  setTimeout(() => {
    void workerLoop(port).catch((error) => {
      // The loop itself is designed not to exit; this is only a final guard.
      workerStarted = false;
      console.error("[sheet1-worker] unexpected fatal loop exit:", error);
    });
  }, START_DELAY_MS);
}
