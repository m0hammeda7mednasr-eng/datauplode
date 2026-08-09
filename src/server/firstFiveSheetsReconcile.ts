import axios from "axios";
import crypto from "crypto";
import { envString, isProduction } from "./config/env.js";
import { prisma } from "./db.js";
import { ScraperService, type NormalizedProduct } from "./services/scraper.js";
import { ShopifyService, type ShopifyGraphqlClient } from "./services/shopify.js";

const SPREADSHEET_ID = "1fCbPajWL3nukX0TdoN1m2X8LV3pfPsxSMLBb0yWug2w";
const RUN_CONFIRMATION = "2026-08-09-sheet1-reconcile-v1";
const MARKER_TYPE = `ONE_TIME_SHEET1_RECONCILE:${RUN_CONFIRMATION}`;
const START_DELAY_MS = 20_000;
const PASS_DELAY_MS = 5 * 60 * 1000;
const CHUNK_DELAY_MS = 1_500;
const CONCURRENCY = 2;
const RETRY_DELAYS_MS = [0, 8_000, 30_000] as const;
const DEFAULT_IN_STOCK_QUANTITY = Math.max(
  1,
  Number(process.env.SHOPIFY_DEFAULT_IN_STOCK_QUANTITY || 10) || 10,
);

const FIRST_FIVE_SHEETS = [
  { name: "الورقة1", gid: 0, sheetId: 0, columnCount: 4 },
  { name: "الورقة2", gid: 531292068, sheetId: 531292068, columnCount: 4 },
  { name: "الورقة15", gid: 242585683, sheetId: 242585683, columnCount: 26 },
  { name: "الورقة10", gid: 1991302797, sheetId: 1991302797, columnCount: 4 },
  { name: "الورقة6", gid: 1951926772, sheetId: 1951926772, columnCount: 4 },
] as const;

type SheetConfig = (typeof FIRST_FIVE_SHEETS)[number];

type SheetRow = {
  sheet: SheetConfig;
  rowNumber: number;
  url: string;
  normalizedUrl: string;
  multiplier: number;
  collection: string;
  existingSku: string;
};

type InvalidSheetRow = {
  sheet: SheetConfig;
  rowNumber: number;
  url: string;
  reason: string;
};

type PlanGroup = {
  url: string;
  rows: SheetRow[];
  multiplier: number | null;
  conflictMultipliers: number[];
};

type GroupStatus =
  | "verified"
  | "rebuild_required"
  | "error"
  | "missing"
  | "ambiguous"
  | "conflict"
  | "invalid";

type GroupResult = {
  status: GroupStatus;
  url: string;
  rows: Array<{ sheetName: string; sheetId: number; rowNumber: number }>;
  multiplier: number | null;
  productCode?: string;
  shopifyProductId?: string;
  shopifyHandle?: string;
  shopifyTitle?: string;
  expectedSku?: string;
  canonicalSize?: string;
  variantsChecked?: number;
  pricesChanged?: number;
  inventoryChanged?: number;
  skuChanged?: boolean;
  readbackVerified?: boolean;
  matchSource?: "database" | "shopify_fallback";
  sheetWritten?: boolean;
  reason?: string;
};

type Totals = {
  passes: number;
  groupsAttempted: number;
  verifiedGroups: number;
  verifiedRows: number;
  errors: number;
  missing: number;
  ambiguous: number;
  conflicts: number;
  invalid: number;
  retries: number;
  sheetCells: number;
  sheetErrors: number;
  skippedPreviouslyVerifiedRows: number;
};

const scraperService = new ScraperService();
let googleTokenCache: { token: string; expiresAt: number } | null = null;
let started = false;

function clean(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canonicalizeUrl(value: string) {
  const raw = String(value || "").replace(/[\t\r\n]+/g, "").trim();
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    parsed.search = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return raw;
  }
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"') {
      if (quoted && next === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }

  row.push(cell);
  if (row.some((value) => clean(value))) rows.push(row);
  return rows;
}

function parseMultiplier(value: unknown) {
  const normalized = clean(value).replace(/,/g, ".");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 1 && number <= 100 ? number : null;
}

function rowKey(row: Pick<SheetRow, "sheet" | "rowNumber">) {
  return `${row.sheet.sheetId}:${row.rowNumber}`;
}

