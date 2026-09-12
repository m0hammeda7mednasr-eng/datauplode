import { prisma } from './db.js';
import { ShopifyService } from './services/shopify.js';
import { processGoogleSheetBatch } from './api.js';

const OK_ACTION = 'CATALOG_RELATION_AUDIT_OK';
const FAILED_ACTION = 'CATALOG_RELATION_AUDIT_FAILED';
const DELETE_ACTION = 'CATALOG_RELATION_UNRELATED_DELETED';
const CLAIM_ACTION = 'CATALOG_RELATION_AUDIT_CLAIM';

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

function normalizeVendor(value: unknown) {
  let key = clean(value).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
  const aliases: Array<[RegExp, string]> = [
    [/^marksandspencer(?:me|uae|ae)?$/, 'marksandspencer'],
    [/^centrepoint(?:stores)?$/, 'centrepoint'],
    [/^max(?:fashion)?$/, 'max'],
    [/^handm(?:uae|ae)?$/, 'hm'],
    [/^hm(?:uae|ae)?$/, 'hm'],
    [/^mothercare(?:uae|ae)?$/, 'mothercare'],
    [/^carters(?:uae|ae)?$/, 'carters'],
    [/^adidas(?:uae|ae)?$/, 'adidas'],
    [/^next(?:uae|ae|direct)?$/, 'next'],
    [/^zara(?:uae|ae)?$/, 'zara'],
    [/^lefties(?:uae|ae)?$/, 'lefties'],
  ];
  for (const [pattern, replacement] of aliases) {
    if (pattern.test(key)) return replacement;
  }
  key = key.replace(/(?:uae|official|onlinestore|store)$/g, '');
  return key;
}

function normalizeTitle(value: unknown) {
  return clean(value)
    .toLowerCase()
    .replace(/\([^)]*(?:cm|yrs?|years?|mths?|months?|size)[^)]*\)/gi, ' ')
    .replace(/\s+-\s+size\s+.+$/i, ' ')
    .replace(/\bsize\s+[a-z0-9\-/(). ]+$/i, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactIdentity(value: unknown) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function parseRaw(raw: string | null | undefined) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : {};
  } catch {
    return {} as Record<string, any>;
  }
}

function importLocation(rawValue: string | null | undefined) {
  const raw = parseRaw(rawValue);
  const meta = raw?.import && typeof raw.import === 'object' ? raw.import : {};
  const sheetUrl = clean(meta.sheetUrl || raw.sheetUrl);
  const rowNumber = Number(meta.excelRowNumber ?? meta.rowNumber ?? raw.excelRowNumber ?? raw.rowNumber);
  if (!sheetUrl || !Number.isInteger(rowNumber) || rowNumber <= 0) return null;
  return { sheetUrl, rowNumber };
}

async function removeLocalCatalogLink(sourceProductId: string) {
  await prisma.$transaction(async (tx) => {
    const shopifyProduct = await tx.shopifyProduct.findUnique({
      where: { sourceProductId },
      select: { id: true },
    });
    if (shopifyProduct?.id) {
      await tx.shopifyVariant.deleteMany({ where: { shopifyProductId: shopifyProduct.id } });
    }
    await tx.shopifyProduct.deleteMany({ where: { sourceProductId } });
    await tx.manualReviewItem.deleteMany({ where: { sourceProductId } });
    await tx.auditLog.deleteMany({ where: { sourceProductId } });
    await tx.sourceImage.deleteMany({ where: { sourceProductId } });
    await tx.sourceVariant.deleteMany({ where: { sourceProductId } });
    await tx.sourceProduct.delete({ where: { id: sourceProductId } });
  });
}

