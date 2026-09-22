import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";

type WorkbookRow = {
  sheetName: string;
  rowNumber: number;
  url: string;
  priceMultiplier: number;
  collection: string;
};

type CheckpointEntry = {
  at: string;
  sheetName?: string;
  rowNumber: number;
  url: string;
  outcome: "successful" | "skipped" | "failed";
  response?: unknown;
  error?: string;
};

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (!value.startsWith("--")) continue;
  const [key, inlineValue] = value.slice(2).split("=", 2);
  args.set(key, inlineValue ?? process.argv[index + 1] ?? "true");
  if (inlineValue === undefined && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    index += 1;
  }
}

const filePath = args.get("file");
if (!filePath) throw new Error("Missing required --file argument");

const apiBase = (args.get("api") || "https://datauplode-production.up.railway.app").replace(/\/$/, "");
const sheetNameArg = args.get("sheet");
const allSheets = args.get("all-sheets") === "true";
const limit = Math.max(1, Number(args.get("limit") || Number.MAX_SAFE_INTEGER));
const concurrency = Math.min(8, Math.max(1, Number(args.get("concurrency") || 1)));
const retryFailed = args.get("retry-failed") === "true";
const scraperApiKey = args.get("scraper-api-key") || process.env.SCRAPERAPI_KEY || "";
const checkpointPath = args.get("checkpoint") || path.join(
  process.env.TEMP || "C:/tmp",
  `${path.basename(filePath).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}-shopify-import.jsonl`,
);