async function loadSheet(sheet: SheetConfig) {
  const csvUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=csv&gid=${sheet.gid}`;
  const response = await axios.get(csvUrl, {
    timeout: Number(process.env.GOOGLE_SHEET_FETCH_TIMEOUT_MS || 30000),
    responseType: "text",
  });

  const valid: SheetRow[] = [];
  const invalid: InvalidSheetRow[] = [];

  parseCsv(String(response.data || "")).forEach((cells, index) => {
    const rowNumber = index + 1;
    const urlColumn = cells.findIndex((value) => /^https?:\/\//i.test(clean(value)));
    if (urlColumn < 0) return;
    const url = clean(cells[urlColumn]);

    let multiplier: number | null = null;
    let multiplierColumn = -1;
    for (let column = 0; column < cells.length; column += 1) {
      if (column === urlColumn) continue;
      const parsed = parseMultiplier(cells[column]);
      if (parsed !== null) {
        multiplier = parsed;
        multiplierColumn = column;
        break;
      }
    }

    if (multiplier === null) {
      invalid.push({
        sheet,
        rowNumber,
        url,
        reason: "The row has a product URL but no valid price multiplier. No price/stock/SKU write was attempted.",
      });
      return;
    }

    const collection = cells
      .map((value, column) => ({ value: clean(value), column }))
      .find(
        (entry) =>
          entry.column !== urlColumn &&
          entry.column !== multiplierColumn &&
          entry.value &&
          !/^https?:\/\//i.test(entry.value) &&
          parseMultiplier(entry.value) === null &&
          !/^(price|collection|collection\s*|sku)$/i.test(entry.value),
      )?.value || "";

    valid.push({
      sheet,
      rowNumber,
      url,
      normalizedUrl: canonicalizeUrl(url),
      multiplier,
      collection,
      existingSku: clean(cells[3]),
    });
  });

  return { valid, invalid };
}

async function loadAllRows() {
  const loaded = await Promise.all(FIRST_FIVE_SHEETS.map((sheet) => loadSheet(sheet)));
  return {
    valid: loaded.flatMap((entry) => entry.valid),
    invalid: loaded.flatMap((entry) => entry.invalid),
  };
}

function buildGroups(rows: SheetRow[], verifiedRows: Set<string>) {
  const byUrl = new Map<string, SheetRow[]>();
  for (const row of rows) {
    if (verifiedRows.has(rowKey(row))) continue;
    const list = byUrl.get(row.normalizedUrl) || [];
    list.push(row);
    byUrl.set(row.normalizedUrl, list);
  }

  const groups: PlanGroup[] = [];
  for (const [url, groupedRows] of byUrl) {
    const multipliers = [...new Set(groupedRows.map((row) => row.multiplier))].sort((a, b) => a - b);
    groups.push({
      url,
      rows: groupedRows,
      multiplier: multipliers.length === 1 ? multipliers[0] : null,
      conflictMultipliers: multipliers,
    });
  }
  return groups.sort((left, right) => {
  const leftNext = /(?:^|\.)next\.(?:ae|co\.uk|us)$/i.test((() => {
    try { return new URL(left.url).hostname; } catch { return ""; }
  })());
  const rightNext = /(?:^|\.)next\.(?:ae|co\.uk|us)$/i.test((() => {
    try { return new URL(right.url).hostname; } catch { return ""; }
  })());
  return Number(leftNext) - Number(rightNext);
});
}

function readJson(value: string | null | undefined) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function loadPreviouslyVerifiedRows() {
  const verified = new Set<string>();
  const runs = await prisma.importBatch.findMany({
    where: { target: "first5_reconcile" },
    orderBy: { createdAt: "desc" },
    take: 10000,
    select: { payloadJson: true },
  });

  for (const run of runs) {
    const payload: any = readJson(run.payloadJson);
    const result = payload?.result;
    if (result?.status !== "verified" || result?.readbackVerified !== true) continue;
    const explicitSize = explicitTitleSizeToken(result?.shopifyTitle);
  const staleFlattenedOneSku = Boolean(
    explicitSize && /-ONE-(?:\d+(?:\.\d+)?)$/i.test(String(result?.expectedSku || "")),
  );
  if (staleFlattenedOneSku) continue;
    for (const row of Array.isArray(result?.rows) ? result.rows : []) {
      const sheetId = Number(row?.sheetId);
      const rowNumber = Number(row?.rowNumber);
      if (Number.isFinite(sheetId) && Number.isSafeInteger(rowNumber) && rowNumber > 0) {
        verified.add(`${sheetId}:${rowNumber}`);
      }
    }
  }
  return verified;
}

function compact(value: unknown) {
  return clean(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function brandCode(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("next.")) return "NXT";
    if (host.includes("hm.com")) return "HM";
    if (host.includes("maxfashion")) return "MAX";
    if (host.includes("centrepoint")) return "CPT";
    if (host.includes("shein")) return "SHN";
    if (host.includes("lefties")) return "LFT";
    if (host.includes("marksandspencer")) return "MNS";
  } catch {}
  return "SRC";
}

function sourceVendor(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("next.")) return "Next";
    if (host.includes("hm.com")) return "H&M";
    if (host.includes("maxfashion")) return "Max";
    if (host.includes("shein")) return "SHEIN";
    if (host.includes("centrepoint")) return "Centrepoint";
  } catch {}
  return "";
}

function shopifySearchValue(value: unknown) {
  return `"${clean(value).replace(/["\\]/g, " ").slice(0, 140)}"`;
}

