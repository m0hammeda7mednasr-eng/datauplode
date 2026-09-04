import { Router } from "express";
import { prisma } from "../db.js";
import { ShopifyService } from "../services/shopify.js";

const router = Router();
const CACHE_MS = 90_000;
const DEFAULTISH_QUERY = "variant_title:Default";
const REPAIR_ACTIONS = [
  "SYNC_PRODUCT_CATALOG_SET",
  "SYNC_PRODUCT_CATALOG_FAILED",
  "SYNC_PRODUCT_CATALOG_SKIPPED_SINGLE_VARIANT",
];

type ShopifyAuditProduct = {
  id: string;
  title: string;
  handle: string;
  vendor: string;
  status: string;
  productType?: string;
  totalInventory?: number;
  variantsCount?: { count?: number };
  options?: Array<{ name?: string; values?: string[] }>;
  variants?: { nodes?: Array<{ title?: string; sku?: string | null; selectedOptions?: Array<{ name?: string; value?: string }> }> };
};

type AuditRow = {
  id: string;
  numericId: string;
  title: string;
  handle: string;
  vendor: string;
  status: string;
  productType: string;
  inventory: number;
  variantCount: number;
  defaultValues: string[];
  sampleVariants: Array<{ title: string; sku: string | null }>;
  issueType: "single_default" | "multi_placeholder";
  recommendedAction: "expand_or_normalize" | "clean_placeholder";
  sourceUrl: string | null;
  sourceVariantCount: number | null;
  sourceSyncStatus: string | null;
  sourceLastScrapedAt: string | null;
  difficulty: "easy" | "medium" | "hard" | "review";
  difficultyReason: string;
  repairStatus: "queued" | "checking" | "confirmed_single" | "failed" | "needs_review" | "needs_source";
  repairMessage: string;
  lastRepairAt: string | null;
};

type CacheValue = { createdAt: number; rows: AuditRow[] };
let cache: CacheValue | null = null;
let refreshPromise: Promise<AuditRow[]> | null = null;

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function isDefaultish(value: unknown) {
  return /(^|\s|\/|-)default(?:\s+title|\s*\d+)?($|\s|\/|-)/i.test(clean(value));
}

function numericId(gid: string) {
  return gid.split("/").pop() || gid;
}

function domainOf(url: string | null) {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function classifyDifficulty(sourceUrl: string | null) {
  const domain = domainOf(sourceUrl);
  if (!domain) {
    return { difficulty: "review" as const, reason: "No linked source URL yet" };
  }
  if (domain.includes("next.ae") || domain.includes("nextdirect.com")) {
    return { difficulty: "easy" as const, reason: "Known direct source with deterministic product pages" };
  }
  if (domain.includes("centrepointstores.com")) {
    return { difficulty: "medium" as const, reason: "Known source; refresh can require richer page data" };
  }
  if (domain.includes("marksandspencer") || domain.includes("hm.com") || domain.includes("mothercare")) {
    return { difficulty: "medium" as const, reason: "Dynamic retailer source; fresh verification required" };
  }
  if (domain.includes("lefties.com") || domain.includes("zara.com")) {
    return { difficulty: "hard" as const, reason: "Dynamic/restricted source; browser or fallback may be required" };
  }
  return { difficulty: "medium" as const, reason: `Linked source: ${domain}` };
}

async function fetchShopifyDefaultishProducts() {
  const client = await ShopifyService.getClientFromDb(prisma);
  const rows: ShopifyAuditProduct[] = [];
  let after: string | null = null;

  while (true) {
    const data: any = await client.request(
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

async function mapDatabaseState(products: ShopifyAuditProduct[]) {
  const ids = products.map((product) => product.id);
  const byShopifyId = new Map<string, any>();

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

function deriveRepairState(
  issueType: AuditRow["issueType"],
  source: any,
): Pick<AuditRow, "repairStatus" | "repairMessage" | "lastRepairAt"> {
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

  return products.map((product): AuditRow => {
    const variantCount = Number(product.variantsCount?.count || product.variants?.nodes?.length || 0);
    const defaultValues = Array.from(
      new Set(
        (product.options || [])
          .flatMap((option) => option.values || [])
          .filter(isDefaultish),
      ),
    );
    const issueType: AuditRow["issueType"] = variantCount <= 1 ? "single_default" : "multi_placeholder";
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

router.get("/shopify-catalog/default-variant-audit", async (req, res) => {
  try {
    const force = clean(req.query.refresh).toLowerCase() === "true";
    const allRows = await getRows(force);
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

    const counts = (key: keyof Pick<AuditRow, "issueType" | "difficulty" | "repairStatus">) =>
      allRows.reduce<Record<string, number>>((acc, row) => {
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
      vendors: Array.from(new Set(allRows.map((row) => row.vendor))).sort((a, b) => a.localeCompare(b)),
      totalFiltered: filtered.length,
      offset,
      limit,
      rows: filtered.slice(offset, offset + limit),
      note: "A Default value is an audit candidate, not proof that variants are missing. Fresh source data decides whether to expand, normalize a genuine single variant, or clean a placeholder.",
    });
  } catch (error: any) {
    console.error("Default variant audit failed", error);
    return res.status(500).json({ success: false, error: error?.message || String(error) });
  }
});

export default router;
