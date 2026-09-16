import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";

type WorkbookRow = {
  rowNumber: number;
  url: string;
  priceMultiplier: number;
  collection: string;
};

type CheckpointEntry = {
  at: string;
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
const limit = Math.max(1, Number(args.get("limit") || Number.MAX_SAFE_INTEGER));
const concurrency = Math.min(8, Math.max(1, Number(args.get("concurrency") || 1)));
const retryFailed = args.get("retry-failed") === "true";
const checkpointPath = args.get("checkpoint") || path.join(
  process.env.TEMP || "C:/tmp",
  `${path.basename(filePath).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}-shopify-import.jsonl`,
);

function normalizeNextUrl(value: string) {
  const parsed = new URL(value.trim());
  parsed.hash = "";
  if (/^(www\.)?next\.ae$/i.test(parsed.hostname)) {
    parsed.pathname = parsed.pathname.replace(/^\/ar\//i, "/en/");
  }
  return parsed.toString().replace(/\/$/, "");
}

function loadCompleted() {
  const completed = new Map<number, CheckpointEntry>();
  if (!fs.existsSync(checkpointPath)) return completed;
  for (const line of fs.readFileSync(checkpointPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as CheckpointEntry;
      if (entry.outcome !== "failed" || !retryFailed) completed.set(entry.rowNumber, entry);
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

const workbook = XLSX.readFile(filePath, { raw: false });
const sheetName = sheetNameArg || workbook.SheetNames[0];
const sheet = workbook.Sheets[sheetName];
if (!sheet) throw new Error(`Sheet not found: ${sheetName}`);

const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
const seenUrls = new Set<string>();
const rows: WorkbookRow[] = [];
for (let index = 0; index < rawRows.length; index += 1) {
  const values = rawRows[index];
  const rawUrl = String(values[0] || "").trim();
  if (!/^https?:\/\//i.test(rawUrl)) continue;
  const priceMultiplier = Number(values[1]);
  if (![22, 23, 24].includes(priceMultiplier)) continue;
  const url = normalizeNextUrl(rawUrl);
  if (seenUrls.has(url)) continue;
  seenUrls.add(url);
  rows.push({
    rowNumber: index + 1,
    url,
    priceMultiplier,
    collection: String(values[2] || "").trim() || "General",
  });
}

const completed = loadCompleted();
const pending = rows.filter((row) => !completed.has(row.rowNumber)).slice(0, limit);
fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });

console.log(JSON.stringify({
  event: "start",
  filePath,
  sheetName,
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
    const response = await postJson(`${apiBase}/api/imports/excel/process`, {
      rows: [row],
      collectionNames: [row.collection],
      createManualReview: true,
      waitForPublishCompletion: true,
      reconcileExistingProducts: true,
      sheetName: `${path.basename(filePath)} / ${sheetName}`,
      sheetUrl: `local-workbook:${path.basename(filePath)}`,
    });
    const success = response?.successful?.find((item: any) => item.rowNumber === row.rowNumber);
    const skip = response?.skipped?.find((item: any) => item.rowNumber === row.rowNumber);
    const failure = response?.failed?.find((item: any) => item.rowNumber === row.rowNumber);
    if (success) {
      successful += 1;
      checkpoint = { at: new Date().toISOString(), rowNumber: row.rowNumber, url: row.url, outcome: "successful", response: success };
    } else if (skip) {
      skipped += 1;
      checkpoint = { at: new Date().toISOString(), rowNumber: row.rowNumber, url: row.url, outcome: "skipped", response: skip };
    } else {
      failed += 1;
      checkpoint = { at: new Date().toISOString(), rowNumber: row.rowNumber, url: row.url, outcome: "failed", response: failure || response, error: failure?.error || failure?.reason || "No successful result returned" };
    }
  } catch (error) {
    failed += 1;
    checkpoint = { at: new Date().toISOString(), rowNumber: row.rowNumber, url: row.url, outcome: "failed", error: error instanceof Error ? error.message : String(error) };
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
