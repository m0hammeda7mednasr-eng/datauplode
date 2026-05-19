import type { NormalizedProduct, ProductCandidate, ProductWarning } from "../types/product.js";

export function generateWarnings(
  candidate: ProductCandidate,
  confidence: NormalizedProduct["confidence"],
): ProductWarning[] {
  const warnings: ProductWarning[] = [];
  if (!candidate.title) warnings.push({ code: "MISSING_TITLE", message: "Product title was not found.", field: "identity.title" });
  if (!Number.isFinite(candidate.price)) warnings.push({ code: "MISSING_PRICE", message: "Product price was not found.", field: "pricing.price" });
  if (!candidate.images?.length) warnings.push({ code: "MISSING_IMAGES", message: "No product images were found.", field: "media.images" });
  if (!candidate.variants?.length && !candidate.options?.length) warnings.push({ code: "NO_VARIANTS", message: "No variants or options were detected.", field: "variants" });
  if (candidate.rawPriceText && !Number.isFinite(candidate.price)) warnings.push({ code: "PRICE_PARSE_FAILED", message: "A price-like value was found but could not be parsed.", field: "pricing.price" });
  if (candidate.price && !candidate.currency) warnings.push({ code: "CURRENCY_UNKNOWN", message: "Currency could not be detected.", field: "pricing.currency" });
  const skus = (candidate.variants || []).map((variant) => variant.sku).filter(Boolean);
  if (new Set(skus).size !== skus.length) warnings.push({ code: "DUPLICATE_SKU", message: "Duplicate variant SKUs were detected.", field: "variants.sku" });
  if (confidence.overall < 70) warnings.push({ code: "LOW_CONFIDENCE", message: "Extraction needs manual review before import.", field: "confidence.overall" });
  return warnings;
}
