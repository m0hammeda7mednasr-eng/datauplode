import { Router } from "express";
import { prisma } from "../db.js";
import { ShopifyService } from "../services/shopify.js";
import { dabBrandCode, dabProductCode } from "../services/dabSku.js";
import { loadGoogleSheetRows, type GoogleSheetRow } from "../api.js";

const router = Router();

const BIG_SPREADSHEET_ID = "1fCbPajWL3nukX0TdoN1m2X8LV3pfPsxSMLBb0yWug2w";
const LEGACY_SPREADSHEET_ID = "13JSw5k_wX8RAd98P-TWLT-938ImshAtrukjjA4n-lkI";
const RECONCILE_JOB_TYPE = "SHOPIFY_CATALOG_LINK_RECONCILE:2026-09-04-v2";
const REFRESH_JOB_TYPE = "SHOPIFY_CATALOG_INDEX_REFRESH:2026-09-04-v2";
const RECONCILE_CONFIRMATION = "LINK_EXACT_SHOPIFY_CATALOG";
const CACHE_TABLE = "ShopifyCatalogIndexV2";
const PAGE_SIZE = 50;
const VARIANT_SAMPLE_SIZE = 10;
const MAX_SHOPIFY_PAGES = 2000;
const STALE_CATALOG_JOB_MS = 5 * 60 * 1000;
const SHEET_INDEX_TTL_MS = 10 * 60 * 1000;

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

type SheetIndex = {
  rows: CatalogSheetRow[];
  byUrl: Map<string, CatalogSheetRow[]>;
  bySku: Map<string, CatalogSheetRow[]>;
  byPrefix: Map<string, CatalogSheetRow[]>;
  bySourceIdentifier: Map<string, CatalogSheetRow[]>;
  bySourceUrlTitle: Map<string, CatalogSheetRow[]>;
  errors: Array<{ spreadsheetName: string; sheetName: string; error: string }>;
};

