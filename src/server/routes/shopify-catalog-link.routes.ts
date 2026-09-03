import { Router } from "express";
import { prisma } from "../db.js";
import { ShopifyService } from "../services/shopify.js";
import { dabBrandCode, dabProductCode } from "../services/dabSku.js";
import { loadGoogleSheetRows, type GoogleSheetRow } from "../api.js";

const router = Router();

const BIG_SPREADSHEET_ID = "1fCbPajWL3nukX0TdoN1m2X8LV3pfPsxSMLBb0yWug2w";
const LEGACY_SPREADSHEET_ID = "13JSw5k_wX8RAd98P-TWLT-938ImshAtrukjjA4n-lkI";
const RECONCILE_JOB_TYPE = "SHOPIFY_CATALOG_LINK_RECONCILE:2026-09-03-v1";
const RECONCILE_CONFIRMATION = "LINK_EXACT_SHOPIFY_CATALOG";
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const SHEET_INDEX_TTL_MS = 10 * 60 * 1000;
const SHOPIFY_PRODUCTS_PER_PAGE = 25;
const SHOPIFY_VARIANTS_PER_PRODUCT = 20;
const MAX_SHOPIFY_PAGES = 800;
const SHOPIFY_PAGE_DELAY_MS = 150;
const SHOPIFY_THROTTLE_RETRIES = 5;

const SHEETS = [
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: "dap_data", sheetName: "الورقة1", gid: 0, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: "dap_data", sheetName: "الورقة2", gid: 531292068, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: "dap_data", sheetName: "الورقة15", gid: 242585683, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: "dap_data", sheetName: "الورقة10", gid: 1991302797, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: "dap_data", sheetName: "الورقة6", gid: 1951926772, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: "dap_data", sheetName: "الورقة7", gid: 93159589, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: "dap_data", sheetName: "الورقة8", gid: 916372394, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: "dap_data", sheetName: "الورقة20", gid: 202697256, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: "dap_data", sheetName: "الورقة9", gid: 1264806944, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: "dap_data", sheetName: "الورقة11", gid: 106757984, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: "dap_data", sheetName: "الورقة12", gid: 1841878091, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: "dap_data", sheetName: "الورقة13", gid: 1219566712, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: "dap_data", sheetName: "الورقة16", gid: 1526682180, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: "dap_data", sheetName: "الورقة18", gid: 1122116162, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: "dap_data", sheetName: "الورقة19", gid: 16172014, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: "dap_data", sheetName: "الورقة21", gid: 1993452910, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: "dap_data", sheetName: "الورقة22", gid: 282692873, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: "dap_data", sheetName: "الورقة23", gid: 770232216, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: "dap_data", sheetName: "الورقة24", gid: 1210585516, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: "dap_data", sheetName: "الورقة25", gid: 307824540, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: "dap_data", sheetName: "الورقة26", gid: 1459453928, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: "dap_data", sheetName: "الورقة27", gid: 4356284, priority: 0 },
  { spreadsheetId: BIG_SPREADSHEET_ID, spreadsheetName: "dap_data", sheetName: "الورقة28", gid: 422632561, priority: 0 },
  { spreadsheetId: LEGACY_SPREADSHEET_ID, spreadsheetName: "legacy_4_sheet", sheetName: "الورقة1", gid: 0, priority: 1 },
  { spreadsheetId: LEGACY_SPREADSHEET_ID, spreadsheetName: "legacy_4_sheet", sheetName: "الورقة2", gid: 1503940200, priority: 1 },
  { spreadsheetId: LEGACY_SPREADSHEET_ID, spreadsheetName: "legacy_4_sheet", sheetName: "الورقة3", gid: 635942262, priority: 1 },
  { spreadsheetId: LEGACY_SPREADSHEET_ID, spreadsheetName: "legacy_4_sheet", sheetName: "الورقة4", gid: 1210175544, priority: 1 },
] as const;

type SheetConfig = (typeof SHEETS)[number];
type CatalogSheetRow = GoogleSheetRow & {
  spreadsheetId: string;
  spreadsheetName: string;
  sheetName: string;
  gid: number;
  sheetUrl: string;
  priority: number;
  canonicalUrl: string;
  productSkuPrefix: string;
};

type ShopifyCatalogProduct = {
  id: string;
  title: string;
  handle: string;
  status: string;
  vendor: string;
  descriptionHtml: string;
  imageUrl: string | null;
  explicitSourceUrls: string[];
  variants: Array<{
    id: string;
    sku: string;
    price: number;
    inventoryQuantity: number;
    selectedOptions: Array<{ name: string; value: string }>;
  }>;
};

type SafeCandidate = {
  shopify: ShopifyCatalogProduct;
  row: CatalogSheetRow;
  matchingRows: CatalogSheetRow[];
  matchMethod: string;
  evidence: string[];
};

type SheetIndex = {
  rows: CatalogSheetRow[];
  byUrl: Map<string, CatalogSheetRow[]>;
  bySku: Map<string, CatalogSheetRow[]>;
  byPrefix: Map<string, CatalogSheetRow[]>;
  sheetErrors: Array<{ spreadsheetName: string; sheetName: string; gid: number; error: string }>;
  loadedAt: string;
};

