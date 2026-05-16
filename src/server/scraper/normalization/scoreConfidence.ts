import type { ProductCandidate } from "../types/product.js";

export function scoreConfidence(candidate: ProductCandidate) {
  let overall = 0;
  const title = candidate.title ? 100 : 0;
  const price = Number.isFinite(candidate.price) ? 100 : 0;
  const images = candidate.images?.length ? 100 : 0;
  const variants = candidate.variants?.length || candidate.options?.length ? 100 : 0;
  const description = candidate.descriptionText || candidate.descriptionHtml ? 100 : 0;

  if (title) overall += 20;
  if (price) overall += 20;
  if (images) overall += 20;
  if (description) overall += 10;
  if (variants) overall += 10;
  if (candidate.signals?.jsonLd) overall += 10;
  if (candidate.canonicalUrl || candidate.signals?.canonical) overall += 5;
  if (candidate.sku || candidate.brand) overall += 5;

  return { overall, title, price, images, variants, description };
}