function extractUrlProductCode(url: string) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const next = path.match(/\/style\/[^/]+\/([^/?#]+)/i)?.[1];
    if (next) return compact(next);
    const shein = path.match(/-p-(\d+)\.html/i)?.[1];
    if (shein) return compact(shein);
    const p = path.match(/\/p\/([^/?#]+)/i)?.[1];
    if (p) return compact(p);
    return "";
  } catch {
    return "";
  }
}

function rawProductCode(url: string, product: NormalizedProduct) {
  const urlCode = extractUrlProductCode(url);
  if (brandCode(url) === "NXT" && urlCode) return urlCode;
  const sourceCode = compact(product?.source?.productId);
  return sourceCode || urlCode;
}

function formatProductCode(value: string) {
  const code = compact(value);
  if (!code) return "";
  if (code.length <= 3) return code;
  return `${code.slice(0, -3)}-${code.slice(-3)}`;
}

function token(value: unknown, max = 30) {
  return clean(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
}

function normalizeSizeToken(value: unknown): string | null {
  const raw = clean(value).toUpperCase();
  if (!raw || raw === "DEFAULT" || raw === "DEFAULT TITLE") return null;

  let match = raw.match(/(\d+)\s*CM[^0-9]*(\d+)\s*LB/);
  if (match) return `${match[1]}CM-${match[2]}LB`;
  match = raw.match(/(\d+)\s*CM.*FIRST\s*SIZE/);
  if (match) return `${match[1]}CM-FIRST-SIZE`;
  if (/\bNEW\s*BORN\b|\bNEWBORN\b|\bNB\b/.test(raw)) return "NB";
  match = raw.match(/UP\s*TO\s*(\d+(?:\.\d+)?)\s*MONTH/);
  if (match) return `UP-TO-${match[1]}M`;
  match = raw.match(/EU\s*(\d+(?:\.\d+)?).*?UK\s*(\d+(?:\.\d+)?)/);
  if (match) return `EU-${match[1]}-UK-${match[2]}`;
  match = raw.match(/\bEU\s*(\d+(?:\.\d+)?)/);
  if (match) return `EU-${match[1]}`;
  match = raw.match(/\bUK\s*(\d+(?:\.\d+)?)/);
  if (match) return `UK-${match[1]}`;
  match = raw.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*MONTH/);
  if (match) return `${match[1]}-${match[2]}M`;
  match = raw.match(/(?:^|[^0-9])(\d+(?:\.\d+)?)\s*MONTH/);
  if (match) return `${match[1]}M`;
  match = raw.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*YEAR/);
  if (match) return `${match[1]}-${match[2]}Y`;
  match = raw.match(/(?:^|[^0-9])(\d+(?:\.\d+)?)\s*YEAR/);
  if (match) return `${match[1]}Y`;
  if (/\bONE\s*SIZE\b|\bSIZE\s*ONE\b|^ONE$/.test(raw)) return "ONE";
  if (/^(XXS|XS|S|M|L|XL|XXL)$/.test(raw)) return raw;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return raw;
  const fallback = token(raw, 20);
  return fallback || null;
}

function sizeRank(value: string | null) {
  if (!value) return Number.POSITIVE_INFINITY;
  if (/^\d+CM-\d+LB$/.test(value)) return -100;
  if (/^\d+CM-FIRST-SIZE$/.test(value)) return -90;
  if (value === "NB") return -80;
  let match = value.match(/^UP-TO-(\d+(?:\.\d+)?)M$/);
  if (match) return -70 + Number(match[1]);
  match = value.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)M$/);
  if (match) return Number(match[1]);
  match = value.match(/^(\d+(?:\.\d+)?)M$/);
  if (match) return Number(match[1]);
  match = value.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)Y$/);
  if (match) return Number(match[1]) * 12;
  match = value.match(/^(\d+(?:\.\d+)?)Y$/);
  if (match) return Number(match[1]) * 12;
  match = value.match(/^EU-(\d+(?:\.\d+)?)/);
  if (match) return 1000 + Number(match[1]);
  match = value.match(/^UK-(\d+(?:\.\d+)?)/);
  if (match) return 1100 + Number(match[1]);
  if (/^\d+(?:\.\d+)?$/.test(value)) return 1200 + Number(value);
  const letters: Record<string, number> = { XXS: 2000, XS: 2010, S: 2020, M: 2030, L: 2040, XL: 2050, XXL: 2060, ONE: 5000 };
  return letters[value] ?? 4000;
}

function normalizeOptionName(value: unknown) {
  const name = clean(value).toLowerCase();
  return name === "colour" ? "color" : name;
}

function sourceOptions(variant: any) {
  const output: Record<string, string> = {};
  const values = variant?.optionValues && typeof variant.optionValues === "object"
    ? variant.optionValues
    : {};
  for (const [name, value] of Object.entries(values)) {
    const key = normalizeOptionName(name);
    const normalized = clean(value).toLowerCase();
    if (key && normalized && normalized !== "default") output[key] = normalized;
  }
  if (variant?.size) output.size = clean(variant.size).toLowerCase();
  if (variant?.color) output.color = clean(variant.color).toLowerCase();
  return output;
}

function shopifyOptions(variant: any) {
  const output: Record<string, string> = {};
  for (const option of variant?.selectedOptions || []) {
    const key = normalizeOptionName(option?.name);
    const normalized = clean(option?.value).toLowerCase();
    if (key && normalized && normalized !== "default title") output[key] = normalized;
  }
  return output;
}

function explicitTitleSizeToken(value: unknown): string | null {
  const title = clean(value);
  const match = title.match(/\s-\sSize\s+(.+)$/i);
  if (!match) return null;
  const parsed = normalizeSizeToken(match[1]);
  return parsed && parsed !== "ONE" ? parsed : null;
}

function optionKey(values: Record<string, string>) {
  return Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("|");
}

function matchSourceVariant(shopifyVariant: any, sourceVariants: any[]) {
  const shopOptions = shopifyOptions(shopifyVariant);
  const exactKey = optionKey(shopOptions);
  if (exactKey) {
    const exact = sourceVariants.filter((variant) => optionKey(sourceOptions(variant)) === exactKey);
    if (exact.length === 1) return exact[0];
  }

  const shopSize = normalizeSizeToken(shopOptions.size || "");
  const shopColor = clean(shopOptions.color).toLowerCase();
  if (shopSize) {
    const matches = sourceVariants.filter((variant) => {
      const source = sourceOptions(variant);
      return (
        normalizeSizeToken(source.size || variant?.size) === shopSize &&
        (!shopColor || !source.color || source.color === shopColor)
      );
    });
    if (matches.length === 1) return matches[0];
  }

  const relaxed = sourceVariants.filter((variant) => {
    const source = sourceOptions(variant);
    const entries = Object.entries(shopOptions);
    if (!entries.length) return false;
    return entries.every(([name, value]) => !source[name] || source[name] === value);
  });
  if (relaxed.length === 1) return relaxed[0];
  return sourceVariants.length === 1 ? sourceVariants[0] : null;
}

function positiveNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function sourcePrice(product: NormalizedProduct, variant: any) {
  return positiveNumber(variant?.price) || positiveNumber(product.price);
}

