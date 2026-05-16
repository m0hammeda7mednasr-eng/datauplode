import type * as cheerio from "cheerio";
import type { ProductCandidate } from "../types/product.js";
import type { ProductSelectors } from "../types/source.js";
import { parsePrice } from "./parsePrice.js";
import { cleanText, getMeta, toAbsoluteUrl } from "./utils.js";
import { extractImages } from "./extractImages.js";
import { extractVariants } from "./extractVariants.js";

const titleSelectors = ["h1", "[data-testid*='title']", "[class*='product-title']", "[class*='ProductTitle']", "[itemprop='name']"];
const priceSelectors = ["[itemprop='price']", "[class*='price']", "[data-testid*='price']", "meta[property='product:price:amount']"];
const descriptionSelectors = ["[itemprop='description']", "[class*='description']", "[data-testid*='description']", "#description", ".product-description"];

function firstText($: cheerio.CheerioAPI, selectors: string[]) {
  for (const selector of selectors) {
    const node = $(selector).first();
    const value = cleanText(node.attr("content") || node.text());
    if (value) return value;
  }
  return "";
}

export function extractDomProduct(
  $: cheerio.CheerioAPI,
  selectors: ProductSelectors | undefined,
  baseUrl: string,
): ProductCandidate {
  const html = $.html();
  const title = firstText($, [selectors?.title, ...titleSelectors].filter(Boolean) as string[]);
  const rawPrice = firstText($, [selectors?.price, ...priceSelectors].filter(Boolean) as string[]);
  const parsed = parsePrice(rawPrice);
  const description = firstText($, [selectors?.description, ...descriptionSelectors].filter(Boolean) as string[]);
  const canonical = toAbsoluteUrl($("link[rel='canonical']").attr("href"), baseUrl);
  const variants = extractVariants(html);

  return {
    canonicalUrl: canonical,
    title,
    brand: selectors?.brand ? cleanText($(selectors.brand).first().text()) : undefined,
    sku: selectors?.sku ? cleanText($(selectors.sku).first().text()) : undefined,
    descriptionText: description,
    price: parsed.amount,
    currency: getMeta($, "product:price:currency") || parsed.currency,
    rawPriceText: rawPrice,
    images: extractImages(html, baseUrl),
    options: variants.options,
    variants: variants.variants,
    raw: {
      extractedHtmlSnippet: html.slice(0, 2000),
    },
    signals: { dom: true, canonical: Boolean(canonical) },
  };
}
