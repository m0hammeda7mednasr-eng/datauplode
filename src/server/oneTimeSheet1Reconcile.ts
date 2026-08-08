import axios from "axios";
import crypto from "crypto";
import { envString, isProduction } from "./config/env.js";
import { prisma } from "./db.js";

const SPREADSHEET_ID = "1fCbPajWL3nukX0TdoN1m2X8LV3pfPsxSMLBb0yWug2w";
const SHEET_GID = 0;
const SHEET_ID = 0;
const RUN_CONFIRMATION = "2026-08-09-sheet1-reconcile-v1";
const MARKER_TYPE = `ONE_TIME_SHEET1_RECONCILE:${RUN_CONFIRMATION}`;
const START_DELAY_MS = 20_000;
const BETWEEN_GROUPS_MS = 3_500;
const RETRY_DELAYS_MS = [0, 15_000, 45_000] as const;
const CONSECUTIVE_ERROR_LIMIT = 4;
const RECENT_RUNNING_MS = 45 * 60 * 1000;
const KNOWN_CANARY_ROWS = [5, 6, 7, 8];

type PlanGroup = {
  url: string;
  rows: number[];
  multipliers: number[];
};

type ReconcileResponse = {
  success?: boolean;
  batchId?: string;
  summary?: Record<string, any>;
  results?: Array<Record<string, any>>;
  error?: string;
};

type RunTotals = {
  groupsAttempted: number;
  verified: number;
  rows: number;
  missing: number;
  ambiguous: number;
  conflicts: number;
  coreErrors: number;
  retries: number;
  sheetCells: number;
  sheetErrors: number;
  skippedPreviouslyVerifiedRows: number;
};

let googleTokenCache: { token: string; expiresAt: number } | null = null;

function clean(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canonicalizeUrl(value: string) {
  const raw = String(value || "").replace(/[\t\r\n]+/g, "").trim();
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    parsed.search = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return raw;
  }
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
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 1 && number <= 100 ? number : null;
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

async function loadPreviouslyVerifiedRows() {
  const rows = new Set<number>();
  const runs = await prisma.importBatch.findMany({
    where: { target: "sheet1_reconcile" },
    orderBy: { createdAt: "desc" },
    take: 5000,
    select: { payloadJson: true },
  });

  for (const run of runs) {
    const payload = readJson(run.payloadJson);
    const summary = (payload as any)?.summary || {};
    if (summary?.dryRun === true) continue;
    const results = Array.isArray((payload as any)?.results)
      ? (payload as any).results
      : [];
    for (const result of results) {
      if (result?.status !== "verified" || result?.readbackVerified !== true) continue;
      if (!Array.isArray(result?.rows)) continue;
      for (const value of result.rows) {
        const rowNumber = Number(value);
        if (Number.isSafeInteger(rowNumber) && rowNumber > 0) rows.add(rowNumber);
      }
    }
  }

  return rows;
}

async function buildFrozenPlan(previouslyVerifiedRows: Set<number>): Promise<PlanGroup[]> {
  const csvUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=csv&gid=${SHEET_GID}`;
  const response = await axios.get(csvUrl, {
    timeout: Number(process.env.GOOGLE_SHEET_FETCH_TIMEOUT_MS || 30000),
    responseType: "text",
  });

  const grouped = new Map<
    string,
    Array<{ rowNumber: number; multiplier: number; sku: string }>
  >();

  parseCsv(String(response.data || "")).forEach((cells, index) => {
    const rawUrl = clean(cells[0]);
    const multiplier = parseMultiplier(cells[1]);
    const sku = clean(cells[3]);
    if (!/^https?:\/\//i.test(rawUrl) || multiplier === null) return;
    const url = canonicalizeUrl(rawUrl);
    const list = grouped.get(url) || [];
    list.push({ rowNumber: index + 1, multiplier, sku });
    grouped.set(url, list);
  });

  const plan: PlanGroup[] = [];
  for (const [url, rows] of grouped) {
    const pendingRows = rows.filter(
      (row) => !row.sku && !previouslyVerifiedRows.has(row.rowNumber),
    );
    if (!pendingRows.length) continue;
    plan.push({
      url,
      rows: pendingRows.map((row) => row.rowNumber),
      multipliers: [...new Set(pendingRows.map((row) => row.multiplier))].sort(
        (a, b) => a - b,
      ),
    });
  }
  return plan;
}

function ensureInternalWriteToken() {
  let token = clean(process.env.CATALOG_AUDIT_WRITE_TOKEN);
  if (!token) {
    token = crypto.randomBytes(32).toString("hex");
    process.env.CATALOG_AUDIT_WRITE_TOKEN = token;
    console.warn(
      "[sheet1-reconcile] generated an ephemeral in-process write token for the guarded loopback one-time run",
    );
  }
  return token;
}

async function postLocal(
  port: number,
  payload: Record<string, any>,
  write: boolean,
): Promise<ReconcileResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (write) {
    const token = ensureInternalWriteToken();
    headers["x-catalog-audit-write-token"] = token;
    headers["x-sheet1-reconcile-run"] = RUN_CONFIRMATION;
  }

  const response = await axios.post(
    `http://127.0.0.1:${port}/api/sheet1-reconcile/run`,
    payload,
    {
      headers,
      timeout: write ? 15 * 60 * 1000 : 5 * 60 * 1000,
      validateStatus: () => true,
    },
  );

  const body = response.data && typeof response.data === "object"
    ? (response.data as ReconcileResponse)
    : { error: clean(response.data) };
  if (response.status < 200 || response.status >= 300 || body.success !== true) {
    throw new Error(
      body.error || `Sheet 1 reconcile API returned HTTP ${response.status}`,
    );
  }
  return body;
}

