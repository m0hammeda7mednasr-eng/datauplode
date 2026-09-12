import crypto from 'crypto';
import { Router, type Request } from 'express';
import { prisma } from '../db.js';
import { ShopifyService } from '../services/shopify.js';

const router = Router();
const CACHE_TABLE = 'ShopifyCatalogIndexV2';
const REQUIRED_SHOP = '09fgkz-6n.myshopify.com';
const REQUIRED_CONFIRM = 'PURGE_DABDOOB_UNVERIFIED_ACTIVE';
const REPAIR_CONFIRM = 'REPAIR_NEXT_V47744_CATALOG';
const REPAIR_PRODUCT_ID = 'gid://shopify/Product/8220083322933';
const REPAIR_SOURCE_URL = 'https://www.next.ae/en/style/sv004113/v47744';
const REPAIR_TITLE = 'Light Green Sweatshirt and Leggings Set (3mths-7yrs)';
const WRONG_COLOR = 'Light Green Sweatshirt and';
const CORRECT_COLOR = 'Light Green';
const REPAIR_MULTIPLIER = 23;
const REPAIR_IN_STOCK_QUANTITY = 10;
const REPAIR_VARIANTS = [
  { size: '3 - 6 Months (62 - 68cm)', sourcePrice: 65, available: false },
  { size: '6 - 9 Months (68 - 74cm)', sourcePrice: 65, available: false },
  { size: '9 - 12 Months (74 - 80cm)', sourcePrice: 65, available: false },
  { size: '12 - 18 Months (80 - 86cm)', sourcePrice: 65, available: false },
  { size: '1.5 - 2 Years (86 - 92cm)', sourcePrice: 76, available: false },
  { size: '2 - 3 Years (92 - 98cm)', sourcePrice: 76, available: true },
  { size: '3 - 4 Years (98 - 104cm)', sourcePrice: 76, available: false },
  { size: '4 - 5 Years (104 - 110cm)', sourcePrice: 76, available: false },
  { size: '5 - 6 Years (110 - 116cm)', sourcePrice: 76, available: false },
  { size: '6 - 7 Years (116 - 122cm)', sourcePrice: 87, available: true },
] as const;
const MAX_AUTHORIZED_CANDIDATES = 1183;
const MAX_BATCH = 30;
const JOB_TYPE = 'PURGE_UNVERIFIED_ACTIVE_SNAPSHOT:2026-09-12';
const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const GITHUB_OIDC_AUDIENCE = 'dabdoob-unverified-purge';
const GITHUB_REPOSITORY = 'm0hammeda7mednasr-eng/datauplode';
const GITHUB_REPOSITORY_ID = '1236020386';
const GITHUB_REF = 'refs/heads/main';
const GITHUB_WORKFLOW_REF = `${GITHUB_REPOSITORY}/.github/workflows/purge-dabdoob-unverified-active.yml@${GITHUB_REF}`;

type GithubOidcClaims = {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  repository?: string;
  repository_id?: string;
  ref?: string;
  workflow_ref?: string;
  event_name?: string;
};

type PurgeCandidate = {
  sourceProductId: string;
  shopifyProductDbId: string;
  shopifyId: string;
  title: string;
  sourceUrl: string;
  cycleState: 'failed' | 'pending';
};

type PurgeResult = {
  stage: 'prepared' | 'deleting' | 'completed';
  initialActive: number;
  snapshotCount: number;
  snapshotHash: string;
  deletedIds: string[];
  alreadyMissingIds: string[];
  protectedIds: string[];
  failed: Record<string, { attempts: number; error: string }>;
  updatedAt: string;
};