type CatalogScan = {
  shopDomain: string;
  items: any[];
  safeCandidates: SafeCandidate[];
  counts: Record<string, number>;
  sheetIndex: SheetIndex;
  shopifyPagesRead: number;
  shopifyProductsRead: number;
  generatedAt: string;
};

let snapshotCache: { expiresAt: number; scan: CatalogScan } | null = null;
let sheetIndexCache: { expiresAt: number; index: SheetIndex } | null = null;
let scanPromise: Promise<CatalogScan> | null = null;
let reconcilePromise: Promise<void> | null = null;

function clean(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isShopifyThrottle(error: unknown) {
  return /throttl|rate limit|http 429/i.test(clean((error as any)?.message || error));
}

async function requestShopifyCatalogPage(client: any, query: string, after: string | null) {
  for (let attempt = 0; attempt <= SHOPIFY_THROTTLE_RETRIES; attempt += 1) {
    try {
      return await client.request(query, { after });
    } catch (error) {
      if (!isShopifyThrottle(error) || attempt === SHOPIFY_THROTTLE_RETRIES) throw error;
      await sleep(Math.min(8_000, 1_000 * 2 ** attempt));
    }
  }
  throw new Error("Shopify catalog request exhausted its retry budget");
}

function normalizeSku(value: unknown) {
  return clean(value).replace(/\s+/g, "").toUpperCase();
}

function parseJsonObject(value: unknown) {
  if (!value || typeof value !== "string") return {} as Record<string, any>;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {} as Record<string, any>;
  }
}

function sourceCurrency(url: string) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (host.endsWith(".ae") || host.includes("ae.hm.com") || /\/en-ae(?:\/|$)/.test(path)) return "AED";
    if (host.endsWith(".sa") || /\/en-sa(?:\/|$)/.test(path)) return "SAR";
    if (host.endsWith(".co.uk") || /\/en-gb(?:\/|$)/.test(path)) return "GBP";
    if (host.endsWith(".us")) return "USD";
  } catch {}
  return "UNKNOWN";
}

function supplierName(url: string, vendor?: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("next.")) return "Next";
    if (host.includes("hm.com")) return "H&M";
    if (host.includes("maxfashion")) return "Max";
    if (host.includes("centrepoint")) return "Centrepoint";
    if (host.includes("shein")) return "SHEIN";
    if (host.includes("lefties")) return "Lefties";
    if (host.includes("marksandspencer")) return "Marks & Spencer";
    return clean(vendor) || host.replace(/^www\./, "");
  } catch {
    return clean(vendor) || "Unknown Supplier";
  }
}

function supplierBaseUrl(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

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
  } catch {
    return clean(value).replace(/\/$/, "").toLowerCase();
  }
}

function canonicalDbUrl(value: unknown) {
  try {
    const parsed = new URL(clean(value));
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return clean(value).replace(/\/$/, "");
  }
}

function extractUrls(value: string) {
  return value.match(/https?:\/\/[^\s<>"']+/gi) || [];
}

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/gi, "/");
}

function productSkuPrefix(url: string) {
  try {
    return `DAB-${dabBrandCode(url)}-${dabProductCode(url)}-`.toUpperCase();
  } catch {
    return "";
  }
}

function possibleSkuPrefixes(sku: string) {
  const normalized = normalizeSku(sku);
  if (!normalized.startsWith("DAB-")) return [] as string[];
  const parts = normalized.split("-").filter(Boolean);
  const values: string[] = [];
  for (let end = 3; end <= Math.max(3, parts.length - 2); end += 1) {
    values.push(`${parts.slice(0, end).join("-")}-`);
  }
  return values;
}

function uniqueByUrl(rows: CatalogSheetRow[]) {
  const map = new Map<string, CatalogSheetRow[]>();
  for (const row of rows) {
    const group = map.get(row.canonicalUrl) || [];
    group.push(row);
    map.set(row.canonicalUrl, group);
  }
  return map;
}

function primaryRow(rows: CatalogSheetRow[], exactSkus: Set<string>) {
  return [...rows].sort((left, right) => {
    const leftExact = exactSkus.has(normalizeSku(left.sku)) ? 0 : 1;
    const rightExact = exactSkus.has(normalizeSku(right.sku)) ? 0 : 1;
    if (leftExact !== rightExact) return leftExact - rightExact;
    if (left.priority !== right.priority) return left.priority - right.priority;
    if (left.spreadsheetName !== right.spreadsheetName) return left.spreadsheetName.localeCompare(right.spreadsheetName);
    if (left.gid !== right.gid) return left.gid - right.gid;
    return left.rowNumber - right.rowNumber;
  })[0];
}

