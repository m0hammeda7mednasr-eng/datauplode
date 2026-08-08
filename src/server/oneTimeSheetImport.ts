import { envString, isProduction } from "./config/env.js";
import { prisma } from "./db.js";

const SPREADSHEET_ID = "1fCbPajWL3nukX0TdoN1m2X8LV3pfPsxSMLBb0yWug2w";
const IMPORT_RUN_KEY = "2026-08-05-sheets-22-28-v2";
const ROWS_PER_BATCH = 50;
const MAX_SHEET_ROW = 1000;
const START_DELAY_MS = 15_000;
const BETWEEN_BATCHES_MS = 1_500;
const RECENT_RUNNING_MS = 45 * 60 * 1000;

const SHEETS = [
  { name: "الورقة1", gid: "0" },
  { name: "الورقة22", gid: "282692873" },
  { name: "الورقة23", gid: "770232216" },
  { name: "الورقة24", gid: "1210585516" },
  { name: "الورقة25", gid: "307824540" },
  { name: "الورقة26", gid: "1459453928" },
  { name: "الورقة27", gid: "4356284" },
  { name: "الورقة28", gid: "422632561" },
] as const;

type SheetConfig = (typeof SHEETS)[number];

type ImportResult = Record<string, unknown> & {
  batchId?: string;
  batchStatus?: string;
  successful?: unknown[];
  failed?: unknown[];
  skipped?: unknown[];
  published?: number;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSheetUrl(gid: string) {
  return `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit?gid=${gid}`;
}

function buildRowNumbers(startRow: number, endRow: number) {
  return Array.from(
    { length: endRow - startRow + 1 },
    (_, index) => startRow + index,
  );
}

function buildMarkerType(sheet: SheetConfig, startRow: number, endRow: number) {
  return `ONE_TIME_SHEET_IMPORT:${IMPORT_RUN_KEY}:${sheet.gid}:${startRow}-${endRow}`;
}

function summarizeResult(result: ImportResult) {
  return {
    batchId: result.batchId || null,
    batchStatus: result.batchStatus || null,
    published:
      typeof result.published === "number"
        ? result.published
        : Array.isArray(result.successful)
          ? result.successful.length
          : 0,
    skipped: Array.isArray(result.skipped) ? result.skipped.length : 0,
    failed: Array.isArray(result.failed) ? result.failed.length : 0,
  };
}

async function batchIsAlreadyHandled(markerType: string) {
  const latest = await prisma.syncJob.findFirst({
    where: { type: markerType },
    orderBy: { createdAt: "desc" },
    select: { status: true, startedAt: true },
  });

  if (!latest) return false;
  if (latest.status === "completed") return true;

  if (latest.status === "running" && latest.startedAt) {
    return Date.now() - latest.startedAt.getTime() < RECENT_RUNNING_MS;
  }

  return false;
}

async function processBatch(params: {
  port: number;
  sheet: SheetConfig;
  startRow: number;
  endRow: number;
}) {
  const { port, sheet, startRow, endRow } = params;
  const markerType = buildMarkerType(sheet, startRow, endRow);

  if (await batchIsAlreadyHandled(markerType)) {
    console.log(
      `[one-time-import] skipped completed/running batch ${sheet.name} ${startRow}-${endRow}`,
    );
    return;
  }

  const marker = await prisma.syncJob.create({
    data: {
      type: markerType,
      status: "running",
      startedAt: new Date(),
      payload: JSON.stringify({
        runKey: IMPORT_RUN_KEY,
        sheet: sheet.name,
        gid: sheet.gid,
        startRow,
        endRow,
      }),
    },
  });

  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/imports/excel/process-sheet-link`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sheetUrl: buildSheetUrl(sheet.gid),
          rowNumbers: buildRowNumbers(startRow, endRow),
          createManualReview: true,
          processOnlyNewRows: false,
          waitForPublishCompletion: false,
        }),
      },
    );

    const responseText = await response.text();
    let parsed: ImportResult = {};
    try {
      parsed = responseText ? (JSON.parse(responseText) as ImportResult) : {};
    } catch {
      parsed = { raw: responseText.slice(0, 5_000) };
    }

    if (!response.ok) {
      const errorMessage =
        typeof parsed.error === "string"
          ? parsed.error
          : `Import API returned ${response.status}`;
      throw new Error(errorMessage);
    }

    const summary = summarizeResult(parsed);
    await prisma.syncJob.update({
      where: { id: marker.id },
      data: {
        status: "completed",
        completedAt: new Date(),
        result: JSON.stringify({
          runKey: IMPORT_RUN_KEY,
          sheet: sheet.name,
          gid: sheet.gid,
          startRow,
          endRow,
          ...summary,
        }),
      },
    });

    console.log(
      `[one-time-import] queued ${sheet.name} ${startRow}-${endRow}`,
      summary,
    );
  } catch (error: any) {
    const message = String(error?.message || error || "Unknown import error");
    await prisma.syncJob.update({
      where: { id: marker.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        result: JSON.stringify({
          runKey: IMPORT_RUN_KEY,
          sheet: sheet.name,
          gid: sheet.gid,
          startRow,
          endRow,
          error: message.slice(0, 5_000),
        }),
      },
    });

    console.error(
      `[one-time-import] failed ${sheet.name} ${startRow}-${endRow}:`,
      message,
    );
  }
}

async function runOneTimeSheetImport(port: number) {
  console.log(
    `[one-time-import] starting ${IMPORT_RUN_KEY} for ${SHEETS.length} sheets`,
  );

  for (const sheet of SHEETS) {
    for (
      let startRow = 1;
      startRow <= MAX_SHEET_ROW;
      startRow += ROWS_PER_BATCH
    ) {
      const endRow = Math.min(
        startRow + ROWS_PER_BATCH - 1,
        MAX_SHEET_ROW,
      );
      await processBatch({ port, sheet, startRow, endRow });
      await sleep(BETWEEN_BATCHES_MS);
    }
  }

  console.log(`[one-time-import] finished queueing ${IMPORT_RUN_KEY}`);
}

export function startOneTimeSheetImport(port: number) {
  const isRailway = Boolean(
    envString("RAILWAY_ENVIRONMENT") || envString("RAILWAY_PUBLIC_DOMAIN"),
  );

  if (!isProduction() || !isRailway) {
    console.log(
      "[one-time-import] disabled outside the Railway production environment",
    );
    return;
  }

  setTimeout(() => {
    void runOneTimeSheetImport(port).catch((error) => {
      console.error("[one-time-import] unexpected fatal error:", error);
    });
  }, START_DELAY_MS);
}