function clean(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function decodeJwtPart(value: string) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try {
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

function snapshotHash(candidates: PurgeCandidate[]) {
  return crypto
    .createHash('sha256')
    .update(candidates.map((row) => row.shopifyId).sort().join('\n'))
    .digest('hex');
}

function unique(values: string[]) {
  const seen = new Set<string>();
  return values.filter((raw) => {
    const value = clean(raw);
    const key = value.toLowerCase();
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function canonicalSize(value: unknown) {
  return clean(value)
    .toLowerCase()
    .replace(/months?/g, 'month')
    .replace(/years?/g, 'year')
    .replace(/[^a-z0-9.]+/g, '');
}

function moneyEqual(left: unknown, right: unknown) {
  return Math.abs(Number(left) - Number(right)) < 0.01;
}

async function verifyGithubActionsOidc(token: string): Promise<boolean> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;

    const header = decodeJwtPart(parts[0]) as { alg?: string; kid?: string; typ?: string };
    const claims = decodeJwtPart(parts[1]) as GithubOidcClaims;
    if (header.alg !== 'RS256' || !header.kid || (header.typ && header.typ !== 'JWT')) return false;

    const now = Math.floor(Date.now() / 1000);
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const claimsValid =
      claims.iss === GITHUB_OIDC_ISSUER &&
      audience.includes(GITHUB_OIDC_AUDIENCE) &&
      Number.isFinite(claims.exp) &&
      Number(claims.exp) > now - 30 &&
      (!Number.isFinite(claims.nbf) || Number(claims.nbf) <= now + 30) &&
      claims.repository === GITHUB_REPOSITORY &&
      clean(claims.repository_id) === GITHUB_REPOSITORY_ID &&
      claims.ref === GITHUB_REF &&
      claims.workflow_ref === GITHUB_WORKFLOW_REF &&
      claims.event_name === 'workflow_dispatch';
    if (!claimsValid) return false;

    const response = await fetch(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    const jwks = (await response.json()) as { keys?: Array<Record<string, unknown> & { kid?: string; kty?: string; use?: string }> };
    const jwk = jwks.keys?.find((key) => key.kid === header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig'));
    if (!jwk) return false;

    const publicKey = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' });
    return crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      publicKey,
      Buffer.from(parts[2], 'base64url'),
    );
  } catch (error) {
    console.warn('[shopify-unverified-purge] GitHub Actions OIDC verification failed', error);
    return false;
  }
}

async function authorized(req: Request) {
  const configured = clean(process.env.CATALOG_AUDIT_WRITE_TOKEN);
  const supplied = clean(req.header('x-catalog-audit-write-token'));
  if (configured && supplied && safeEqual(configured, supplied)) return true;

  const oidcToken = clean(req.header('x-github-actions-oidc-token'));
  return Boolean(oidcToken) && verifyGithubActionsOidc(oidcToken);
}

async function shopState(client: any) {
  const data = await client.request(`
    query UnverifiedPurgeState {
      shop { id name myshopifyDomain }
      active: productsCount(query: "status:active", limit: null) { count precision }
      draft: productsCount(query: "status:draft", limit: null) { count precision }
      archived: productsCount(query: "status:archived", limit: null) { count precision }
      unlisted: productsCount(query: "status:unlisted", limit: null) { count precision }
    }
  `);
  return {
    shop: data?.shop || null,
    active: Number(data?.active?.count || 0),
    draft: Number(data?.draft?.count || 0),
    archived: Number(data?.archived?.count || 0),
    unlisted: Number(data?.unlisted?.count || 0),
    precision: {
      active: clean(data?.active?.precision),
      draft: clean(data?.draft?.precision),
    },
  };
}

async function currentUnverifiedCandidates(shopifyIds?: string[]): Promise<PurgeCandidate[]> {
  const idFilter = shopifyIds?.length
    ? `AND sp."shopifyId" IN (${shopifyIds.map((_, index) => `$${index + 1}`).join(',')})`
    : '';
  return prisma.$queryRawUnsafe<PurgeCandidate[]>(`
    WITH progress AS (
      SELECT
        s."id" AS "sourceProductId",
        sp."id" AS "shopifyProductDbId",
        sp."shopifyId",
        s."title",
        s."url" AS "sourceUrl",
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
      INNER JOIN "${CACHE_TABLE}" catalog
        ON catalog."shopifyId"=sp."shopifyId"
        AND UPPER(COALESCE(catalog."status", ''))='ACTIVE'
      LEFT JOIN "AuditLog" a ON a."sourceProductId"=s."id"
        AND a."action" IN (
          'SYNC_PRODUCT_CATALOG_SET',
          'SYNC_PRICE_STOCK_ONLY',
          'SYNC_PRODUCT_CATALOG_FAILED',
          'SYNC_PRICE_STOCK_FAILED'
        )
      WHERE LOWER(COALESCE(sp."status", ''))='active'
        ${idFilter}
      GROUP BY s."id", sp."id", sp."shopifyId"
    ), classified AS (
      SELECT
        *,
        CASE
          WHEN NOT (
            "catalogSuccessAt" IS NOT NULL
            AND ("catalogFailureAt" IS NULL OR "catalogFailureAt" <= "catalogSuccessAt")
          ) OR NOT (
            "priceStockSuccessAt" IS NOT NULL
            AND ("priceStockFailureAt" IS NULL OR "priceStockFailureAt" <= "priceStockSuccessAt")
          ) THEN
            CASE
              WHEN (
                "catalogFailureAt" IS NOT NULL
                AND ("catalogSuccessAt" IS NULL OR "catalogFailureAt" > "catalogSuccessAt")
              ) OR (
                "priceStockFailureAt" IS NOT NULL
                AND ("priceStockSuccessAt" IS NULL OR "priceStockFailureAt" > "priceStockSuccessAt")
              ) THEN 'failed'
              ELSE 'pending'
            END
          ELSE 'verified'
        END AS "cycleState"
      FROM progress
    )
    SELECT
      "sourceProductId",
      "shopifyProductDbId",
      "shopifyId",
      "title",
      "sourceUrl",
      "cycleState"
    FROM classified
    WHERE "cycleState" IN ('failed', 'pending')
    ORDER BY "shopifyId" ASC
  `, ...(shopifyIds || []));
}

async function deleteShopifyProduct(client: any, productId: string) {
  try {
    return await ShopifyService.deleteProduct(client, productId);
  } catch (error: any) {
    const message = clean(error?.message || error);
    if (!/Shopify REST delete failed with HTTP 422/i.test(message)) throw error;

    const data = await client.request(
      `mutation DeleteUnverifiedProduct($id: ID!) {
        productDelete(input: { id: $id }, synchronous: true) {
          deletedProductId
          userErrors { field message }
        }
      }`,
      { id: productId },
    );
    const userErrors = Array.isArray(data?.productDelete?.userErrors) ? data.productDelete.userErrors : [];
    if (userErrors.length) {
      throw new Error(userErrors.map((entry: any) => clean(entry?.message)).filter(Boolean).join('; ') || 'Shopify delete rejected');
    }
    if (clean(data?.productDelete?.deletedProductId) !== productId) {
      throw new Error('Shopify did not confirm the requested product deletion');
    }
    return { deletedProductId: productId, method: 'graphql_422_fallback' };
  }
}

async function removeLocalCatalogProduct(candidate: PurgeCandidate) {
  await prisma.$transaction(async (tx) => {
    await tx.shopifyVariant.deleteMany({
      where: {
        OR: [
          { shopifyProductId: candidate.shopifyProductDbId },
          { sourceVariant: { sourceProductId: candidate.sourceProductId } },
        ],
      },
    });
    await tx.shopifyProduct.deleteMany({ where: { id: candidate.shopifyProductDbId } });
    await tx.manualReviewItem.deleteMany({ where: { sourceProductId: candidate.sourceProductId } });
    await tx.auditLog.deleteMany({ where: { sourceProductId: candidate.sourceProductId } });
    await tx.sourceImage.deleteMany({ where: { sourceProductId: candidate.sourceProductId } });
    await tx.sourceVariant.deleteMany({ where: { sourceProductId: candidate.sourceProductId } });
    await tx.sourceProduct.deleteMany({ where: { id: candidate.sourceProductId } });
  });
  await prisma.$executeRawUnsafe(`
    UPDATE "${CACHE_TABLE}"
    SET "status"='DELETED',
        "matchStatus"='deleted',
        "reason"='explicit_unverified_active_purge_2026_09_12',
        "updatedAt"=NOW()
    WHERE "shopifyId"=$1
  `, candidate.shopifyId);
}

router.post('/admin/purge-unverified-active', async (req, res) => {
  try {
    if (!(await authorized(req))) {
      return res.status(403).json({ success: false, code: 'UNVERIFIED_PURGE_NOT_AUTHORIZED' });
    }
    const confirm = clean(req.header('x-shopify-unverified-purge-confirm') || req.body?.confirm);
    if (confirm !== REQUIRED_CONFIRM) {
      return res.status(428).json({ success: false, code: 'UNVERIFIED_PURGE_CONFIRMATION_REQUIRED' });
    }

    const client = await ShopifyService.getClientFromDb(prisma);
    const state = await shopState(client);
    const domain = clean(state.shop?.myshopifyDomain).toLowerCase();
    if (domain !== REQUIRED_SHOP || state.precision.active !== 'EXACT' || state.precision.draft !== 'EXACT') {
      return res.status(409).json({ success: false, code: 'UNVERIFIED_PURGE_WRONG_OR_IMPRECISE_SHOP', state });
    }
    if (state.draft !== 0 || state.archived !== 0 || state.unlisted !== 0) {
      return res.status(409).json({ success: false, code: 'UNVERIFIED_PURGE_UNEXPECTED_PRODUCT_STATES', state });
    }

    const phase = clean(req.body?.phase || 'status').toLowerCase();
    if (phase === 'prepare') {
      const existing = await prisma.syncJob.findFirst({
        where: { type: JOB_TYPE, status: 'running' },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) {
        const candidates = parseJson<PurgeCandidate[]>(existing.payload, []);
        return res.json({ success: true, resumed: true, jobId: existing.id, snapshotCount: candidates.length, state });
      }

      const candidates = await currentUnverifiedCandidates();
      if (candidates.length < 1 || candidates.length > MAX_AUTHORIZED_CANDIDATES) {
        return res.status(409).json({
          success: false,
          code: 'UNVERIFIED_PURGE_SCOPE_OUT_OF_BOUNDS',
          candidates: candidates.length,
          maximumAuthorized: MAX_AUTHORIZED_CANDIDATES,
          state,
        });
      }
      const hash = snapshotHash(candidates);
      const result: PurgeResult = {
        stage: 'prepared',
        initialActive: state.active,
        snapshotCount: candidates.length,
        snapshotHash: hash,
        deletedIds: [],
        alreadyMissingIds: [],
        protectedIds: [],
        failed: {},
        updatedAt: new Date().toISOString(),
      };
      const job = await prisma.syncJob.create({
        data: {
          type: JOB_TYPE,
          status: 'running',
          startedAt: new Date(),
          payload: JSON.stringify(candidates),
          result: JSON.stringify(result),
        },
      });
      await prisma.auditLog.create({
        data: {
          action: 'UNVERIFIED_ACTIVE_PURGE_SNAPSHOT',
          userId: 'System',
          details: JSON.stringify({ jobId: job.id, snapshotCount: candidates.length, snapshotHash: hash, state }),
        },
      });
      return res.json({
        success: true,
        resumed: false,
        jobId: job.id,
        snapshotCount: candidates.length,
        snapshotHash: hash,
        breakdown: candidates.reduce((counts: Record<string, number>, row) => {
          counts[row.cycleState] = (counts[row.cycleState] || 0) + 1;
          return counts;
        }, {}),
        state,
      });
    }

    const jobId = clean(req.body?.jobId);
    if (!jobId) return res.status(400).json({ success: false, code: 'UNVERIFIED_PURGE_JOB_ID_REQUIRED' });
    const job = await prisma.syncJob.findUnique({ where: { id: jobId } });
    if (!job || job.type !== JOB_TYPE) {
      return res.status(404).json({ success: false, code: 'UNVERIFIED_PURGE_SNAPSHOT_NOT_FOUND' });
    }
    const candidates = parseJson<PurgeCandidate[]>(job.payload, []);
    const result = parseJson<PurgeResult>(job.result, {
      stage: 'prepared',
      initialActive: state.active,
      snapshotCount: candidates.length,
      snapshotHash: snapshotHash(candidates),
      deletedIds: [],
      alreadyMissingIds: [],
      protectedIds: [],
      failed: {},
      updatedAt: new Date().toISOString(),
    });
    if (snapshotHash(candidates) !== result.snapshotHash || candidates.length !== result.snapshotCount) {
      return res.status(409).json({ success: false, code: 'UNVERIFIED_PURGE_SNAPSHOT_TAMPERED' });
    }
    if (phase === 'status') {
      return res.json({ success: true, jobId, jobStatus: job.status, result, state });
    }
    if (phase !== 'execute') {
      return res.status(400).json({ success: false, code: 'UNVERIFIED_PURGE_UNKNOWN_PHASE' });
    }
    if (job.status === 'completed') {
      return res.json({ success: true, complete: true, jobId, result, state });
    }

    const terminal = new Set([...result.deletedIds, ...result.alreadyMissingIds, ...result.protectedIds]);
    const requested = Math.max(1, Math.min(MAX_BATCH, Math.floor(Number(req.body?.limit || 20) || 20)));
    const selected = candidates
      .filter((row) => !terminal.has(row.shopifyId) && (result.failed[row.shopifyId]?.attempts || 0) < 3)
      .slice(0, requested);
    const stillUnverified = new Map(
      (await currentUnverifiedCandidates(selected.map((row) => row.shopifyId))).map((row) => [row.shopifyId, row]),
    );
    let cursor = 0;
    const batchRows: Array<{ shopifyId: string; title: string; status: string; error?: string }> = [];

    async function worker() {
      while (cursor < selected.length) {
        const snapshot = selected[cursor++];
        if (!snapshot) return;
        const current = stillUnverified.get(snapshot.shopifyId);
        if (!current) {
          result.protectedIds.push(snapshot.shopifyId);
          delete result.failed[snapshot.shopifyId];
          batchRows.push({ shopifyId: snapshot.shopifyId, title: snapshot.title, status: 'protected_now_verified' });
          continue;
        }
        try {
          const liveBefore = await ShopifyService.getProductBasic(client, snapshot.shopifyId);
          if (liveBefore && clean(liveBefore.status).toUpperCase() !== 'ACTIVE') {
            result.protectedIds.push(snapshot.shopifyId);
            delete result.failed[snapshot.shopifyId];
            batchRows.push({ shopifyId: snapshot.shopifyId, title: snapshot.title, status: 'protected_status_changed' });
            continue;
          }
          if (liveBefore) await deleteShopifyProduct(client, snapshot.shopifyId);

          let liveAfter: any = null;
          for (let attempt = 0; attempt < 4; attempt += 1) {
            liveAfter = await ShopifyService.getProductBasic(client, snapshot.shopifyId).catch(() => null);
            if (!liveAfter) break;
            await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
          }
          if (liveAfter) throw new Error('shopify_delete_readback_failed');

          await removeLocalCatalogProduct(current);
          if (liveBefore) result.deletedIds.push(snapshot.shopifyId);
          else result.alreadyMissingIds.push(snapshot.shopifyId);
          delete result.failed[snapshot.shopifyId];
          batchRows.push({ shopifyId: snapshot.shopifyId, title: snapshot.title, status: liveBefore ? 'deleted' : 'already_missing_cleaned' });
        } catch (error: any) {
          const previous = result.failed[snapshot.shopifyId]?.attempts || 0;
          const message = clean(error?.message || error).slice(0, 500);
          result.failed[snapshot.shopifyId] = { attempts: previous + 1, error: message };
          batchRows.push({ shopifyId: snapshot.shopifyId, title: snapshot.title, status: 'failed', error: message });
        }
      }
    }

    result.stage = 'deleting';
    await Promise.all(Array.from({ length: Math.min(3, selected.length || 1) }, () => worker()));
    const completedCount = result.deletedIds.length + result.alreadyMissingIds.length + result.protectedIds.length;
    const retryable = candidates.filter((row) => !terminal.has(row.shopifyId) && ![
      ...result.deletedIds,
      ...result.alreadyMissingIds,
      ...result.protectedIds,
    ].includes(row.shopifyId) && (result.failed[row.shopifyId]?.attempts || 0) < 3).length;
    const abandoned = Object.values(result.failed).filter((entry) => entry.attempts >= 3).length;
    const complete = completedCount + abandoned >= candidates.length;
    if (complete) result.stage = 'completed';
    result.updatedAt = new Date().toISOString();

    await prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status: complete ? (abandoned ? 'failed' : 'completed') : 'running',
        completedAt: complete ? new Date() : null,
        result: JSON.stringify(result),
      },
    });
    const after = await shopState(client);
    await prisma.auditLog.create({
      data: {
        action: 'UNVERIFIED_ACTIVE_PURGE_BATCH',
        userId: 'System',
        details: JSON.stringify({ jobId, selected: selected.length, batchRows, completedCount, retryable, abandoned, after }),
      },
    });

    return res.status(complete && abandoned ? 500 : 200).json({
      success: !(complete && abandoned),
      complete,
      jobId,
      selected: selected.length,
      batchRows,
      totals: {
        snapshot: candidates.length,
        deleted: result.deletedIds.length,
        alreadyMissing: result.alreadyMissingIds.length,
        protected: result.protectedIds.length,
        retryable,
        abandoned,
      },
      after,
    });
  } catch (error: any) {
    console.error('[shopify-unverified-purge] failed', error);
    return res.status(500).json({ success: false, code: 'UNVERIFIED_PURGE_FAILED', error: clean(error?.message || error) });
  }
});

router.post('/admin/repair-next-v47744-catalog', async (req, res) => {
  try {
    if (!(await authorized(req))) {
      return res.status(403).json({ success: false, code: 'NEXT_CATALOG_REPAIR_NOT_AUTHORIZED' });
    }
    const confirm = clean(req.header('x-next-catalog-repair-confirm') || req.body?.confirm);
    if (confirm !== REPAIR_CONFIRM) {
      return res.status(428).json({ success: false, code: 'NEXT_CATALOG_REPAIR_CONFIRMATION_REQUIRED' });
    }

    const client = await ShopifyService.getClientFromDb(prisma);
    const state = await shopState(client);
    if (clean(state.shop?.myshopifyDomain).toLowerCase() !== REQUIRED_SHOP) {
      return res.status(409).json({ success: false, code: 'NEXT_COLOR_REPAIR_WRONG_SHOP', state });
    }

    const source = await prisma.sourceProduct.findFirst({
      where: { url: REPAIR_SOURCE_URL },
      include: {
        variants: {
          include: { shopifyVariant: true },
          orderBy: { createdAt: 'asc' },
        },
        shopifyProduct: true,
      },
    });
    if (
      !source ||
      source.shopifyProduct?.shopifyId !== REPAIR_PRODUCT_ID ||
      clean(source.title) !== REPAIR_TITLE
    ) {
      return res.status(409).json({ success: false, code: 'NEXT_CATALOG_REPAIR_IDENTITY_MISMATCH' });
    }

    const before = await ShopifyService.getProductCatalogSnapshot(client, REPAIR_PRODUCT_ID);
    if (!before || clean(before.title) !== REPAIR_TITLE || clean(before.status).toUpperCase() !== 'ACTIVE') {
      return res.status(409).json({ success: false, code: 'NEXT_CATALOG_REPAIR_LIVE_IDENTITY_MISMATCH' });
    }
    if (before.variants.length !== 10 || source.variants.length !== 10) {
      return res.status(409).json({
        success: false,
        code: 'NEXT_CATALOG_REPAIR_VARIANT_COUNT_MISMATCH',
        liveVariants: before.variants.length,
        sourceVariants: source.variants.length,
      });
    }

    const expectedBySize = new Map(REPAIR_VARIANTS.map((variant) => [canonicalSize(variant.size), variant]));
    const inventoryBefore = await ShopifyService.getProductInventoryVariants(client, REPAIR_PRODUCT_ID);
    const liveBySize = new Map<string, any>();
    for (const variant of inventoryBefore) {
      const size = clean(variant.selectedOptions?.find((option: any) => clean(option.name).toLowerCase() === 'size')?.value);
      const key = canonicalSize(size);
      if (!expectedBySize.has(key) || liveBySize.has(key)) {
        return res.status(409).json({ success: false, code: 'NEXT_CATALOG_REPAIR_LIVE_SIZE_MISMATCH', size });
      }
      liveBySize.set(key, variant);
    }
    const sourceBySize = new Map<string, typeof source.variants[number]>();
    for (const variant of source.variants) {
      const key = canonicalSize(variant.size);
      if (!expectedBySize.has(key) || sourceBySize.has(key)) {
        return res.status(409).json({ success: false, code: 'NEXT_CATALOG_REPAIR_SOURCE_SIZE_MISMATCH', size: variant.size });
      }
      sourceBySize.set(key, variant);
    }
    if (liveBySize.size !== REPAIR_VARIANTS.length || sourceBySize.size !== REPAIR_VARIANTS.length) {
      return res.status(409).json({
        success: false,
        code: 'NEXT_CATALOG_REPAIR_SIZE_SET_MISMATCH',
        expected: REPAIR_VARIANTS.length,
        live: liveBySize.size,
        source: sourceBySize.size,
      });
    }

    const liveColors = unique(before.variants.map((variant: any) =>
      clean(variant.selectedOptions?.find((option: any) => clean(option.name).toLowerCase() === 'color')?.value),
    ));
    const sourceColors = unique(source.variants.map((variant) => clean(variant.color)));
    const acceptedColors = new Set([WRONG_COLOR.toLowerCase(), CORRECT_COLOR.toLowerCase()]);
    if (!liveColors.length || !sourceColors.length ||
      !liveColors.every((color) => acceptedColors.has(color.toLowerCase())) ||
      !sourceColors.every((color) => acceptedColors.has(color.toLowerCase()))) {
      return res.status(409).json({
        success: false,
        code: 'NEXT_CATALOG_REPAIR_UNEXPECTED_COLOR_STATE',
        liveColors,
        sourceColors,
      });
    }

    const beforeRows = REPAIR_VARIANTS.map((expected) => {
      const live = liveBySize.get(canonicalSize(expected.size));
      const targetPrice = expected.sourcePrice * REPAIR_MULTIPLIER;
      const targetInventory = expected.available ? REPAIR_IN_STOCK_QUANTITY : 0;
      return {
        size: expected.size,
        sourcePrice: expected.sourcePrice,
        targetPrice,
        targetInventory,
        beforePrice: Number(live.price),
        beforeInventory: Number(live.inventoryQuantity),
      };
    });
    const alreadyRepaired = liveColors.length === 1 && liveColors[0] === CORRECT_COLOR &&
      sourceColors.length === 1 && sourceColors[0] === CORRECT_COLOR &&
      beforeRows.every((row) => moneyEqual(row.beforePrice, row.targetPrice) && row.beforeInventory === row.targetInventory) &&
      REPAIR_VARIANTS.every((expected) => {
        const variant = sourceBySize.get(canonicalSize(expected.size));
        return variant?.color === CORRECT_COLOR && moneyEqual(variant?.price, expected.sourcePrice) &&
          variant?.available === expected.available &&
          variant?.stockStatus === (expected.available ? 'in_stock' : 'out_of_stock');
      });
    const summary = {
      productId: REPAIR_PRODUCT_ID,
      sourceProductId: source.id,
      title: before.title,
      sourceUrl: source.url,
      variants: before.variants.length,
      liveColors,
      sourceColors,
      targetColor: CORRECT_COLOR,
      multiplier: REPAIR_MULTIPLIER,
      inStock: REPAIR_VARIANTS.filter((variant) => variant.available).length,
      soldOut: REPAIR_VARIANTS.filter((variant) => !variant.available).length,
      rows: beforeRows,
    };
    if (req.body?.dryRun === true) {
      return res.json({ success: true, dryRun: req.body?.dryRun === true, alreadyRepaired, summary });
    }

    if (!(liveColors.length === 1 && liveColors[0] === CORRECT_COLOR)) {
      const optionNames = unique(before.variants.flatMap((variant: any) =>
        (variant.selectedOptions || []).map((option: any) => clean(option.name)),
      ));
      const productOptions = optionNames.map((optionName, position) => ({
        name: optionName,
        position: position + 1,
        values: unique(before.variants.map((variant: any) => {
          const value = clean(variant.selectedOptions?.find((option: any) => clean(option.name) === optionName)?.value);
          return optionName.toLowerCase() === 'color' ? CORRECT_COLOR : value;
        })).map((name) => ({ name })),
      }));
      const variants = before.variants.map((variant: any, index: number) => {
        const size = clean(variant.selectedOptions?.find((option: any) => clean(option.name).toLowerCase() === 'size')?.value);
        const expected = expectedBySize.get(canonicalSize(size))!;
        return {
          id: variant.id,
          optionValues: (variant.selectedOptions || []).map((option: any) => ({
            optionName: clean(option.name),
            name: clean(option.name).toLowerCase() === 'color' ? CORRECT_COLOR : clean(option.value),
          })),
          price: (expected.sourcePrice * REPAIR_MULTIPLIER).toFixed(2),
          sku: variant.sku,
          position: index + 1,
        };
      });
      const mutation = await ShopifyService.setProductCatalog(client, REPAIR_PRODUCT_ID, {
        title: before.title,
        descriptionHtml: before.descriptionHtml || '',
        vendor: before.vendor || 'Next',
        status: 'ACTIVE',
        productOptions,
        variants,
      });
      const userErrors = Array.isArray(mutation?.productSet?.userErrors) ? mutation.productSet.userErrors : [];
      if (userErrors.length) {
        throw new Error(userErrors.map((entry: any) => clean(entry?.message)).filter(Boolean).join('; ') || 'Shopify productSet rejected repair');
      }
    }

    const liveVariants = await ShopifyService.getProductInventoryVariants(client, REPAIR_PRODUCT_ID);
    if (liveVariants.length !== REPAIR_VARIANTS.length) throw new Error('Shopify variants changed during catalog repair');
    const variantUpdates: any[] = [];
    const inventoryUpdates: Array<{ inventoryItemId: string; quantity: number }> = [];
    for (const live of liveVariants) {
      const size = clean(live.selectedOptions?.find((option: any) => clean(option.name).toLowerCase() === 'size')?.value);
      const expected = expectedBySize.get(canonicalSize(size));
      if (!expected || !live.inventoryItem?.id) throw new Error(`Shopify variant cannot be mapped safely: ${size || live.id}`);
      variantUpdates.push({
        id: live.id,
        price: (expected.sourcePrice * REPAIR_MULTIPLIER).toFixed(2),
        inventoryItem: { tracked: true },
      });
      inventoryUpdates.push({
        inventoryItemId: live.inventoryItem.id,
        quantity: expected.available ? REPAIR_IN_STOCK_QUANTITY : 0,
      });
    }
    const priceMutation = await ShopifyService.updateVariantsBulk(client, REPAIR_PRODUCT_ID, variantUpdates);
    const priceErrors = priceMutation?.productVariantsBulkUpdate?.userErrors || [];
    if (priceErrors.length) throw new Error(`Shopify price repair failed: ${priceErrors[0].message}`);

    const location = await ShopifyService.getInventoryLocation(client);
    const inventoryMutation = await ShopifyService.setInventoryQuantities(client, {
      locationId: location.id,
      quantities: inventoryUpdates,
      referenceDocumentUri: 'https://datauplode.vercel.app/products/next-v47744-catalog-repair',
    });
    const inventoryErrors = inventoryMutation?.inventorySetQuantities?.userErrors || [];
    if (inventoryErrors.length) throw new Error(`Shopify inventory repair failed: ${inventoryErrors[0].message}`);

    let after: any = null;
    let afterCatalog: any = null;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      after = await ShopifyService.getProductInventoryVariants(client, REPAIR_PRODUCT_ID);
      afterCatalog = await ShopifyService.getProductCatalogSnapshot(client, REPAIR_PRODUCT_ID);
      const colors = unique((afterCatalog?.variants || []).map((variant: any) =>
        clean(variant.selectedOptions?.find((option: any) => clean(option.name).toLowerCase() === 'color')?.value),
      ));
      const rowsMatch = after?.length === REPAIR_VARIANTS.length && after.every((variant: any) => {
        const size = clean(variant.selectedOptions?.find((option: any) => clean(option.name).toLowerCase() === 'size')?.value);
        const expected = expectedBySize.get(canonicalSize(size));
        return expected && moneyEqual(variant.price, expected.sourcePrice * REPAIR_MULTIPLIER) &&
          Number(variant.inventoryQuantity) === (expected.available ? REPAIR_IN_STOCK_QUANTITY : 0);
      });
      if (rowsMatch && colors.length === 1 && colors[0] === CORRECT_COLOR) break;
      if (attempt < 8) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
    const afterColors = unique((afterCatalog?.variants || []).map((variant: any) =>
      clean(variant.selectedOptions?.find((option: any) => clean(option.name).toLowerCase() === 'color')?.value),
    ));
    const afterRows = (after || []).map((variant: any) => {
      const size = clean(variant.selectedOptions?.find((option: any) => clean(option.name).toLowerCase() === 'size')?.value);
      return { size, price: Number(variant.price), inventory: Number(variant.inventoryQuantity) };
    });
    const readbackVerified = afterRows.length === REPAIR_VARIANTS.length &&
      afterColors.length === 1 && afterColors[0] === CORRECT_COLOR &&
      afterRows.every((row: any) => {
        const expected = expectedBySize.get(canonicalSize(row.size));
        return expected && moneyEqual(row.price, expected.sourcePrice * REPAIR_MULTIPLIER) &&
          row.inventory === (expected.available ? REPAIR_IN_STOCK_QUANTITY : 0);
      });
    if (!readbackVerified) {
      throw new Error('Shopify catalog repair readback did not converge');
    }

    const dbUpdates: any[] = [];
    for (const variant of source.variants) {
      const expected = expectedBySize.get(canonicalSize(variant.size));
      if (!expected) throw new Error(`Stored source variant cannot be mapped safely: ${variant.size || variant.id}`);
      const raw = parseJson<Record<string, any>>(variant.raw, {});
      if (raw.optionValues && typeof raw.optionValues === 'object') {
        raw.optionValues.Color = CORRECT_COLOR;
        if ('color' in raw.optionValues) raw.optionValues.color = CORRECT_COLOR;
      }
      Object.assign(raw, {
        name: expected.size,
        stockStatus: expected.available ? 'InStock' : 'SoldOut',
        price: `AED${expected.sourcePrice}`,
        priceUnformatted: expected.sourcePrice,
        verifiedFromNextEmbeddedDataAt: new Date().toISOString(),
      });
      dbUpdates.push(prisma.sourceVariant.update({
        where: { id: variant.id },
        data: {
          color: CORRECT_COLOR,
          size: expected.size,
          price: expected.sourcePrice,
          currency: 'AED',
          available: expected.available,
          stockStatus: expected.available ? 'in_stock' : 'out_of_stock',
          raw: JSON.stringify(raw),
        },
      }));
      if (variant.shopifyVariant) {
        dbUpdates.push(prisma.shopifyVariant.update({
          where: { id: variant.shopifyVariant.id },
          data: { price: expected.sourcePrice * REPAIR_MULTIPLIER },
        }));
      }
    }
    const sourceRaw = parseJson<Record<string, any>>(source.raw, {});
    sourceRaw.exactVariantAvailability = REPAIR_VARIANTS;
    sourceRaw.verifiedFromNextEmbeddedDataAt = new Date().toISOString();
    dbUpdates.push(prisma.sourceProduct.update({
      where: { id: source.id },
      data: { price: 65, currency: 'AED', raw: JSON.stringify(sourceRaw), lastScrapedAt: new Date() },
    }));
    dbUpdates.push(prisma.shopifyProduct.update({
      where: { id: source.shopifyProduct.id },
      data: { price: 65 * REPAIR_MULTIPLIER, status: 'active' },
    }));
    dbUpdates.push(prisma.auditLog.create({
      data: {
        sourceProductId: source.id,
        action: 'SYNC_PRICE_STOCK_ONLY',
        userId: 'System',
        details: JSON.stringify({
          productId: REPAIR_PRODUCT_ID,
          pricesUpdated: beforeRows.filter((row) => !moneyEqual(row.beforePrice, row.targetPrice)).length,
          variantsUpdated: beforeRows.filter((row) => row.beforeInventory !== row.targetInventory).length,
          inStock: summary.inStock,
          outOfStock: summary.soldOut,
          skippedVariants: 0,
          unmatchedVariants: 0,
          readbackVerified: true,
          exactSourceReadback: true,
          sourceUrl: REPAIR_SOURCE_URL,
          multiplier: REPAIR_MULTIPLIER,
          rows: afterRows,
        }),
      },
    }));
    dbUpdates.push(prisma.auditLog.create({
      data: {
        sourceProductId: source.id,
        action: 'NEXT_V47744_CATALOG_REPAIRED',
        userId: 'System',
        details: JSON.stringify({
          productId: REPAIR_PRODUCT_ID,
          color: CORRECT_COLOR,
          multiplier: REPAIR_MULTIPLIER,
          variants: afterRows.length,
          inStock: summary.inStock,
          soldOut: summary.soldOut,
          rows: afterRows,
          at: new Date().toISOString(),
        }),
      },
    }));
    await prisma.$transaction(dbUpdates);

    return res.json({
      success: true,
      repaired: true,
      alreadyRepaired,
      productId: REPAIR_PRODUCT_ID,
      sourceProductId: source.id,
      variants: afterRows.length,
      beforeColors: liveColors,
      afterColors,
      multiplier: REPAIR_MULTIPLIER,
      inStock: summary.inStock,
      soldOut: summary.soldOut,
      rows: afterRows,
      readbackVerified,
    });
  } catch (error: any) {
    console.error('[shopify-unverified-purge] Next V47744 catalog repair failed', error);
    return res.status(500).json({ success: false, code: 'NEXT_CATALOG_REPAIR_FAILED', error: clean(error?.message || error) });
  }
});

export default router;
