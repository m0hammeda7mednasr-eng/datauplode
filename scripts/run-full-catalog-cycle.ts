import "dotenv/config";
import type { Prisma } from "@prisma/client";
import { prisma } from "../src/server/db.js";
import { ShopifyService } from "../src/server/services/shopify.js";
import { syncFullProductCatalog } from "../src/server/services/fullCatalogSync.js";
import { getApprovedSheetMultiplier } from "../src/server/services/sheetMultiplier.js";

function arg(name: string, fallback = "") {
  const envName = `FULL_CATALOG_RUN_${name.replace(/-/g, "_").toUpperCase()}`;
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
  return arg("domains", "next.ae")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[a-z0-9.-]+$/.test(value));
}

function quietScraperLogs() {
  if (arg("verbose", "false").toLowerCase() === "true") return;
  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);
  console.log = (...values: unknown[]) => {
    const first = clean(values[0]);
    if (first.startsWith("{") || first.startsWith("[")) originalLog(...values);
  };
  console.error = (...values: unknown[]) => {
    const first = clean(values[0]);
    if (/^(Error|TypeError|Prisma|RangeError|ReferenceError|\{|\[)/i.test(first)) {
      originalError(...values);
    }
  };
}

function domainRank(url: string, domains: string[]) {
  const normalized = clean(url).toLowerCase();
  const rank = domains.findIndex((domain) => normalized.includes(domain));
  return rank >= 0 ? rank : domains.length;
}

function isTransientBlock(message: string) {
  return /blocked automated server access|HTTP 403|access denied|forbidden|cloudflare|ScraperAPI returned a blocked page/i.test(message);
}

function isImportPlaceholderTitle(title: string) {
  return /^(?:Excel Import Issue|Blocked Source Product)\b/i.test(clean(title));
}

async function countFullyVerified() {
  return prisma.sourceProduct.count({
    where: {
      shopifyProduct: { is: { syncEnabled: true } },
      auditLogs: { some: { action: "SYNC_PRODUCT_CATALOG_SET" } },
    },
  });
}

async function main() {
  quietScraperLogs();
  const domains = parseDomains();
  const limit = numberArg("limit", 25);
  const target = numberArg("target", 5000);
  const concurrency = Math.max(1, Math.min(5, numberArg("concurrency", 2)));
  const poolSize = Math.max(limit * 5, numberArg("pool", 500));
  const minAgeDays = numberArg("min-age-days", 30);
  const failureRetryMinutes = numberArg("failure-retry-minutes", 1440);
  const successCutoff = new Date(Date.now() - minAgeDays * 24 * 60 * 60 * 1000);
  const failureCutoff = new Date(Date.now() - failureRetryMinutes * 60 * 1000);

  if (domains.length === 0) throw new Error("No valid target domains were provided");

  const baseWhere: Prisma.SourceProductWhereInput = {
    syncStatus: { not: "paused" },
    OR: domains.map((domain) => ({ url: { contains: domain, mode: "insensitive" } })),
    title: { not: { startsWith: "Excel Import Issue" } },
    raw: { contains: "sheetPriceMultiplier" },
    shopifyProduct: { is: { syncEnabled: true } },
    AND: [
      { auditLogs: { none: { action: "SYNC_PRODUCT_CATALOG_SET", createdAt: { gte: successCutoff } } } },
      { auditLogs: { none: { action: "SYNC_PRODUCT_CATALOG_FAILED", createdAt: { gte: failureCutoff } } } },
    ],
  };

  const fullyBefore = await countFullyVerified();
  const candidates = await prisma.sourceProduct.findMany({
    where: baseWhere,
    select: {
      id: true,
      title: true,
      url: true,
      raw: true,
      lastScrapedAt: true,
      variants: { select: { sku: true, shopifyVariant: { select: { sku: true } } }, take: 8 },
      shopifyProduct: { select: { variants: { select: { sku: true }, take: 8 } } },
    },
    orderBy: { lastScrapedAt: "asc" },
    take: poolSize,
  });

  const selected = candidates
    .filter((candidate) => !isImportPlaceholderTitle(candidate.title) && Boolean(getApprovedSheetMultiplier(candidate)))
    .sort((left, right) =>
      domainRank(left.url, domains) - domainRank(right.url, domains) ||
      (left.lastScrapedAt?.getTime() || 0) - (right.lastScrapedAt?.getTime() || 0),
    )
    .slice(0, Math.max(0, Math.min(limit, target - fullyBefore)));

  const client = await ShopifyService.getClientFromDb(prisma);
  const location = await ShopifyService.getInventoryLocation(client);
  const results: Array<{ id: string; ok: boolean; title: string; error?: string }> = [];
  let cursor = 0;

  async function worker() {
    while (cursor < selected.length) {
      const candidate = selected[cursor++];
      try {
        await syncFullProductCatalog({
          prisma,
          sourceProductId: candidate.id,
          client,
          location,
        });
        results.push({ id: candidate.id, ok: true, title: candidate.title });
      } catch (error: any) {
        const message = clean(error?.message || error).slice(0, 2000);
        try {
          await prisma.auditLog.create({
            data: {
              sourceProductId: candidate.id,
              action: "SYNC_PRODUCT_CATALOG_FAILED",
              details: JSON.stringify({
                message,
                runner: "run-full-catalog-cycle",
                transientBlock: isTransientBlock(message),
              }),
            },
          });
        } catch (logError) {
          console.error(JSON.stringify({ auditLogWriteFailed: clean((logError as Error)?.message || logError) }));
        }
        results.push({ id: candidate.id, ok: false, title: candidate.title, error: message });
      }
      const done = results.length;
      if (done % 10 === 0 || done === selected.length) {
        const ok = results.filter((result) => result.ok).length;
        const failed = results.length - ok;
        console.log(JSON.stringify({ progress: done, selected: selected.length, ok, failed }));
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, () => worker()));
  const fullyAfter = await countFullyVerified();
  const ok = results.filter((result) => result.ok).length;
  const failed = results.length - ok;
  const sampleFailures = results
    .filter((result) => !result.ok)
    .slice(0, 5)
    .map((result) => ({ title: result.title, error: result.error?.slice(0, 160) }));

  console.log(JSON.stringify({
    domains,
    selected: selected.length,
    ok,
    failed,
    fullyBefore,
    fullyAfter,
    addedFullyVerified: fullyAfter - fullyBefore,
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