function sourceInventory(variant: any): number | null {
  if (variant?.stockStatus === "out_of_stock" || variant?.available === false) return 0;
  if (variant?.stockStatus === "in_stock" || variant?.stockStatus === "low_stock") {
    return DEFAULT_IN_STOCK_QUANTITY;
  }
  return null;
}

async function getProductState(client: ShopifyGraphqlClient, productId: string) {
  const query = `
    query FirstFiveProduct($id: ID!) {
      product(id: $id) {
        id
        title
        handle
        status
        variants(first: 250) {
          nodes {
            id
            title
            price
            sku
            inventoryQuantity
            selectedOptions { name value }
            inventoryItem { id sku tracked }
          }
        }
      }
    }
  `;
  const data: any = await client.request(query, { id: productId });
  const product = data?.product;
  if (!product) return null;
  return { ...product, variants: product.variants?.nodes || [] };
}

async function findDbProduct(url: string, productCode: string) {
  const orFilters: any[] = [
    { url: { equals: url, mode: "insensitive" } },
    { url: { equals: canonicalizeUrl(url), mode: "insensitive" } },
  ];
  if (productCode) {
    orFilters.push(
      { productId: { contains: productCode, mode: "insensitive" } },
      { variants: { some: { sku: { contains: productCode, mode: "insensitive" } } } },
    );
  }

  const products = await prisma.sourceProduct.findMany({
    where: {
      shopifyProduct: { isNot: null },
      OR: orFilters,
    } as any,
    include: { shopifyProduct: true },
    take: 20,
  });
  const exact = products.find((product) => canonicalizeUrl(product.url) === canonicalizeUrl(url));
  const selected = exact || (products.length === 1 ? products[0] : null);
  return selected?.shopifyProduct?.shopifyId || null;
}

function titleSimilarity(left: string, right: string) {
  const a = new Set(clean(left).toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length > 2));
  const b = new Set(clean(right).toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length > 2));
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const word of a) if (b.has(word)) common += 1;
  return common / Math.max(a.size, b.size);
}

async function findShopifyProduct(
  client: ShopifyGraphqlClient,
  row: SheetRow,
  fresh: NormalizedProduct,
  productCode: string,
) {
  const dbId = await findDbProduct(row.normalizedUrl, productCode);
  if (dbId) {
    const state = await getProductState(client, dbId);
    if (state?.status === "ACTIVE") {
      return { product: state, ambiguous: false, matchSource: "database" as const };
    }
  }

  const code = compact(productCode);
  const vendor = sourceVendor(row.normalizedUrl);
  const freshTitle = clean(fresh.title);
  const sourceIdentifiers = [
    compact(fresh?.source?.productId),
    ...(fresh.variants || []).flatMap((variant: any) => [
      compact(variant?.sku),
      compact(variant?.sourceVariantId),
    ]),
  ]
    .filter((value, index, values) => value.length >= 5 && values.indexOf(value) === index)
    .slice(0, 8);
  const query = `
    query FirstFiveFind($query: String!) {
      products(first: 20, query: $query) {
        nodes {
          id
          title
          handle
          vendor
          status
          variants(first: 250) {
            nodes {
              id
              title
              price
              sku
              inventoryQuantity
              selectedOptions { name value }
              inventoryItem { id sku tracked }
            }
          }
        }
      }
    }
  `;

  const found = new Map<string, any>();
  const vendorFilter = vendor ? `vendor:${shopifySearchValue(vendor)} AND ` : "";
  const queryTexts: Array<{ label: string; queryText: string }> = [];
  if (freshTitle) {
    queryTexts.push({
      label: `title:${freshTitle}`,
      queryText: `${vendorFilter}title:${shopifySearchValue(freshTitle)}`,
    });
    if (vendorFilter) {
      queryTexts.push({
        label: `title-any-vendor:${freshTitle}`,
        queryText: `title:${shopifySearchValue(freshTitle)}`,
      });
    }
  }
  for (const identifier of sourceIdentifiers) {
    queryTexts.push({
      label: `sku:${identifier}`,
      queryText: `${vendorFilter}sku:${identifier}*`,
    });
    if (vendorFilter) {
      queryTexts.push({
        label: `sku-any-vendor:${identifier}`,
        queryText: `sku:${identifier}*`,
      });
    }
  }
  if (code) {
    queryTexts.push({
      label: `code:${code}`,
      queryText: `${vendorFilter}${shopifySearchValue(code)}`,
    });
    if (vendorFilter) {
      queryTexts.push({
        label: `code-any-vendor:${code}`,
        queryText: shopifySearchValue(code),
      });
    }
  }

  for (const request of queryTexts) {
    try {
      const data: any = await client.request(query, { query: request.queryText });
      for (const product of data?.products?.nodes || []) {
        if (product?.id) {
          found.set(product.id, { ...product, variants: product.variants?.nodes || [] });
        }
      }
    } catch (error) {
      console.warn("[first5-reconcile] Shopify search term failed", {
        term: request.label,
        error: clean((error as any)?.message || error),
      });
    }
  }

  const candidates = [...found.values()];
  if (!candidates.length) return { product: null, ambiguous: false, matchSource: "shopify_fallback" as const };

  const existingSku = clean(row.existingSku).toUpperCase();
  const scored = candidates
    .map((product) => {
      let score = 0;
      const productText = compact(`${product.title} ${product.handle}`);
      const candidateVendor = clean(product.vendor).toLowerCase();
      const expectedVendor = vendor.toLowerCase();
      const candidateSkus = product.variants
        .map((variant: any) => compact(variant?.inventoryItem?.sku || variant?.sku))
        .filter(Boolean);
      const exactExistingSku = Boolean(
        existingSku &&
          product.variants.some(
            (variant: any) =>
              clean(variant?.inventoryItem?.sku || variant?.sku).toUpperCase() ===
              existingSku,
          ),
      );
      const codeIdentity = Boolean(
        code &&
          (productText.includes(code) ||
            candidateSkus.some((sku: string) => sku.includes(code))),
      );
      const sourceIdentity = sourceIdentifiers.some((identifier) =>
        candidateSkus.some(
          (sku: string) => sku.includes(identifier) || identifier.includes(sku),
        ),
      );
      if (expectedVendor && candidateVendor === expectedVendor) score += 15;
      if (freshTitle && clean(product.title).toLowerCase() === freshTitle.toLowerCase()) score += 50;
      if (code && productText.includes(code)) score += 30;
      if (exactExistingSku) score += 100;
      if (code && candidateSkus.some((sku: string) => sku.includes(code))) score += 50;
      if (sourceIdentity) score += 90;
      score += Math.round(titleSimilarity(fresh.title, product.title) * 30);
      return {
        product,
        score,
        identityMatch: exactExistingSku || codeIdentity || sourceIdentity,
      };
    })
    .sort((a, b) => b.score - a.score);

  if (scored.length === 1 && scored[0].score >= 30 && scored[0].identityMatch) {
    return { product: scored[0].product, ambiguous: false, matchSource: "shopify_fallback" as const };
  }
  if (scored.length === 1) {
    return { product: null, ambiguous: true, matchSource: "shopify_fallback" as const };
  }
  if (
    scored[0].score > scored[1].score &&
    scored[0].score >= 20 &&
    scored[0].identityMatch
  ) {
    return { product: scored[0].product, ambiguous: false, matchSource: "shopify_fallback" as const };
  }
  return { product: null, ambiguous: true, matchSource: "shopify_fallback" as const };
}