async function loadSheetIndex(force = false): Promise<SheetIndex> {
  if (!force && sheetIndexCache && sheetIndexCache.expiresAt > Date.now()) {
    return sheetIndexCache.index;
  }

  const rows: CatalogSheetRow[] = [];
  const sheetErrors: SheetIndex["sheetErrors"] = [];
  for (let offset = 0; offset < SHEETS.length; offset += 4) {
    const batch = SHEETS.slice(offset, offset + 4);
    const results = await Promise.all(
      batch.map(async (sheet) => {
        try {
          const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/edit?gid=${sheet.gid}`;
          const data = await loadGoogleSheetRows(sheetUrl);
          return { sheet, sheetUrl, rows: data.rows, error: null as string | null };
        } catch (error: any) {
          return {
            sheet,
            sheetUrl: `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/edit?gid=${sheet.gid}`,
            rows: [] as GoogleSheetRow[],
            error: clean(error?.message || error),
          };
        }
      }),
    );
    for (const result of results) {
      if (result.error) {
        sheetErrors.push({
          spreadsheetName: result.sheet.spreadsheetName,
          sheetName: result.sheet.sheetName,
          gid: result.sheet.gid,
          error: result.error,
        });
        continue;
      }
      for (const row of result.rows) {
        const url = canonicalUrl(row.url);
        if (!url) continue;
        rows.push({
          ...row,
          spreadsheetId: result.sheet.spreadsheetId,
          spreadsheetName: result.sheet.spreadsheetName,
          sheetName: result.sheet.sheetName,
          gid: result.sheet.gid,
          sheetUrl: result.sheetUrl,
          priority: result.sheet.priority,
          canonicalUrl: url,
          productSkuPrefix: productSkuPrefix(row.url),
        });
      }
    }
  }

  const byUrl = new Map<string, CatalogSheetRow[]>();
  const bySku = new Map<string, CatalogSheetRow[]>();
  const byPrefix = new Map<string, CatalogSheetRow[]>();
  for (const row of rows) {
    const urlRows = byUrl.get(row.canonicalUrl) || [];
    urlRows.push(row);
    byUrl.set(row.canonicalUrl, urlRows);

    const sku = normalizeSku(row.sku);
    if (sku) {
      const skuRows = bySku.get(sku) || [];
      skuRows.push(row);
      bySku.set(sku, skuRows);
    }

    if (row.productSkuPrefix) {
      const prefixRows = byPrefix.get(row.productSkuPrefix) || [];
      prefixRows.push(row);
      byPrefix.set(row.productSkuPrefix, prefixRows);
    }
  }

  const index = {
    rows,
    byUrl,
    bySku,
    byPrefix,
    sheetErrors,
    loadedAt: new Date().toISOString(),
  };
  sheetIndexCache = { expiresAt: Date.now() + SHEET_INDEX_TTL_MS, index };
  return index;
}

async function readShopifyCatalog() {
  const connection = await prisma.shopifyConnection.findFirst({
    where: { isConnected: true, accessTokenEnc: { not: null } },
    select: { shopDomain: true },
  });
  if (!connection?.shopDomain) throw new Error("No active Shopify connection is stored in the Sync Engine database");

  const client = await ShopifyService.getClientFromDb(prisma);
  const products: ShopifyCatalogProduct[] = [];
  let after: string | null = null;
  let pages = 0;
  let hasMore = true;

  while (hasMore && pages < MAX_SHOPIFY_PAGES) {
    const data: any = await requestShopifyCatalogPage(client, `
      query SyncEngineCatalogLink($after: String) {
        products(first: ${SHOPIFY_PRODUCTS_PER_PAGE}, after: $after, sortKey: ID) {
          nodes {
            id
            title
            handle
            status
            vendor
            descriptionHtml
            synclySource: metafield(namespace: "syncly", key: "source_url") { value }
            customSource: metafield(namespace: "custom", key: "source_url") { value }
            media(first: 1) {
              nodes {
                ... on MediaImage { image { url } }
              }
            }
            variants(first: ${SHOPIFY_VARIANTS_PER_PRODUCT}) {
              nodes {
                id
                sku
                price
                inventoryQuantity
                selectedOptions { name value }
              }
              pageInfo { hasNextPage }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `, after);

    const page = data?.products;
    for (const product of page?.nodes || []) {
      const values = [product.descriptionHtml, product.synclySource?.value, product.customSource?.value]
        .map((value) => decodeHtml(String(value || "")));
      const explicitSourceUrls = [...new Set(values.flatMap(extractUrls).map(canonicalUrl).filter(Boolean))];
      products.push({
        id: clean(product.id),
        title: clean(product.title),
        handle: clean(product.handle),
        status: clean(product.status).toUpperCase(),
        vendor: clean(product.vendor),
        descriptionHtml: String(product.descriptionHtml || ""),
        imageUrl: clean(product.media?.nodes?.[0]?.image?.url) || null,
        explicitSourceUrls,
        variants: (product.variants?.nodes || []).map((variant: any) => ({
          id: clean(variant.id),
          sku: clean(variant.sku),
          price: Number(variant.price || 0),
          inventoryQuantity: Number(variant.inventoryQuantity || 0),
          selectedOptions: Array.isArray(variant.selectedOptions) ? variant.selectedOptions : [],
        })),
        variantPaginationIncomplete: product.variants?.pageInfo?.hasNextPage === true,
      } as ShopifyCatalogProduct & { variantPaginationIncomplete: boolean });
    }

    pages += 1;
    hasMore = page?.pageInfo?.hasNextPage === true;
    if (!hasMore) break;
    after = clean(page.pageInfo.endCursor);
    if (!after) throw new Error("Shopify pagination returned hasNextPage without an endCursor");
    await sleep(SHOPIFY_PAGE_DELAY_MS);
  }

  if (hasMore) {
    throw new Error(
      `Shopify catalog exceeded the safe ${MAX_SHOPIFY_PAGES * SHOPIFY_PRODUCTS_PER_PAGE}-product scan limit`,
    );
  }

  return { shopDomain: connection.shopDomain, products, pages };
}

function dbImportMeta(sourceProduct: any) {
  const raw = parseJsonObject(sourceProduct?.raw);
  return raw.import && typeof raw.import === "object" ? raw.import : {};
}

function resolveCandidate(product: ShopifyCatalogProduct & { variantPaginationIncomplete?: boolean }, index: SheetIndex) {
  if (product.variantPaginationIncomplete) {
    return {
      status: "needs_review",
      reason: "Shopify product has more than 250 variants; automatic linking was blocked.",
      evidence: ["variant_set_incomplete"],
      matchingRows: [] as CatalogSheetRow[],
      row: null as CatalogSheetRow | null,
      matchMethod: "ambiguous",
    };
  }

  const shopifySkus = new Set(product.variants.map((variant) => normalizeSku(variant.sku)).filter(Boolean));
  const evidenceRows: Array<{ method: string; row: CatalogSheetRow }> = [];

  for (const explicitUrl of product.explicitSourceUrls) {
    for (const row of index.byUrl.get(explicitUrl) || []) {
      evidenceRows.push({ method: "source_url", row });
    }
  }

  for (const sku of shopifySkus) {
    for (const row of index.bySku.get(sku) || []) {
      evidenceRows.push({ method: "exact_sku", row });
    }
    for (const prefix of possibleSkuPrefixes(sku)) {
      for (const row of index.byPrefix.get(prefix) || []) {
        evidenceRows.push({ method: "dab_product_prefix", row });
      }
    }
  }

  const matchingRows = [...new Map(
    evidenceRows.map(({ row }) => [`${row.spreadsheetId}:${row.gid}:${row.rowNumber}`, row]),
  ).values()];
  const urls = uniqueByUrl(matchingRows);
  if (urls.size > 1) {
    return {
      status: "needs_review",
      reason: `Strong matching evidence points to ${urls.size} different source URLs.`,
      evidence: [...new Set(evidenceRows.map((entry) => entry.method))],
      matchingRows,
      row: null,
      matchMethod: "ambiguous",
    };
  }

  if (urls.size === 1) {
    const onlyRows = [...urls.values()][0];
    const row = primaryRow(onlyRows, shopifySkus);
    const methods = [...new Set(
      evidenceRows.filter((entry) => entry.row.canonicalUrl === row.canonicalUrl).map((entry) => entry.method),
    )];
    const matchMethod = methods.includes("source_url")
      ? "source_url"
      : methods.includes("exact_sku")
        ? "exact_sku"
        : "dab_product_prefix";
    return {
      status: "matched",
      reason: null,
      evidence: methods,
      matchingRows: onlyRows,
      row,
      matchMethod,
    };
  }

  const explicitSourceNotInSheets = product.explicitSourceUrls.length > 0;
  return {
    status: explicitSourceNotInSheets ? "needs_review" : "needs_link",
    reason: explicitSourceNotInSheets
      ? "Shopify contains a source URL, but that URL was not found in the connected sheets."
      : "No exact source URL or deterministic SKU match was found in the connected sheets.",
    evidence: explicitSourceNotInSheets ? ["source_url_not_in_sheets"] : [],
    matchingRows: [] as CatalogSheetRow[],
    row: null as CatalogSheetRow | null,
    matchMethod: explicitSourceNotInSheets ? "source_url_not_in_sheets" : "none",
  };
}

function rowView(row: CatalogSheetRow | null | undefined) {
  if (!row) return null;
  return {
    spreadsheetId: row.spreadsheetId,
    spreadsheetName: row.spreadsheetName,
    sheetName: row.sheetName,
    sheetId: row.gid,
    sheetRowNumber: row.rowNumber,
    sheetUrl: row.sheetUrl,
    sheetSku: clean(row.sku) || null,
    multiplier: row.priceMultiplier,
    collection: row.collection || null,
    sourceUrl: row.url,
  };
}

async function buildCatalogScan(force = false): Promise<CatalogScan> {
  const [sheetIndex, shopifyCatalog, dbLinks] = await Promise.all([
    loadSheetIndex(force),
    readShopifyCatalog(),
    prisma.shopifyProduct.findMany({
      select: {
        id: true,
        shopifyId: true,
        handle: true,
        status: true,
        price: true,
        syncEnabled: true,
        syncPrice: true,
        syncInventory: true,
        updatedAt: true,
        sourceProduct: {
          select: {
            id: true,
            url: true,
            title: true,
            currency: true,
            price: true,
            syncStatus: true,
            raw: true,
            updatedAt: true,
            supplier: { select: { name: true } },
            images: { select: { url: true }, orderBy: { position: "asc" }, take: 1 },
            variants: { select: { sku: true }, take: 250 },
          },
        },
      },
    }),
  ]);

  const dbByShopifyId = new Map(dbLinks.map((link) => [link.shopifyId, link]));
  const safeCandidates: SafeCandidate[] = [];
  const items = shopifyCatalog.products.map((product) => {
    const dbLink = dbByShopifyId.get(product.id);
    const shopifySkus = product.variants.map((variant) => normalizeSku(variant.sku)).filter(Boolean);
    const primarySku = shopifySkus.find((sku) => sku.startsWith("DAB-")) || shopifySkus[0] || null;

    if (dbLink) {
      const importMeta = dbImportMeta(dbLink.sourceProduct);
      const sourceRows = sheetIndex.byUrl.get(canonicalUrl(dbLink.sourceProduct.url)) || [];
      const fallbackRow = sourceRows.length
        ? primaryRow(sourceRows, new Set(shopifySkus))
        : null;
      const storedSheet = importMeta?.sheetName || importMeta?.excelRowNumber
        ? {
            spreadsheetId: importMeta.spreadsheetId || null,
            spreadsheetName:
              importMeta.spreadsheetId === BIG_SPREADSHEET_ID
                ? "dap_data"
                : importMeta.spreadsheetId === LEGACY_SPREADSHEET_ID
                  ? "legacy_4_sheet"
                  : null,
            sheetName: importMeta.sheetName || null,
            sheetId: Number.isFinite(Number(importMeta.sheetId)) ? Number(importMeta.sheetId) : null,
            sheetRowNumber: Number.isFinite(Number(importMeta.excelRowNumber)) ? Number(importMeta.excelRowNumber) : null,
            sheetUrl: importMeta.sheetUrl || null,
            sheetSku: primarySku,
            multiplier: Number.isFinite(Number(importMeta.sheetPriceMultiplier)) ? Number(importMeta.sheetPriceMultiplier) : null,
            collection: importMeta.sheetCollection || null,
            sourceUrl: dbLink.sourceProduct.url,
          }
        : rowView(fallbackRow);
      const active = dbLink.syncEnabled && dbLink.sourceProduct.syncStatus === "active";
      return {
        key: product.id,
        sourceProductId: dbLink.sourceProduct.id,
        title: product.title || dbLink.sourceProduct.title,
        vendor: product.vendor || dbLink.sourceProduct.supplier?.name,
        imageUrl: product.imageUrl || dbLink.sourceProduct.images?.[0]?.url || null,
        shopifyProductId: product.id,
        shopifyHandle: product.handle || dbLink.handle,
        shopifyStatus: product.status,
        shopifyPrice: product.variants[0]?.price ?? dbLink.price,
        shopifySku: primarySku,
        sourceUrl: dbLink.sourceProduct.url,
        sourceCurrency: dbLink.sourceProduct.currency,
        sourcePrice: dbLink.sourceProduct.price,
        syncStatus: dbLink.sourceProduct.syncStatus,
        syncEnabled: dbLink.syncEnabled,
        syncPrice: dbLink.syncPrice,
        syncInventory: dbLink.syncInventory,
        matchStatus: active ? "active" : "linked",
        matchMethod: importMeta.exactSkuBootstrap
          ? "exact_sku"
          : importMeta.exactSourceUrlBootstrap
            ? "source_url"
            : importMeta.catalogIndexMatchMethod || "database",
        evidence: ["database_link"],
        sheet: storedSheet,
        sheetMatchCount: sourceRows.length,
        reason: null,
        updatedAt: dbLink.sourceProduct.updatedAt,
      };
    }

    const candidate = resolveCandidate(product, sheetIndex);
    if (candidate.status === "matched" && candidate.row) {
      safeCandidates.push({
        shopify: product,
        row: candidate.row,
        matchingRows: candidate.matchingRows,
        matchMethod: candidate.matchMethod,
        evidence: candidate.evidence,
      });
    }
    return {
      key: product.id,
      sourceProductId: null,
      title: product.title,
      vendor: product.vendor,
      imageUrl: product.imageUrl,
      shopifyProductId: product.id,
      shopifyHandle: product.handle,
      shopifyStatus: product.status,
      shopifyPrice: product.variants[0]?.price ?? null,
      shopifySku: primarySku,
      sourceUrl: candidate.row?.url || product.explicitSourceUrls[0] || null,
      sourceCurrency: candidate.row ? sourceCurrency(candidate.row.url) : null,
      sourcePrice: null,
      syncStatus: candidate.status === "matched" ? "ready_to_link" : "unlinked",
      syncEnabled: false,
      syncPrice: false,
      syncInventory: false,
      matchStatus: candidate.status,
      matchMethod: candidate.matchMethod,
      evidence: candidate.evidence,
      sheet: rowView(candidate.row),
      sheetMatchCount: candidate.matchingRows.length,
      reason: candidate.reason,
      updatedAt: null,
    };
  });

  const counts = {
    shopifyTotal: items.length,
    linked: items.filter((item) => item.sourceProductId).length,
    activeSync: items.filter((item) => item.matchStatus === "active").length,
    matchedReady: items.filter((item) => item.matchStatus === "matched").length,
    needsLink: items.filter((item) => item.matchStatus === "needs_link").length,
    needsReview: items.filter((item) => item.matchStatus === "needs_review").length,
    pausedOrLinked: items.filter((item) => item.matchStatus === "linked").length,
    sheetRows: sheetIndex.rows.length,
    sheetErrors: sheetIndex.sheetErrors.length,
  };

  const scan = {
    shopDomain: shopifyCatalog.shopDomain,
    items,
    safeCandidates,
    counts,
    sheetIndex,
    shopifyPagesRead: shopifyCatalog.pages,
    shopifyProductsRead: shopifyCatalog.products.length,
    generatedAt: new Date().toISOString(),
  };
  snapshotCache = { expiresAt: Date.now() + SNAPSHOT_TTL_MS, scan };
  return scan;
}

async function scanCatalog(force = false): Promise<CatalogScan> {
  if (!force && snapshotCache && snapshotCache.expiresAt > Date.now()) {
    return snapshotCache.scan;
  }
  if (scanPromise) return scanPromise;

  const staleScan = snapshotCache?.scan || null;
  scanPromise = buildCatalogScan(force);
  try {
    return await scanPromise;
  } catch (error) {
    if (staleScan) {
      console.warn("Shopify catalog refresh failed; serving the last successful snapshot", {
        error: clean((error as any)?.message || error),
        generatedAt: staleScan.generatedAt,
      });
      return staleScan;
    }
    throw error;
  } finally {
    scanPromise = null;
  }
}

function optionMap(selectedOptions: Array<{ name: string; value: string }>) {
  return Object.fromEntries(
    (selectedOptions || [])
      .map((option) => [clean(option.name), clean(option.value)])
      .filter(([name, value]) => Boolean(name && value)),
  );
}

function optionValue(values: Record<string, string>, pattern: RegExp) {
  return Object.entries(values).find(([name]) => pattern.test(name))?.[1] || null;
}

async function persistCatalogLink(candidate: SafeCandidate) {
  const row = candidate.row;
  const product = candidate.shopify;
  const dbUrl = canonicalDbUrl(row.url);
  const multiplier = Number(row.priceMultiplier || 0);
  const hasMultiplier = Number.isFinite(multiplier) && multiplier > 0;
  const currency = sourceCurrency(row.url);
  const firstShopifyPrice = Number(product.variants[0]?.price || 0);
  const estimatedSourcePrice = hasMultiplier && firstShopifyPrice > 0
    ? Number((firstShopifyPrice / multiplier).toFixed(4))
    : firstShopifyPrice;

  return prisma.$transaction(async (tx) => {
    const [existingShopify, existingSourceByExact, existingSourceByCanonical] = await Promise.all([
      tx.shopifyProduct.findUnique({
        where: { shopifyId: product.id },
        select: { id: true, sourceProductId: true },
      }),
      tx.sourceProduct.findUnique({
        where: { url: row.url },
        include: {
          shopifyProduct: { select: { id: true, shopifyId: true } },
          variants: { include: { shopifyVariant: true } },
        },
      }),
      row.url === dbUrl
        ? Promise.resolve(null)
        : tx.sourceProduct.findUnique({
            where: { url: dbUrl },
            include: {
              shopifyProduct: { select: { id: true, shopifyId: true } },
              variants: { include: { shopifyVariant: true } },
            },
          }),
    ]);
    const existingSource = existingSourceByExact || existingSourceByCanonical;

    if (existingShopify) {
      if (existingShopify.sourceProductId === existingSource?.id) {
        return { status: "already_linked", sourceProductId: existingShopify.sourceProductId };
      }
      throw new Error("Shopify product is already linked to a different source product");
    }
    if (existingSource?.shopifyProduct && existingSource.shopifyProduct.shopifyId !== product.id) {
      throw new Error("Source URL is already linked to a different Shopify product");
    }

    const supplierLabel = supplierName(row.url, product.vendor);
    const supplier = await tx.supplier.upsert({
      where: { name: supplierLabel },
      update: {},
      create: { name: supplierLabel, baseUrl: supplierBaseUrl(row.url) },
    });

    const previousRaw = parseJsonObject(existingSource?.raw);
    const importMeta = {
      ...(previousRaw.import && typeof previousRaw.import === "object" ? previousRaw.import : {}),
      spreadsheetId: row.spreadsheetId,
      sheetUrl: row.sheetUrl,
      sheetName: row.sheetName,
      sheetId: row.gid,
      excelRowNumber: row.rowNumber,
      sheetCollection: clean(row.collection),
      sheetPriceMultiplier: row.priceMultiplier,
      linkedExistingOnly: true,
      catalogIndexBootstrap: true,
      catalogIndexMatchMethod: candidate.matchMethod,
      catalogIndexEvidence: candidate.evidence,
      catalogIndexSheetMatches: candidate.matchingRows.length,
      linkedAt: new Date().toISOString(),
    };
    const mergedRaw = JSON.stringify({
      ...previousRaw,
      import: importMeta,
      bootstrap: {
        ...(previousRaw.bootstrap && typeof previousRaw.bootstrap === "object" ? previousRaw.bootstrap : {}),
        shopifyProductId: product.id,
        sourcePricePendingRefresh: true,
        scraperApiCreditsUsedForLinking: 0,
      },
    });

    const sourceProduct = existingSource
      ? await tx.sourceProduct.update({
          where: { id: existingSource.id },
          data: {
            supplierId: existingSource.supplierId || supplier.id,
            syncStatus: "active",
            raw: mergedRaw,
          },
        })
      : await tx.sourceProduct.create({
          data: {
            supplierId: supplier.id,
            url: dbUrl,
            productId: null,
            title: product.title,
            description: null,
            brand: product.vendor || supplierLabel,
            currency,
            price: estimatedSourcePrice,
            syncStatus: "active",
            lastScrapedAt: new Date(0),
            raw: mergedRaw,
          },
        });

    await tx.manualReviewItem.deleteMany({
      where: { sourceProductId: sourceProduct.id, status: "pending" },
    });

    if (!existingSource && product.imageUrl) {
      await tx.sourceImage.create({
        data: {
          sourceProductId: sourceProduct.id,
          url: product.imageUrl,
          alt: product.title,
          position: 0,
        },
      });
    }

    const shopifyProduct = await tx.shopifyProduct.create({
      data: {
        sourceProductId: sourceProduct.id,
        shopifyId: product.id,
        handle: product.handle || null,
        status: product.status.toLowerCase(),
        collectionIds: row.collection || null,
        price: firstShopifyPrice || null,
        syncEnabled: true,
        syncPrice: hasMultiplier,
        syncInventory: true,
        syncImages: false,
      },
    });

    const sourceVariants = existingSource?.variants || [];
    for (const variant of product.variants) {
      const sku = normalizeSku(variant.sku);
      const exactSourceVariants = sourceVariants.filter(
        (sourceVariant) => sku && normalizeSku(sourceVariant.sku) === sku && !sourceVariant.shopifyVariant,
      );
      let sourceVariant = exactSourceVariants.length === 1 ? exactSourceVariants[0] : null;
      const values = optionMap(variant.selectedOptions);
      if (!sourceVariant) {
        sourceVariant = await tx.sourceVariant.create({
          data: {
            sourceProductId: sourceProduct.id,
            sourceVariantId: `shopify-catalog-bootstrap-${String(variant.id).split("/").pop()}`,
            sku: variant.sku || null,
            color: optionValue(values, /colou?r/i),
            size: optionValue(values, /size|age|shoe/i),
            price: hasMultiplier && variant.price > 0
              ? Number((variant.price / multiplier).toFixed(4))
              : variant.price,
            currency,
            available: variant.inventoryQuantity > 0,
            stockStatus: variant.inventoryQuantity > 0 ? "in_stock" : "out_of_stock",
            imageUrl: product.imageUrl,
            raw: JSON.stringify({
              optionValues: values,
              catalogIndexBootstrap: true,
              sourcePricePendingRefresh: true,
            }),
          },
        });
      }

      await tx.shopifyVariant.create({
        data: {
          shopifyProductId: shopifyProduct.id,
          sourceVariantId: sourceVariant.id,
          shopifyId: variant.id,
          sku: variant.sku || null,
          price: variant.price,
        },
      });
    }

    await tx.auditLog.create({
      data: {
        sourceProductId: sourceProduct.id,
        action: "LINK_EXISTING_SHOPIFY_CATALOG_INDEX_EXACT",
        details: JSON.stringify({
          shopifyProductId: product.id,
          sourceUrl: row.url,
          spreadsheetId: row.spreadsheetId,
          sheetName: row.sheetName,
          sheetId: row.gid,
          rowNumber: row.rowNumber,
          sheetSku: clean(row.sku) || null,
          multiplier: row.priceMultiplier,
          matchMethod: candidate.matchMethod,
          evidence: candidate.evidence,
          sheetMatches: candidate.matchingRows.length,
          variantsLinked: product.variants.length,
          shopifyMutations: 0,
          scraperApiCreditsUsed: 0,
        }),
      },
    });

    return { status: "linked", sourceProductId: sourceProduct.id };
  }, { maxWait: 15_000, timeout: 45_000 });
}

async function runReconcile(jobId: string) {
  await prisma.syncJob.update({
    where: { id: jobId },
    data: { status: "running", startedAt: new Date() },
  });

  const progress = {
    shopifyProducts: 0,
    exactCandidates: 0,
    linked: 0,
    alreadyLinked: 0,
    failed: 0,
    failures: [] as Array<{ shopifyProductId: string; title: string; error: string }>,
    scraperApiCreditsUsed: 0,
    shopifyMutations: 0,
    googleSheetWrites: 0,
  };

  try {
    const scan = await scanCatalog(true);
    progress.shopifyProducts = scan.counts.shopifyTotal;
    progress.exactCandidates = scan.safeCandidates.length;

    for (const [index, candidate] of scan.safeCandidates.entries()) {
      try {
        const result = await persistCatalogLink(candidate);
        if (result.status === "already_linked") progress.alreadyLinked += 1;
        else progress.linked += 1;
      } catch (error: any) {
        progress.failed += 1;
        progress.failures.push({
          shopifyProductId: candidate.shopify.id,
          title: candidate.shopify.title,
          error: clean(error?.message || error).slice(0, 1000),
        });
      }

      if ((index + 1) % 25 === 0 || index + 1 === scan.safeCandidates.length) {
        await prisma.syncJob.update({
          where: { id: jobId },
          data: {
            result: JSON.stringify({
              ...progress,
              processed: index + 1,
              status: "running",
              failures: progress.failures.slice(-50),
            }),
          },
        });
      }
    }

    snapshotCache = null;
    const finalScan = await scanCatalog(true);
    await prisma.syncJob.update({
      where: { id: jobId },
      data: {
        status: progress.failed ? "completed" : "completed",
        completedAt: new Date(),
        result: JSON.stringify({
          ...progress,
          status: "completed",
          finalCounts: finalScan.counts,
          failures: progress.failures.slice(-100),
        }),
      },
    });
  } catch (error: any) {
    await prisma.syncJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        completedAt: new Date(),
        result: JSON.stringify({
          ...progress,
          status: "failed",
          error: clean(error?.message || error),
          failures: progress.failures.slice(-100),
        }),
      },
    });
  } finally {
    reconcilePromise = null;
  }
}

function parseJobResult(value: string | null) {
  return parseJsonObject(value);
}

router.get("/shopify-catalog/link-state", async (req, res) => {
  try {
    const force = String(req.query.refresh || "").toLowerCase() === "true";
    const limit = Math.max(1, Math.min(250, Number(req.query.limit || 200) || 200));
    const offset = Math.max(0, Number(req.query.offset || 0) || 0);
    const search = clean(req.query.search).toLowerCase();
    const status = clean(req.query.status).toLowerCase();
    const scan = await scanCatalog(force);
    const latestJob = await prisma.syncJob.findFirst({
      where: { type: RECONCILE_JOB_TYPE },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, result: true, createdAt: true, startedAt: true, completedAt: true },
    });

    let filtered = scan.items;
    if (search) {
      filtered = filtered.filter((item) =>
        [
          item.title,
          item.vendor,
          item.shopifyProductId,
          item.shopifySku,
          item.sourceUrl,
          item.sheet?.sheetName,
          item.sheet?.spreadsheetName,
        ].some((value) => String(value || "").toLowerCase().includes(search)),
      );
    }
    if (status && status !== "all") {
      filtered = filtered.filter((item) => {
        if (status === "linked") return Boolean(item.sourceProductId);
        if (status === "active") return item.matchStatus === "active";
        if (status === "matched") return item.matchStatus === "matched";
        if (status === "needs_link") return item.matchStatus === "needs_link";
        if (status === "needs_review") return item.matchStatus === "needs_review";
        if (status === "paused") return item.matchStatus === "linked";
        return item.matchStatus === status;
      });
    }

    return res.json({
      success: true,
      sourceOfTruth: "shopify_database_connection",
      shopDomain: scan.shopDomain,
      counts: scan.counts,
      filteredTotal: filtered.length,
      offset,
      limit,
      hasMore: offset + limit < filtered.length,
      items: filtered.slice(offset, offset + limit),
      latestJob: latestJob
        ? { ...latestJob, result: parseJobResult(latestJob.result) }
        : null,
      scan: {
        generatedAt: scan.generatedAt,
        shopifyPagesRead: scan.shopifyPagesRead,
        shopifyProductsRead: scan.shopifyProductsRead,
        sheetRowsRead: scan.sheetIndex.rows.length,
        sheetsConfigured: SHEETS.length,
        sheetErrors: scan.sheetIndex.sheetErrors,
        scraperApiCreditsUsed: 0,
      },
    });
  } catch (error: any) {
    console.error("Shopify catalog link-state failed", error);
    const throttled = isShopifyThrottle(error);
    if (throttled) res.setHeader("Retry-After", "30");
    return res.status(throttled ? 503 : 500).json({
      success: false,
      code: "SHOPIFY_CATALOG_LINK_STATE_FAILED",
      error: clean(error?.message || error),
    });
  }
});

router.post("/shopify-catalog/reconcile", async (req, res) => {
  try {
    if (clean(req.body?.confirm) !== RECONCILE_CONFIRMATION) {
      return res.status(428).json({
        success: false,
        code: "SHOPIFY_CATALOG_RECONCILE_CONFIRMATION_REQUIRED",
        error: `Send confirm=${RECONCILE_CONFIRMATION}.`,
      });
    }

    const runningJob = await prisma.syncJob.findFirst({
      where: { type: RECONCILE_JOB_TYPE, status: { in: ["pending", "running"] } },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true },
    });
    if (runningJob || reconcilePromise) {
      return res.status(202).json({
        success: true,
        alreadyRunning: true,
        jobId: runningJob?.id || null,
        status: runningJob?.status || "running",
      });
    }

    const job = await prisma.syncJob.create({
      data: {
        type: RECONCILE_JOB_TYPE,
        status: "pending",
        payload: JSON.stringify({
          sourceOfTruth: "shopify_database_connection",
          exactOnly: true,
          shopifyMutations: 0,
          googleSheetWrites: 0,
          scraperApiCreditsUsed: 0,
          requestedAt: new Date().toISOString(),
        }),
      },
    });

    reconcilePromise = runReconcile(job.id);
    return res.status(202).json({
      success: true,
      jobId: job.id,
      status: "pending",
      exactOnly: true,
      shopifyMutations: 0,
      googleSheetWrites: 0,
      scraperApiCreditsUsed: 0,
    });
  } catch (error: any) {
    console.error("Shopify catalog reconcile start failed", error);
    return res.status(500).json({
      success: false,
      code: "SHOPIFY_CATALOG_RECONCILE_FAILED",
      error: clean(error?.message || error),
    });
  }
});

export default router;
