import type { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { ShopifyService } from './services/shopify.js';
import { syncFullProductCatalog } from './services/fullCatalogSync.js';
import { getApprovedSheetMultiplier } from './services/sheetMultiplier.js';

const DEFAULT_DOMAINS = [
  'ae.hm.com',
  'mothercare.ae',
  'next.ae',
  'centrepointstores.com',
  'maxfashion.com',
  'zara.com',
  'lefties.com',
  'ae.carters.com',
  'adidas.ae',
  'marksandspencerme.com',
  'marksandspencer.ae',
];

const CLAIM_ACTION = 'CATALOG_PARALLEL_WORKER_CLAIM';
const FAILURE_ACTION = 'SYNC_PRODUCT_CATALOG_FAILED';
const SUCCESS_ACTION = 'SYNC_PRODUCT_CATALOG_SET';

let workerStarted = false;
let workerRunning = false;
let workerTimer: ReturnType<typeof setTimeout> | null = null;

function clean(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function positiveInt(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function configuredDomains() {
  const raw = clean(process.env.CATALOG_PARALLEL_WORKER_DOMAINS);
  const values = (raw ? raw.split(',') : DEFAULT_DOMAINS)
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[a-z0-9.-]+$/.test(value));
  return [...new Set(values)];
}

function domainRank(url: string, domains: string[]) {
  const normalized = clean(url).toLowerCase();
  const rank = domains.findIndex((domain) => normalized.includes(domain));
  return rank >= 0 ? rank : domains.length;
}

function isImportPlaceholder(title: string) {
  return /^(?:Excel Import Issue|Blocked Source Product)\b/i.test(clean(title));
}

async function countFullyVerified() {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: number }>>(`
    WITH progress AS (
      SELECT
        s."id" AS "sourceProductId",
        MAX(a."createdAt") FILTER (
          WHERE a."action"='SYNC_PRODUCT_CATALOG_SET'
            AND COALESCE(a."details", '') ~ '"readbackVerified"[[:space:]]*:[[:space:]]*true'
        ) AS "catalogSuccessAt",
        MAX(a."createdAt") FILTER (
          WHERE a."action" IN ('SYNC_PRODUCT_CATALOG_SET','SYNC_PRICE_STOCK_ONLY')
            AND COALESCE(a."details", '') ~ '"readbackVerified"[[:space:]]*:[[:space:]]*true'
        ) AS "priceStockSuccessAt",
        MAX(a."createdAt") FILTER (WHERE a."action"='SYNC_PRODUCT_CATALOG_FAILED') AS "catalogFailureAt",
        MAX(a."createdAt") FILTER (WHERE a."action"='SYNC_PRICE_STOCK_FAILED') AS "priceStockFailureAt"
      FROM "SourceProduct" s
      INNER JOIN "ShopifyProduct" sp ON sp."sourceProductId"=s."id"
      LEFT JOIN "AuditLog" a ON a."sourceProductId"=s."id"
        AND a."action" IN (
          'SYNC_PRODUCT_CATALOG_SET',
          'SYNC_PRICE_STOCK_ONLY',
          'SYNC_PRODUCT_CATALOG_FAILED',
          'SYNC_PRICE_STOCK_FAILED'
        )
      WHERE LOWER(COALESCE(sp."status", ''))='active'
      GROUP BY s."id"
    )
    SELECT COUNT(*)::int AS count
    FROM progress
    WHERE "catalogSuccessAt" IS NOT NULL
      AND "priceStockSuccessAt" IS NOT NULL
      AND ("catalogFailureAt" IS NULL OR "catalogFailureAt" <= "catalogSuccessAt")
      AND ("priceStockFailureAt" IS NULL OR "priceStockFailureAt" <= "priceStockSuccessAt")
  `);
  return Number(rows[0]?.count || 0);
}

async function runCycle() {
  if (workerRunning) return;
  workerRunning = true;
  const startedAt = Date.now();

  try {
    const domains = configuredDomains();
    const batchSize = positiveInt('CATALOG_PARALLEL_WORKER_BATCH_SIZE', 12, 1, 30);
    const concurrency = positiveInt('CATALOG_PARALLEL_WORKER_CONCURRENCY', 3, 1, 5);
    const poolSize = positiveInt('CATALOG_PARALLEL_WORKER_POOL_SIZE', 600, batchSize, 2000);
    const successAgeDays = positiveInt('CATALOG_PARALLEL_WORKER_SUCCESS_AGE_DAYS', 30, 1, 365);
    const failureRetryMinutes = positiveInt('CATALOG_PARALLEL_WORKER_FAILURE_RETRY_MINUTES', 30, 5, 1440);
    const claimMinutes = positiveInt('CATALOG_PARALLEL_WORKER_CLAIM_MINUTES', 20, 5, 120);

    const successCutoff = new Date(Date.now() - successAgeDays * 24 * 60 * 60 * 1000);
    const failureCutoff = new Date(Date.now() - failureRetryMinutes * 60 * 1000);
    const claimCutoff = new Date(Date.now() - claimMinutes * 60 * 1000);

    const where: Prisma.SourceProductWhereInput = {
      syncStatus: { not: 'paused' },
      raw: { contains: 'sheetPriceMultiplier' },
      OR: domains.map((domain) => ({
        url: { contains: domain, mode: 'insensitive' as const },
      })),
      shopifyProduct: { is: { syncEnabled: true } },
      AND: [
        {
          auditLogs: {
            none: { action: SUCCESS_ACTION, createdAt: { gte: successCutoff } },
          },
        },
        {
          auditLogs: {
            none: { action: FAILURE_ACTION, createdAt: { gte: failureCutoff } },
          },
        },
        {
          auditLogs: {
            none: { action: CLAIM_ACTION, createdAt: { gte: claimCutoff } },
          },
        },
      ],
    };

    const candidates = await prisma.sourceProduct.findMany({
      where,
      select: {
        id: true,
        title: true,
        url: true,
        raw: true,
        lastScrapedAt: true,
        variants: { select: { sku: true }, take: 5 },
        shopifyProduct: { select: { shopifyId: true, syncEnabled: true, status: true } },
      },
      orderBy: { lastScrapedAt: 'asc' },
      take: poolSize,
    });

    const selected = candidates
      .filter((candidate) =>
        !isImportPlaceholder(candidate.title) &&
        Boolean(candidate.shopifyProduct?.shopifyId) &&
        Boolean(getApprovedSheetMultiplier(candidate)),
      )
      .sort((left, right) =>
        domainRank(left.url, domains) - domainRank(right.url, domains) ||
        (left.lastScrapedAt?.getTime() || 0) - (right.lastScrapedAt?.getTime() || 0),
      )
      .slice(0, batchSize);

    if (selected.length === 0) {
      console.log('[catalog-parallel] no eligible products in this cycle');
      return;
    }

    const fullyBefore = await countFullyVerified();
    const client = await ShopifyService.getClientFromDb(prisma);
    const location = await ShopifyService.getInventoryLocation(client);
    const results: Array<{ id: string; ok: boolean; title: string; error?: string }> = [];
    let cursor = 0;

    async function worker() {
      while (cursor < selected.length) {
        const candidate = selected[cursor++];
        if (!candidate) return;

        try {
          await prisma.auditLog.create({
            data: {
              sourceProductId: candidate.id,
              action: CLAIM_ACTION,
              userId: 'System',
              details: JSON.stringify({
                runner: 'catalog-parallel-sync-worker',
                claimedAt: new Date().toISOString(),
              }),
            },
          });

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
                action: FAILURE_ACTION,
                userId: 'System',
                details: JSON.stringify({
                  message,
                  runner: 'catalog-parallel-sync-worker',
                  failedAt: new Date().toISOString(),
                }),
              },
            });
          } catch (auditError: any) {
            console.error('[catalog-parallel] failed to record product failure:', clean(auditError?.message || auditError));
          }
          results.push({ id: candidate.id, ok: false, title: candidate.title, error: message });
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, selected.length) }, () => worker()),
    );

    const fullyAfter = await countFullyVerified();
    const ok = results.filter((result) => result.ok).length;
    const failed = results.length - ok;
    console.log(JSON.stringify({
      worker: 'catalog-parallel-sync-worker',
      selected: selected.length,
      ok,
      failed,
      fullyBefore,
      fullyAfter,
      addedFullyVerified: fullyAfter - fullyBefore,
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      sampleFailures: results
        .filter((result) => !result.ok)
        .slice(0, 5)
        .map((result) => ({ title: result.title, error: result.error?.slice(0, 180) })),
    }));
  } catch (error: any) {
    console.error('[catalog-parallel] cycle failed:', clean(error?.message || error));
  } finally {
    workerRunning = false;
  }
}

function scheduleNext(delayMs: number) {
  if (workerTimer) clearTimeout(workerTimer);
  workerTimer = setTimeout(async () => {
    await runCycle();
    scheduleNext(positiveInt('CATALOG_PARALLEL_WORKER_INTERVAL_SECONDS', 15, 10, 600) * 1000);
  }, delayMs);
  workerTimer.unref?.();
}

export function startCatalogParallelSyncWorker() {
  if (workerStarted) return;
  workerStarted = true;

  if (process.env.CATALOG_PARALLEL_WORKER_AUTOSTART !== 'true') {
    console.log('[catalog-parallel] autostart disabled');
    return;
  }

  const concurrency = positiveInt('CATALOG_PARALLEL_WORKER_CONCURRENCY', 3, 1, 5);
  const batchSize = positiveInt('CATALOG_PARALLEL_WORKER_BATCH_SIZE', 12, 1, 30);
  console.log(`[catalog-parallel] enabled: batch=${batchSize} concurrency=${concurrency}`);
  scheduleNext(15_000);
}

startCatalogParallelSyncWorker();
