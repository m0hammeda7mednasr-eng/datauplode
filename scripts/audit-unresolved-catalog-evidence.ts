import { prisma } from "../src/server/db.js";

type Row = {
  shopifyId: string;
  title: string;
  vendor: string | null;
  primarySku: string | null;
  matchStatus: string;
  matchMethod: string;
  explicitSourceUrls: string | null;
  reason: string | null;
};

const limit = Math.max(1, Number(process.argv.find((arg) => arg.startsWith("--limit="))?.slice(8) || 40));
const compact = process.argv.includes("--compact");
const summary = process.argv.includes("--summary");
const requestedStatus = process.argv.find((arg) => arg.startsWith("--status="))?.slice(9);
const requestedMethod = process.argv.find((arg) => arg.startsWith("--method="))?.slice(9);
const allowedStatuses = new Set(["needs_link", "needs_review"]);
const allowedMethods = new Set(["ambiguous", "conflict", "source_url_not_in_sheets", "none"]);
const statusClause = requestedStatus && allowedStatuses.has(requestedStatus)
  ? `AND "matchStatus"='${requestedStatus}'`
  : "";
const methodClause = requestedMethod && allowedMethods.has(requestedMethod)
  ? `AND "matchMethod"='${requestedMethod}'`
  : "";
if (summary) {
  const groups = await prisma.$queryRawUnsafe<Array<{ matchStatus: string; matchMethod: string; vendor: string; count: number }>>(`
    SELECT "matchStatus", "matchMethod", COALESCE("vendor", '') AS "vendor", COUNT(*)::int AS "count"
    FROM "${"ShopifyCatalogIndexV2"}"
    WHERE UPPER(COALESCE("status", ''))='ACTIVE'
      AND "matchStatus" IN ('needs_link','needs_review')
    GROUP BY 1, 2, 3
    ORDER BY 1, 4 DESC
  `);
  console.log(JSON.stringify(groups));
  await prisma.$disconnect();
  process.exit(0);
}
const rows = await prisma.$queryRawUnsafe<Row[]>(`
  SELECT "shopifyId", "title", "vendor", "primarySku", "matchStatus", "matchMethod",
         "explicitSourceUrls", "reason"
  FROM "ShopifyCatalogIndexV2"
  WHERE UPPER(COALESCE("status", ''))='ACTIVE'
    AND "matchStatus" IN ('needs_link','needs_review')
    ${statusClause}
    ${methodClause}
  ORDER BY CASE WHEN "matchStatus"='needs_review' THEN 0 ELSE 1 END, "vendor", "title"
  LIMIT ${limit}
`);

const parse = (value: string | null) => {
  try { return JSON.parse(value || "[]"); } catch { return []; }
};

console.log(JSON.stringify(rows.map((row) => ({
  ...row,
  explicitSourceUrls: parse(row.explicitSourceUrls),
})), null, compact ? 0 : 2));

await prisma.$disconnect();
