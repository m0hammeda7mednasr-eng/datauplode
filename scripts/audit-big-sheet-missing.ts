import fs from 'node:fs';
import { prisma } from '../src/server/db.js';
import { loadGoogleSheetRows } from '../src/server/api.js';

const spreadsheetId = '1fCbPajWL3nukX0TdoN1m2X8LV3pfPsxSMLBb0yWug2w';
const sheets = [
  ['الورقة1', 0],
  ['الورقة2', 531292068],
  ['الورقة6', 1951926772],
  ['الورقة7', 93159589],
  ['الورقة8', 916372394],
  ['الورقة9', 1264806944],
  ['الورقة10', 1991302797],
  ['الورقة11', 106757984],
  ['الورقة12', 1841878091],
  ['الورقة13', 1219566712],
  ['الورقة15', 242585683],
  ['الورقة16', 1526682180],
  ['الورقة18', 1122116162],
  ['الورقة19', 16172014],
  ['الورقة20', 202697256],
  ['الورقة21', 1993452910],
  ['الورقة22', 282692873],
  ['الورقة23', 770232216],
  ['الورقة24', 1210585516],
  ['الورقة25', 307824540],
  ['الورقة26', 1459453928],
  ['الورقة27', 4356284],
  ['الورقة28', 422632561],
] as const;

function normalizedUrl(value: string) {
  try {
    const url = new URL(value.trim());
    url.hash = '';
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return value.trim().replace(/\/$/, '').toLowerCase();
  }
}

const linked = await prisma.sourceProduct.findMany({
  where: { shopifyProduct: { isNot: null } },
  select: { url: true },
});
const linkedUrls = new Set(linked.map((product) => normalizedUrl(product.url)));
const report: any = {
  generatedAt: new Date().toISOString(),
  spreadsheetId,
  linkedProducts: linkedUrls.size,
  sheets: [],
};

for (const [name, gid] of sheets) {
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit?gid=${gid}`;
  const data = await loadGoogleSheetRows(sheetUrl);
  const uniqueRows = [...new Map(
    data.rows.map((row) => [normalizedUrl(row.url), row]),
  ).values()];
  const missingRows = uniqueRows.filter((row) => !linkedUrls.has(normalizedUrl(row.url)));
  report.sheets.push({
    name,
    gid,
    sheetUrl,
    totalRows: data.rows.length,
    uniqueRows: uniqueRows.length,
    linkedRows: uniqueRows.length - missingRows.length,
    missingRows: missingRows.map((row) => ({
      rowNumber: row.rowNumber,
      url: row.url,
      priceMultiplier: row.priceMultiplier,
      collection: row.collection,
      sku: row.sku,
    })),
  });
  console.log(`${name}: unique=${uniqueRows.length} linked=${uniqueRows.length - missingRows.length} missing=${missingRows.length}`);
}

report.totalUniqueRows = report.sheets.reduce((sum: number, sheet: any) => sum + sheet.uniqueRows, 0);
report.totalLinkedRows = report.sheets.reduce((sum: number, sheet: any) => sum + sheet.linkedRows, 0);
report.totalMissingRows = report.sheets.reduce((sum: number, sheet: any) => sum + sheet.missingRows.length, 0);
fs.writeFileSync('C:/tmp/big-sheet-missing-audit.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  totalUniqueRows: report.totalUniqueRows,
  totalLinkedRows: report.totalLinkedRows,
  totalMissingRows: report.totalMissingRows,
  output: 'C:/tmp/big-sheet-missing-audit.json',
}));
await prisma.$disconnect();
