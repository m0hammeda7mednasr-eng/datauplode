import crypto from 'crypto';
import { Router, type Request } from 'express';
import { prisma } from '../db.js';
import { ShopifyService } from '../services/shopify.js';

const router = Router();
const REQUIRED_SHOP = '09fgkz-6n.myshopify.com';
const REQUIRED_CONFIRM = 'PURGE_DABDOOB_ORPHAN_DRAFTS';
const EXPECTED_ACTIVE = 5062;
const MAX_BATCH = 50;
const MAX_EXPECTED_DRAFTS = 1756;

function clean(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authorized(req: Request) {
  const configured = clean(process.env.CATALOG_AUDIT_WRITE_TOKEN);
  const supplied = clean(req.header('x-catalog-audit-write-token'));
  return Boolean(configured && supplied && safeEqual(configured, supplied));
}

async function shopState(client: any) {
  const data = await client.request(`
    query OrphanPurgeState {
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

async function firstDrafts(client: any, first: number) {
  const data = await client.request(
    `query OrphanDraftBatch($first: Int!) {
      products(first: $first, query: "status:draft", sortKey: ID) {
        nodes { id title handle status createdAt }
      }
    }`,
    { first },
  );
  return Array.isArray(data?.products?.nodes) ? data.products.nodes : [];
}

async function preconditions(client: any) {
  const state = await shopState(client);
  const domain = clean(state.shop?.myshopifyDomain).toLowerCase();
  const failures: string[] = [];
  if (domain !== REQUIRED_SHOP) failures.push(`wrong_shop:${domain || 'unknown'}`);
  if (state.precision.active !== 'EXACT' || state.precision.draft !== 'EXACT') failures.push('product_counts_not_exact');
  if (state.active !== EXPECTED_ACTIVE) failures.push(`active_count_changed:${state.active}`);
  if (state.draft < 0 || state.draft > MAX_EXPECTED_DRAFTS) failures.push(`draft_count_out_of_bounds:${state.draft}`);
  if (state.archived !== 0 || state.unlisted !== 0) failures.push(`unexpected_non_active_states:archived=${state.archived},unlisted=${state.unlisted}`);
  return { state, failures };
}

router.post('/admin/purge-shopify-orphans', async (req, res) => {
  try {
    if (!authorized(req)) {
      return res.status(403).json({ success: false, code: 'ORPHAN_PURGE_NOT_AUTHORIZED' });
    }
    const confirm = clean(req.header('x-shopify-orphan-purge-confirm') || req.body?.confirm);
    if (confirm !== REQUIRED_CONFIRM) {
      return res.status(428).json({ success: false, code: 'ORPHAN_PURGE_CONFIRMATION_REQUIRED' });
    }

    const client = await ShopifyService.getClientFromDb(prisma);
    const before = await preconditions(client);
    if (before.failures.length) {
      return res.status(409).json({
        success: false,
        code: 'ORPHAN_PURGE_PRECONDITION_FAILED',
        failures: before.failures,
        state: before.state,
      });
    }

    const requested = Math.max(1, Math.min(MAX_BATCH, Math.floor(Number(req.body?.limit || 25) || 25)));
    const draftNodes = await firstDrafts(client, requested);
    const ids = draftNodes.map((row: any) => clean(row?.id)).filter(Boolean);
    const linkedRows = ids.length
      ? await prisma.shopifyProduct.findMany({
          where: { shopifyId: { in: ids } },
          select: { shopifyId: true, sourceProductId: true },
        })
      : [];
    const linkedIds = new Set(linkedRows.map((row) => clean(row.shopifyId)).filter(Boolean));
    const candidates = draftNodes.filter((row: any) => row?.id && !linkedIds.has(clean(row.id)));

    if (req.body?.dryRun === true) {
      return res.json({
        success: true,
        dryRun: true,
        state: before.state,
        selectedDrafts: draftNodes.length,
        orphanCandidates: candidates.length,
        linkedDraftsSkipped: linkedRows.length,
        sample: candidates.slice(0, 10).map((row: any) => ({ id: row.id, title: row.title, status: row.status })),
      });
    }

    if (before.state.draft > 0 && candidates.length === 0) {
      return res.status(409).json({
        success: false,
        code: 'ORPHAN_PURGE_NO_SAFE_CANDIDATES',
        state: before.state,
        linkedDraftsSkipped: linkedRows.length,
      });
    }

    const results: Array<{ id: string; title: string; status: string; error?: string }> = [];
    let cursor = 0;
    const concurrency = 3;

    async function worker() {
      while (cursor < candidates.length) {
        const row: any = candidates[cursor++];
        if (!row) return;
        const id = clean(row.id);
        const title = clean(row.title);
        try {
          const local = await prisma.shopifyProduct.findFirst({
            where: { shopifyId: id },
            select: { id: true, sourceProductId: true },
          });
          if (local) {
            results.push({ id, title, status: 'became_linked' });
            continue;
          }

          const liveBefore = await ShopifyService.getProductCatalogSnapshot(client, id);
          if (!liveBefore) {
            results.push({ id, title, status: 'already_missing' });
            continue;
          }
          if (clean(liveBefore.status).toUpperCase() !== 'DRAFT') {
            results.push({ id, title, status: 'status_changed' });
            continue;
          }

          await ShopifyService.deleteProduct(client, id);
          let liveAfter: any = null;
          for (let attempt = 0; attempt < 4; attempt += 1) {
            liveAfter = await ShopifyService.getProductBasic(client, id).catch(() => null);
            if (!liveAfter) break;
            await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
          }
          if (liveAfter) throw new Error('delete_readback_failed');
          results.push({ id, title, status: 'deleted' });
        } catch (error: any) {
          results.push({ id, title, status: 'failed', error: clean(error?.message || error).slice(0, 500) });
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length || 1) }, () => worker()));

    const after = await shopState(client);
    const deleted = results.filter((row) => row.status === 'deleted').length;
    const failed = results.filter((row) => row.status === 'failed').length;
    const unsafe = results.filter((row) => ['became_linked', 'status_changed'].includes(row.status)).length;

    await prisma.auditLog.create({
      data: {
        action: 'SHOPIFY_ORPHAN_PURGE_BATCH',
        userId: 'System',
        details: JSON.stringify({
          shop: before.state.shop,
          beforeDrafts: before.state.draft,
          afterDrafts: after.draft,
          selected: candidates.length,
          deleted,
          failed,
          unsafeSkipped: unsafe,
          results,
          at: new Date().toISOString(),
        }),
      },
    });

    if (failed > 0) {
      return res.status(500).json({
        success: false,
        code: 'ORPHAN_PURGE_BATCH_PARTIAL_FAILURE',
        before: before.state,
        after,
        selected: candidates.length,
        deleted,
        failed,
        unsafeSkipped: unsafe,
        results,
      });
    }

    return res.json({
      success: true,
      before: before.state,
      after,
      selected: candidates.length,
      deleted,
      failed,
      unsafeSkipped: unsafe,
      results,
      complete: after.draft === 0,
    });
  } catch (error: any) {
    console.error('[shopify-orphan-purge-route] failed', error);
    return res.status(500).json({ success: false, code: 'ORPHAN_PURGE_FAILED', error: clean(error?.message || error) });
  }
});

export default router;