async function auditOne(client: any, product: any) {
  const shopifyId = clean(product.shopifyProduct?.shopifyId);
  if (!shopifyId) throw new Error('Missing linked Shopify product id');

  const live = await ShopifyService.getProductCatalogSnapshot(client, shopifyId);
  if (!live?.id) throw new Error('Shopify returned no product snapshot');

  const expectedVendor = normalizeVendor(product.brand || product.supplier?.name);
  const liveVendor = normalizeVendor(live.vendor);
  const expectedTitle = normalizeTitle(product.title);
  const liveTitle = normalizeTitle(live.title);

  const sourceIds = new Set<string>();
  const addSourceId = (value: unknown) => {
    const id = compactIdentity(value);
    if (id && id.length >= 3) sourceIds.add(id);
  };
  addSourceId(product.productId);
  for (const variant of product.variants || []) {
    addSourceId(variant.sku);
    addSourceId(variant.sourceVariantId);
  }

  const liveSkus = new Set<string>();
  for (const variant of live.variants || []) {
    const sku = compactIdentity(variant.sku);
    if (sku && sku.length >= 3) liveSkus.add(sku);
  }

  const vendorComparable = Boolean(expectedVendor && liveVendor);
  const titleComparable = Boolean(expectedTitle && liveTitle);
  const identityComparable = sourceIds.size > 0 && liveSkus.size > 0;

  const vendorExact = vendorComparable && expectedVendor === liveVendor;
  const titleExact = titleComparable && expectedTitle === liveTitle;
  const identityExact = identityComparable && [...sourceIds].some((id) => liveSkus.has(id));

  const unrelatedConfirmed =
    vendorComparable &&
    titleComparable &&
    identityComparable &&
    !vendorExact &&
    !titleExact &&
    !identityExact;

  return {
    live,
    expectedVendor,
    liveVendor,
    expectedTitle,
    liveTitle,
    sourceIds: [...sourceIds],
    liveSkus: [...liveSkus],
    vendorExact,
    titleExact,
    identityExact,
    unrelatedConfirmed,
  };
}

