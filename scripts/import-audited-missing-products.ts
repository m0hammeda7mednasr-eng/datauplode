import fs from "node:fs";
import { processGoogleSheetBatch } from "../src/server/api.js";
import { prisma } from "../src/server/db.js";

type MissingRow = {
  rowNumber: number;
  url: string;
  priceMultiplier: number | null;
};

type AuditSheet = {
  name: string;
  gid: number;
  sheetUrl: string;
  missingRows: MissingRow[];
};

type AuditReport = { sheets: AuditSheet[] };

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

const reportPath = args.get("report") || "C:/tmp/big-sheet-missing-audit.json";
const checkpointPath = args.get("checkpoint") || "C:/tmp/big-sheet-missing-import.jsonl";
const limit = Math.max(1, Number(args.get("limit") || 1));
const batchSize = Math.max(1, Math.min(10, Number(args.get("batch-size") || 1)));
const requestedGid = args.has("gid") ? Number(args.get("gid")) : null;
const hostPattern = new RegExp(args.get("host") || "centrepointstores\\.com|maxfashion\\.com|ae\\.hm\\.com", "i");
const retryFailed = args.get("retry-failed") === "true";
const validMultipliers = new Set([22, 23, 24]);

const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as AuditReport;
const completedKeys = new Set<string>();
if (fs.existsSync(checkpointPath)) {
  for (const line of fs.readFileSync(checkpointPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (
        entry.outcome === "published" ||
        entry.outcome === "skipped_existing" ||
        (entry.outcome === "failed" && !retryFailed)
      ) {
        completedKeys.add(`${entry.gid}:${entry.rowNumber}`);
      }
    } catch {
      // Keep a partially written final line from breaking a resumable run.
    }
  }
}

const selected = report.sheets.flatMap((sheet) =>
  sheet.missingRows
    .filter((row) => requestedGid === null || sheet.gid === requestedGid)
    .filter((row) => validMultipliers.has(Number(row.priceMultiplier)))
    .filter((row) => {
      try {
        return hostPattern.test(new URL(row.url).hostname);
      } catch {
        return false;
      }
    })
    .filter((row) => !completedKeys.has(`${sheet.gid}:${row.rowNumber}`))
    .map((row) => ({ sheet, row })),
).slice(0, limit);

if (selected.length === 0) {
  console.log(JSON.stringify({ success: true, selected: 0, message: "No eligible missing rows remain" }));
  await prisma.$disconnect();
  process.exit(0);
}

let published = 0;
let skippedExisting = 0;
let failed = 0;

for (let offset = 0; offset < selected.length;) {
  const first = selected[offset];
  const batch = [] as typeof selected;
  while (
    offset + batch.length < selected.length &&
    batch.length < batchSize &&
    selected[offset + batch.length].sheet.gid === first.sheet.gid
  ) {
    batch.push(selected[offset + batch.length]);
  }
  const result = await processGoogleSheetBatch({
    sheetUrl: first.sheet.sheetUrl,
    rowNumbers: batch.map((entry) => entry.row.rowNumber),
    createManualReview: true,
    processOnlyNewRows: false,
    waitForPublishCompletion: true,
    createMissingProducts: true,
    skipExistingProducts: true,
    allowBlockedSheetFallback: false,
    mode: "sheet_link",
  });

  for (const entry of batch) {
    const success = result.successful.find((item) => item.rowNumber === entry.row.rowNumber);
    const skipped = result.skipped.find((item) => item.rowNumber === entry.row.rowNumber);
    const failure = result.failed.find((item) => item.rowNumber === entry.row.rowNumber);
    const outcome = success?.action === "published"
      ? "published"
      : skipped?.reason === "already_linked_to_shopify_missing_only_guard"
        ? "skipped_existing"
        : "failed";
    if (outcome === "published") published += 1;
    else if (outcome === "skipped_existing") skippedExisting += 1;
    else failed += 1;
    const checkpoint = {
      at: new Date().toISOString(),
      sheet: entry.sheet.name,
      gid: entry.sheet.gid,
      rowNumber: entry.row.rowNumber,
      url: entry.row.url,
      multiplier: entry.row.priceMultiplier,
      outcome,
      success: success || null,
      skipped: skipped || null,
      failure: failure || null,
    };
    fs.appendFileSync(checkpointPath, `${JSON.stringify(checkpoint)}\n`);
    console.log(JSON.stringify(checkpoint));
  }
  offset += batch.length;
}

console.log(JSON.stringify({ success: failed === 0, selected: selected.length, published, skippedExisting, failed, checkpointPath }));
await prisma.$disconnect();
if (failed > 0) process.exitCode = 2;