function normalizeProductUrl(value: string) {
  const parsed = new URL(value.trim());
  parsed.hash = "";
  if (/^(www\.)?next\.ae$/i.test(parsed.hostname)) {
    parsed.pathname = parsed.pathname.replace(/^\/ar\//i, "/en/");
  }
  return parsed.toString().replace(/\/$/, "");
}

function productIdentity(url: string) {
  const parsed = new URL(url);
  if (/(^|\.)shein\.com$/i.test(parsed.hostname)) {
    const productId = parsed.pathname.match(/-p-(\d+)(?:\.|-|\/|$)/i)?.[1];
    if (productId) return `shein:${productId}`;
  }
  return url;
}

function checkpointKey(entry: { sheetName?: string; rowNumber: number }) {
  return `${entry.sheetName || sheetNameArg || ""}:${entry.rowNumber}`;
}

function loadCompleted() {
  const completed = new Map<string, CheckpointEntry>();
  if (!fs.existsSync(checkpointPath)) return completed;
  for (const line of fs.readFileSync(checkpointPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as CheckpointEntry;
      if (entry.outcome !== "failed" || !retryFailed) completed.set(checkpointKey(entry), entry);
    } catch {
      // Ignore a partially written final line so interrupted runs stay resumable.
    }
  }
  return completed;
}

async function postJson(url: string, body: unknown, attempts = 3) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12 * 60 * 1000),
      });
      const text = await response.text();
      const parsed = text ? JSON.parse(text) : {};
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${parsed?.error || text}`);
      return parsed;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
    }
  }
  throw lastError;
}

function shouldRetryWithManagedSnapshot(response: any) {
  const failure = response?.failed?.[0];
  const message = String(failure?.error || failure?.reason || "");
  return /Cloudflare|protected|browser snapshot|Bridge task timeout|No usable product HTML/i.test(message);
}

async function loadManagedSnapshot(url: string) {
  if (!scraperApiKey) return "";
  const endpoint = new URL("https://api.scraperapi.com");
  endpoint.searchParams.set("api_key", scraperApiKey);
  endpoint.searchParams.set("url", url);
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(3 * 60 * 1000) });
  if (!response.ok) throw new Error(`Managed snapshot failed with HTTP ${response.status}`);
  const html = await response.text();
  if (html.trim().length < 500) throw new Error("Managed snapshot returned incomplete HTML");
  return html;
}

const workbook = XLSX.readFile(filePath, { raw: false });
const selectedSheetNames = allSheets
  ? workbook.SheetNames
  : [sheetNameArg || workbook.SheetNames[0]];
const seenProducts = new Set<string>();
const rows: WorkbookRow[] = [];
for (const sheetName of selectedSheetNames) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`Sheet not found: ${sheetName}`);
  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
  for (let index = 0; index < rawRows.length; index += 1) {
    const values = rawRows[index];
    const urlIndex = values.findIndex((value) => /^https?:\/\//i.test(String(value || "").trim()));
    if (urlIndex < 0) continue;
    const multiplierIndex = values.findIndex(
      (value, valueIndex) => valueIndex !== urlIndex && [22, 23, 24].includes(Number(value)),
    );
    if (multiplierIndex < 0) continue;
    const rawUrl = String(values[urlIndex] || "").trim();
    const priceMultiplier = Number(values[multiplierIndex]);
    const url = normalizeProductUrl(rawUrl);
    const identity = productIdentity(url);
    if (seenProducts.has(identity)) continue;
    seenProducts.add(identity);
    const collectionIndex = values.findIndex((value, valueIndex) => {
      const text = String(value || "").trim();
      return valueIndex > multiplierIndex && Boolean(text) && !/^https?:\/\//i.test(text) && ![22, 23, 24].includes(Number(value));
    });
    rows.push({
      sheetName,
      rowNumber: index + 1,
      url,
      priceMultiplier,
      collection: collectionIndex >= 0 ? String(values[collectionIndex]).trim() : "General",
    });
  }
}

const completed = loadCompleted();
const pending = rows
  .filter((row) => !completed.has(checkpointKey(row)) && !completed.has(`:${row.rowNumber}`))
  .slice(0, limit);
fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });

console.log(JSON.stringify({
  event: "start",
  filePath,
  sheetNames: selectedSheetNames,
  uniqueRows: rows.length,
  alreadyCompleted: completed.size,
  selected: pending.length,
  concurrency,
  checkpointPath,
}));

let successful = 0;
let skipped = 0;
let failed = 0;
let completedCount = 0;

async function processRow(row: WorkbookRow) {
  let checkpoint: CheckpointEntry;
  try {
    const requestBody = {
      rows: [row],
      collectionNames: [row.collection],
      createManualReview: true,
      waitForPublishCompletion: true,
      reconcileExistingProducts: true,
      sheetName: `${path.basename(filePath)} / ${row.sheetName}`,
      sheetUrl: `local-workbook:${path.basename(filePath)}`,
    };
    let response = await postJson(`${apiBase}/api/imports/excel/process`, requestBody);
    if (scraperApiKey && shouldRetryWithManagedSnapshot(response)) {
      const pageText = await loadManagedSnapshot(row.url);
      await postJson(`${apiBase}/api/imports/analyze`, { url: row.url, pageText }, 1);
      response = await postJson(`${apiBase}/api/imports/excel/process`, requestBody);
    }
    const success = response?.successful?.find((item: any) => item.rowNumber === row.rowNumber);
    const skip = response?.skipped?.find((item: any) => item.rowNumber === row.rowNumber);
    const failure = response?.failed?.find((item: any) => item.rowNumber === row.rowNumber);
    if (success) {
      successful += 1;
      checkpoint = { at: new Date().toISOString(), sheetName: row.sheetName, rowNumber: row.rowNumber, url: row.url, outcome: "successful", response: success };
    } else if (skip) {
      skipped += 1;
      checkpoint = { at: new Date().toISOString(), sheetName: row.sheetName, rowNumber: row.rowNumber, url: row.url, outcome: "skipped", response: skip };
    } else {
      failed += 1;
      checkpoint = { at: new Date().toISOString(), sheetName: row.sheetName, rowNumber: row.rowNumber, url: row.url, outcome: "failed", response: failure || response, error: failure?.error || failure?.reason || "No successful result returned" };
    }
  } catch (error) {
    failed += 1;
    checkpoint = { at: new Date().toISOString(), sheetName: row.sheetName, rowNumber: row.rowNumber, url: row.url, outcome: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  fs.appendFileSync(checkpointPath, `${JSON.stringify(checkpoint)}\n`);
  completedCount += 1;
  console.log(JSON.stringify({
    event: "row",
    progress: `${completedCount}/${pending.length}`,
    successful,
    skipped,
    failed,
    ...checkpoint,
  }));
}

let nextRowIndex = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (nextRowIndex < pending.length) {
      const row = pending[nextRowIndex];
      nextRowIndex += 1;
      await processRow(row);
    }
  }),
);

console.log(JSON.stringify({ event: "complete", selected: pending.length, successful, skipped, failed, checkpointPath }));
if (failed > 0) process.exitCode = 2;
