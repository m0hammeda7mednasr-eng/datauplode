import { prisma } from "../db.js";
import { fetchHtmlViaManagedBypass, ScraperService, type NormalizedProduct } from "./scraper.js";

const JOB_TYPE = "CATALOG_SOURCE_DISCOVERY_BATCH";
const CACHE_TABLE = "ShopifyCatalogIndexV2";
const DEFAULT_MULTIPLIER = 23;
const scraper = new ScraperService();

type DiscoveryRow = {
  shopifyId: string;
  title: string;
  vendor: string | null;
  handle: string | null;
  price: number | null;
};

type VendorSearch = { domains: string[]; queryLabel: string };

const SEARCH_BY_VENDOR: Record<string, VendorSearch> = {
  zara: { domains: ["zara.com"], queryLabel: "Zara" },
  hm: { domains: ["hm.com"], queryLabel: "H&M" },
  handm: { domains: ["hm.com"], queryLabel: "H&M" },
  next: { domains: ["next.ae", "nextdirect.com"], queryLabel: "Next" },
  mothercare: { domains: ["mothercarestores.com", "mothercare.com"], queryLabel: "Mothercare" },
  ms: { domains: ["marksandspencerme.com", "marksandspencer.com"], queryLabel: "Marks Spencer" },
  mands: { domains: ["marksandspencerme.com", "marksandspencer.com"], queryLabel: "Marks Spencer" },
  marksandspencer: { domains: ["marksandspencerme.com", "marksandspencer.com"], queryLabel: "Marks Spencer" },
  gap: { domains: ["gap.ae", "gap.com"], queryLabel: "Gap" },
  lefties: { domains: ["lefties.com"], queryLabel: "Lefties" },
  adidas: { domains: ["adidas.ae", "adidas.com"], queryLabel: "Adidas" },
  nike: { domains: ["nike.ae", "nike.com"], queryLabel: "Nike" },
  carters: { domains: ["carters.com"], queryLabel: "Carters" },
  cathkidston: { domains: ["cathkidston.com"], queryLabel: "Cath Kidston" },
  jojomamanbebe: { domains: ["jojomamanbebe.co.uk"], queryLabel: "JoJo Maman Bebe" },
  riverisland: { domains: ["riverisland.com"], queryLabel: "River Island" },
  max: { domains: ["maxfashion.com"], queryLabel: "Max Fashion" },
  juniors: { domains: ["centrepointstores.com"], queryLabel: "Juniors Centrepoint" },
  giggles: { domains: ["centrepointstores.com"], queryLabel: "Giggles Centrepoint" },
};

