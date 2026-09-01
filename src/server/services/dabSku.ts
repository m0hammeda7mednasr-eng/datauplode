import crypto from "node:crypto";
import type { NormalizedProduct } from "./scraper.js";

function clean(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function token(value: unknown, max = 24) {
  return clean(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
}

function compact(value: unknown) {
  return clean(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function shortHash(value: unknown, length = 8) {
  return crypto
    .createHash("sha1")
    .update(clean(value))
    .digest("hex")
    .slice(0, length)
    .toUpperCase();
}

export function isDabSku(value: unknown) {
  return /^DAB-[A-Z0-9]+-[A-Z0-9-]+$/i.test(clean(value));
}

export function dabBrandCode(url: string) {
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

function canonicalUrl(value: string) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.search = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return clean(value);
  }
}

function leftiesColorId(url: string) {
  try {
    return compact(new URL(url).searchParams.get("colorId"));
  } catch {
    return "";
  }
}

function urlProductCode(url: string) {
  try {
    const path = new URL(url).pathname;
    const next = path.match(/\/style\/[^/]+\/([^/?#]+)/i)?.[1];
    if (next) return compact(next);
    const shein = path.match(/-p-(\d+)\.html/i)?.[1];
    if (shein) return compact(shein);
    const productPath = path.match(/\/p\/([^/?#]+)/i)?.[1];
    if (productPath) return compact(productPath);
  } catch {}
  return "";
}

function formatProductCode(value: unknown) {
  const code = compact(value);
  if (!code) return "";
  if (code.length <= 3) return code;
  return `${code.slice(0, -3)}-${code.slice(-3)}`;
}

function boundedProductCode(value: unknown, identity: string) {
  const formatted = formatProductCode(value);
  if (!formatted) return "";
  if (formatted.length <= 26) return formatted;

  // Long source slugs (notably H&M) often share their first 26 characters
  // across different colours/patterns. Preserve a readable prefix but reserve
  // an 8-character stable hash so distinct source products cannot collapse to
  // the same DAB product code after truncation.
  const hash = shortHash(identity || formatted, 8);
  const prefix = compact(value).slice(0, Math.max(1, 26 - hash.length - 1));
  return `${prefix}-${hash}`;
}

export function dabProductCode(url: string, sourceProductId?: string) {
  const brand = dabBrandCode(url);
  const fromUrl = urlProductCode(url);
  let raw = brand === "NXT" && fromUrl ? fromUrl : compact(sourceProductId) || fromUrl;

  // Lefties reuses the same numeric productId for colour-specific product
  // pages. colorId is therefore part of the source-product identity and must
  // participate in the deterministic SKU product code.
  if (brand === "LFT") {
    const colorId = leftiesColorId(url);
    if (raw && colorId) raw = `${raw}${colorId}`;
  }

  if (raw) {
    const identity = `${brand}|${clean(sourceProductId)}|${canonicalUrl(url)}|${leftiesColorId(url)}`;
    return boundedProductCode(raw, identity);
  }

  return shortHash(canonicalUrl(url), 10);
}

function sizeToken(variant: NormalizedProduct["variants"][number]) {
  const optionValues = variant.optionValues || {};
  const optionSize = Object.entries(optionValues).find(([key]) =>
    /size|age|shoe|طول|مقاس/i.test(key),
  )?.[1];
  return token(variant.size || optionSize || "ONE", 20) || "ONE";
}

function multiplierToken(multiplier: number | null | undefined) {
  if (!Number.isFinite(Number(multiplier)) || Number(multiplier) <= 0) return "1";
  return String(Number(multiplier)).replace(/\.0+$/, "").replace(".", "P");
}

function sizeRank(value: string) {
  if (value === "NB") return -100;
  const month = value.match(/^(?:UP-TO-)?(\d+(?:P\d+)?)M$/);
  if (month) return Number(month[1].replace("P", "."));
  const year = value.match(/^(\d+(?:P\d+)?)Y$/);
  if (year) return Number(year[1].replace("P", ".")) * 12;
  const order: Record<string, number> = {
    XXS: 2000,
    XS: 2010,
    S: 2020,
    M: 2030,
    L: 2040,
    XL: 2050,
    XXL: 2060,
    ONE: 5000,
  };
  return order[value] ?? 3000;
}

export function applyDeterministicDabSkus(params: {
  product: NormalizedProduct;
  url: string;
  multiplier?: number | null;
  existingProductSku?: string | null;
}) {
  const { product, url } = params;
  const brand = dabBrandCode(url);
  const productCode = dabProductCode(url, product.source?.productId);
  const priceMultiplier = multiplierToken(params.multiplier);
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const ranked = variants
    .map((variant, index) => ({ index, size: sizeToken(variant) }))
    .sort((left, right) => sizeRank(left.size) - sizeRank(right.size) || left.index - right.index);
  const canonicalIndex = ranked[0]?.index ?? 0;
  const expectedProductPrefix = `DAB-${brand}-${productCode}-`;
  const existingSku = clean(params.existingProductSku).toUpperCase().slice(0, 64);
  const preferredSku =
    isDabSku(existingSku) && existingSku.startsWith(expectedProductPrefix)
      ? existingSku
      : "";
  const used = new Set<string>();
  let canonicalSku = "";

  product.variants = variants.map((variant, index) => {
    const size = sizeToken(variant);
    const base = `DAB-${brand}-${productCode}-${size}-${priceMultiplier}`.slice(0, 64);
    let sku = index === canonicalIndex && preferredSku ? preferredSku : base;
    if (used.has(sku)) {
      const color = token(variant.color || variant.optionValues?.Color || "", 10);
      const variantIdentity = clean(
        variant.sourceVariantId || variant.sku || `${color}|${size}|${index}`,
      );
      const suffix = shortHash(variantIdentity, 6);
      sku = `${base.slice(0, Math.max(1, 63 - suffix.length))}-${suffix}`;
    }
    used.add(sku);
    if (index === canonicalIndex) canonicalSku = sku;
    return { ...variant, sku };
  });

  if (!canonicalSku) {
    canonicalSku = preferredSku || `DAB-${brand}-${productCode}-ONE-${priceMultiplier}`.slice(0, 64);
  }

  return { canonicalSku, productCode, canonicalIndex };
}
