import "dotenv/config";
import { prisma } from "../src/server/db.js";

const hours = Math.max(1, Number(process.env.CATALOG_FAILURE_REPORT_HOURS || 2));
const since = new Date(Date.now() - hours * 60 * 60 * 1000);
const logs = await prisma.auditLog.findMany({
  where: {
    action: "SYNC_PRODUCT_CATALOG_FAILED",
    createdAt: { gte: since },
  },
  include: {
    sourceProduct: { select: { title: true, url: true } },
  },
  orderBy: { createdAt: "desc" },
});

function message(details: string | null) {
  try {
    return String(JSON.parse(details || "{}").message || "");
  } catch {
    return String(details || "");
  }
}

function reason(value: string) {
  if (/blocked|403|access denied|cooling down|No usable product HTML/i.test(value)) return "source_blocked";
  if (/quality gate|suspicious|implausible|placeholder|duplicate/i.test(value)) return "quality_rejected";
  if (/read-back|could not be verified|did not converge/i.test(value)) return "shopify_readback_failed";
  return "other";
}

const rows = logs.map((log) => ({
  at: log.createdAt,
  title: log.sourceProduct?.title,
  url: log.sourceProduct?.url,
  reason: reason(message(log.details)),
  error: message(log.details),
}));
const counts = Object.fromEntries(
  [...new Set(rows.map((row) => row.reason))].map((key) => [key, rows.filter((row) => row.reason === key).length]),
);

console.log(JSON.stringify({ since, total: rows.length, counts, rows }, null, 2));
await prisma.$disconnect();
