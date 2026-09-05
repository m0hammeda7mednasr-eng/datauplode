import { Router } from "express";
import { prisma } from "../db.js";
import { ShopifyService } from "../services/shopify.js";
import { getScraperApiAccountUsage } from "../services/scraperCreditBudget.js";

const router = Router();
const CACHE_MS = 90_000;
const DEFAULTISH_QUERY = "variant_title:Default";
const REPAIR_ACTIONS = [
  "SYNC_PRODUCT_CATALOG_SET",
  "SYNC_PRODUCT_CATALOG_FAILED",
  "SYNC_PRODUCT_CATALOG_SKIPPED_SINGLE_VARIANT",
];

let cache = null;
let refreshPromise = null;

function clean(value) {
  return String(value ?? "").trim();
}

function isDefaultish(value) {
  return /(^|\s|\/|-)default(?:\s+title|\s*\d+)?($|\s|\/|-)/i.test(clean(value));
}

function numericId(gid) {
  return gid.split("/").pop() || gid;
}

function domainOf(url) {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function classifyDifficulty(sourceUrl) {
  const domain = domainOf(sourceUrl);
  if (!domain) return { difficulty: "review", reason: "No linked source URL yet" };
  if (domain.includes("next.ae") || domain.includes("nextdirect.com")) {
    return { difficulty: "medium", reason: "Known source with managed fallback; some pages return HTTP 403" };
  }
  if (domain.includes("centrepointstores.com")) {
    return { difficulty: "hard", reason: "Protected source; refresh can be slow or require a richer snapshot" };
  }
  if (domain.includes("marksandspencer") || domain.includes("hm.com") || domain.includes("mothercare")) {
    return { difficulty: "medium", reason: "Dynamic retailer source; fresh verification required" };
  }
  if (domain.includes("lefties.com") || domain.includes("zara.com")) {
    return { difficulty: "hard", reason: "Dynamic/restricted source; browser or fallback may be required" };
  }
  return { difficulty: "medium", reason: `Linked source: ${domain}` };
}

async function fetchShopifyDefaultishProducts() {
  const client = await ShopifyService.getClientFromDb(prisma);
  const rows = [];
  let after = null;

  while (true) {
    const data = await client.request(
      `query DefaultVariantAudit($after: String) {
        products(first: 250, after: $after, query: "${DEFAULTISH_QUERY}", sortKey: ID) {
          nodes {
            id
            title
            handle
            vendor
            status
            productType
            totalInventory
            variantsCount { count }
            options { name values }
            variants(first: 5) {
              nodes { title sku selectedOptions { name value } }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { after },
    );

    const connection = data?.products;
    rows.push(...(connection?.nodes || []));
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor;
    if (!after || rows.length > 20_000) break;
  }

  return rows;
}

async function mapDatabaseState(products) {
  const ids = products.map((product) => product.id);
  const byShopifyId = new Map();

  for (let offset = 0; offset < ids.length; offset += 250) {
    const chunk = ids.slice(offset, offset + 250);
    const linked = await prisma.shopifyProduct.findMany({
      where: { shopifyId: { in: chunk } },
      select: {
        shopifyId: true,
        sourceProduct: {
          select: {
            url: true,
            syncStatus: true,
            lastScrapedAt: true,
            _count: { select: { variants: true } },
            auditLogs: {
              where: { action: { in: REPAIR_ACTIONS } },
              orderBy: { createdAt: "desc" },
              take: 1,
              select: { action: true, details: true, createdAt: true },
            },
          },
        },
      },
    });
    linked.forEach((row) => byShopifyId.set(row.shopifyId, row));
  }

  return byShopifyId;
}

function deriveRepairState(issueType, source) {
  if (!source?.url) {
    return { repairStatus: "needs_source", repairMessage: "Source link is missing", lastRepairAt: null };
  }

  const latest = source.auditLogs?.[0];
  if (latest?.action === "SYNC_PRODUCT_CATALOG_FAILED") {
    return {
      repairStatus: "failed",
      repairMessage: "Latest catalog repair failed; retry/fallback required",
      lastRepairAt: latest.createdAt?.toISOString?.() || String(latest.createdAt || ""),
    };
  }
  if (latest?.action === "SYNC_PRODUCT_CATALOG_SKIPPED_SINGLE_VARIANT") {
    return {
      repairStatus: "confirmed_single",
      repairMessage: "Fresh source still has one real variant; normalize the label instead of inventing variants",
      lastRepairAt: latest.createdAt?.toISOString?.() || String(latest.createdAt || ""),
    };
  }
  if (latest?.action === "SYNC_PRODUCT_CATALOG_SET") {
    return {
      repairStatus: "needs_review",
      repairMessage: "A repair ran but a Default placeholder still remains",
      lastRepairAt: latest.createdAt?.toISOString?.() || String(latest.createdAt || ""),
    };
  }
  if (issueType === "multi_placeholder") {
    return { repairStatus: "checking", repairMessage: "Real variants exist; only the Default placeholder needs source-safe cleanup", lastRepairAt: null };
  }
  return { repairStatus: "queued", repairMessage: "Single Default variant is queued for fresh-source verification", lastRepairAt: null };
}

async function buildRows() {
  const products = await fetchShopifyDefaultishProducts();
  const dbById = await mapDatabaseState(products);

  return products.map((product) => {
    const variantCount = Number(product.variantsCount?.count || product.variants?.nodes?.length || 0);
    const defaultValues = Array.from(
      new Set(
        (product.options || [])
          .flatMap((option) => option.values || [])
          .filter(isDefaultish),
      ),
    );
    const issueType = variantCount <= 1 ? "single_default" : "multi_placeholder";
    const linked = dbById.get(product.id);
    const source = linked?.sourceProduct || null;
    const sourceUrl = source?.url || null;
    const difficulty = classifyDifficulty(sourceUrl);
    const repair = deriveRepairState(issueType, source);

    return {
      id: product.id,
      numericId: numericId(product.id),
      title: product.title,
      handle: product.handle,
      vendor: product.vendor || "Unknown",
      status: clean(product.status).toLowerCase(),
      productType: product.productType || "",
      inventory: Number(product.totalInventory || 0),
      variantCount,
      defaultValues: defaultValues.length ? defaultValues : ["Default"],
      sampleVariants: (product.variants?.nodes || []).map((variant) => ({
        title: clean(variant.title),
        sku: variant.sku || null,
      })),
      issueType,
      recommendedAction: issueType === "single_default" ? "expand_or_normalize" : "clean_placeholder",
      sourceUrl,
      sourceVariantCount: source?._count?.variants ?? null,
      sourceSyncStatus: source?.syncStatus || null,
      sourceLastScrapedAt: source?.lastScrapedAt?.toISOString?.() || (source?.lastScrapedAt ? String(source.lastScrapedAt) : null),
      difficulty: difficulty.difficulty,
      difficultyReason: difficulty.reason,
      ...repair,
    };
  });
}

async function getRows(force = false) {
  const now = Date.now();
  if (!force && cache && now - cache.createdAt < CACHE_MS) return cache.rows;
  if (!refreshPromise) {
    refreshPromise = buildRows()
      .then((rows) => {
        cache = { createdAt: Date.now(), rows };
        return rows;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

function parsedDetails(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

async function buildRuntimeStatus() {
  const providerUsage = await getScraperApiAccountUsage();
  const now = new Date();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const startUtcDay = new Date(now);
  startUtcDay.setUTCHours(0, 0, 0, 0);
  const actions = [...REPAIR_ACTIONS, "SCRAPERAPI_CREDIT_RESERVED"];
  const [latestJob, logs] = await Promise.all([
    prisma.syncJob.findFirst({
      where: { type: "SYNC_FULL_CATALOG_BATCH" },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, createdAt: true, startedAt: true, completedAt: true, result: true },
    }),
    prisma.auditLog.findMany({
      where: { action: { in: actions }, createdAt: { gte: since24h } },
      select: {
        action: true,
        details: true,
        createdAt: true,
        sourceProduct: { select: { url: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 10_000,
    }),
  ]);

  const sourceMap = new Map();
  let creditsUsedToday = 0;
  let verified = 0;
  let failed = 0;
  let skipped = 0;
  for (const log of logs) {
    const details = parsedDetails(log.details);
    if (log.action === "SCRAPERAPI_CREDIT_RESERVED") {
      if (log.createdAt >= startUtcDay) {
        creditsUsedToday += Math.max(0, Number(details.requestedCredits || details.credits || 0));
      }
      continue;
    }
    const domain = domainOf(log.sourceProduct?.url) || "unknown";
    const source = sourceMap.get(domain) || { domain, verified: 0, failed: 0, skipped: 0 };
    if (log.action === "SYNC_PRODUCT_CATALOG_SET" && details.readbackVerified === true) {
      verified += 1;
      source.verified += 1;
    } else if (log.action === "SYNC_PRODUCT_CATALOG_FAILED") {
      failed += 1;
      source.failed += 1;
    } else if (log.action === "SYNC_PRODUCT_CATALOG_SKIPPED_SINGLE_VARIANT") {
      skipped += 1;
      source.skipped += 1;
    }
    sourceMap.set(domain, source);
  }

  const latestResult = parsedDetails(latestJob?.result);
  const startedAt = latestJob?.startedAt || latestJob?.createdAt;
  const runningSeconds = latestJob?.status === "running" && startedAt
    ? Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 1000))
    : 0;
  const dailyLimit = Math.max(0, Number(process.env.SCRAPERAPI_DAILY_CREDIT_LIMIT || 0));
  const targetDomains = String(process.env.SYNC_FULL_CATALOG_TARGET_DOMAINS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  return {
    worker: {
      enabled: String(process.env.SYNC_FULL_CATALOG_AUTOSTART || "").toLowerCase() === "true",
      defaultVariantsOnly: String(process.env.SYNC_FULL_CATALOG_DEFAULT_VARIANTS_ONLY || "").toLowerCase() === "true",
      targetDomains,
      batchSize: Math.max(0, Number(process.env.SYNC_FULL_CATALOG_BATCH_SIZE || 0)),
      intervalMinutes: Math.max(0, Number(process.env.SYNC_FULL_CATALOG_INTERVAL_MINUTES || 0)),
      failureRetryMinutes: Math.max(0, Number(process.env.SYNC_FULL_CATALOG_FAILURE_RETRY_MINUTES || 0)),
    },
    credits: {
      providerCycleUsed: providerUsage?.creditsUsed ?? null,
      providerCycleLimit: providerUsage?.creditLimit ?? null,
      usedToday: creditsUsedToday,
      estimatedProviderUsedToday: creditsUsedToday,
      dailyLimit,
      remainingToday: dailyLimit ? Math.max(0, dailyLimit - creditsUsedToday) : null,
    },
    last24h: { verified, failed, skipped },
    latestJob: latestJob ? {
      id: latestJob.id,
      status: latestJob.status,
      createdAt: latestJob.createdAt,
      completedAt: latestJob.completedAt,
      runningSeconds,
      stalled: latestJob.status === "running" && runningSeconds > 8 * 60,
      selected: Number(latestResult.selected || 0),
      completed: Number(latestResult.completed || 0),
      failed: Number(latestResult.failed || 0),
      readbackVerified: Number(latestResult.readbackVerified || 0),
    } : null,
    sources: [...sourceMap.values()]
      .map((source) => ({
        ...source,
        successRate: source.verified + source.failed > 0
          ? Math.round((source.verified / (source.verified + source.failed)) * 100)
          : null,
      }))
      .sort((left, right) => (right.verified + right.failed) - (left.verified + left.failed)),
    generatedAt: now.toISOString(),
  };
}

router.get("/shopify-catalog/default-variant-audit", async (req, res) => {
  try {
    const force = clean(req.query.refresh).toLowerCase() === "true";
    const [allRows, operations] = await Promise.all([getRows(force), buildRuntimeStatus()]);
    const search = clean(req.query.search).toLowerCase();
    const issueType = clean(req.query.issueType);
    const difficulty = clean(req.query.difficulty);
    const repairStatus = clean(req.query.repairStatus);
    const vendor = clean(req.query.vendor);
    const offset = Math.max(0, Number(req.query.offset || 0) || 0);
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50) || 50));

    const filtered = allRows.filter((row) => {
      if (search && !`${row.title} ${row.handle} ${row.vendor} ${row.sampleVariants.map((variant) => variant.sku || "").join(" ")}`.toLowerCase().includes(search)) return false;
      if (issueType && row.issueType !== issueType) return false;
      if (difficulty && row.difficulty !== difficulty) return false;
      if (repairStatus && row.repairStatus !== repairStatus) return false;
      if (vendor && row.vendor !== vendor) return false;
      return true;
    });

    const counts = (key) =>
      allRows.reduce((acc, row) => {
        const value = String(row[key]);
        acc[value] = (acc[value] || 0) + 1;
        return acc;
      }, {});

    return res.json({
      success: true,
      generatedAt: new Date().toISOString(),
      cacheAgeSeconds: cache ? Math.round((Date.now() - cache.createdAt) / 1000) : 0,
      summary: {
        total: allRows.length,
        issueType: counts("issueType"),
        difficulty: counts("difficulty"),
        repairStatus: counts("repairStatus"),
      },
      operations,
      vendors: Array.from(new Set(allRows.map((row) => row.vendor))).sort((a, b) => a.localeCompare(b)),
      totalFiltered: filtered.length,
      offset,
      limit,
      rows: filtered.slice(offset, offset + limit),
      note: "A Default value is an audit candidate, not proof that variants are missing. Fresh source data decides whether to expand, normalize a genuine single variant, or clean a placeholder.",
    });
  } catch (error) {
    console.error("Default variant audit failed", error);
    return res.status(500).json({ success: false, error: error?.message || String(error) });
  }
});

export default router;