function resultRows(group: PlanGroup) {
  return group.rows.map((row) => ({
    sheetName: row.sheet.name,
    sheetId: row.sheet.sheetId,
    rowNumber: row.rowNumber,
  }));
}

async function reconcileGroup(
  client: ShopifyGraphqlClient,
  locationId: string,
  group: PlanGroup,
  freshOverride?: NormalizedProduct,
): Promise<GroupResult> {
  if (group.multiplier === null) {
    return {
      status: "conflict",
      url: group.url,
      rows: resultRows(group),
      multiplier: null,
      reason: `The same source URL has conflicting multipliers: ${group.conflictMultipliers.join(", ")}. No Shopify write was made.`,
    };
  }

  const fresh = freshOverride || (await scraperService.scrape(group.rows[0].url));
  const codeRaw = rawProductCode(group.url, fresh);
  if (!codeRaw) throw new Error("Could not determine a stable source product code");
  const productCode = formatProductCode(codeRaw);
  const located = await findShopifyProduct(client, group.rows[0], fresh, codeRaw);

  if (located.ambiguous) {
    return {
      status: "ambiguous",
      url: group.url,
      rows: resultRows(group),
      multiplier: group.multiplier,
      productCode,
      matchSource: located.matchSource,
      reason: "More than one ACTIVE Shopify product matched with the same confidence. No automatic write was made.",
    };
  }
  if (!located.product) {
    return {
      status: "missing",
      url: group.url,
      rows: resultRows(group),
      multiplier: group.multiplier,
      productCode,
      matchSource: located.matchSource,
      reason: "No existing ACTIVE Shopify product could be matched safely. No product was created.",
    };
  }

  const product = located.product;
  const sourceVariants = Array.isArray(fresh.variants) && fresh.variants.length
    ? fresh.variants
    : [
        {
          sourceVariantId: fresh.source.productId || codeRaw,
          price: fresh.price,
          available: true,
          stockStatus: "unknown",
          optionValues: {},
        },
      ];

  if (
    fresh.raw?.repairedFlattenedNextVariants === true &&
    product.variants.length < sourceVariants.length
  ) {
    return {
      status: "rebuild_required",
      url: group.url,
      rows: resultRows(group),
      multiplier: group.multiplier,
      productCode,
      shopifyProductId: product.id,
      shopifyHandle: clean(product.handle),
      shopifyTitle: clean(product.title),
      variantsChecked: product.variants.length,
      matchSource: located.matchSource,
      reason:
        `Shopify variant structure is incomplete (${product.variants.length}/${sourceVariants.length}) ` +
        "and was matched safely for a handle-preserving rebuild.",
    };
  }

  const singleVariant = product.variants.length === 1;
const titleSizeToken = singleVariant
  ? explicitTitleSizeToken(product.title)
  : null;
if (singleVariant && /\s-\sSize\s+/i.test(clean(product.title)) && !titleSizeToken) {
  throw new Error("Single-variant Shopify product has an explicit title size that could not be normalized safely");
}

const mapped = product.variants.map((current: any) => {
  if (singleVariant && titleSizeToken) {
    const sizeMatches = sourceVariants.filter((variant) => {
      const source = sourceOptions(variant);
      return normalizeSizeToken(source.size || (variant as any)?.size || "") === titleSizeToken;
    });
    if (sizeMatches.length === 1) {
      return { current, source: sizeMatches[0], forcedSizeToken: titleSizeToken };
    }
    if (sourceVariants.length === 1) {
      return { current, source: sourceVariants[0], forcedSizeToken: titleSizeToken };
    }
    return { current, source: null, forcedSizeToken: titleSizeToken };
  }
  return {
    current,
    source: matchSourceVariant(current, sourceVariants),
    forcedSizeToken: null,
  };
});
  const unmapped = mapped.filter((entry: any) => !entry.source);
  if (unmapped.length) {
    throw new Error(`Could not map ${unmapped.length}/${mapped.length} Shopify variants to fresh source variants`);
  }

  const canonicalCandidates = mapped
    .map((entry: any) => ({
      ...entry,
      sizeToken:
      entry.forcedSizeToken ||
      normalizeSizeToken(entry.source?.size || sourceOptions(entry.source).size || ""),
    }))
    .sort((a: any, b: any) => sizeRank(a.sizeToken) - sizeRank(b.sizeToken));
  const canonical = canonicalCandidates[0];
  if (!canonical) throw new Error("No canonical variant could be selected");
  if (mapped.length > 1 && !canonical.sizeToken) {
    throw new Error("Multiple variants exist but a canonical size could not be determined safely");
  }

  const canonicalSize = canonical.sizeToken || "ONE";
  const expectedSku = `DAB-${brandCode(group.url)}-${productCode}-${canonicalSize}-${Number.isInteger(group.multiplier) ? String(group.multiplier) : String(group.multiplier)}`.slice(0, 64);
  const variantUpdates: any[] = [];
  const inventoryUpdates: Array<{ inventoryItemId: string; quantity: number; variantId: string }> = [];
  const expected = new Map<string, { price: number; sku?: string; inventory?: number }>();
  let pricesChanged = 0;
  let inventoryChanged = 0;
  let skuChanged = false;

  for (const entry of mapped as any[]) {
    const priceBase = sourcePrice(fresh, entry.source);
    if (!priceBase) throw new Error(`Fresh source price is missing for Shopify variant ${entry.current.title || entry.current.id}`);
    const price = Number((priceBase * group.multiplier).toFixed(2));
    const inventory = sourceInventory(entry.source);
    const isCanonical = entry.current.id === canonical.current.id;
    const currentSku = clean(entry.current?.inventoryItem?.sku || entry.current?.sku);
    const update: any = { id: entry.current.id, price: price.toFixed(2) };
    const inventoryItem: any = {};

    if (isCanonical && currentSku !== expectedSku) {
      inventoryItem.sku = expectedSku;
      skuChanged = true;
    }
    if (inventory !== null && entry.current?.inventoryItem?.id) {
      if (entry.current?.inventoryItem?.tracked !== true) inventoryItem.tracked = true;
      if (Number(entry.current?.inventoryQuantity) !== inventory) inventoryChanged += 1;
      inventoryUpdates.push({
        inventoryItemId: entry.current.inventoryItem.id,
        quantity: inventory,
        variantId: entry.current.id,
      });
    }
    if (Object.keys(inventoryItem).length) update.inventoryItem = inventoryItem;
    if (Math.abs(Number(entry.current.price) - price) >= 0.01) pricesChanged += 1;
    variantUpdates.push(update);
    expected.set(entry.current.id, {
      price,
      ...(isCanonical ? { sku: expectedSku } : {}),
      ...(inventory !== null ? { inventory } : {}),
    });
  }

  const updateResponse: any = await ShopifyService.updateVariantsBulk(client, product.id, variantUpdates);
  const variantErrors = updateResponse?.productVariantsBulkUpdate?.userErrors || [];
  if (variantErrors.length) throw new Error(`Shopify variant update failed: ${variantErrors[0].message}`);

  if (inventoryUpdates.length) {
    const inventoryResponse: any = await ShopifyService.setInventoryQuantities(client, {
      locationId,
      referenceDocumentUri: `https://datauplode.vercel.app/products?source=${encodeURIComponent(group.url)}`,
      quantities: inventoryUpdates.map((entry) => ({
        inventoryItemId: entry.inventoryItemId,
        quantity: entry.quantity,
      })),
    });
    const inventoryErrors = inventoryResponse?.inventorySetQuantities?.userErrors || [];
    if (inventoryErrors.length) throw new Error(`Shopify inventory update failed: ${inventoryErrors[0].message}`);
  }

  const after = await getProductState(client, product.id);
  if (!after) throw new Error("Shopify product disappeared during read-back");
  const afterMap = new Map(after.variants.map((variant: any) => [variant.id, variant]));
  const readbackVerified = [...expected.entries()].every(([variantId, expectation]) => {
    const variant: any = afterMap.get(variantId);
    if (!variant) return false;
    if (Math.abs(Number(variant.price) - expectation.price) >= 0.01) return false;
    if (expectation.sku !== undefined && clean(variant?.inventoryItem?.sku || variant?.sku) !== expectation.sku) return false;
    if (expectation.inventory !== undefined && Number(variant.inventoryQuantity) !== expectation.inventory) return false;
    return true;
  });
  if (!readbackVerified) throw new Error("Shopify read-back did not match expected price/SKU/inventory values");

  return {
    status: "verified",
    url: group.url,
    rows: resultRows(group),
    multiplier: group.multiplier,
    productCode,
    shopifyProductId: product.id,
    shopifyTitle: product.title,
    expectedSku,
    canonicalSize,
    variantsChecked: mapped.length,
    pricesChanged,
    inventoryChanged,
    skuChanged,
    readbackVerified: true,
    matchSource: located.matchSource,
  };
}

