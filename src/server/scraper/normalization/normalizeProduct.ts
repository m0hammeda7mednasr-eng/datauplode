import type { NormalizedProduct, ProductCandidate } from "../types/product.js";
import { NormalizedProductSchema } from "../types/product.js";
import { ScraperError } from "../types/errors.js";
import { scoreConfidence } from "./scoreConfidence.js";
import { generateWarnings } from "./generateWarnings.js";

function clean(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function mergeCandidates(candidates: ProductCandidate[]) {
  const merged: ProductCandidate = { images: [], options: [], variants: [], tags: [], raw: {}, signals: {} };
  for (const candidate of candidates) {
    merged.title ||= clean(candidate.title);
    merged.canonicalUrl ||= candidate.canonicalUrl;
    merged.handle ||= candidate.handle;
    merged.sku ||= candidate.sku;
    merged.barcode ||= candidate.barcode;
    merged.brand ||= candidate.brand;
    merged.vendor ||= candidate.vendor;
    merged.descriptionText ||= candidate.descriptionText;
    merged.descriptionHtml ||= candidate.descriptionHtml;
    merged.shortDescription ||= candidate.shortDescription;
    merged.bullets ||= candidate.bullets;
    merged.specs ||= candidate.specs;
    merged.price ??= candidate.price;
    merged.compareAtPrice ??= candidate.compareAtPrice;
    merged.currency ||= candidate.currency;
    merged.rawPriceText ||= candidate.rawPriceText;
    merged.category ||= candidate.category;
    merged.breadcrumbs ||= candidate.breadcrumbs;
    merged.productType ||= candidate.productType;
    merged.inStock ??= candidate.inStock;
    merged.quantity ??= candidate.quantity;
    merged.availabilityText ||= candidate.availabilityText;
    merged.tags = [...new Set([...(merged.tags || []), ...(candidate.tags || [])])];
    merged.images = [...(merged.images || []), ...(candidate.images || [])].filter(
      (image, index, all) => image.url && all.findIndex((item) => item.url === image.url) === index,
    );
    merged.options = (merged.options?.length ? merged.options : candidate.options) || [];
    merged.variants = (merged.variants?.length ? merged.variants : candidate.variants) || [];
    merged.raw = { ...(merged.raw || {}), ...(candidate.raw || {}) };
    merged.signals = { ...(merged.signals || {}), ...(candidate.signals || {}) };
  }
  return merged;
}

export function normalizeProduct(params: {
  sourceUrl: string;
  adapter: string;
  candidates: ProductCandidate[];
  html?: string;
}): NormalizedProduct {
  const url = new URL(params.sourceUrl);
  const candidate = mergeCandidates(params.candidates);
  const confidence = scoreConfidence(candidate);
  const product: NormalizedProduct = {
    source: {
      url: params.sourceUrl,
      canonicalUrl: candidate.canonicalUrl,
      domain: url.hostname,
      adapter: params.adapter,
      extractedAt: new Date().toISOString(),
    },
    identity: {
      title: clean(candidate.title) || "Untitled product",
      handle: candidate.handle,
      sku: candidate.sku,
      barcode: candidate.barcode,
      brand: candidate.brand,
      vendor: candidate.vendor || candidate.brand,
    },
    content: {
      descriptionText: candidate.descriptionText,
      descriptionHtml: candidate.descriptionHtml,
      shortDescription: candidate.shortDescription,
      bullets: candidate.bullets,
      specs: candidate.specs,
    },
    pricing: {
      price: candidate.price,
      compareAtPrice: candidate.compareAtPrice,
      currency: candidate.currency,
      rawPriceText: candidate.rawPriceText,
    },
    media: { images: (candidate.images || []).slice(0, 40) },
    classification: {
      category: candidate.category,
      breadcrumbs: candidate.breadcrumbs,
      tags: candidate.tags || [],
      productType: candidate.productType,
    },
    availability: {
      inStock: candidate.inStock,
      quantity: candidate.quantity,
      availabilityText: candidate.availabilityText,
    },
    options: candidate.options || [],
    variants: candidate.variants || [],
    confidence,
    warnings: generateWarnings(candidate, confidence),
    raw: {
      jsonLd: candidate.raw?.jsonLd,
      meta: candidate.raw?.meta as Record<string, string> | undefined,
      extractedHtmlSnippet: candidate.raw?.extractedHtmlSnippet as string | undefined,
      adapterResult: candidate.raw,
    },
  };
  const parsed = NormalizedProductSchema.safeParse(product);
  if (!parsed.success) {
    throw new ScraperError("INVALID_PRODUCT_DATA", "Extracted product failed validation.", parsed.error.flatten());
  }
  return parsed.data;
}
