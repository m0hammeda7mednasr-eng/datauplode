import { prisma } from './db.js';
import { ShopifyService } from './services/shopify.js';
import { syncTrustedStoredCatalog } from './services/storedCatalogSync.js';

const CLAIM_ACTION = 'CATALOG_STORED_FALLBACK_CLAIM';
const SUCCESS_ACTION = 'SYNC_STORED_CATALOG_SET';
const FAILURE_ACTION = 'SYNC_STORED_CATALOG_FAILED';

let started = false;
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function clean(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function positiveInt(name: string, fallback: number, min: number, max: number) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

const blockedFailureMatchers = [
  'status code 403',
  'HTTP 403',
  'SOURCE_BLOCKED',
  'blocked automated server access',
  'did not expose product colors',
  'did not expose usable product data',
  'permission to access',
  'Access Denied',
  'Forbidden',
];

async function runCycle() {
  if (running) return;
  running = true;
  const startedAt = Date.now();

  try {
    const batchSize = positiveInt('CATALOG_STORED_FALLBACK_BATCH_SIZE', 2, 1, 10);
    const concurrency = positiveInt('CATALOG_STORED_FALLBACK_CONCURRENCY', 1, 1, 3);
    const failureAgeHours = positiveInt('CATALOG_STORED_FALLBACK_FAILURE_AGE_HOURS', 24, 1, 168);
    const successAgeDays = positiveInt('CATALOG_STORED_FALLBACK_SUCCESS_AGE_DAYS', 30, 1, 365);
    const retryMinutes = positiveInt('CATALOG_STORED_FALLBACK_RETRY_MINUTES', 60, 15, 1440);
    const claimMinutes = positiveInt('CATALOG_STORED_FALLBACK_CLAIM_MINUTES', 20, 5, 120);

    const recentFailureCutoff = new Date(Date.now() - failureAgeHours * 60 * 60 * 1000);
    const successCutoff = new Date(Date.now() - successAgeDays * 24 * 60 * 60 * 1000);
    const retryCutoff = new Date(Date.now() - retryMinutes * 60 * 1000);
    const claimCutoff = new Date(Date.now() - claimMinutes * 60 * 1000);

    const failures = await prisma.auditLog.findMany({
      where: {
        action: 'SYNC_PRODUCT_CATALOG_FAILED',
        createdAt: { gte: recentFailureCutoff },
        sourceProductId: { not: null },
        OR: blockedFailureMatchers.map((matcher) => ({
          details: { contains: matcher, mode: 'insensitive' as const },
        })),
      },
      orderBy: { createdAt: 'desc' },
      take: 1200,
      select: { sourceProductId: true, createdAt: true },
    });

    const ids = [...new Set(failures.map((entry) => entry.sourceProductId).filter(Boolean))] as string[];
    if (!ids.length) {
      console.log('[catalog-stored-fallback] no recent source-blocked products');
      return;
    }

    const candidates = await prisma.sourceProduct.findMany({
      where: {
        id: { in: ids },
        syncStatus: { not: 'paused' },
        currency: 'AED',
        price: { gt: 1 },
        description: { not: null },
        shopifyProduct: { is: { syncEnabled: true } },
        variants: {
          some: { sku: { not: null } },
          every: { sku: { not: null } },
        },
        images: { some: {} },
        AND: [
          { auditLogs: { none: { action: SUCCESS_ACTION, createdAt: { gte: successCutoff } } } },
          { auditLogs: { none: { action: FAILURE_ACTION, createdAt: { gte: retryCutoff } } } },
          { auditLogs: { none: { action: CLAIM_ACTION, createdAt: { gte: claimCutoff } } } },
        ],
      },
      select: {
        id: true,
        title: true,
        url: true,
        lastScrapedAt: true,
        _count: { select: { variants: true, images: true } },
      },
      orderBy: { lastScrapedAt: 'asc' },
      take: Math.max(batchSize * 8, 40),
    });

    const selected = candidates.slice(0, batchSize);
    if (!selected.length) {
      console.log('[catalog-stored-fallback] no eligible complete trusted stored candidates');
      return;
    }

    const client = await ShopifyService.getClientFromDb(prisma);
    const location = await ShopifyService.getInventoryLocation(client);
    const results: Array<{ id: string; title: string; ok: boolean; error?: string; variants?: number }> = [];
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
                runner: 'catalog-stored-fallback-worker',
                sourceMode: 'stored-fallback',
                claimedAt: new Date().toISOString(),
              }),
            },
          });

          const result = await syncTrustedStoredCatalog({
            prisma,
            sourceProductId: candidate.id,
            client,
            location,
          });
          results.push({
            id: candidate.id,
            title: candidate.title,
            ok: true,
            variants: result.variants,
          });
        } catch (error: any) {
          const message = clean(error?.message || error).slice(0, 1800);
          try {
            await prisma.auditLog.create({
              data: {
                sourceProductId: candidate.id,
                action: FAILURE_ACTION,
                userId: 'System',
                details: JSON.stringify({
                  runner: 'catalog-stored-fallback-worker',
                  sourceMode: 'stored-fallback',
                  message,
                  failedAt: new Date().toISOString(),
                }),
              },
            });
          } catch {}
          results.push({ id: candidate.id, title: candidate.title, ok: false, error: message });
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, selected.length) }, () => worker()),
    );

    console.log(JSON.stringify({
      worker: 'catalog-stored-fallback-worker',
      selected: selected.length,
      ok: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      results: results.map((result) => ({
        title: result.title,
        ok: result.ok,
        variants: result.variants,
        error: result.error?.slice(0, 220),
      })),
    }));
  } catch (error: any) {
    console.error('[catalog-stored-fallback] cycle failed:', clean(error?.message || error));
  } finally {
    running = false;
  }
}

function scheduleNext(delayMs: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    await runCycle();
    scheduleNext(positiveInt('CATALOG_STORED_FALLBACK_INTERVAL_SECONDS', 30, 20, 600) * 1000);
  }, delayMs);
  timer.unref?.();
}

export function startCatalogStoredFallbackWorker() {
  if (started) return;
  started = true;
  if (process.env.CATALOG_STORED_FALLBACK_AUTOSTART !== 'true') {
    console.log('[catalog-stored-fallback] autostart disabled');
    return;
  }
  const batchSize = positiveInt('CATALOG_STORED_FALLBACK_BATCH_SIZE', 2, 1, 10);
  const concurrency = positiveInt('CATALOG_STORED_FALLBACK_CONCURRENCY', 1, 1, 3);
  console.log(`[catalog-stored-fallback] enabled: batch=${batchSize} concurrency=${concurrency}`);
  scheduleNext(20_000);
}

startCatalogStoredFallbackWorker();
