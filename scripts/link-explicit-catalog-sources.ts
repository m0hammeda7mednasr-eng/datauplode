import { prisma } from "../src/server/db.js";
import { ShopifyService } from "../src/server/services/shopify.js";

const CACHE_TABLE = "ShopifyCatalogIndexV2";
const CONFIRMATION = "LINK_EXPLICIT_CATALOG_SOURCES";
const apply = process.argv.includes("--apply");
const confirmed = process.argv.includes(`--confirm=${CONFIRMATION}`);
const limit = Math.max(1, Number(process.argv.find((arg) => arg.startsWith("--limit="))?.slice(8) || 500));
const concurrency = Math.max(1, Math.min(5, Number(process.argv.find((arg) => arg.startsWith("--concurrency="))?.slice(14) || 3)));

if (apply && !confirmed) throw new Error(`Apply requires --confirm=${CONFIRMATION}`);

type CacheRow = {
  shopifyId: string;
  title: string;
  vendor: string | null;
  primarySku: string | null;
  explicitSourceUrls: string | null;
};

const clean = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
const compact = (value: unknown) => clean(value).toUpperCase().replace(/[^A-Z0-9]+/g, "");
const normalizeTitle = (value: unknown) => clean(value)
  .replace(/&(?:amp;)?/gi, " and ")
  .replace(/[^a-z0-9]+/gi, " ")
  .replace(/\s+/g, " ")
  .trim()
  .toLowerCase();

function canonicalUrl(value: unknown) {
  try {
    const parsed = new URL(clean(value).replace(/[),.;]+$/, ""));
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^m\./, "www.");
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|gclid|fbclid|ref|source)/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch { return ""; }
}

function parseUrls(value: string | null) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? [...new Set(parsed.map(canonicalUrl).filter(Boolean))] : [];
  } catch { return []; }
}

function extractUrls(value: unknown) {
  return clean(value).match(/https?:\/\/[^\s<>"']+/gi) || [];
}

function knownProductUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (/media\.|cdn\.|cloudfront|shopify|youtube|youtu\.be/.test(host)) return false;
    if (/\.(?:jpe?g|png|webp|gif|svg|mp4)(?:$|\?)/i.test(url.pathname)) return false;
    if (host.includes("lefties.")) return /p\d+\.html$/i.test(url.pathname);
    if (host.includes("next.")) return /\/style\/[a-z0-9]+\/[a-z0-9]+/i.test(url.pathname);
    if (host.includes("maxfashion.")) return /\/buy-|\/product\//i.test(url.pathname);
    if (host.includes("centrepointstores.")) return /\/buy-|\/product\//i.test(url.pathname);
    if (host.includes("hm.com")) return /productpage|\/product\//i.test(url.pathname);
    if (host.includes("marksandspencer.")) return /\/p\//i.test(url.pathname);
    if (host.includes("mothercare")) return /\/product|\/p\//i.test(url.pathname);
    if (host.includes("gap.")) return /\/browse\/product/i.test(url.pathname);
    return false;
  } catch { return false; }
}

function titleFromUrl(value: string) {
  try {
    const url = new URL(value);
    let segment = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
    segment = segment
      .replace(/\.html$/i, "")
      .replace(/-c\d+p\d+$/i, "")
      .replace(/-p-?\d+$/i, "")
      .replace(/^buy-/i, "");
    return normalizeTitle(segment.replace(/-/g, " "));
  } catch { return ""; }
}

function titleConfirms(shopifyTitle: string, url: string) {
  const sourceTitle = titleFromUrl(url);
  const sourceTokens = new Set(sourceTitle.split(" ").filter((token) => token.length > 1));
  const shopifyTokens = new Set(normalizeTitle(shopifyTitle).split(" ").filter((token) => token.length > 1));
  if (sourceTokens.size < 3 || shopifyTokens.size < 3) return false;
  const shared = [...sourceTokens].filter((token) => shopifyTokens.has(token)).length;
  return shared / Math.min(sourceTokens.size, shopifyTokens.size) >= 0.8;
}

