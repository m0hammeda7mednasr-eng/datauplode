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
const GROUPS_PER_BATCH = 10;
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

async function buildFrozenPlan(): Promise<PlanGroup[]> {
  const csvUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=csv&gid=${SHEET_GID}`;
  const response = await axios.get(csvUrl, {
    timeout: Number(process.env.GOOGLE_SHEET_FETCH_TIMEOUT_MS || 30000),
    responseType: "text",
  });

  const grouped = new Map<string, Array<{ rowNumber: number; multiplier: number; sku: string }>>();
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
    if (!rows.some((row) => !row.sku)) continue;
    plan.push({
      url,
      rows: rows.map((row) => row.rowNumber),
      multipliers: [...new Set(rows.map((row) => row.multiplier))].sort((a, b) => a - b),
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
    ? response.data as ReconcileResponse
    : { error: clean(response.data) };
  if (response.status < 200 || response.status >= 300 || body.success !== true) {
    throw new Error(
      body.error || `Sheet 1 reconcile API returned HTTP ${response.status}`,
    );
  }
  return body;
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
    throw new Error(
      "Google Sheets writer credentials are missing in Railway (GOOGLE_SHEETS_ACCESS_TOKEN or service-account credentials)",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(JSON.stringify({
    iss: email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
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
  const verified = results.filter((result) =>
    result?.status === "verified" && clean(result?.expectedSku) && Array.isArray(result?.rows),
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
          rows: [{ values: [{ userEnteredValue: { stringValue: sku } }] }],
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

function accumulate(
  totals: Record<string, number>,
  response: ReconcileResponse,
) {
  const summary = response.summary || {};
  totals.batches += 1;
  totals.units += Number(summary.unitsProcessed || 0);
  totals.rows += Number(summary.rowsProcessed || 0);
  totals.verified += Number(summary.verified || 0);
  totals.missing += Number(summary.missing || 0);
  totals.ambiguous += Number(summary.ambiguous || 0);
  totals.conflicts += Number(summary.conflicts || 0);
  totals.errors += Number(summary.errors || 0);
}

async function findCanaryFromRows(port: number, rows: number[]) {
  for (const rowNumber of rows) {
    try {
      const response = await postLocal(port, {
        dryRun: true,
        writeSheet: false,
        rowNumbers: [rowNumber],
      }, false);
      const summary = response.summary || {};
      const verified = (response.results || []).find((result) =>
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

async function runOneTimeSheet1Reconcile(port: number) {
  const existing = await existingHandledMarker();
  if (existing) {
    console.log(`[sheet1-reconcile] ${MARKER_TYPE} already ${existing.status}; startup run skipped`);
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
        sheetWriteMode: "runner_after_shopify_readback",
      }),
    },
  });

  const totals = {
    batches: 0,
    units: 0,
    rows: 0,
    verified: 0,
    missing: 0,
    ambiguous: 0,
    conflicts: 0,
    errors: 0,
    sheetCells: 0,
  };
  const issues: Array<Record<string, any>> = [];

  try {
    const plan = await buildFrozenPlan();
    console.log(`[sheet1-reconcile] frozen plan contains ${plan.length} missing-SKU URL groups`);
    await updateMarker(marker.id, {
      stage: "plan_ready",
      planGroups: plan.length,
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
            totals,
            issues: [],
          }),
        },
      });
      return;
    }

    let canary = await findCanaryFromRows(port, KNOWN_CANARY_ROWS);

    if (!canary) {
      const probes = plan.slice(0, 100);
      for (const group of probes) {
        try {
          const response = await postLocal(port, {
            dryRun: true,
            writeSheet: false,
            rowNumbers: group.rows,
          }, false);
          const summary = response.summary || {};
          const verified = (response.results || []).find((result) =>
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
            canary = {
              rowNumber: Number(verified.rows[0]),
              expectedSku: clean(verified.expectedSku),
              productId: clean(verified.shopifyProductId),
              dryRunBatchId: clean(response.batchId),
            };
            break;
          }
        } catch (error: any) {
          console.warn("[sheet1-reconcile] missing-group dry-run probe failed", {
            rows: group.rows,
            error: clean(error?.message || error),
          });
        }
      }
    }

    if (!canary) {
      throw new Error("No clean canary candidate was found in verified rows or the first 100 missing groups");
    }

    await updateMarker(marker.id, {
      stage: "dry_run_passed",
      planGroups: plan.length,
      canary,
      totals,
    });
    console.log("[sheet1-reconcile] dry-run canary selected", canary);

    const canaryResponse = await postLocal(port, {
      dryRun: false,
      writeSheet: false,
      rowNumbers: [canary.rowNumber],
    }, true);
    const canaryResults = canaryResponse.results || [];
    const canaryVerified = canaryResults.length > 0 && canaryResults.every((result) =>
      result.status === "verified" && result.readbackVerified === true,
    ) && canaryResults.some((result) => clean(result.expectedSku) === canary.expectedSku);
    if (!canaryVerified) {
      throw new Error("One-product canary did not pass exact Shopify read-back");
    }

    await updateMarker(marker.id, {
      stage: "canary_passed",
      planGroups: plan.length,
      canary: {
        ...canary,
        writeBatchId: canaryResponse.batchId || null,
      },
      totals,
    });
    console.log("[sheet1-reconcile] one-product canary + read-back passed");

    const batches: PlanGroup[][] = [];
    for (let index = 0; index < plan.length; index += GROUPS_PER_BATCH) {
      batches.push(plan.slice(index, index + GROUPS_PER_BATCH));
    }

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex];
      const rowNumbers = batch.flatMap((group) => group.rows);
      let response: ReconcileResponse | null = null;
      let lastError = "";

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          response = await postLocal(port, {
            dryRun: false,
            writeSheet: false,
            rowNumbers,
          }, true);
          break;
        } catch (error: any) {
          lastError = clean(error?.message || error);
          if (attempt < 2) await sleep(5_000);
        }
      }

      if (!response) {
        totals.errors += batch.length;
        issues.push({
          batch: batchIndex + 1,
          rowNumbers,
          transportError: lastError,
        });
      } else {
        accumulate(totals, response);
        for (const result of response.results || []) {
          if (result.status !== "verified") {
            issues.push({ batch: batchIndex + 1, ...result });
          }
        }

        try {
          let sheetWrite: { cellsWritten: number; batches: number } | null = null;
          let sheetError = "";
          for (let attempt = 1; attempt <= 2; attempt += 1) {
            try {
              sheetWrite = await writeVerifiedSkusToSheet(response.results || []);
              break;
            } catch (error: any) {
              sheetError = clean(error?.message || error);
              if (attempt < 2) await sleep(3_000);
            }
          }
          if (!sheetWrite) {
            totals.errors += 1;
            issues.push({
              batch: batchIndex + 1,
              rowNumbers,
              sheetWriteError: sheetError || "Unknown Google Sheets write error",
            });
          } else {
            totals.sheetCells += sheetWrite.cellsWritten;
          }
        } catch (error: any) {
          totals.errors += 1;
          issues.push({
            batch: batchIndex + 1,
            rowNumbers,
            sheetWriteError: clean(error?.message || error),
          });
        }
      }

      await updateMarker(marker.id, {
        stage: "full_run",
        planGroups: plan.length,
        batch: batchIndex + 1,
        totalBatches: batches.length,
        canary,
        totals,
        issues: issues.slice(-100),
      });
      console.log(`[sheet1-reconcile] batch ${batchIndex + 1}/${batches.length}`, totals);
    }

    await prisma.syncJob.update({
      where: { id: marker.id },
      data: {
        status: "completed",
        completedAt: new Date(),
        result: JSON.stringify({
          stage: "completed",
          planGroups: plan.length,
          canary,
          totals,
          issues: issues.slice(0, 500),
          completedWithIssues:
            totals.missing + totals.ambiguous + totals.conflicts + totals.errors > 0,
        }),
      },
    });
    console.log("[sheet1-reconcile] one-time run completed", totals);
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
          totals,
          issues: issues.slice(0, 200),
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