function clean(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function vendorKey(value: unknown) {
  return clean(value).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
}

function normalizedTokens(value: unknown) {
  return new Set(
    clean(value)
      .toLowerCase()
      .replace(/&(?:amp;)?/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((token) => token.length > 1 && !["the", "with", "and", "for", "size", "years", "months", "mths"].includes(token)),
  );
}

function titleOverlap(left: unknown, right: unknown) {
  const a = normalizedTokens(left);
  const b = normalizedTokens(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

function canonicalUrl(value: string) {
  const parsed = new URL(value.replace(/&amp;/gi, "&"));
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(utm_|gclid|fbclid|ref|source)/i.test(key)) parsed.searchParams.delete(key);
  }
  return parsed.toString().replace(/\/$/, "");
}

function allowedHost(url: string, domains: string[]) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function productIdentity(url: string) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const matches = [
      path.match(/-p0*(\d+)\.html/i)?.[1],
      path.match(/productpage[.\/-]?(\d{7,15})/i)?.[1],
      path.match(/-p-(\d+)\.html/i)?.[1],
      path.match(/\/style\/([^/]+)\/([^/?#]+)/i)?.slice(1).join("/"),
      path.match(/\/p\/([^/?#]+)/i)?.[1],
    ];
    return clean(matches.find(Boolean)).toUpperCase().replace(/[^A-Z0-9/]/g, "");
  } catch {
    return "";
  }
}

function extractSupplierLinks(html: string, domains: string[]) {
  const decoded = html
    .replace(/&amp;/gi, "&")
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\\//g, "/");
  const links = [...decoded.matchAll(/https?:\/\/[^\s"'<>]+/g)]
    .map((match) => match[0].replace(/[),.;]+$/, ""))
    .filter((url) => allowedHost(url, domains))
    .map((url) => {
      try { return canonicalUrl(url); } catch { return ""; }
    })
    .filter(Boolean);
  return [...new Set(links)].filter((url) => Boolean(productIdentity(url)));
}

function preferredUrl(urls: string[], identity: string, search: VendorSearch) {
  if (search.domains.includes("next.ae") && /^[A-Z0-9]+\/[A-Z0-9]+$/.test(identity)) {
    return `https://www.next.ae/en/style/${identity.toLowerCase()}`;
  }
  return [...urls].sort((a, b) => {
    const rank = (url: string) => /\/ae\/en\//i.test(url) || /next\.ae/i.test(url) || /gap\.ae/i.test(url) || /adidas\.ae/i.test(url) ? 0 : 1;
    return rank(a) - rank(b) || a.length - b.length;
  })[0];
}

async function discoverSource(row: DiscoveryRow, search: VendorSearch) {
  const siteQuery = search.domains.map((domain) => `site:${domain}`).join(" OR ");
  const compactTitle = clean(row.title)
    .replace(/\s+-\s+size\s+.+$/i, "")
    .replace(/\s+\|\s+size\s+.+$/i, "");
  const queries = [
    `(${siteQuery}) "${row.title}" ${search.queryLabel}`,
    ...(compactTitle !== clean(row.title) ? [`(${siteQuery}) "${compactTitle}" ${search.queryLabel}`] : []),
    `(${siteQuery}) ${compactTitle} ${search.queryLabel}`,
  ];
  let links: string[] = [];
  let searchAttempts = 0;
  for (const query of [...new Set(queries)]) {
    searchAttempts += 1;
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    const html = await fetchHtmlViaManagedBypass(googleUrl, {
      providerOrder: ["scraperapi"],
      jsRender: false,
      premium: false,
      ultraPremium: false,
      deviceType: "none",
    });
    links = extractSupplierLinks(html, search.domains);
    if (links.length > 0) break;
  }
  const byIdentity = new Map<string, string[]>();
  for (const link of links) {
    const identity = productIdentity(link);
    byIdentity.set(identity, [...(byIdentity.get(identity) || []), link]);
  }
  if (byIdentity.size !== 1) {
    throw new Error(`Search returned ${byIdentity.size} distinct supplier product IDs`);
  }
  const [identity, identityLinks] = [...byIdentity.entries()][0];
  const url = preferredUrl(identityLinks, identity, search);
  const product = await scraper.scrape(url);
  const overlap = titleOverlap(row.title, product.title);
  if (overlap < 0.55) throw new Error(`Scraped title overlap ${overlap.toFixed(2)} is below 0.55`);
  if (!(product.price > 0) || !product.images.length || !product.variants.length) {
    throw new Error("Scraped product failed price/image/variant validation");
  }
  return { identity, url, product, overlap, searchResultCount: identityLinks.length, searchAttempts };
}

async function persistLink(row: DiscoveryRow, result: Awaited<ReturnType<typeof discoverSource>>) {
  const { product, url, identity, overlap, searchResultCount, searchAttempts } = result;
  await prisma.$transaction(async (tx) => {
    const existingShopify = await tx.shopifyProduct.findUnique({ where: { shopifyId: row.shopifyId } });
    if (existingShopify) return;
    const existingSource = await tx.sourceProduct.findUnique({ where: { url }, include: { shopifyProduct: true } });
    if (existingSource?.shopifyProduct && existingSource.shopifyProduct.shopifyId !== row.shopifyId) {
      throw new Error("Discovered source URL is already linked to another Shopify product");
    }
    const supplier = await tx.supplier.upsert({
      where: { name: clean(product.source.supplier) || clean(row.vendor) || "Discovered Supplier" },
      update: {},
      create: {
        name: clean(product.source.supplier) || clean(row.vendor) || "Discovered Supplier",
        baseUrl: new URL(url).origin,
      },
    });
    const raw = JSON.stringify({
      ...(product.raw && typeof product.raw === "object" ? product.raw : {}),
      import: {
        sourceDiscovery: true,
        matchMethod: "scraped_unique_search_product_id",
        sourceProductIdentity: identity,
        titleOverlap: overlap,
        searchResultCount,
        searchAttempts,
        sheetPriceMultiplier: DEFAULT_MULTIPLIER,
        linkedAt: new Date().toISOString(),
      },
    });
    const data = {
      supplierId: supplier.id,
      productId: clean(product.source.productId) || identity,
      title: product.title,
      description: product.description || null,
      brand: product.brand || row.vendor,
      currency: product.currency || "AED",
      price: product.price,
      raw,
      syncStatus: "active",
      lastScrapedAt: new Date(),
    };
    const source = existingSource
      ? await tx.sourceProduct.update({ where: { id: existingSource.id }, data })
      : await tx.sourceProduct.create({ data: { ...data, url } });
    await tx.sourceImage.deleteMany({ where: { sourceProductId: source.id } });
    await tx.sourceVariant.deleteMany({ where: { sourceProductId: source.id, shopifyVariant: null } });
    await tx.sourceImage.createMany({
      data: product.images.map((image, index) => ({
        sourceProductId: source.id,
        url: image.url,
        alt: image.alt || product.title,
        color: image.color || null,
        position: Number.isFinite(image.position) ? image.position : index,
      })),
    });
    await tx.sourceVariant.createMany({
      data: product.variants.map((variant, index) => ({
        sourceProductId: source.id,
        sourceVariantId: clean(variant.sourceVariantId) || `${identity}-${index + 1}`,
        sku: clean(variant.sku) || null,
        color: clean(variant.color) || null,
        size: clean(variant.size) || null,
        price: Number(variant.price || product.price),
        currency: variant.currency || product.currency || "AED",
        available: variant.available !== false,
        stockStatus: variant.stockStatus || "unknown",
        imageUrl: clean(variant.imageUrl) || null,
        raw: JSON.stringify(variant.raw || {}),
      })),
    });
    await tx.shopifyProduct.create({
      data: {
        sourceProductId: source.id,
        shopifyId: row.shopifyId,
        handle: row.handle,
        status: "active",
        price: row.price,
        syncEnabled: true,
        syncPrice: true,
        syncInventory: true,
        syncImages: true,
      },
    });
    await tx.auditLog.create({
      data: {
        sourceProductId: source.id,
        action: "CATALOG_SOURCE_DISCOVERY_LINKED",
        details: JSON.stringify({ shopifyId: row.shopifyId, url, identity, overlap, searchResultCount, searchAttempts }),
      },
    });
    await tx.$executeRawUnsafe(`
      UPDATE "${CACHE_TABLE}"
      SET "matchStatus"='active', "matchMethod"='scraped_unique_search_product_id',
          "matchedSourceUrl"=$2, "reason"=NULL,
          "evidence"=$3, "updatedAt"=NOW()
      WHERE "shopifyId"=$1
    `, row.shopifyId, url, JSON.stringify(["unique_search_product_id", "scraped_title_verified"]));
  });
}

export async function runCatalogSourceDiscoveryBatch() {
  const batchSize = Math.max(1, Math.min(50, Number(process.env.CATALOG_SOURCE_DISCOVERY_BATCH_SIZE || 5)));
  const rows = await prisma.$queryRawUnsafe<DiscoveryRow[]>(`
    SELECT "shopifyId", "title", "vendor", "handle", "price"
    FROM "${CACHE_TABLE}"
    WHERE UPPER(COALESCE("status",''))='ACTIVE'
      AND "matchStatus"='needs_link'
      AND (
        "reason" IS NULL
        OR "reason" NOT LIKE 'Source discovery:%'
        OR "updatedAt" < NOW() - INTERVAL '24 hours'
      )
    ORDER BY "updatedAt" ASC
  `);
  const candidates = rows.filter((row) => SEARCH_BY_VENDOR[vendorKey(row.vendor)]).slice(0, batchSize);
  const job = await prisma.syncJob.create({ data: { type: JOB_TYPE, status: "running", startedAt: new Date(), payload: JSON.stringify({ batchSize }) } });
  const result = { selected: candidates.length, linked: 0, failed: 0, issues: [] as Array<Record<string, unknown>> };
  const concurrency = Math.max(1, Math.min(5, Number(process.env.CATALOG_SOURCE_DISCOVERY_CONCURRENCY || 2)));
  for (let offset = 0; offset < candidates.length; offset += concurrency) {
    await Promise.all(candidates.slice(offset, offset + concurrency).map(async (row) => {
      try {
        const discovered = await discoverSource(row, SEARCH_BY_VENDOR[vendorKey(row.vendor)]);
        await persistLink(row, discovered);
        result.linked += 1;
      } catch (error: any) {
        result.failed += 1;
        const message = clean(error?.message || error).slice(0, 500);
        result.issues.push({ shopifyId: row.shopifyId, title: row.title, vendor: row.vendor, error: message });
        await prisma.$executeRawUnsafe(`
          UPDATE "${CACHE_TABLE}"
          SET "reason"=$2, "updatedAt"=NOW()
          WHERE "shopifyId"=$1 AND "matchStatus"='needs_link'
        `, row.shopifyId, `Source discovery: ${message}`);
      }
    }));
  }
  await prisma.syncJob.update({
    where: { id: job.id },
    data: { status: "completed", completedAt: new Date(), result: JSON.stringify(result) },
  });
  return result;
}

let monitorStarted = false;
let running = false;

export function startCatalogSourceDiscoveryMonitor() {
  if (monitorStarted || process.env.CATALOG_SOURCE_DISCOVERY_AUTOSTART !== "true") return;
  const intervalMinutes = Math.max(5, Number(process.env.CATALOG_SOURCE_DISCOVERY_INTERVAL_MINUTES || 5));
  const run = async () => {
    if (running) return;
    running = true;
    try { await runCatalogSourceDiscoveryBatch(); }
    catch (error: any) { console.error("Catalog source discovery batch failed:", clean(error?.message || error)); }
    finally { running = false; }
  };
  monitorStarted = true;
  const timer = setInterval(() => void run(), intervalMinutes * 60 * 1000);
  timer.unref?.();
  const initial = setTimeout(() => void run(), 20_000);
  initial.unref?.();
  console.log(`Catalog source discovery enabled: every ${intervalMinutes} minute(s)`);
}