function identityConfirms(sku: string | null, url: string) {
  const skuIdentity = compact(sku);
  if (!skuIdentity) return false;
  try {
    const parsed = new URL(url);
    const ids = [
      parsed.pathname.match(/\/style\/[^/]+\/([^/?#]+)/i)?.[1],
      parsed.pathname.match(/productpage[.\/-]?(\d{7,15})/i)?.[1],
      parsed.pathname.match(/p(\d{7,15})\.html/i)?.[1],
      parsed.searchParams.get("pid"),
      parsed.searchParams.get("productId"),
    ].map(compact).filter((id) => id.length >= 5);
    return ids.some((id) => skuIdentity.includes(id) || id.includes(skuIdentity));
  } catch { return false; }
}

const rows = await prisma.$queryRawUnsafe<CacheRow[]>(`
  SELECT "shopifyId", "title", "vendor", "primarySku", "explicitSourceUrls"
  FROM "${CACHE_TABLE}"
  WHERE UPPER(COALESCE("status", ''))='ACTIVE'
    AND "matchStatus"='needs_review'
    AND "matchMethod"='source_url_not_in_sheets'
  ORDER BY "shopifyId" ASC
  LIMIT ${limit}
`);

const candidates = rows.flatMap((row) => {
  const urls = parseUrls(row.explicitSourceUrls).filter(knownProductUrl);
  if (urls.length !== 1) return [];
  const url = urls[0];
  if (!titleConfirms(row.title, url) && !identityConfirms(row.primarySku, url)) return [];
  return [{ row, url }];
});

const result = { apply, selected: rows.length, candidates: candidates.length, linked: 0, failed: 0, issues: [] as Array<Record<string, unknown>> };
if (!apply) {
  console.log(JSON.stringify({ ...result, sample: candidates.slice(0, 20).map(({ row, url }) => ({ shopifyId: row.shopifyId, title: row.title, url })) }));
  await prisma.$disconnect();
  process.exit(0);
}

const client = await ShopifyService.getClientFromDb(prisma);
for (let offset = 0; offset < candidates.length; offset += concurrency) {
  await Promise.all(candidates.slice(offset, offset + concurrency).map(async ({ row, url }) => {
    try {
      const data: any = await client.request(`
        query ExplicitCatalogSource($id: ID!) {
          product(id: $id) {
            id title vendor status descriptionHtml
            synclySource: metafield(namespace: "syncly", key: "source_url") { value }
            customSource: metafield(namespace: "custom", key: "source_url") { value }
            variants(first: 250) { nodes { sku } }
          }
        }
      `, { id: row.shopifyId });
      const product = data?.product;
      if (!product || String(product.status).toUpperCase() !== "ACTIVE") throw new Error("Shopify product missing or inactive");
      if (normalizeTitle(product.title) !== normalizeTitle(row.title)) throw new Error("Live Shopify title changed");
      const liveUrls = [product.descriptionHtml, product.synclySource?.value, product.customSource?.value]
        .flatMap(extractUrls).map(canonicalUrl).filter(Boolean);
      if (!liveUrls.includes(url)) throw new Error("Source URL is no longer present on live Shopify product");
      const liveSkus = (product.variants?.nodes || []).map((variant: any) => clean(variant.sku));
      if (!titleConfirms(product.title, url) && !liveSkus.some((sku: string) => identityConfirms(sku, url))) {
        throw new Error("Live product identity does not confirm source URL");
      }
      await prisma.$transaction(async (tx) => {
        const changed = await tx.$executeRawUnsafe(`
          UPDATE "${CACHE_TABLE}"
          SET "matchStatus"='linked', "matchMethod"='verified_shopify_explicit_source',
              "matchedSourceUrl"=$2,
              "reason"='Verified source URL embedded in live Shopify product; source record pending',
              "evidence"=$3, "updatedAt"=NOW()
          WHERE "shopifyId"=$1 AND "matchStatus"='needs_review'
            AND "matchMethod"='source_url_not_in_sheets'
        `, product.id, url, JSON.stringify(["live_shopify_source_url", "supplier_product_url", "title_or_identifier_verified"]));
        if (!changed) return;
        await tx.auditLog.create({ data: {
          action: "LINK_EXISTING_SHOPIFY_EXPLICIT_SOURCE",
          details: JSON.stringify({ shopifyId: product.id, sourceUrl: url, liveReadbackVerified: true }),
        } });
        result.linked += 1;
      }, { maxWait: 15_000, timeout: 45_000 });
    } catch (error: any) {
      result.failed += 1;
      result.issues.push({ shopifyId: row.shopifyId, error: clean(error?.message || error).slice(0, 300) });
    }
  }));
}

console.log(JSON.stringify(result));
await prisma.$disconnect();