async function runCycle() {
  if (running) return;
  running = true;
  const startedAt = Date.now();

  try {
    const batchSize = positiveInt('CATALOG_RELATION_AUDIT_BATCH_SIZE', 5, 1, 50);
    const concurrency = positiveInt('CATALOG_RELATION_AUDIT_CONCURRENCY', 1, 1, 8);
    const retryMinutes = positiveInt('CATALOG_RELATION_AUDIT_RETRY_MINUTES', 30, 5, 1440);
    const claimMinutes = positiveInt('CATALOG_RELATION_AUDIT_CLAIM_MINUTES', 20, 5, 120);
    const retryCutoff = new Date(Date.now() - retryMinutes * 60 * 1000);
    const claimCutoff = new Date(Date.now() - claimMinutes * 60 * 1000);

    const candidates = await prisma.sourceProduct.findMany({
      where: {
        syncStatus: { not: 'paused' },
        shopifyProduct: { is: { syncEnabled: true } },
        AND: [
          { auditLogs: { none: { action: OK_ACTION } } },
          { auditLogs: { none: { action: FAILED_ACTION, createdAt: { gte: retryCutoff } } } },
          { auditLogs: { none: { action: CLAIM_ACTION, createdAt: { gte: claimCutoff } } } },
        ],
      },
      include: {
        supplier: true,
        variants: { select: { sku: true, sourceVariantId: true } },
        shopifyProduct: { select: { id: true, shopifyId: true, syncEnabled: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: batchSize,
    });

    if (!candidates.length) {
      console.log('[catalog-relation-audit] no unaudited linked products');
      return;
    }

    const client = await ShopifyService.getClientFromDb(prisma);
    const results: any[] = [];
    let cursor = 0;

    async function worker() {
      while (cursor < candidates.length) {
        const product = candidates[cursor++];
        if (!product) return;
        try {
          await prisma.auditLog.create({
            data: {
              sourceProductId: product.id,
              action: CLAIM_ACTION,
              userId: 'System',
              details: JSON.stringify({ claimedAt: new Date().toISOString() }),
            },
          });

          const audit = await auditOne(client, product);
          if (!audit.unrelatedConfirmed) {
            await prisma.auditLog.create({
              data: {
                sourceProductId: product.id,
                action: OK_ACTION,
                userId: 'System',
                details: JSON.stringify({
                  shopifyProductId: product.shopifyProduct?.shopifyId,
                  vendorExact: audit.vendorExact,
                  titleExact: audit.titleExact,
                  identityExact: audit.identityExact,
                  auditedAt: new Date().toISOString(),
                }),
              },
            });
            results.push({ title: product.title, status: 'ok' });
            continue;
          }

          const location = importLocation(product.raw);
          if (!location) {
            await prisma.auditLog.create({
              data: {
                sourceProductId: product.id,
                action: FAILED_ACTION,
                userId: 'System',
                details: JSON.stringify({
                  reason: 'confirmed_unrelated_but_missing_rebuild_sheet_location',
                  shopifyProductId: product.shopifyProduct?.shopifyId,
                  expectedVendor: audit.expectedVendor,
                  liveVendor: audit.liveVendor,
                  expectedTitle: audit.expectedTitle,
                  liveTitle: audit.liveTitle,
                  failedAt: new Date().toISOString(),
                }),
              },
            });
            results.push({ title: product.title, status: 'blocked_missing_sheet_location' });
            continue;
          }

          const oldShopifyId = product.shopifyProduct!.shopifyId;
          await ShopifyService.deleteProduct(client, oldShopifyId);
          await removeLocalCatalogLink(product.id);

          let rebuild: any = null;
          let rebuildError = '';
          try {
            rebuild = await processGoogleSheetBatch({
              sheetUrl: location.sheetUrl,
              rowNumbers: [location.rowNumber],
              createManualReview: true,
            });
          } catch (error: any) {
            rebuildError = clean(error?.message || error);
          }

          await prisma.auditLog.create({
            data: {
              action: DELETE_ACTION,
              userId: 'System',
              details: JSON.stringify({
                oldSourceProductId: product.id,
                oldShopifyProductId: oldShopifyId,
                url: product.url,
                title: product.title,
                expectedVendor: audit.expectedVendor,
                liveVendor: audit.liveVendor,
                expectedTitle: audit.expectedTitle,
                liveTitle: audit.liveTitle,
                sourceIdentifiers: audit.sourceIds.slice(0, 50),
                liveSkus: audit.liveSkus.slice(0, 50),
                sheetUrl: location.sheetUrl,
                rowNumber: location.rowNumber,
                rebuildAttempted: true,
                rebuildError: rebuildError || null,
                rebuildSummary: rebuild?.summary || null,
                deletedAt: new Date().toISOString(),
              }),
            },
          });

          results.push({
            title: product.title,
            status: rebuildError ? 'deleted_rebuild_failed' : 'deleted_rebuilt',
            rebuildError: rebuildError || undefined,
          });
        } catch (error: any) {
          const message = clean(error?.message || error).slice(0, 1800);
          try {
            await prisma.auditLog.create({
              data: {
                sourceProductId: product.id,
                action: FAILED_ACTION,
                userId: 'System',
                details: JSON.stringify({ message, failedAt: new Date().toISOString() }),
              },
            });
          } catch {}
          results.push({ title: product.title, status: 'failed', error: message });
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()));

    console.log(JSON.stringify({
      worker: 'catalog-relation-audit-worker',
      selected: candidates.length,
      ok: results.filter((entry) => entry.status === 'ok').length,
      deletedRebuilt: results.filter((entry) => entry.status === 'deleted_rebuilt').length,
      deletedRebuildFailed: results.filter((entry) => entry.status === 'deleted_rebuild_failed').length,
      blockedMissingSheetLocation: results.filter((entry) => entry.status === 'blocked_missing_sheet_location').length,
      failed: results.filter((entry) => entry.status === 'failed').length,
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      results: results.slice(0, 20),
    }));
  } catch (error: any) {
    console.error('[catalog-relation-audit] cycle failed:', clean(error?.message || error));
  } finally {
    running = false;
  }
}

function scheduleNext(delayMs: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    await runCycle();
    scheduleNext(positiveInt('CATALOG_RELATION_AUDIT_INTERVAL_SECONDS', 20, 10, 600) * 1000);
  }, delayMs);
  timer.unref?.();
}

export function startCatalogRelationAuditWorker() {
  if (started) return;
  started = true;
  if (process.env.CATALOG_RELATION_AUDIT_AUTOSTART !== 'true') {
    console.log('[catalog-relation-audit] autostart disabled');
    return;
  }
  const batchSize = positiveInt('CATALOG_RELATION_AUDIT_BATCH_SIZE', 5, 1, 50);
  const concurrency = positiveInt('CATALOG_RELATION_AUDIT_CONCURRENCY', 1, 1, 8);
  console.log(`[catalog-relation-audit] enabled: batch=${batchSize} concurrency=${concurrency}`);
  scheduleNext(20_000);
}

startCatalogRelationAuditWorker();
