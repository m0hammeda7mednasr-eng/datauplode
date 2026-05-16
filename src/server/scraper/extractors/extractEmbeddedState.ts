import * as cheerio from "cheerio";
import type { ProductCandidate } from "../types/product.js";
import { parsePrice } from "./parsePrice.js";
import { cleanText, parseJsonText } from "./utils.js";

function walk(value: unknown, visit: (node: any) => void, depth = 0, seen = new Set<unknown>()) {
  if (!value || typeof value !== "object" || depth > 8 || seen.has(value)) return;
  seen.add(value);
  if (!Array.isArray(value)) visit(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) walk(child, visit, depth + 1, seen);
}

function candidateFromObject(node: any): ProductCandidate | undefined {
  const title = cleanText(node.title || node.name || node.productName);
  const rawPrice = node.price || node.amount || node.salePrice || node.currentPrice || node.priceText;
  const images = node.images || node.image || node.media || node.gallery;
  const variants = node.variants || node.skus || node.items;
  const signals = [title, rawPrice, images, variants, node.sku, node.productId, node.handle].filter(Boolean).length;
  if (!title || signals < 2) return undefined;
  const parsed = parsePrice(Array.isArray(rawPrice) ? rawPrice[0] : rawPrice);
  const imageList = (Array.isArray(images) ? images : images ? [images] : [])
    .map((image: any) => (typeof image === "string" ? image : image?.url || image?.src || image?.imageUrl))
    .filter(Boolean)
    .map((url: string) => ({ url, source: "dom" as const }));
  return {
    title,
    handle: cleanText(node.handle || node.slug),
    sku: cleanText(node.sku || node.productId),
    brand: cleanText(node.brand?.name || node.brand),
    descriptionText: cleanText(node.description || node.descriptionText),
    price: parsed.amount,
    currency: cleanText(node.currency || node.priceCurrency) || parsed.currency,
    rawPriceText: parsed.raw,
    images: imageList,
    options: Array.isArray(node.options) ? node.options : [],
    variants: Array.isArray(variants)
      ? variants.map((variant: any) => ({
          title: cleanText(variant.title || variant.name),
          sku: cleanText(variant.sku || variant.id),
          optionValues: variant.optionValues || {},
          price: parsePrice(variant.price || variant.amount).amount,
          currency: cleanText(variant.currency) || parsed.currency,
          inStock: variant.available ?? variant.inStock,
          raw: variant,
        }))
      : [],
    raw: { embeddedState: node },
    signals: { embeddedState: true },
  };
}

export function extractEmbeddedState(html: string): ProductCandidate[] {
  const $ = cheerio.load(html);
  const roots: unknown[] = [];
  $("#__NEXT_DATA__, script#__NUXT__").each((_, element) => {
    const parsed = parseJsonText($(element).text());
    if (parsed) roots.push(parsed);
  });
  $("script[type='application/json']").each((_, element) => {
    const parsed = parseJsonText($(element).text());
    if (parsed) roots.push(parsed);
  });
  const scriptText = $("script").toArray().map((node) => $(node).html() || "").join("\n");
  for (const pattern of [
    /window\.__APOLLO_STATE__\s*=\s*({[\s\S]*?});/m,
    /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/m,
    /window\.ShopifyAnalytics\s*=\s*({[\s\S]*?});/m,
  ]) {
    const parsed = parseJsonText(scriptText.match(pattern)?.[1] || "");
    if (parsed) roots.push(parsed);
  }

  const products: ProductCandidate[] = [];
  for (const root of roots) {
    walk(root, (node) => {
      const candidate = candidateFromObject(node);
      if (candidate) products.push(candidate);
    });
  }
  return products.slice(0, 25);
}
