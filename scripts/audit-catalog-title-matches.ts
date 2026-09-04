import { prisma } from "../src/server/db.js";

type CatalogRow = {
  shopifyId: string;
  title: string;
  vendor: string | null;
  primarySku: string | null;
};

function clean(value: unknown) {
  return String(value ?? "")
    .replace(/&amp;/gi, "and")
    .replace(/&#(?:189|xbd);/gi, " half ")
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function vendorKey(value: unknown) {
  const normalized = clean(value).replace(/\band\b/g, "").replace(/\s+/g, "");
  if (/^(mands|marksandspencer)$/.test(normalized)) return "marksandspencer";
  if (/^(hm|handm)$/.test(normalized)) return "hm";
  if (/^(max|maxfashion)$/.test(normalized)) return "max";
  return normalized;
}

function compact(value: unknown) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function sourceIdentifiers(url: string) {
  const identifiers = new Set<string>();
  try {
    const parsed = new URL(url);
    const candidates = [
      ...parsed.pathname.split("/"),
      ...[...parsed.searchParams.values()],
    ];
    for (const candidate of candidates) {
      const value = compact(decodeURIComponent(candidate));
      if (/^(?=.*[A-Z])(?=.*\d)[A-Z0-9]{5,40}$/.test(value) || /^\d{7,15}$/.test(value)) {
        identifiers.add(value);
      }
    }
    const next = parsed.pathname.match(/\/style\/[^/]+\/([^/?#]+)/i)?.[1];
    const hm = parsed.pathname.match(/productpage[.\/-]?(\d{7,15})/i)?.[1];
    const productPath = parsed.pathname.match(/\/p\/([^/?#]+)/i)?.[1];
    for (const value of [next, hm, productPath, parsed.searchParams.get("v1"), parsed.searchParams.get("pid")]) {
      const normalized = compact(value);
      if (normalized.length >= 5) identifiers.add(normalized);
    }
  } catch {}
  return [...identifiers];
}

function skuIdentifiers(sku: unknown, vendor: unknown) {
  const raw = String(sku ?? "").toUpperCase();
  const normalizedVendor = vendorKey(vendor);
  const identifiers = new Set<string>();
  const base = compact(raw.replace(/-OPTION.*$/i, ""));
  if (base.length >= 5) identifiers.add(base);
  if (normalizedVendor === "next") {
    const match = base.match(/^([A-Z]\d{5})/);
    if (match) identifiers.add(match[1]);
  }
  if (normalizedVendor === "hm") {
    const match = base.match(/^(\d{10})/);
    if (match) identifiers.add(match[1]);
  }
  if (normalizedVendor === "mothercare") {
    const match = compact(raw.replace(/^M[-_]?/i, "")).match(/^([A-Z]{2}\d{3})/);
    if (match) identifiers.add(match[1]);
  }
  return [...identifiers];
}

const catalog = await prisma.$queryRawUnsafe<CatalogRow[]>(`
  SELECT "shopifyId", "title", "vendor", "primarySku"
  FROM "ShopifyCatalogIndexV2"
  WHERE UPPER(COALESCE("status", '')) = 'ACTIVE'
    AND "matchStatus" = 'needs_link'
`);

const sources = await prisma.sourceProduct.findMany({
  where: { shopifyProduct: null },
  select: {
    id: true,
    url: true,
    title: true,
    brand: true,
    raw: true,
    supplier: { select: { name: true } },
    variants: { select: { sku: true }, take: 20 },
  },
});

const byTitleVendor = new Map<string, typeof sources>();
const byTitle = new Map<string, typeof sources>();
const byIdentifier = new Map<string, typeof sources>();
for (const source of sources) {
  const title = clean(source.title);
  if (!title) continue;
  const vendor = vendorKey(source.brand || source.supplier.name);
  const titleVendorKey = `${title}|${vendor}`;
  byTitleVendor.set(titleVendorKey, [...(byTitleVendor.get(titleVendorKey) || []), source]);
  byTitle.set(title, [...(byTitle.get(title) || []), source]);
  for (const identifier of sourceIdentifiers(source.url)) {
    byIdentifier.set(identifier, [...(byIdentifier.get(identifier) || []), source]);
  }
}

let exactTitleVendorUnique = 0;
let exactTitleUnique = 0;
let exactTitleVendorAmbiguous = 0;
let exactIdentifierUnique = 0;
const samples: Array<Record<string, unknown>> = [];
for (const product of catalog) {
  const title = clean(product.title);
  const vendor = vendorKey(product.vendor);
  const titleVendor = byTitleVendor.get(`${title}|${vendor}`) || [];
  const titleOnly = byTitle.get(title) || [];
  if (titleVendor.length === 1) {
    exactTitleVendorUnique += 1;
    if (samples.length < 20) {
      samples.push({ shopifyTitle: product.title, vendor: product.vendor, sourceUrl: titleVendor[0].url });
    }
  } else if (titleVendor.length > 1) {
    exactTitleVendorAmbiguous += 1;
  }
  if (titleOnly.length === 1) exactTitleUnique += 1;
  const identifierMatches = new Map<string, (typeof sources)[number]>();
  for (const identifier of skuIdentifiers(product.primarySku, product.vendor)) {
    for (const source of byIdentifier.get(identifier) || []) identifierMatches.set(source.url, source);
  }
  if (identifierMatches.size === 1) exactIdentifierUnique += 1;
}

const vendorCounts = new Map<string, number>();
for (const product of catalog) {
  const vendor = vendorKey(product.vendor);
  vendorCounts.set(vendor, (vendorCounts.get(vendor) || 0) + 1);
}
const noMatchByVendor = [...vendorCounts.entries()]
  .map(([vendor, count]) => ({ vendor, count }))
  .sort((a, b) => b.count - a.count)
  .slice(0, 20);

console.log(JSON.stringify({
  noMatchCatalogProducts: catalog.length,
  unlinkedScrapedSources: sources.length,
  exactTitleVendorUnique,
  exactTitleVendorAmbiguous,
  exactTitleUnique,
  exactIdentifierUnique,
  noMatchByVendor,
  samples,
}, null, 2));

await prisma.$disconnect();