function googleWriterConfigured() {
  if (clean(process.env.GOOGLE_SHEETS_ACCESS_TOKEN)) return true;
  const email = clean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
  const privateKey = clean(
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY_BASE64 ||
      process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
  );
  return Boolean(email && privateKey);
}

function base64Url(value: string | Buffer) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function googleAccessToken() {
  const direct = clean(process.env.GOOGLE_SHEETS_ACCESS_TOKEN);
  if (direct) return direct;
  if (googleTokenCache && googleTokenCache.expiresAt > Date.now() + 60_000) {
    return googleTokenCache.token;
  }

  const email = clean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
  const encodedKey = clean(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY_BASE64);
  const privateKey = encodedKey
    ? Buffer.from(encodedKey, "base64").toString("utf8")
    : String(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!email || !privateKey) {
    throw new Error("Google Sheets writer credentials are missing in Railway");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(
    JSON.stringify({
      iss: email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${claim}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${base64Url(signer.sign(privateKey))}`;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const response = await axios.post("https://oauth2.googleapis.com/token", body, {
    timeout: 20000,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const token = clean(response.data?.access_token);
  if (!token) throw new Error("Google did not return an access token");
  googleTokenCache = {
    token,
    expiresAt: Date.now() + Number(response.data?.expires_in || 3600) * 1000,
  };
  return token;
}

async function writeVerifiedSkusToSheet(results: Array<Record<string, any>>) {
  const verified = results.filter(
    (result) =>
      result?.status === "verified" &&
      result?.readbackVerified === true &&
      clean(result?.expectedSku) &&
      Array.isArray(result?.rows),
  );
  if (!verified.length) return { cellsWritten: 0, batches: 0 };

  const requests: any[] = [];
  for (const result of verified) {
    const sku = clean(result.expectedSku);
    for (const rawRowNumber of result.rows) {
      const rowNumber = Number(rawRowNumber);
      if (!Number.isSafeInteger(rowNumber) || rowNumber < 1) continue;
      requests.push({
        updateCells: {
          range: {
            sheetId: SHEET_ID,
            startRowIndex: rowNumber - 1,
            endRowIndex: rowNumber,
            startColumnIndex: 3,
            endColumnIndex: 4,
          },
          rows: [
            { values: [{ userEnteredValue: { stringValue: sku } }] },
          ],
          fields: "userEnteredValue",
        },
      });
    }
  }
  if (!requests.length) return { cellsWritten: 0, batches: 0 };

  const token = await googleAccessToken();
  let batches = 0;
  for (let index = 0; index < requests.length; index += 300) {
    await axios.post(
      `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`,
      { requests: requests.slice(index, index + 300) },
      {
        timeout: 30000,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );
    batches += 1;
  }
  return { cellsWritten: requests.length, batches };
}

async function updateMarker(markerId: string, result: Record<string, any>) {
  await prisma.syncJob.update({
    where: { id: markerId },
    data: { result: JSON.stringify(result) },
  });
}

async function existingHandledMarker() {
  const latest = await prisma.syncJob.findFirst({
    where: { type: MARKER_TYPE },
    orderBy: { createdAt: "desc" },
  });
  if (!latest) return null;
  if (latest.status === "completed") return latest;
  if (latest.status === "running" && latest.startedAt) {
    if (Date.now() - latest.startedAt.getTime() < RECENT_RUNNING_MS) return latest;
  }
  return null;
}

function resultStatus(response: ReconcileResponse) {
  const results = Array.isArray(response.results) ? response.results : [];
  if (!results.length) return "error";
  if (results.every((result) => result?.status === "verified")) return "verified";
  if (results.some((result) => result?.status === "error")) return "error";
  if (results.some((result) => result?.status === "ambiguous")) return "ambiguous";
  if (results.some((result) => result?.status === "conflict")) return "conflict";
  if (results.some((result) => result?.status === "missing")) return "missing";
  return clean(results[0]?.status) || "error";
}

function collectIssues(response: ReconcileResponse) {
  return (response.results || [])
    .filter((result) => result?.status !== "verified")
    .map((result) => ({
      status: clean(result?.status),
      rows: result?.rows,
      url: result?.url,
      productCode: result?.productCode,
      reason: clean(result?.reason).slice(0, 2000),
    }));
}

async function findCanaryFromRows(port: number, rows: number[]) {
  for (const rowNumber of rows) {
    try {
      const response = await postLocal(
        port,
        { dryRun: true, writeSheet: false, rowNumbers: [rowNumber] },
        false,
      );
      const summary = response.summary || {};
      const verified = (response.results || []).find(
        (result) =>
          result.status === "verified" &&
          result.readbackVerified === true &&
          clean(result.expectedSku) &&
          Array.isArray(result.rows) &&
          result.rows.length > 0,
      );
      if (
        Number(summary.errors || 0) === 0 &&
        Number(summary.ambiguous || 0) === 0 &&
        Number(summary.conflicts || 0) === 0 &&
        verified
      ) {
        return {
          rowNumber: Number(verified.rows[0]),
          expectedSku: clean(verified.expectedSku),
          productId: clean(verified.shopifyProductId),
          dryRunBatchId: clean(response.batchId),
        };
      }
    } catch (error: any) {
      console.warn("[sheet1-reconcile] known canary probe failed", {
        rowNumber,
        error: clean(error?.message || error),
      });
    }
  }
  return null;
}

async function processGroupWithRetries(
  port: number,
  group: PlanGroup,
  totals: RunTotals,
) {
  let lastResponse: ReconcileResponse | null = null;
  let lastTransportError = "";

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay > 0) {
      totals.retries += 1;
      console.warn(
        `[sheet1-reconcile] retrying rows ${group.rows.join(",")} after ${delay}ms`,
      );
      await sleep(delay);
    }

    try {
      const response = await postLocal(
        port,
        { dryRun: false, writeSheet: false, rowNumbers: group.rows },
        true,
      );
      lastResponse = response;
      const status = resultStatus(response);
      if (status !== "error") {
        return { response, status, transportError: "" };
      }
    } catch (error: any) {
      lastTransportError = clean(error?.message || error).slice(0, 2000);
    }
  }

  return {
    response: lastResponse,
    status: "error",
    transportError: lastTransportError,
  };
}

async function runOneTimeSheet1Reconcile(port: number) {
  const existing = await existingHandledMarker();
  if (existing) {
    console.log(
      `[sheet1-reconcile] ${MARKER_TYPE} already ${existing.status}; startup run skipped`,
    );
    return;
  }

  const marker = await prisma.syncJob.create({
    data: {
      type: MARKER_TYPE,
      status: "running",
      startedAt: new Date(),
      payload: JSON.stringify({
        runConfirmation: RUN_CONFIRMATION,
        spreadsheetId: SPREADSHEET_ID,
        sheetGid: SHEET_GID,
        mode: "existing_products_only",
        createProducts: false,
        rebuildProducts: false,
        pacingMs: BETWEEN_GROUPS_MS,
        retryDelaysMs: RETRY_DELAYS_MS,
        resumeFromVerifiedImportBatches: true,
      }),
    },
  });

  const totals: RunTotals = {
    groupsAttempted: 0,
    verified: 0,
    rows: 0,
    missing: 0,
    ambiguous: 0,
    conflicts: 0,
    coreErrors: 0,
    retries: 0,
    sheetCells: 0,
    sheetErrors: 0,
    skippedPreviouslyVerifiedRows: 0,
  };
  const issues: Array<Record<string, any>> = [];
  let sheetWriteEnabled = googleWriterConfigured();
  let sheetWriteDisabledReason = sheetWriteEnabled
    ? ""
    : "Google writer credentials are not configured in Railway; external Sheet backfill is required.";

  try {
    const previouslyVerifiedRows = await loadPreviouslyVerifiedRows();
    totals.skippedPreviouslyVerifiedRows = previouslyVerifiedRows.size;
    const plan = await buildFrozenPlan(previouslyVerifiedRows);

    console.log(
      `[sheet1-reconcile] resume plan has ${plan.length} URL groups; ` +
        `${previouslyVerifiedRows.size} rows already have verified Shopify read-back`,
    );

    await updateMarker(marker.id, {
      stage: "plan_ready",
      planGroups: plan.length,
      previouslyVerifiedRows: previouslyVerifiedRows.size,
      sheetWriteEnabled,
      sheetWriteDisabledReason,
      totals,
    });

    if (plan.length === 0) {
      await prisma.syncJob.update({
        where: { id: marker.id },
        data: {
          status: "completed",
          completedAt: new Date(),
          result: JSON.stringify({
            stage: "completed",
            planGroups: 0,
            sheetWriteEnabled,
            sheetWriteDisabledReason,
            sheetBackfillRequired: !sheetWriteEnabled,
            totals,
            issues: [],
          }),
        },
      });
      return;
    }

    let canary = await findCanaryFromRows(port, KNOWN_CANARY_ROWS);
    if (!canary) {
      for (const group of plan.slice(0, 50)) {
        const response = await postLocal(
          port,
          { dryRun: true, writeSheet: false, rowNumbers: group.rows },
          false,
        );
        const verified = (response.results || []).find(
          (result) =>
            result.status === "verified" &&
            result.readbackVerified === true &&
            clean(result.expectedSku),
        );
        if (verified) {
          canary = {
            rowNumber: Number(verified.rows?.[0]),
            expectedSku: clean(verified.expectedSku),
            productId: clean(verified.shopifyProductId),
            dryRunBatchId: clean(response.batchId),
          };
          break;
        }
        await sleep(BETWEEN_GROUPS_MS);
      }
    }

    if (!canary) {
      throw new Error("No clean canary candidate was found");
    }

    await updateMarker(marker.id, {
      stage: "dry_run_passed",
      planGroups: plan.length,
      canary,
      sheetWriteEnabled,
      sheetWriteDisabledReason,
      totals,
    });

    const canaryResponse = await postLocal(
      port,
      { dryRun: false, writeSheet: false, rowNumbers: [canary.rowNumber] },
      true,
    );
    const canaryResults = canaryResponse.results || [];
    const canaryVerified =
      canaryResults.length > 0 &&
      canaryResults.every(
        (result) => result.status === "verified" && result.readbackVerified === true,
      ) &&
      canaryResults.some(
        (result) => clean(result.expectedSku) === canary?.expectedSku,
      );
    if (!canaryVerified) {
      throw new Error("One-product canary did not pass exact Shopify read-back");
    }

    await updateMarker(marker.id, {
      stage: "canary_passed",
      planGroups: plan.length,
      canary: { ...canary, writeBatchId: canaryResponse.batchId || null },
      sheetWriteEnabled,
      sheetWriteDisabledReason,
      totals,
    });

    let consecutiveCoreErrors = 0;

    for (let groupIndex = 0; groupIndex < plan.length; groupIndex += 1) {
      const group = plan[groupIndex];
      totals.groupsAttempted += 1;
      const processed = await processGroupWithRetries(port, group, totals);
      const response = processed.response;
      const status = processed.status;

      if (status === "verified" && response) {
        consecutiveCoreErrors = 0;
        const summary = response.summary || {};
        totals.verified += Number(summary.verified || 0);
        totals.rows += Number(summary.rowsProcessed || 0);

        if (sheetWriteEnabled) {
          try {
            const sheetWrite = await writeVerifiedSkusToSheet(response.results || []);
            totals.sheetCells += sheetWrite.cellsWritten;
          } catch (error: any) {
            totals.sheetErrors += 1;
            sheetWriteEnabled = false;
            sheetWriteDisabledReason = clean(error?.message || error).slice(0, 2000);
            issues.push({
              type: "sheet_write_disabled",
              group: groupIndex + 1,
              rows: group.rows,
              reason: sheetWriteDisabledReason,
            });
            console.error(
              "[sheet1-reconcile] Google Sheet writeback disabled for the rest of this run:",
              sheetWriteDisabledReason,
            );
          }
        }
      } else if (status === "conflict") {
        consecutiveCoreErrors = 0;
        totals.conflicts += 1;
        if (response) issues.push(...collectIssues(response));
      } else if (status === "ambiguous") {
        consecutiveCoreErrors = 0;
        totals.ambiguous += 1;
        if (response) issues.push(...collectIssues(response));
      } else if (status === "missing") {
        consecutiveCoreErrors = 0;
        totals.missing += 1;
        if (response) issues.push(...collectIssues(response));
      } else {
        consecutiveCoreErrors += 1;
        totals.coreErrors += 1;
        if (response) {
          issues.push(...collectIssues(response));
        } else {
          issues.push({
            status: "error",
            rows: group.rows,
            url: group.url,
            reason: processed.transportError || "Unknown reconcile transport error",
          });
        }
      }

      await updateMarker(marker.id, {
        stage: "full_run",
        planGroups: plan.length,
        batch: groupIndex + 1,
        totalBatches: plan.length,
        currentRows: group.rows,
        canary,
        sheetWriteEnabled,
        sheetWriteDisabledReason,
        sheetBackfillRequired: !sheetWriteEnabled,
        consecutiveCoreErrors,
        totals,
        issues: issues.slice(-100),
      });

      console.log(
        `[sheet1-reconcile] group ${groupIndex + 1}/${plan.length} status=${status}`,
        totals,
      );

      if (consecutiveCoreErrors >= CONSECUTIVE_ERROR_LIMIT) {
        throw new Error(
          `Circuit breaker stopped the run after ${CONSECUTIVE_ERROR_LIMIT} consecutive core errors. ` +
            "The last failed groups are recorded in SyncJob.result for diagnosis.",
        );
      }

      await sleep(BETWEEN_GROUPS_MS);
    }

    const completedWithIssues =
      totals.missing +
        totals.ambiguous +
        totals.conflicts +
        totals.coreErrors >
        0;

    await prisma.syncJob.update({
      where: { id: marker.id },
      data: {
        status: "completed",
        completedAt: new Date(),
        result: JSON.stringify({
          stage: "completed",
          planGroups: plan.length,
          canary,
          sheetWriteEnabled,
          sheetWriteDisabledReason,
          sheetBackfillRequired: !sheetWriteEnabled,
          totals,
          issues: issues.slice(0, 500),
          completedWithIssues,
        }),
      },
    });
  } catch (error: any) {
    const message = clean(error?.message || error || "Unknown Sheet 1 reconcile failure");
    await prisma.syncJob.update({
      where: { id: marker.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        result: JSON.stringify({
          stage: "failed",
          error: message.slice(0, 5000),
          sheetWriteEnabled,
          sheetWriteDisabledReason,
          sheetBackfillRequired: !sheetWriteEnabled,
          totals,
          issues: issues.slice(-200),
        }),
      },
    });
    console.error("[sheet1-reconcile] one-time run failed:", message);
  }
}

export function startOneTimeSheet1Reconcile(port: number) {
  const isRailway = Boolean(
    envString("RAILWAY_ENVIRONMENT") || envString("RAILWAY_PUBLIC_DOMAIN"),
  );
  if (!isProduction() || !isRailway) {
    console.log("[sheet1-reconcile] one-time run disabled outside Railway production");
    return;
  }

  setTimeout(() => {
    void runOneTimeSheet1Reconcile(port).catch((error) => {
      console.error("[sheet1-reconcile] unexpected fatal startup error:", error);
    });
  }, START_DELAY_MS);
}