type ShopifyCatalogProduct = {
  id: string;
  title: string;
  handle: string;
  status: string;
  vendor: string;
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

type CandidateResult = {
  status: "matched" | "needs_review" | "needs_link";
  row: CatalogSheetRow | null;
  matchingRows: CatalogSheetRow[];
  matchMethod: string;
  reason: string | null;
  evidence: string[];
};

let sheetIndexCache: { expiresAt: number; value: SheetIndex } | null = null;
let cacheInitPromise: Promise<void> | null = null;
let refreshPromise: Promise<void> | null = null;
let reconcilePromise: Promise<void> | null = null;
let autoRefreshStarted = false;

function clean(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeSku(value: unknown) {
  return clean(value).replace(/\s+/g, "").toUpperCase();
}

function parseJson(value: unknown) {
  if (!value || typeof value !== "string") return {} as Record<string, any>;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {} as Record<string, any>;
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
  try { return new URL(url).origin; } catch { return url; }
}

function productSkuPrefix(url: string) {
  try { return `DAB-${dabBrandCode(url)}-${dabProductCode(url)}-`.toUpperCase(); }
  catch { return ""; }
}

function possibleSkuPrefixes(sku: string) {
  const normalized = normalizeSku(sku);
  if (!normalized.startsWith("DAB-")) return [] as string[];
  const parts = normalized.split("-").filter(Boolean);
  const out: string[] = [];
  for (let end = 3; end <= Math.max(3, parts.length - 2); end += 1) {
    out.push(`${parts.slice(0, end).join("-")}-`);
  }
  return out;
}

function compactIdentifier(value: unknown) {
  return clean(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizedProductTitle(value: unknown) {
  return clean(value)
    .replace(/&amp;/gi, " and ")
    .replace(/&#(?:189|xbd);/gi, " half ")
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function sourceTitleFromUrl(value: string) {
  try {
    const parsed = new URL(value);
    const segments = parsed.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
    const productMarker = segments.findIndex((segment) => segment.toLowerCase() === "p");
    const candidate = productMarker > 0 ? segments[productMarker - 1] : "";
    if (!candidate || !/[a-z]/i.test(candidate) || !candidate.includes("-")) return "";
    return normalizedProductTitle(candidate.replace(/^buy-/i, ""));
  } catch {
    return "";
  }
}

function sourceIdentifiersFromUrl(value: string) {
  const identifiers = new Set<string>();
  try {
    const parsed = new URL(value);
    const pathMatches = [
      parsed.pathname.match(/\/style\/[^/]+\/([^/?#]+)/i)?.[1],
      parsed.pathname.match(/productpage[.\/-]?(\d{7,15})/i)?.[1],
      parsed.pathname.match(/-p-(\d+)\.html/i)?.[1],
      parsed.pathname.match(/\/p\/([^/?#]+)/i)?.[1],
    ];
    const queryMatches = [
      parsed.searchParams.get("v1"),
      parsed.searchParams.get("pid"),
      parsed.searchParams.get("productId"),
      parsed.searchParams.get("product_id"),
    ];
    for (const candidate of [...pathMatches, ...queryMatches]) {
      const identifier = compactIdentifier(candidate);
      if (identifier.length >= 5 && identifier.length <= 64 && /\d/.test(identifier)) {
        identifiers.add(identifier);
      }
    }
  } catch {}
  return [...identifiers];
}

function sourceIdentifiersFromSku(value: unknown, vendor: unknown) {
  const raw = clean(value).toUpperCase();
  const compact = compactIdentifier(raw.replace(/-OPTION.*$/i, ""));
  const normalizedVendor = compactIdentifier(vendor);
  const identifiers = new Set<string>();
  if (compact.length >= 5 && compact.length <= 64 && /\d/.test(compact)) identifiers.add(compact);
  if (normalizedVendor === "NEXT") {
    const next = compact.match(/^([A-Z]\d{5})/)?.[1];
    if (next) identifiers.add(next);
  }
  if (normalizedVendor === "HM") {
    const hm = compact.match(/^(\d{10})/)?.[1];
    if (hm) identifiers.add(hm);
  }
  if (normalizedVendor === "MOTHERCARE") {
    const mothercare = compactIdentifier(raw.replace(/^M[-_]?/i, "")).match(/^([A-Z]{2}\d{3})/)?.[1];
    if (mothercare) identifiers.add(mothercare);
  }
  return [...identifiers];
}

function extractUrls(value: string) {
  return value.match(/https?:\/\/[^\s<>"']+/gi) || [];
}

function decodeHtml(value: string) {
  return value.replace(/&amp;/gi, "&").replace(/&#x2F;/gi, "/").replace(/&#47;/gi, "/");
}

async function ensureCacheTable() {
  if (cacheInitPromise) return cacheInitPromise;
  cacheInitPromise = (async () => {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "${CACHE_TABLE}" (
        "shopifyId" TEXT PRIMARY KEY,
        "title" TEXT NOT NULL DEFAULT '',
        "handle" TEXT,
        "status" TEXT,
        "vendor" TEXT,
        "imageUrl" TEXT,
        "primarySku" TEXT,
        "price" DOUBLE PRECISION,
        "inventoryQuantity" INTEGER,
        "explicitSourceUrls" TEXT,
        "matchStatus" TEXT NOT NULL DEFAULT 'needs_link',
        "matchMethod" TEXT,
        "matchedSourceUrl" TEXT,
        "sheetSpreadsheetId" TEXT,
        "sheetSpreadsheetName" TEXT,
        "sheetName" TEXT,
        "sheetGid" INTEGER,
        "sheetRowNumber" INTEGER,
        "sheetSku" TEXT,
        "sheetMultiplier" DOUBLE PRECISION,
        "reason" TEXT,
        "evidence" TEXT,
        "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "${CACHE_TABLE}_status_idx" ON "${CACHE_TABLE}" ("matchStatus")`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "${CACHE_TABLE}_sku_idx" ON "${CACHE_TABLE}" ("primarySku")`);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "${CACHE_TABLE}" (
        "shopifyId", "title", "handle", "status", "vendor", "imageUrl", "primarySku",
        "price", "matchStatus", "matchMethod", "matchedSourceUrl", "reason", "evidence", "lastSeenAt", "updatedAt"
      )
      SELECT
        sp."shopifyId",
        s."title",
        sp."handle",
        sp."status",
        COALESCE(s."brand", sup."name", ''),
        (SELECT si."url" FROM "SourceImage" si WHERE si."sourceProductId" = s."id" ORDER BY si."position" ASC LIMIT 1),
        (SELECT sv."sku" FROM "SourceVariant" sv WHERE sv."sourceProductId" = s."id" AND sv."sku" IS NOT NULL LIMIT 1),
        sp."price",
        CASE WHEN sp."syncEnabled" = TRUE AND s."syncStatus" = 'active' THEN 'active' ELSE 'linked' END,
        'database',
        s."url",
        NULL,
        '["database"]',
        NOW(),
        NOW()
      FROM "ShopifyProduct" sp
      JOIN "SourceProduct" s ON s."id" = sp."sourceProductId"
      LEFT JOIN "Supplier" sup ON sup."id" = s."supplierId"
      WHERE NOT EXISTS (SELECT 1 FROM "${CACHE_TABLE}" LIMIT 1)
      ON CONFLICT ("shopifyId") DO UPDATE SET
        "title" = EXCLUDED."title",
        "handle" = EXCLUDED."handle",
        "status" = EXCLUDED."status",
        "vendor" = EXCLUDED."vendor",
        "imageUrl" = COALESCE(EXCLUDED."imageUrl", "${CACHE_TABLE}"."imageUrl"),
        "primarySku" = COALESCE(EXCLUDED."primarySku", "${CACHE_TABLE}"."primarySku"),
        "price" = COALESCE(EXCLUDED."price", "${CACHE_TABLE}"."price"),
        "matchStatus" = EXCLUDED."matchStatus",
        "matchMethod" = 'database',
        "matchedSourceUrl" = EXCLUDED."matchedSourceUrl",
        "reason" = NULL,
        "evidence" = '["database"]',
        "updatedAt" = NOW()
    `);
  })().catch((error) => {
    cacheInitPromise = null;
    throw error;
  });
  return cacheInitPromise;
}

async function loadSheetIndex(force = false): Promise<SheetIndex> {
  if (!force && sheetIndexCache && sheetIndexCache.expiresAt > Date.now()) return sheetIndexCache.value;
  const rows: CatalogSheetRow[] = [];
  const errors: SheetIndex["errors"] = [];
  for (let offset = 0; offset < SHEETS.length; offset += 4) {
    const batch = SHEETS.slice(offset, offset + 4);
    const results = await Promise.all(batch.map(async (sheet) => {
      const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/edit?gid=${sheet.gid}`;
      try {
        const data = await loadGoogleSheetRows(sheetUrl);
        return { sheet, sheetUrl, rows: data.rows, error: null as string | null };
      } catch (error: any) {
        return { sheet, sheetUrl, rows: [] as GoogleSheetRow[], error: clean(error?.message || error) };
      }
    }));
    for (const result of results) {
      if (result.error) {
        errors.push({ spreadsheetName: result.sheet.spreadsheetName, sheetName: result.sheet.sheetName, error: result.error });
        continue;
      }
      for (const row of result.rows) {
        if (!clean(row.url)) continue;
        rows.push({
          ...row,
          spreadsheetId: result.sheet.spreadsheetId,
          spreadsheetName: result.sheet.spreadsheetName,
          sheetName: result.sheet.sheetName,
          gid: result.sheet.gid,
          sheetUrl: result.sheetUrl,
          priority: result.sheet.priority,
          canonicalUrl: canonicalUrl(row.url),
          productSkuPrefix: productSkuPrefix(row.url),
        });
      }
    }
  }
  const byUrl = new Map<string, CatalogSheetRow[]>();
  const bySku = new Map<string, CatalogSheetRow[]>();
  const byPrefix = new Map<string, CatalogSheetRow[]>();
  const bySourceIdentifier = new Map<string, CatalogSheetRow[]>();
  const bySourceUrlTitle = new Map<string, CatalogSheetRow[]>();
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
    for (const identifier of sourceIdentifiersFromUrl(row.url)) {
      const identifierRows = bySourceIdentifier.get(identifier) || [];
      identifierRows.push(row);
      bySourceIdentifier.set(identifier, identifierRows);
    }
    const sourceUrlTitle = sourceTitleFromUrl(row.url);
    if (sourceUrlTitle) {
      const titleRows = bySourceUrlTitle.get(sourceUrlTitle) || [];
      titleRows.push(row);
      bySourceUrlTitle.set(sourceUrlTitle, titleRows);
    }
  }
  const value = { rows, byUrl, bySku, byPrefix, bySourceIdentifier, bySourceUrlTitle, errors };
  sheetIndexCache = { expiresAt: Date.now() + SHEET_INDEX_TTL_MS, value };
  return value;
}

function resolveCandidate(product: ShopifyCatalogProduct, index: SheetIndex): CandidateResult {
  const skuSet = new Set(product.variants.map((variant) => normalizeSku(variant.sku)).filter(Boolean));
  const evidence: Array<{ method: string; row: CatalogSheetRow }> = [];
  for (const sourceUrl of product.explicitSourceUrls) {
    for (const row of index.byUrl.get(sourceUrl) || []) evidence.push({ method: "source_url", row });
  }
  for (const sku of skuSet) {
    for (const row of index.bySku.get(sku) || []) evidence.push({ method: "exact_sku", row });
    for (const prefix of possibleSkuPrefixes(sku)) {
      for (const row of index.byPrefix.get(prefix) || []) evidence.push({ method: "dab_product_prefix", row });
    }
    for (const identifier of sourceIdentifiersFromSku(sku, product.vendor)) {
      for (const row of index.bySourceIdentifier.get(identifier) || []) {
        evidence.push({ method: "source_product_identifier", row });
      }
    }
  }
  const exactUrlTitle = normalizedProductTitle(product.title);
  if (evidence.length === 0 && exactUrlTitle) {
    for (const row of index.bySourceUrlTitle.get(exactUrlTitle) || []) {
      evidence.push({ method: "source_url_title", row });
    }
  }
  const byCanonical = new Map<string, CatalogSheetRow[]>();
  for (const entry of evidence) {
    const group = byCanonical.get(entry.row.canonicalUrl) || [];
    group.push(entry.row);
    byCanonical.set(entry.row.canonicalUrl, group);
  }
  if (byCanonical.size === 1) {
    const canonical = [...byCanonical.keys()][0];
    const rows = byCanonical.get(canonical) || [];
    const row = [...rows].sort((a, b) => {
      const aExact = skuSet.has(normalizeSku(a.sku)) ? 0 : 1;
      const bExact = skuSet.has(normalizeSku(b.sku)) ? 0 : 1;
      return aExact - bExact || a.priority - b.priority || a.rowNumber - b.rowNumber;
    })[0];
    const methods = [...new Set(evidence.filter((entry) => entry.row.canonicalUrl === canonical).map((entry) => entry.method))];
    return {
      status: "matched",
      row,
      matchingRows: rows,
      matchMethod: methods.includes("source_url")
        ? "source_url"
        : methods.includes("exact_sku")
          ? "exact_sku"
          : methods.includes("dab_product_prefix")
            ? "dab_product_prefix"
            : methods.includes("source_product_identifier")
              ? "source_product_identifier"
              : "source_url_title",
      reason: null,
      evidence: methods,
    };
  }
  if (byCanonical.size > 1) {
    return {
      status: "needs_review",
      row: null,
      matchingRows: [...byCanonical.values()].flat(),
      matchMethod: "ambiguous",
      reason: "Multiple different source URLs matched this Shopify product. No automatic link was written.",
      evidence: [...new Set(evidence.map((entry) => entry.method))],
    };
  }
  if (product.explicitSourceUrls.length > 0) {
    return {
      status: "needs_review",
      row: null,
      matchingRows: [],
      matchMethod: "source_url_not_in_sheets",
      reason: "Shopify contains a source URL, but it was not found in the connected sheets.",
      evidence: ["shopify_source_url"],
    };
  }
  return {
    status: "needs_link",
    row: null,
    matchingRows: [],
    matchMethod: "none",
    reason: "No exact source URL or deterministic SKU match was found in the connected sheets.",
    evidence: [],
  };
}

async function shopifyRequestWithBackoff(client: any, query: string, variables: any) {
  const maxAttempts = 9;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await client.request(query, variables);
    } catch (error: any) {
      const message = clean(error?.message || error);
      const throttled = /throttled|rate limit|429/i.test(message);
      const transient = throttled || /502|503|504|timeout|socket hang up|ECONNRESET/i.test(message);
      if (!transient || attempt >= maxAttempts) throw error;
      const waitMs = Math.min(20_000, 1000 * (2 ** Math.min(attempt - 1, 4)));
      console.warn(`[shopify-catalog] ${message}; retrying in ${waitMs}ms (${attempt}/${maxAttempts})`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw new Error("Shopify request retries exhausted");
}

async function readShopifyPage(client: any, after: string | null) {
  const data: any = await shopifyRequestWithBackoff(client, `
    query SyncEngineCatalogIndex($after: String) {
        products(first: ${PAGE_SIZE}, after: $after, sortKey: ID, query: "status:active") {
        nodes {
          id title handle status vendor descriptionHtml
          synclySource: metafield(namespace: "syncly", key: "source_url") { value }
          customSource: metafield(namespace: "custom", key: "source_url") { value }
          media(first: 1) { nodes { ... on MediaImage { image { url } } } }
          variants(first: ${VARIANT_SAMPLE_SIZE}) {
            nodes { id sku price inventoryQuantity selectedOptions { name value } }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `, { after });
  const page = data?.products;
  const products: ShopifyCatalogProduct[] = (page?.nodes || []).map((product: any) => {
    const sourceValues = [product.descriptionHtml, product.synclySource?.value, product.customSource?.value]
      .map((value) => decodeHtml(String(value || "")));
    return {
      id: clean(product.id),
      title: clean(product.title),
      handle: clean(product.handle),
      status: clean(product.status).toUpperCase(),
      vendor: clean(product.vendor),
      imageUrl: clean(product.media?.nodes?.[0]?.image?.url) || null,
      explicitSourceUrls: [...new Set(sourceValues.flatMap(extractUrls).map(canonicalUrl).filter(Boolean))],
      variants: (product.variants?.nodes || []).map((variant: any) => ({
        id: clean(variant.id),
        sku: clean(variant.sku),
        price: Number(variant.price || 0),
        inventoryQuantity: Number(variant.inventoryQuantity || 0),
        selectedOptions: Array.isArray(variant.selectedOptions) ? variant.selectedOptions : [],
      })),
    };
  });
  return {
    products,
    hasNextPage: page?.pageInfo?.hasNextPage === true,
    endCursor: clean(page?.pageInfo?.endCursor) || null,
  };
}

async function upsertCatalogIndex(product: ShopifyCatalogProduct, candidate: CandidateResult, forcedStatus?: string, forcedUrl?: string | null) {
  const primarySku = product.variants.map((v) => normalizeSku(v.sku)).find((sku) => sku.startsWith("DAB-"))
    || product.variants.map((v) => normalizeSku(v.sku)).find(Boolean)
    || null;
  const row = candidate.row;
  await prisma.$executeRawUnsafe(`
    INSERT INTO "${CACHE_TABLE}" (
      "shopifyId", "title", "handle", "status", "vendor", "imageUrl", "primarySku", "price", "inventoryQuantity",
      "explicitSourceUrls", "matchStatus", "matchMethod", "matchedSourceUrl", "sheetSpreadsheetId", "sheetSpreadsheetName",
      "sheetName", "sheetGid", "sheetRowNumber", "sheetSku", "sheetMultiplier", "reason", "evidence", "lastSeenAt", "updatedAt"
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,NOW(),NOW())
    ON CONFLICT ("shopifyId") DO UPDATE SET
      "title"=EXCLUDED."title", "handle"=EXCLUDED."handle", "status"=EXCLUDED."status", "vendor"=EXCLUDED."vendor",
      "imageUrl"=EXCLUDED."imageUrl", "primarySku"=EXCLUDED."primarySku", "price"=EXCLUDED."price",
      "inventoryQuantity"=EXCLUDED."inventoryQuantity", "explicitSourceUrls"=EXCLUDED."explicitSourceUrls",
      "matchStatus"=EXCLUDED."matchStatus", "matchMethod"=EXCLUDED."matchMethod", "matchedSourceUrl"=EXCLUDED."matchedSourceUrl",
      "sheetSpreadsheetId"=EXCLUDED."sheetSpreadsheetId", "sheetSpreadsheetName"=EXCLUDED."sheetSpreadsheetName",
      "sheetName"=EXCLUDED."sheetName", "sheetGid"=EXCLUDED."sheetGid", "sheetRowNumber"=EXCLUDED."sheetRowNumber",
      "sheetSku"=EXCLUDED."sheetSku", "sheetMultiplier"=EXCLUDED."sheetMultiplier", "reason"=EXCLUDED."reason",
      "evidence"=EXCLUDED."evidence", "lastSeenAt"=NOW(), "updatedAt"=NOW()
  `,
    product.id,
    product.title,
    product.handle || null,
    product.status || null,
    product.vendor || null,
    product.imageUrl,
    primarySku,
    product.variants[0]?.price ?? null,
    product.variants.reduce((sum, v) => sum + Number(v.inventoryQuantity || 0), 0),
    JSON.stringify(product.explicitSourceUrls),
    forcedStatus || candidate.status,
    forcedStatus ? "database" : candidate.matchMethod,
    forcedUrl ?? row?.url ?? product.explicitSourceUrls[0] ?? null,
    row?.spreadsheetId ?? null,
    row?.spreadsheetName ?? null,
    row?.sheetName ?? null,
    row?.gid ?? null,
    row?.rowNumber ?? null,
    row?.sku ?? null,
    Number(row?.priceMultiplier || 0) || null,
    forcedStatus ? null : candidate.reason,
    JSON.stringify(forcedStatus ? ["database"] : candidate.evidence),
  );
}

function optionMap(selectedOptions: Array<{ name: string; value: string }>) {
  return Object.fromEntries((selectedOptions || []).map((option) => [clean(option.name), clean(option.value)]));
}

function optionValue(values: Record<string, string>, pattern: RegExp) {
  return Object.entries(values).find(([name]) => pattern.test(name))?.[1] || null;
}

async function persistCatalogLink(product: ShopifyCatalogProduct, candidate: CandidateResult) {
  if (!candidate.row) throw new Error("Exact candidate row is required");
  const row = candidate.row;
  const multiplier = Number(row.priceMultiplier || 0);
  const hasMultiplier = Number.isFinite(multiplier) && multiplier > 0;
  const firstShopifyPrice = Number(product.variants[0]?.price || 0);
  const estimatedSourcePrice = hasMultiplier && firstShopifyPrice > 0 ? Number((firstShopifyPrice / multiplier).toFixed(4)) : firstShopifyPrice;
  const currency = sourceCurrency(row.url);
  return prisma.$transaction(async (tx) => {
    const existingShopify = await tx.shopifyProduct.findUnique({ where: { shopifyId: product.id }, include: { sourceProduct: true } });
    if (existingShopify) {
      return { status: "already_linked", sourceProductId: existingShopify.sourceProductId, sourceUrl: existingShopify.sourceProduct.url };
    }
    const existingSource = await tx.sourceProduct.findUnique({
      where: { url: row.url },
      include: { shopifyProduct: true, variants: { include: { shopifyVariant: true } } },
    });
    if (existingSource?.shopifyProduct && existingSource.shopifyProduct.shopifyId !== product.id) {
      throw new Error("Source URL is already linked to a different Shopify product");
    }
    const label = supplierName(row.url, product.vendor);
    const supplier = await tx.supplier.upsert({
      where: { name: label },
      update: {},
      create: { name: label, baseUrl: supplierBaseUrl(row.url) },
    });
    const oldRaw = parseJson(existingSource?.raw);
    const importMeta = {
      ...(oldRaw.import && typeof oldRaw.import === "object" ? oldRaw.import : {}),
      spreadsheetId: row.spreadsheetId,
      sheetUrl: row.sheetUrl,
      sheetName: row.sheetName,
      sheetId: row.gid,
      excelRowNumber: row.rowNumber,
      sheetSku: row.sku || null,
      sheetPriceMultiplier: Number(row.priceMultiplier || 0) || null,
      sheetCollection: row.collection || null,
      sourceUrl: row.url,
      exactCatalogLink: true,
      matchMethod: candidate.matchMethod,
      scraperApiCreditsUsedForLinking: 0,
      linkedAt: new Date().toISOString(),
    };
    const mergedRaw = JSON.stringify({ ...oldRaw, import: importMeta });
    const sourceProduct = existingSource
      ? await tx.sourceProduct.update({
          where: { id: existingSource.id },
          data: { supplierId: existingSource.supplierId || supplier.id, syncStatus: "active", raw: mergedRaw },
        })
      : await tx.sourceProduct.create({
          data: {
            supplierId: supplier.id,
            url: row.url,
            title: product.title,
            description: null,
            brand: product.vendor || label,
            currency,
            price: estimatedSourcePrice,
            syncStatus: "active",
            lastScrapedAt: new Date(0),
            raw: mergedRaw,
          },
        });
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
    const existingVariants = existingSource?.variants || [];
    for (const variant of product.variants) {
      if (!variant.id) continue;
      const sku = normalizeSku(variant.sku);
      const exact = sku ? existingVariants.filter((entry) => normalizeSku(entry.sku) === sku && !entry.shopifyVariant) : [];
      let sourceVariant: any = exact.length === 1 ? exact[0] : null;
      const values = optionMap(variant.selectedOptions);
      if (!sourceVariant) {
        sourceVariant = await tx.sourceVariant.create({
          data: {
            sourceProductId: sourceProduct.id,
            sourceVariantId: `shopify-catalog-bootstrap-${variant.id.split("/").pop()}`,
            sku: variant.sku || null,
            color: optionValue(values, /colou?r/i),
            size: optionValue(values, /size|age|shoe/i),
            price: hasMultiplier && variant.price > 0 ? Number((variant.price / multiplier).toFixed(4)) : variant.price || null,
            currency,
            available: variant.inventoryQuantity > 0,
            stockStatus: variant.inventoryQuantity > 0 ? "in_stock" : "out_of_stock",
          },
        });
      }
      await tx.shopifyVariant.create({
        data: {
          shopifyProductId: shopifyProduct.id,
          sourceVariantId: sourceVariant.id,
          shopifyId: variant.id,
          sku: variant.sku || null,
          price: variant.price || null,
        },
      });
    }
    await tx.manualReviewItem.deleteMany({ where: { sourceProductId: sourceProduct.id, status: "pending" } });
    if (!existingSource && product.imageUrl) {
      await tx.sourceImage.create({ data: { sourceProductId: sourceProduct.id, url: product.imageUrl, alt: product.title, position: 0 } });
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
          sheetRowNumber: row.rowNumber,
          matchMethod: candidate.matchMethod,
          scraperApiCreditsUsed: 0,
        }),
      },
    });
    return { status: "linked", sourceProductId: sourceProduct.id, sourceUrl: sourceProduct.url };
  }, { maxWait: 15_000, timeout: 45_000 });
}

async function updateJob(jobId: string, result: Record<string, any>, status?: string) {
  await prisma.syncJob.update({
    where: { id: jobId },
    data: {
      ...(status ? { status } : {}),
      result: JSON.stringify(result),
      ...(status === "running" ? { startedAt: new Date() } : {}),
      ...(status === "completed" || status === "failed" ? { completedAt: new Date() } : {}),
    },
  });
}

async function readActiveShopifyProductCount(client: any) {
  const data: any = await shopifyRequestWithBackoff(client, `
    query SyncEngineActiveCatalogCount {
      productsCount(query: "status:active", limit: null) { count precision }
    }
  `, {});
  return Number(data?.productsCount?.count || 0);
}

function jobResult(job: { result?: string | null } | null | undefined) {
  return parseJson(job?.result);
}

function jobHeartbeat(job: { result?: string | null; startedAt?: Date | null; createdAt?: Date | null }) {
  const result = jobResult(job);
  const value = result.lastPageAt || job.startedAt || job.createdAt;
  const timestamp = value ? new Date(value).getTime() : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isStaleCatalogJob(job: { result?: string | null; startedAt?: Date | null; createdAt?: Date | null }) {
  return Date.now() - jobHeartbeat(job) > STALE_CATALOG_JOB_MS;
}

async function runCatalogJob(
  jobId: string,
  linkExact: boolean,
  resumeAfter: string | null = null,
  resumedScanStartedAt: string | null = null,
) {
  const started = Date.now();
  const parsedScanStartedAt = resumedScanStartedAt ? new Date(resumedScanStartedAt) : new Date();
  const scanStartedAt = Number.isFinite(parsedScanStartedAt.getTime()) ? parsedScanStartedAt : new Date();
  const result: Record<string, any> = {
    stage: "starting",
    shopifyProductsRead: 0,
    shopifyPagesRead: 0,
    sheetRowsRead: 0,
    linked: 0,
    alreadyLinked: 0,
    matchedReady: 0,
    needsReview: 0,
    needsLink: 0,
    failed: 0,
    scraperApiCreditsUsed: 0,
    resumed: Boolean(resumeAfter),
    scanStartedAt: scanStartedAt.toISOString(),
    nextCursor: resumeAfter,
  };
  try {
    await ensureCacheTable();
    await updateJob(jobId, result, "running");
    result.stage = "loading_sheets";
    const sheetIndex = await loadSheetIndex(true);
    result.sheetRowsRead = sheetIndex.rows.length;
    result.sheetErrors = sheetIndex.errors.length;
    await updateJob(jobId, result);
    const client = await ShopifyService.getClientFromDb(prisma);
    result.activeProductsExpected = await readActiveShopifyProductCount(client);
    const linkedSourceOwners = await prisma.shopifyProduct.findMany({
      select: { shopifyId: true, sourceProduct: { select: { url: true } } },
    });
    const sourceOwnerByUrl = new Map(
      linkedSourceOwners.map((entry) => [canonicalUrl(entry.sourceProduct.url), entry.shopifyId]),
    );
    await updateJob(jobId, result);
    let after: string | null = resumeAfter;
    let pages = 0;
    result.stage = linkExact ? "linking_exact_matches" : "indexing_shopify";
    while (pages < MAX_SHOPIFY_PAGES) {
      const page = await readShopifyPage(client, after);
      if (page.products.length === 0 && pages === 0) break;
      const productIds = page.products.map((product) => product.id);
      const existingLinks = await prisma.shopifyProduct.findMany({
        where: { shopifyId: { in: productIds } },
        select: {
          shopifyId: true,
          syncEnabled: true,
          sourceProduct: { select: { url: true, syncStatus: true } },
        },
      });
      const existingById = new Map(existingLinks.map((entry) => [entry.shopifyId, entry]));
      for (const product of page.products) {
        const existing = existingById.get(product.id);
        if (existing) {
          const active = existing.syncEnabled && existing.sourceProduct.syncStatus === "active";
          await upsertCatalogIndex(product, {
            status: "needs_link", row: null, matchingRows: [], matchMethod: "database", reason: null, evidence: ["database"],
          }, active ? "active" : "linked", existing.sourceProduct.url);
          result.alreadyLinked += 1;
          continue;
        }
        let candidate = resolveCandidate(product, sheetIndex);
        const candidateOwner = candidate.row
          ? sourceOwnerByUrl.get(canonicalUrl(candidate.row.url))
          : null;
        if (candidate.status === "matched" && candidateOwner && candidateOwner !== product.id) {
          candidate = {
            ...candidate,
            status: "needs_review",
            matchMethod: "conflict",
            reason: "Source URL is already linked to a different Shopify product",
            evidence: [...candidate.evidence, "database_conflict"],
          };
        }
        if (candidate.status === "matched" && linkExact) {
          try {
            const linked = await persistCatalogLink(product, candidate);
            result.linked += linked.status === "linked" ? 1 : 0;
            result.alreadyLinked += linked.status === "already_linked" ? 1 : 0;
            sourceOwnerByUrl.set(canonicalUrl(linked.sourceUrl), product.id);
            await upsertCatalogIndex(product, candidate, "active", linked.sourceUrl);
            continue;
          } catch (error: any) {
            result.failed += 1;
            candidate = {
              ...candidate,
              status: "needs_review",
              matchMethod: "conflict",
              reason: clean(error?.message || error),
              evidence: [...candidate.evidence, "database_conflict"],
            };
          }
        }
        if (candidate.status === "matched") result.matchedReady += 1;
        if (candidate.status === "needs_review") result.needsReview += 1;
        if (candidate.status === "needs_link") result.needsLink += 1;
        await upsertCatalogIndex(product, candidate);
      }
      pages += 1;
      result.shopifyPagesRead = pages;
      result.shopifyProductsRead += page.products.length;
      result.lastPageAt = new Date().toISOString();
      result.nextCursor = page.hasNextPage ? page.endCursor : null;
      result.elapsedSeconds = Math.round((Date.now() - started) / 1000);
      await updateJob(jobId, result);
      if (!page.hasNextPage) break;
      if (!page.endCursor) throw new Error("Shopify pagination returned hasNextPage without endCursor");
      after = page.endCursor;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (pages >= MAX_SHOPIFY_PAGES) throw new Error(`Shopify catalog exceeded ${MAX_SHOPIFY_PAGES * PAGE_SIZE} indexed products`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM "${CACHE_TABLE}" WHERE "lastSeenAt" < $1`,
      scanStartedAt,
    );
    result.stage = "completed";
    result.elapsedSeconds = Math.round((Date.now() - started) / 1000);
    await updateJob(jobId, result, "completed");
  } catch (error: any) {
    result.stage = "failed";
    result.error = clean(error?.message || error);
    result.elapsedSeconds = Math.round((Date.now() - started) / 1000);
    await updateJob(jobId, result, "failed").catch(() => {});
    console.error("[shopify-catalog] background job failed:", error);
  }
}

async function startBackgroundJob(linkExact: boolean) {
  const currentPromise = linkExact ? reconcilePromise : refreshPromise;
  if (currentPromise) return { alreadyRunning: true, job: null };
  const type = linkExact ? RECONCILE_JOB_TYPE : REFRESH_JOB_TYPE;
  const existing = await prisma.syncJob.findFirst({
    where: { type: { startsWith: "SHOPIFY_CATALOG_" }, status: { in: ["pending", "running"] } },
    orderBy: { createdAt: "desc" },
  });
  if (existing && !isStaleCatalogJob(existing)) return { alreadyRunning: true, job: existing };

  let resumeAfter: string | null = null;
  let resumedScanStartedAt: string | null = null;
  if (existing) {
    const previous = jobResult(existing);
    if (existing.type === type) {
      resumeAfter = clean(previous.nextCursor) || null;
      resumedScanStartedAt = clean(previous.scanStartedAt) || null;
    }
    await prisma.syncJob.updateMany({
      where: { id: existing.id, status: { in: ["pending", "running"] } },
      data: {
        status: "failed",
        completedAt: new Date(),
        result: JSON.stringify({
          ...previous,
          stage: "stale_recovered",
          error: "Catalog worker heartbeat expired; a replacement worker was started automatically.",
          recoveredAt: new Date().toISOString(),
        }),
      },
    });
  }
  const job = await prisma.syncJob.create({
    data: {
      type,
      status: "pending",
      payload: JSON.stringify({
        sourceOfTruth: "shopify_database_connection",
        exactOnly: linkExact,
        shopifyMutations: 0,
        googleSheetWrites: 0,
        scraperApiCreditsUsed: 0,
        requestedAt: new Date().toISOString(),
        resumeAfter,
        resumedScanStartedAt,
      }),
    },
  });
  const promise = runCatalogJob(job.id, linkExact, resumeAfter, resumedScanStartedAt).finally(() => {
    if (linkExact) reconcilePromise = null;
    else refreshPromise = null;
  });
  if (linkExact) reconcilePromise = promise;
  else refreshPromise = promise;
  void promise;
  return { alreadyRunning: false, job };
}

async function latestCatalogJob() {
  const job = await prisma.syncJob.findFirst({
    where: { type: { in: [RECONCILE_JOB_TYPE, REFRESH_JOB_TYPE] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, type: true, status: true, result: true, createdAt: true, startedAt: true, completedAt: true },
  });
  if (!job) return null;
  return { ...job, result: parseJson(job.result) };
}

async function knownShopifyCatalogTotal(indexedTotal: number) {
  const jobs = await prisma.syncJob.findMany({
    where: { type: { startsWith: "SHOPIFY_CATALOG_" } },
    orderBy: { createdAt: "desc" },
    take: 25,
    select: { result: true },
  });
  return jobs.reduce((known, job) => {
    const result = jobResult(job);
    return Math.max(
      known,
      Number(result.activeProductsExpected || 0),
    );
  }, indexedTotal);
}

async function dbCounts() {
  const [linked, activeSync] = await Promise.all([
    prisma.shopifyProduct.count(),
    prisma.shopifyProduct.count({ where: { syncEnabled: true, sourceProduct: { syncStatus: "active" } } }),
  ]);
  return { shopifyTotal: linked, linked, activeSync, matchedReady: 0, needsLink: 0, needsReview: 0, pausedOrLinked: linked - activeSync };
}

async function dbOnlyResponse(search: string, status: string, offset: number, limit: number) {
  const activeFilter = status === "active" ? { syncEnabled: true, sourceProduct: { syncStatus: "active" } } : {};
  const searchFilter = search ? {
    OR: [
      { shopifyId: { contains: search, mode: "insensitive" as const } },
      { handle: { contains: search, mode: "insensitive" as const } },
      { sourceProduct: { title: { contains: search, mode: "insensitive" as const } } },
      { sourceProduct: { url: { contains: search, mode: "insensitive" as const } } },
      { variants: { some: { sku: { contains: search, mode: "insensitive" as const } } } },
    ],
  } : {};
  const where: any = { ...activeFilter, ...searchFilter };
  if (["matched", "needs_review", "needs_link"].includes(status)) {
    return {
      success: true,
      legacy: false,
      degraded: true,
      counts: await dbCounts(),
      filteredTotal: 0,
      offset,
      limit,
      hasMore: false,
      items: [],
      latestJob: await latestCatalogJob(),
    };
  }
  const [total, products, connection] = await Promise.all([
    prisma.shopifyProduct.count({ where }),
    prisma.shopifyProduct.findMany({
      where,
      skip: offset,
      take: limit,
      orderBy: { updatedAt: "desc" },
      include: {
        sourceProduct: { include: { supplier: true, images: { orderBy: { position: "asc" }, take: 1 }, variants: { take: 20 } } },
        variants: { take: 20 },
      },
    }),
    prisma.shopifyConnection.findFirst({ where: { isConnected: true }, select: { shopDomain: true } }),
  ]);
  const items = products.map((entry) => {
    const raw = parseJson(entry.sourceProduct.raw);
    const meta = raw.import && typeof raw.import === "object" ? raw.import : {};
    const active = entry.syncEnabled && entry.sourceProduct.syncStatus === "active";
    return {
      key: entry.shopifyId,
      sourceProductId: entry.sourceProduct.id,
      title: entry.sourceProduct.title,
      vendor: entry.sourceProduct.brand || entry.sourceProduct.supplier?.name,
      imageUrl: entry.sourceProduct.images?.[0]?.url || null,
      shopifyProductId: entry.shopifyId,
      shopifyHandle: entry.handle,
      shopifyStatus: entry.status,
      shopifyPrice: entry.price,
      shopifySku: entry.variants.find((variant) => variant.sku)?.sku || entry.sourceProduct.variants.find((variant) => variant.sku)?.sku || null,
      sourceUrl: entry.sourceProduct.url,
      sourceCurrency: entry.sourceProduct.currency,
      sourcePrice: entry.sourceProduct.price,
      syncStatus: entry.sourceProduct.syncStatus,
      syncEnabled: entry.syncEnabled,
      syncPrice: entry.syncPrice,
      syncInventory: entry.syncInventory,
      matchStatus: active ? "active" : "linked",
      matchMethod: "database",
      sheet: {
        spreadsheetId: meta.spreadsheetId || null,
        spreadsheetName: meta.spreadsheetId === BIG_SPREADSHEET_ID ? "dap_data" : meta.spreadsheetId === LEGACY_SPREADSHEET_ID ? "legacy_4_sheet" : null,
        sheetName: meta.sheetName || null,
        sheetId: meta.sheetId || null,
        sheetRowNumber: meta.excelRowNumber || null,
        sheetUrl: meta.sheetUrl || null,
        sheetSku: meta.sheetSku || entry.sourceProduct.variants.find((variant) => variant.sku)?.sku || null,
        multiplier: meta.sheetPriceMultiplier || null,
        sourceUrl: entry.sourceProduct.url,
      },
      reason: null,
      evidence: ["database"],
    };
  });
  return {
    success: true,
    sourceOfTruth: "shopify_database_connection",
    degraded: true,
    shopDomain: connection?.shopDomain || undefined,
    counts: await dbCounts(),
    filteredTotal: total,
    offset,
    limit,
    hasMore: offset + items.length < total,
    items,
    latestJob: await latestCatalogJob(),
    scan: { mode: "database_first", message: "Shopify indexing continues in the background; existing mappings are served directly from the database." },
  };
}

router.get("/shopify-catalog/link-state", async (req, res) => {
  const search = clean(req.query.search).toLowerCase();
  const status = clean(req.query.status).toLowerCase() || "all";
  const offset = Math.max(0, Number(req.query.offset || 0) || 0);
  const limit = Math.max(1, Math.min(250, Number(req.query.limit || 100) || 100));
  const refresh = String(req.query.refresh || "").toLowerCase() === "true";
  try {
    await ensureCacheTable();
    if (refresh) {
      void startBackgroundJob(false).catch((error) => console.error("[shopify-catalog] refresh start failed:", error));
    }
    const clauses: string[] = [`UPPER(COALESCE("status", '')) = 'ACTIVE'`];
    const params: any[] = [];
    if (search) {
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      clauses.push(`(LOWER("title") LIKE ${p} OR LOWER(COALESCE("primarySku",'')) LIKE ${p} OR LOWER("shopifyId") LIKE ${p} OR LOWER(COALESCE("matchedSourceUrl",'')) LIKE ${p} OR LOWER(COALESCE("sheetName",'')) LIKE ${p})`);
    }
    if (status && status !== "all") {
      if (status === "linked") clauses.push(`"matchStatus" IN ('active','linked')`);
      else if (status === "active") clauses.push(`"matchStatus" = 'active'`);
      else if (status === "matched") clauses.push(`"matchStatus" = 'matched'`);
      else if (status === "needs_review") clauses.push(`"matchStatus" = 'needs_review'`);
      else if (status === "needs_link") clauses.push(`"matchStatus" = 'needs_link'`);
      else if (status === "paused") clauses.push(`"matchStatus" = 'linked'`);
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const countRows = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*)::int AS count FROM "${CACHE_TABLE}" ${whereSql}`, ...params);
    const filteredTotal = Number(countRows?.[0]?.count || 0);
    const pageParams = [...params, limit, offset];
    const rows = await prisma.$queryRawUnsafe<any[]>(`
      SELECT * FROM "${CACHE_TABLE}" ${whereSql}
      ORDER BY "title" ASC, "shopifyId" ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, ...pageParams);
    const ids = rows.map((row) => String(row.shopifyId));
    const linked = ids.length ? await prisma.shopifyProduct.findMany({
      where: { shopifyId: { in: ids } },
      include: {
        sourceProduct: { include: { supplier: true, images: { orderBy: { position: "asc" }, take: 1 }, variants: { take: 20 } } },
        variants: { take: 20 },
      },
    }) : [];
    const linkedById = new Map(linked.map((entry) => [entry.shopifyId, entry]));
    const items = rows.map((row) => {
      const dbLink = linkedById.get(String(row.shopifyId));
      if (dbLink) {
        const raw = parseJson(dbLink.sourceProduct.raw);
        const meta = raw.import && typeof raw.import === "object" ? raw.import : {};
        const active = dbLink.syncEnabled && dbLink.sourceProduct.syncStatus === "active";
        return {
          key: row.shopifyId,
          sourceProductId: dbLink.sourceProduct.id,
          title: row.title || dbLink.sourceProduct.title,
          vendor: row.vendor || dbLink.sourceProduct.brand || dbLink.sourceProduct.supplier?.name,
          imageUrl: row.imageUrl || dbLink.sourceProduct.images?.[0]?.url || null,
          shopifyProductId: row.shopifyId,
          shopifyHandle: row.handle || dbLink.handle,
          shopifyStatus: row.status || dbLink.status,
          shopifyPrice: row.price ?? dbLink.price,
          shopifySku: row.primarySku || dbLink.variants.find((variant) => variant.sku)?.sku || null,
          sourceUrl: dbLink.sourceProduct.url,
          sourceCurrency: dbLink.sourceProduct.currency,
          sourcePrice: dbLink.sourceProduct.price,
          syncStatus: dbLink.sourceProduct.syncStatus,
          syncEnabled: dbLink.syncEnabled,
          syncPrice: dbLink.syncPrice,
          syncInventory: dbLink.syncInventory,
          matchStatus: active ? "active" : "linked",
          matchMethod: "database",
          sheet: {
            spreadsheetId: meta.spreadsheetId || row.sheetSpreadsheetId || null,
            spreadsheetName: row.sheetSpreadsheetName || (meta.spreadsheetId === BIG_SPREADSHEET_ID ? "dap_data" : meta.spreadsheetId === LEGACY_SPREADSHEET_ID ? "legacy_4_sheet" : null),
            sheetName: meta.sheetName || row.sheetName || null,
            sheetId: meta.sheetId || row.sheetGid || null,
            sheetRowNumber: meta.excelRowNumber || row.sheetRowNumber || null,
            sheetUrl: meta.sheetUrl || (row.sheetSpreadsheetId ? `https://docs.google.com/spreadsheets/d/${row.sheetSpreadsheetId}/edit?gid=${row.sheetGid || 0}` : null),
            sheetSku: meta.sheetSku || row.sheetSku || null,
            multiplier: meta.sheetPriceMultiplier || row.sheetMultiplier || null,
            sourceUrl: dbLink.sourceProduct.url,
          },
          reason: null,
          evidence: ["database"],
        };
      }
      return {
        key: row.shopifyId,
        sourceProductId: null,
        title: row.title,
        vendor: row.vendor,
        imageUrl: row.imageUrl || null,
        shopifyProductId: row.shopifyId,
        shopifyHandle: row.handle || null,
        shopifyStatus: row.status || null,
        shopifyPrice: row.price ?? null,
        shopifySku: row.primarySku || null,
        sourceUrl: row.matchedSourceUrl || null,
        sourceCurrency: row.matchedSourceUrl ? sourceCurrency(row.matchedSourceUrl) : null,
        sourcePrice: null,
        syncStatus: row.matchStatus === "matched" ? "ready_to_link" : "unlinked",
        syncEnabled: false,
        syncPrice: false,
        syncInventory: false,
        matchStatus: row.matchStatus,
        matchMethod: row.matchMethod,
        sheet: row.sheetSpreadsheetId ? {
          spreadsheetId: row.sheetSpreadsheetId,
          spreadsheetName: row.sheetSpreadsheetName,
          sheetName: row.sheetName,
          sheetId: row.sheetGid,
          sheetRowNumber: row.sheetRowNumber,
          sheetUrl: `https://docs.google.com/spreadsheets/d/${row.sheetSpreadsheetId}/edit?gid=${row.sheetGid || 0}`,
          sheetSku: row.sheetSku,
          multiplier: row.sheetMultiplier,
          sourceUrl: row.matchedSourceUrl,
        } : null,
        reason: row.reason || null,
        evidence: parseJson(row.evidence),
      };
    });
    const grouped = await prisma.$queryRawUnsafe<any[]>(`SELECT "matchStatus", COUNT(*)::int AS count FROM "${CACHE_TABLE}" WHERE UPPER(COALESCE("status", '')) = 'ACTIVE' GROUP BY "matchStatus"`);
    const group = new Map(grouped.map((entry) => [String(entry.matchStatus), Number(entry.count || 0)]));
    const indexedTotal = [...group.values()].reduce((sum, count) => sum + count, 0);
    const activeSync = group.get("active") || 0;
    const pausedOrLinked = group.get("linked") || 0;
    const counts = {
      shopifyTotal: await knownShopifyCatalogTotal(indexedTotal),
      linked: activeSync + pausedOrLinked,
      activeSync,
      matchedReady: group.get("matched") || 0,
      needsLink: group.get("needs_link") || 0,
      needsReview: group.get("needs_review") || 0,
      pausedOrLinked,
    };
    const connection = await prisma.shopifyConnection.findFirst({ where: { isConnected: true }, select: { shopDomain: true } });
    let latestJob = await latestCatalogJob();
    const latestJobIsStale = latestJob && ["pending", "running"].includes(latestJob.status) && isStaleCatalogJob(latestJob);
    const catalogIndexIncomplete = indexedTotal === 0 || indexedTotal < counts.shopifyTotal;
    const staleReconcileNeedsResume = Boolean(latestJobIsStale && latestJob?.type === RECONCILE_JOB_TYPE);
    if (latestJob && latestJobIsStale && !catalogIndexIncomplete && !staleReconcileNeedsResume) {
      const recoveredResult = {
        ...latestJob.result,
        stage: "stale_closed_complete_index",
        error: "Catalog worker heartbeat expired after the complete index had already been preserved.",
        recoveredAt: new Date().toISOString(),
      };
      await prisma.syncJob.update({
        where: { id: latestJob.id },
        data: { status: "failed", completedAt: new Date(), result: JSON.stringify(recoveredResult) },
      });
      latestJob = { ...latestJob, status: "failed", completedAt: new Date(), result: recoveredResult };
    }
    if (
      !autoRefreshStarted &&
      !refresh &&
      (catalogIndexIncomplete || staleReconcileNeedsResume) &&
      (!latestJob || !["pending", "running"].includes(latestJob.status) || latestJobIsStale)
    ) {
      autoRefreshStarted = true;
      const recoverExactLink = staleReconcileNeedsResume;
      setTimeout(() => {
        void startBackgroundJob(recoverExactLink).catch((error) => console.error("[shopify-catalog] automatic catalog job start failed:", error));
      }, 1000);
    }
    return res.json({
      success: true,
      sourceOfTruth: "shopify_database_connection",
      shopDomain: connection?.shopDomain || undefined,
      counts,
      filteredTotal,
      offset,
      limit,
      hasMore: offset + items.length < filteredTotal,
      items,
      latestJob,
      scan: {
        mode: "database_first_background_shopify_index",
        shopifyProductsRead: Number(latestJob?.result?.shopifyProductsRead || counts.shopifyTotal),
        indexedTotal,
        pendingProducts: Math.max(0, counts.shopifyTotal - indexedTotal),
        shopifyPagesRead: Number(latestJob?.result?.shopifyPagesRead || 0),
        sheetRowsRead: Number(latestJob?.result?.sheetRowsRead || 0),
        scraperApiCreditsUsed: 0,
      },
    });
  } catch (error: any) {
    console.error("[shopify-catalog] link-state cache path failed; serving DB fallback:", error);
    try {
      const fallback = await dbOnlyResponse(search, status, offset, limit);
      return res.status(200).json({ ...fallback, cacheError: clean(error?.message || error) });
    } catch (fallbackError: any) {
      return res.status(500).json({ success: false, error: clean(fallbackError?.message || fallbackError) });
    }
  }
});

router.post("/shopify-catalog/reconcile", async (req, res) => {
  try {
    if (clean(req.body?.confirm) !== RECONCILE_CONFIRMATION) {
      return res.status(428).json({
        success: false,
        code: "CONFIRMATION_REQUIRED",
        error: `Send confirm=${RECONCILE_CONFIRMATION} to start exact catalog linking.`,
      });
    }
    await ensureCacheTable();
    const started = await startBackgroundJob(true);
    return res.status(202).json({
      success: true,
      alreadyRunning: started.alreadyRunning,
      jobId: started.job?.id || null,
      mode: "database_first_background_exact_linking",
      scraperApiCreditsUsed: 0,
      shopifyMutations: 0,
      googleSheetWrites: 0,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: clean(error?.message || error) });
  }
});

export default router;