export async function reconcileExistingShopifyProductForImport(params: {
  client: ShopifyGraphqlClient;
  locationId: string;
  url: string;
  rowNumber: number;
  multiplier: number;
  collection?: string;
  sheetId?: number;
  sheetName?: string;
  existingSku?: string;
  fresh: NormalizedProduct;
}) {
  const normalizedUrl = canonicalizeUrl(params.url);
  const sheet = {
    name: "الورقة7",
    gid: Number.isFinite(params.sheetId) ? Number(params.sheetId) : 93159589,
    sheetId: Number.isFinite(params.sheetId) ? Number(params.sheetId) : 93159589,
    columnCount: 4,
  } as unknown as SheetConfig;
  const row: SheetRow = {
    sheet,
    rowNumber: params.rowNumber,
    url: params.url,
    normalizedUrl,
    multiplier: params.multiplier,
    collection: clean(params.collection),
    existingSku: clean(params.existingSku),
  };

  return reconcileGroup(
    params.client,
    params.locationId,
    {
      url: normalizedUrl,
      rows: [row],
      multiplier: params.multiplier,
      conflictMultipliers: [],
    },
    params.fresh,
  );
}

async function persistResult(result: GroupResult) {
  await prisma.importBatch.create({
    data: {
      status: result.status === "verified" ? "COMPLETED" : "PARTIAL",
      target: "first5_reconcile",
      productIds: result.shopifyProductId || "",
      payloadJson: JSON.stringify({
        mode: "existing_products_only",
        createProducts: false,
        rebuildProducts: false,
        result,
        completedAt: new Date().toISOString(),
      }),
    },
  });
}

