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

export function dabProductCode(url: string, sourceProductId?: string) {
  const brand = dabBrandCode(url);
  const fromUrl = urlProductCode(url);
  const raw = brand === "NXT" && fromUrl ? fromUrl : compact(sourceProductId) || fromUrl;
  if (raw) return formatProductCode(raw).slice(0, 26);
  return crypto
    .createHash("sha1")
    .update(canonicalUrl(url))
    .digest("hex")
    .slice(0, 10)
    .toUpperCase();
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
  const preferredSku = isDabSku(params.existingProductSku)
    ? clean(params.existingProductSku).toUpperCase().slice(0, 64)
    : "";
  const used = new Set<string>();
  let canonicalSku = "";

  product.variants = variants.map((variant, index) => {
    const size = sizeToken(variant);
    const base = `DAB-${brand}-${productCode}-${size}-${priceMultiplier}`.slice(0, 64);
    let sku = index === canonicalIndex && preferredSku ? preferredSku : base;
    if (used.has(sku)) {
      const color = token(variant.color || variant.optionValues?.Color || "", 10);
      const suffix = color ? `${color}-${index + 1}` : String(index + 1);
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
