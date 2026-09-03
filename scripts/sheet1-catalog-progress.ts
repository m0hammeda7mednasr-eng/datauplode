import { prisma } from "../src/server/db.js";

function safeJson(value: unknown) {
  if (!value) return {};
  if (typeof value === "object") return value as Record<string, any>;
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
}

function hostOf(url: string | null | undefined) {
  try {
    return new URL(String(url || "")).hostname.replace(/^www\./i, "");
  } catch {
    return "unknown";
  }
}

const jobs = await prisma.syncJob.findMany({
  where: {
    type: {
      startsWith: "SHEET1_CATALOG_AUTO_SYNC:",
    },
  },
  orderBy: { createdAt: "desc" },
  take: 10,
});
const latestJob = jobs.find((job) => {
  const result = safeJson(job.result);
  const state = safeJson(result.state || result);
  return state.totalRows === 5000 || state.verifiedRows !== undefined;
}) || jobs[0];
const result = safeJson(latestJob?.result);
const state = safeJson(result.state || result);

const [
  activeShopify,
  draftShopify,
  errorSourceProducts,
  suspiciousActive,
  recentCreated,
] = await Promise.all([
  prisma.shopifyProduct.count({
    where: { status: "active", syncEnabled: true },
  }),
  prisma.shopifyProduct.count({ where: { status: "draft" } }),
  prisma.sourceProduct.count({ where: { syncStatus: "error" } }),
  prisma.shopifyProduct.findMany({
    where: {
      status: "active",
      syncEnabled: true,
      OR: [
        { price: { lte: 25 } },
        {
          sourceProduct: {
            OR: [
              { price: { lte: 1 } },
              { currency: "TRY", url: { contains: "ae.hm.com" } },
              {
                url: { contains: "shein.com" },
                currency: { notIn: ["AED", "USD"] },
              },
              {
                url: { contains: "shein.com" },
                title: { contains: "too many requests", mode: "insensitive" },
              },
              {
                url: { contains: "shein.com" },
                title: { contains: "exceeds our limit", mode: "insensitive" },
              },
              {
                url: { contains: "shein.com" },
                title: { contains: "challenge", mode: "insensitive" },
              },
            ],
          },
        },
      ],
    },
    include: {
      sourceProduct: {
        select: {
          url: true,
          title: true,
          price: true,
          currency: true,
          syncStatus: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  }),
  prisma.shopifyProduct.findMany({
    include: {
      sourceProduct: {
        select: {
          url: true,
          title: true,
          price: true,
          currency: true,
          syncStatus: true,
        },
      },
      variants: { select: { sku: true, price: true }, take: 2 },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  }),
]);

const issues = Array.isArray(state.issues) ? state.issues : [];
const recentIssueHosts = new Map<string, number>();
for (const issue of issues.slice(-200)) {
  const host = String(issue.host || hostOf(issue.url));
  recentIssueHosts.set(host, (recentIssueHosts.get(host) || 0) + 1);
}

console.log(
  JSON.stringify(
    {
      latestJob: latestJob
        ? {
            id: latestJob.id,
            type: latestJob.type,
            status: latestJob.status,
            createdAt: latestJob.createdAt,
            startedAt: latestJob.startedAt,
            completedAt: latestJob.completedAt,
          }
        : null,
      counters: {
        stage: state.stage,
        cycle: state.cycle,
        totalRows: state.totalRows,
        candidateRows: state.candidateRows,
        verifiedRows: state.verifiedRows,
        remainingRows: state.remainingRows,
        existingUpdated: state.existingUpdated,
        published: state.published,
        failed: state.failed,
        skipped: state.skipped,
        sheetCellsWritten: state.sheetCellsWritten,
        sheetWritePending: state.sheetWritePending,
        pendingSkuWrites: Object.keys(state.pendingSkuWrites || {}).length,
        lastRunAt: state.lastRunAt,
      },
      dbTotals: { activeShopify, draftShopify, errorSourceProducts },
      suspiciousActive: suspiciousActive.map((product) => ({
        shopifyId: product.shopifyId,
        shopifyPrice: product.price,
        sourcePrice: product.sourceProduct?.price,
        currency: product.sourceProduct?.currency,
        title: product.sourceProduct?.title,
        url: product.sourceProduct?.url,
      })),
      recentIssueHosts: Object.fromEntries(
        [...recentIssueHosts.entries()].sort((a, b) => b[1] - a[1]),
      ),
      recentCreated: recentCreated.map((product) => ({
        shopifyId: product.shopifyId,
        status: product.status,
        syncEnabled: product.syncEnabled,
        shopifyPrice: product.price,
        sourcePrice: product.sourceProduct?.price,
        currency: product.sourceProduct?.currency,
        syncStatus: product.sourceProduct?.syncStatus,
        host: hostOf(product.sourceProduct?.url),
        title: product.sourceProduct?.title,
        sampleSkus: product.variants.map((variant) => variant.sku),
        createdAt: product.createdAt,
      })),
    },
    null,
    2,
  ),
);

await prisma.$disconnect();