export function googleWriterConfigured() {
  if (clean(process.env.GOOGLE_SHEETS_ACCESS_TOKEN)) return true;
  return Boolean(
    clean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) &&
      clean(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY_BASE64 || process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY),
  );
}

function base64Url(value: string | Buffer) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function googleAccessToken() {
  const direct = clean(process.env.GOOGLE_SHEETS_ACCESS_TOKEN);
  if (direct) return direct;
  if (googleTokenCache && googleTokenCache.expiresAt > Date.now() + 60_000) return googleTokenCache.token;

  const email = clean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
  const encodedKey = clean(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY_BASE64);
  const privateKey = encodedKey
    ? Buffer.from(encodedKey, "base64").toString("utf8")
    : String(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!email || !privateKey) throw new Error("Google Sheets writer credentials are missing in Railway");

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(JSON.stringify({
    iss: email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claim}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${base64Url(signer.sign(privateKey))}`;
  const response = await axios.post(
    "https://oauth2.googleapis.com/token",
    new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    { timeout: 20000, headers: { "Content-Type": "application/x-www-form-urlencoded" } },
  );
  const accessToken = clean(response.data?.access_token);
  if (!accessToken) throw new Error("Google did not return an access token");
  googleTokenCache = {
    token: accessToken,
    expiresAt: Date.now() + Number(response.data?.expires_in || 3600) * 1000,
  };
  return accessToken;
}

async function writeVerifiedSkuToSheet(result: GroupResult) {
  if (result.status !== "verified" || !result.expectedSku || !result.readbackVerified) return 0;
  return writeSkuCellsToSheet(
    result.rows.map((row) => ({
      sheetId: row.sheetId,
      rowNumber: row.rowNumber,
      sku: result.expectedSku!,
    })),
  );
}

export async function writeSkuCellsToSheet(
  updates: Array<{ sheetId: number; rowNumber: number; sku: string }>,
) {
  const requests = updates
    .filter(
      (entry) =>
        Number.isSafeInteger(entry.sheetId) &&
        Number.isSafeInteger(entry.rowNumber) &&
        entry.rowNumber > 0 &&
        clean(entry.sku),
    )
    .map((entry) => ({
    updateCells: {
      range: {
        sheetId: entry.sheetId,
        startRowIndex: entry.rowNumber - 1,
        endRowIndex: entry.rowNumber,
        startColumnIndex: 3,
        endColumnIndex: 4,
      },
      rows: [{ values: [{ userEnteredValue: { stringValue: clean(entry.sku) } }] }],
      fields: "userEnteredValue",
    },
  }));
  if (!requests.length) return 0;
  const accessToken = await googleAccessToken();
  await axios.post(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`,
    { requests },
    {
      timeout: 30000,
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    },
  );
  return requests.length;
}

async function updateMarker(markerId: string, payload: Record<string, any>) {
  await prisma.syncJob.update({
    where: { id: markerId },
    data: { result: JSON.stringify(payload) },
  });
}

async function processWithRetries(
  client: ShopifyGraphqlClient,
  locationId: string,
  group: PlanGroup,
  totals: Totals,
) {
  let lastError = "";
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay) {
      totals.retries += 1;
      await sleep(delay);
    }
    try {
      return await reconcileGroup(client, locationId, group);
    } catch (error: any) {
      lastError = clean(error?.message || error).slice(0, 3000);
      const blockedSource = /(?:HTTP\s*403|blocked automated server access|access denied|security verification|cloudflare)/i.test(lastError);
      console.warn("[first5-reconcile] group attempt failed", {
        url: group.url,
        rows: resultRows(group),
        attempt: attempt + 1,
        blockedSource,
        error: lastError,
      });
      if (blockedSource) break;
    }
  }
  return {
    status: "error" as const,
    url: group.url,
    rows: resultRows(group),
    multiplier: group.multiplier,
    reason: lastError || "Unknown reconcile error",
  };
}

function addResultToTotals(result: GroupResult, totals: Totals) {
  if (result.status === "verified") {
    totals.verifiedGroups += 1;
    totals.verifiedRows += result.rows.length;
  } else if (result.status === "missing") totals.missing += result.rows.length;
  else if (result.status === "ambiguous") totals.ambiguous += result.rows.length;
  else if (result.status === "conflict") totals.conflicts += result.rows.length;
  else if (result.status === "invalid") totals.invalid += result.rows.length;
  else totals.errors += result.rows.length;
}

