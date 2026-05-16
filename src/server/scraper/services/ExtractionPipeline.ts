import * as cheerio from "cheerio";
import type { ProductSelectors } from "../types/source.js";
import type { ProductCandidate } from "../types/product.js";
import { extractJsonLdProducts } from "../extractors/extractJsonLdProducts.js";
import { extractEmbeddedState } from "../extractors/extractEmbeddedState.js";
import { extractOpenGraph } from "../extractors/extractOpenGraph.js";
import { extractDomProduct } from "../extractors/extractDomProduct.js";
import { normalizeProduct } from "../normalization/normalizeProduct.js";

export function extractProductFromHtml(params: {
  html: string;
  url: string;
  adapter: string;
  selectors?: ProductSelectors;
}) {
  const $ = cheerio.load(params.html);
  const jsonLd = extractJsonLdProducts(params.html);
  const embedded = extractEmbeddedState(params.html);
  const openGraph = extractOpenGraph(params.html);
  const dom = extractDomProduct($, params.selectors, params.url);
  const candidates: ProductCandidate[] = [
    ...jsonLd,
    ...embedded,
    openGraph,
    dom,
  ].filter((candidate) => candidate.title || candidate.price || candidate.images?.length);
  return normalizeProduct({
    sourceUrl: params.url,
    adapter: params.adapter,
    candidates,
    html: params.html,
  });
}
