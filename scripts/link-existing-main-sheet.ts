import { writeFile } from "node:fs/promises";
import { processGoogleSheetBatch } from "../src/server/api.js";
import { prisma } from "../src/server/db.js";

const spreadsheetId = "1fCbPajWL3nukX0TdoN1m2X8LV3pfPsxSMLBb0yWug2w";
const confirmation = "link-existing-main-sheet-v1";
const gid = boundedInteger(process.env.LINK_EXISTING_SHEET_GID || "0", 0, 2_147_483_647);
const rows = String(process.env.LINK_EXISTING_ROW_NUMBERS || "")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isSafeInteger(value) && value > 0);
const execute = process.env.LINK_EXISTING_CONFIRMATION === confirmation;
const sheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit?gid=${gid}`;
const outputPath = process.env.LINK_EXISTING_REPORT || `C:/tmp/link-existing-${gid}-${Date.now()}.json`;

if (!rows.length) {
  throw new Error("LINK_EXISTING_ROW_NUMBERS must contain explicit positive row numbers");
}

if (!execute) {
  console.log(JSON.stringify({
    dryRun: true,
    sheetUrl,
    rows,
    createsMissingProducts: false,
    confirmationRequired: confirmation,
  }));
  await prisma.$disconnect();
  process.exit(0);
}

try {
  const result = await processGoogleSheetBatch({
    sheetUrl,
    rowNumbers: rows,
    createManualReview: false,
    processOnlyNewRows: false,
    waitForPublishCompletion: true,
    createMissingProducts: false,
    linkExistingProductsOnly: true,
    allowBlockedSheetFallback: true,
    mode: "sheet_link",
  });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    dryRun: false,
    summary: result.summary,
    batchId: result.batchId,
    outputPath,
  }));
} finally {
  await prisma.$disconnect();
}

function boundedInteger(raw: string, min: number, max: number) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Expected an integer between ${min} and ${max}`);
  }
  return value;
}
