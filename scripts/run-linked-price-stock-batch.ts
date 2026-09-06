import "dotenv/config";
import type { Prisma } from "@prisma/client";
import { prisma } from "../src/server/db.js";
import { QueueService } from "../src/server/services/queue.js";
import { getApprovedSheetMultiplier } from "../src/server/services/sheetMultiplier.js";

function arg(name: string, fallback = "") {
  const envName = `PRICE_STOCK_RUN_${name.replace(/-/g, "_").toUpperCase()}`;
  if (process.env[envName]) return String(process.env[envName]);
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || "") : fallback;
}

function numberArg(name: string, fallback: number) {
  const value = Number(arg(name));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function clean(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseDomains() {
  return arg("domains", "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[a-z0-9.-]+$/.test(value));
}

function parseJson(value: string | null | undefined) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function isImportPlaceholderTitle(title: string) {
  return /^(?:Excel Import Issue|Blocked Source Product)\b/i.test(clean(title));
}

function domainRank(url: string, domains: string[]) {
  if (domains.length === 0) return 0;
  const normalized = clean(url).toLowerCase();
  const rank = domains.findIndex((domain) => normalized.includes(domain));
  return rank >= 0 ? rank : domains.length;
}

function resultSummary(result: string | null | undefined) {
  const parsed = parseJson(result);
  return {
    pricesUpdated: Number(parsed.pricesUpdated || parsed.priceUpdates || 0),
    inventoryUpdated: Number(parsed.inventoryUpdated || parsed.inventoryUpdates || parsed.variantsUpdated || 0),
    variantsMatched: Number(parsed.variantsMatched || 0),
    error: clean(parsed.error || parsed.message || ""),
  };
}

async function countPriceStockVerified() {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(DISTINCT sp."sourceProductId")::bigint AS count
    FROM "ShopifyProduct" sp
    JOIN "AuditLog" a ON a."sourceProductId" = sp."sourceProductId"
    WHERE sp."syncEnabled" = TRUE
      AND a."action" IN ('SYNC_PRODUCT_CATALOG_SET', 'SYNC_PRICE_STOCK_ONLY')
  `;
  return Number(rows[0]?.count || 0);
}

async function main() {
  const domains = parseDomains();
  const limit = numberArg("limit", 100);
  const pool = Math.max(limit * 3, numberArg("pool", 500));
  const successAgeHours = numberArg("success-age-hours", 24);
  const failureRetryMinutes = numberArg("failure-retry-minutes", 180);
  const timeoutMinutes = numberArg("timeout-minutes", 30);
  const successCutoff = new Date(Date.now() - successAgeHours * 60 * 60 * 1000);
  const failureCutoff = new Date(Date.now() - failureRetryMinutes * 60 * 1000);

  const where: Prisma.SourceProductWhereInput = {
    syncStatus: { not: "paused" },
    raw: { contains: "sheetPriceMultiplier" },
    ...(domains.length
      ? { OR: domains.map((domain) => ({ url: { contains: domain, mode: "insensitive" as const } })) }
      : {}),
    shopifyProduct: {
      is: {
        syncEnabled: true,
        OR: [{ syncPrice: true }, { syncInventory: true }],
      },
    },
    AND: [
      {
        auditLogs: {
          none: {
            action: { in: ["SYNC_PRODUCT_CATALOG_SET", "SYNC_PRICE_STOCK_ONLY"] },
            createdAt: { gte: successCutoff },
          },
        },
      },
      {
        auditLogs: {
          none: {
            action: "SYNC_PRICE_STOCK_FAILED",
            createdAt: { gte: failureCutoff },
          },
        },
      },
    ],
  };

  const beforeVerified = await countPriceStockVerified();
  const candidates = await prisma.sourceProduct.findMany({
    where,
    select: {
      id: true,
      title: true,
      url: true,
      raw: true,
      lastScrapedAt: true,
      variants: { select: { sku: true, shopifyVariant: { select: { sku: true } } }, take: 5 },
    },
    orderBy: { lastScrapedAt: "asc" },
    take: pool,
  });

  const selected = candidates
    .filter((product) =>
      !isImportPlaceholderTitle(product.title) &&
      Boolean(getApprovedSheetMultiplier(product)) &&
      product.variants.some((variant) => clean(variant.shopifyVariant?.sku || variant.sku)),
    )
    .sort((left, right) =>
      domainRank(left.url, domains) - domainRank(right.url, domains) ||
      (left.lastScrapedAt?.getTime() || 0) - (right.lastScrapedAt?.getTime() || 0),
    )
    .slice(0, limit);

  const queued: Array<{ jobId: string; sourceProductId: string; title: string }> = [];
  for (const product of selected) {
    const job = await QueueService.addTask("SYNC_PRICE_STOCK", {
      sourceProductId: product.id,
      reason: "operator_price_stock_batch",
    });
    queued.push({ jobId: job.id, sourceProductId: product.id, title: product.title });
  }

  const deadline = Date.now() + timeoutMinutes * 60 * 1000;
  let completed = 0;
  let failed = 0;
  let lastReported = -1;
  while (Date.now() < deadline) {
    const jobs = queued.length
      ? await prisma.syncJob.findMany({
          where: { id: { in: queued.map((job) => job.jobId) } },
          select: { id: true, status: true, result: true },
        })
      : [];
    completed = jobs.filter((job) => job.status === "completed").length;
    failed = jobs.filter((job) => job.status === "failed").length;
    const done = completed + failed;
    if (done !== lastReported && (done % 10 === 0 || done === queued.length)) {
      console.log(JSON.stringify({ progress: done, queued: queued.length, completed, failed }));
      lastReported = done;
    }
    if (done >= queued.length) break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  const finalJobs = queued.length
    ? await prisma.syncJob.findMany({
        where: { id: { in: queued.map((job) => job.jobId) } },
        select: { id: true, status: true, result: true },
      })
    : [];
  const jobById = new Map(finalJobs.map((job) => [job.id, job]));
  let pricesUpdated = 0;
  let inventoryUpdated = 0;
  let variantsMatched = 0;
  const sampleFailures: Array<{ title: string; error: string }> = [];
  for (const queuedJob of queued) {
    const job = jobById.get(queuedJob.jobId);
    const summary = resultSummary(job?.result);
    if (job?.status === "completed") {
      pricesUpdated += summary.pricesUpdated;
      inventoryUpdated += summary.inventoryUpdated;
      variantsMatched += summary.variantsMatched;
    } else if (sampleFailures.length < 5) {
      sampleFailures.push({
        title: queuedJob.title,
        error: summary.error || clean(job?.status || "timeout"),
      });
    }
  }
  const afterVerified = await countPriceStockVerified();

  console.log(JSON.stringify({
    domains,
    selected: selected.length,
    queued: queued.length,
    completed: finalJobs.filter((job) => job.status === "completed").length,
    failed: finalJobs.filter((job) => job.status === "failed").length,
    stillRunning: finalJobs.filter((job) => job.status === "running" || job.status === "pending").length,
    priceStockVerifiedBefore: beforeVerified,
    priceStockVerifiedAfter: afterVerified,
    addedPriceStockVerified: afterVerified - beforeVerified,
    pricesUpdated,
    inventoryUpdated,
    variantsMatched,
    sampleFailures,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