async function runContinuousFirstFive() {
  const marker = await prisma.syncJob.create({
    data: {
      type: MARKER_TYPE,
      status: "running",
      startedAt: new Date(),
      payload: JSON.stringify({
        mode: "existing_products_only",
        createProducts: false,
        rebuildProducts: false,
        spreadsheetId: SPREADSHEET_ID,
        sheets: FIRST_FIVE_SHEETS.map(({ name, gid, sheetId }) => ({ name, gid, sheetId })),
        concurrency: CONCURRENCY,
        continuous: true,
      }),
    },
  });

  const totals: Totals = {
    passes: 0,
    groupsAttempted: 0,
    verifiedGroups: 0,
    verifiedRows: 0,
    errors: 0,
    missing: 0,
    ambiguous: 0,
    conflicts: 0,
    invalid: 0,
    retries: 0,
    sheetCells: 0,
    sheetErrors: 0,
    skippedPreviouslyVerifiedRows: 0,
  };
  const issues: GroupResult[] = [];
  let sheetWriteEnabled = googleWriterConfigured();
  let sheetWriteDisabledReason = sheetWriteEnabled
    ? ""
    : "Google writer credentials are not configured in Railway; verified SKU cells require external/backfill writing.";

  try {
    const client = await ShopifyService.getClientFromDb(prisma);
    const location = await ShopifyService.getInventoryLocation(client);

    while (true) {
      totals.passes += 1;
      const verifiedRows = await loadPreviouslyVerifiedRows();
      totals.skippedPreviouslyVerifiedRows = verifiedRows.size;
      const loaded = await loadAllRows();
      const plan = buildGroups(loaded.valid, verifiedRows);

      for (const invalid of loaded.invalid) {
        const key = `${invalid.sheet.sheetId}:${invalid.rowNumber}`;
        if (verifiedRows.has(key)) continue;
        const result: GroupResult = {
          status: "invalid",
          url: canonicalizeUrl(invalid.url),
          rows: [{ sheetName: invalid.sheet.name, sheetId: invalid.sheet.sheetId, rowNumber: invalid.rowNumber }],
          multiplier: null,
          reason: invalid.reason,
        };
        issues.push(result);
      }

      await updateMarker(marker.id, {
        stage: plan.length ? "full_run" : "idle_complete",
        pass: totals.passes,
        planGroups: plan.length,
        loadedRows: loaded.valid.length,
        invalidRows: loaded.invalid.length,
        previouslyVerifiedRows: verifiedRows.size,
        sheetWriteEnabled,
        sheetWriteDisabledReason,
        sheetBackfillRequired: !sheetWriteEnabled,
        totals,
        issues: issues.slice(-100),
      });

      if (!plan.length) {
        console.log("[first5-reconcile] first five sheets are fully verified for all currently processable rows; polling for new/changed rows");
        await sleep(PASS_DELAY_MS);
        continue;
      }

      for (let index = 0; index < plan.length; index += CONCURRENCY) {
        const chunk = plan.slice(index, index + CONCURRENCY);
        const results = await Promise.all(
          chunk.map(async (group) => {
            totals.groupsAttempted += 1;
            const result = await processWithRetries(client, location.id, group, totals);
            addResultToTotals(result, totals);
            await persistResult(result);

            if (result.status === "verified" && sheetWriteEnabled) {
              try {
                const written = await writeVerifiedSkuToSheet(result);
                totals.sheetCells += written;
                result.sheetWritten = written > 0;
              } catch (error: any) {
                totals.sheetErrors += 1;
                sheetWriteEnabled = false;
                sheetWriteDisabledReason = clean(error?.message || error).slice(0, 2000);
                console.error("[first5-reconcile] Google Sheet writeback disabled", sheetWriteDisabledReason);
              }
            }

            if (result.status !== "verified") issues.push(result);
            return result;
          }),
        );

        const processed = Math.min(index + chunk.length, plan.length);
        await updateMarker(marker.id, {
          stage: "full_run",
          pass: totals.passes,
          planGroups: plan.length,
          batch: processed,
          totalBatches: plan.length,
          lastResults: results,
          sheetWriteEnabled,
          sheetWriteDisabledReason,
          sheetBackfillRequired: !sheetWriteEnabled,
          createProducts: 0,
          rebuildProducts: 0,
          totals,
          issues: issues.slice(-100),
        });
        console.log(`[first5-reconcile] pass ${totals.passes} processed ${processed}/${plan.length}`, totals);
        await sleep(CHUNK_DELAY_MS);
      }

      await updateMarker(marker.id, {
        stage: "pass_complete",
        pass: totals.passes,
        sheetWriteEnabled,
        sheetWriteDisabledReason,
        sheetBackfillRequired: !sheetWriteEnabled,
        createProducts: 0,
        rebuildProducts: 0,
        totals,
        issues: issues.slice(-100),
      });
      await sleep(PASS_DELAY_MS);
    }
  } catch (error: any) {
    const message = clean(error?.message || error || "Unknown first-five reconcile failure").slice(0, 5000);
    await prisma.syncJob.update({
      where: { id: marker.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        result: JSON.stringify({
          stage: "failed",
          error: message,
          sheetWriteEnabled,
          sheetWriteDisabledReason,
          sheetBackfillRequired: !sheetWriteEnabled,
          createProducts: 0,
          rebuildProducts: 0,
          totals,
          issues: issues.slice(-200),
        }),
      },
    });
    console.error("[first5-reconcile] worker failed", message);
  }
}

export function startFirstFiveSheetsReconcile(_port: number) {
  const isRailway = Boolean(envString("RAILWAY_ENVIRONMENT") || envString("RAILWAY_PUBLIC_DOMAIN"));
  if (!isProduction() || !isRailway) {
    console.log("[first5-reconcile] continuous worker disabled outside Railway production");
    return;
  }
  if (started) return;
  started = true;
  setTimeout(() => {
    void runContinuousFirstFive().catch((error) => {
      console.error("[first5-reconcile] unexpected fatal startup error", error);
    });
  }, START_DELAY_MS);
}
