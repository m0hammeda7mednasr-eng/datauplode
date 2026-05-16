import * as cheerio from "cheerio";
import type { ProductCandidate } from "../types/product.js";
import { cleanText, flattenJsonLd, parseJsonText, unique } from "./utils.js";
import { parsePrice } from "./parsePrice.js";

function typeIncludes(value: unknown, wanted: string) {
  const types = Array.isArray(value) ? value : [value];
  return types.some((item) => String(item || "").toLowerCase() === wanted.toLowerCase());
}

function imageList(value: any) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values
    .map((image) => (typeof image === "string" ? image : image?.url || image?.contentUrl))
    .filter(Boolean)
    .map((url) => ({ url: String(url), source: "json_ld" as const }));
}

function firstOffer(product: any) {
  const offers = Array.isArray(product?.offers) ? product.offers : product?.offers ? [product.offers] : [];
  return offers[0] || {};
}

function brandName(value: any) {
  if (!value) return undefined;
  if (typeof value === "string") return cleanText(value);
  return cleanText(value.name);
}

export function extractJsonLdProducts(html: string): ProductCandidate[] {
  const $ = cheerio.load(html);
  const parsed: any[] = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    const text = $(element).text();
    const json = parseJsonText(text);
    if (json) parsed.push(...flattenJsonLd(json));
  });

  const breadcrumbs = parsed
    .filter((node) => typeIncludes(node["@type"], "BreadcrumbList"))
    .flatMap((list) => list.itemListElement || [])
    .map((item: any) => cleanText(item?.name || item?.item?.name))
    .filter(Boolean);

  return parsed
    .filter((node) => typeIncludes(node["@type"], "Product") || typeIncludes(node["@type"], "ProductGroup"))
    .map((product) => {
      const offer = firstOffer(product);
      const price = parsePrice(offer.price || offer.lowPrice || offer.highPrice || offer.priceSpecification?.price);
      const availability = cleanText(offer.availability || product.availability);
      return {
        title: cleanText(product.name),
        descriptionText: cleanText(product.description),
        sku: cleanText(product.sku),
        barcode: cleanText(product.gtin || product.gtin13 || product.gtin14 || product.mpn),
        brand: brandName(product.brand),
        vendor: brandName(product.manufacturer),
        price: price.amount,
        compareAtPrice: parsePrice(offer.highPrice).amount,
        currency: cleanText(offer.priceCurrency) || price.currency,
        rawPriceText: price.raw,
        images: imageList(product.image),
        category: cleanText(product.category),
        breadcrumbs: breadcrumbs.length ? unique(breadcrumbs) : undefined,
        inStock: availability ? !/outofstock|soldout|discontinued/i.test(availability) : undefined,
        availabilityText: availability,
        variants: Array.isArray(product.hasVariant)
          ? product.hasVariant.map((variant: any) => ({
              title: cleanText(variant.name),
              sku: cleanText(variant.sku),
              optionValues: {},
              price: parsePrice(firstOffer(variant).price).amount,
              currency: cleanText(firstOffer(variant).priceCurrency) || price.currency,
              raw: variant,
            }))
          : [],
        raw: { jsonLd: product },
        signals: { jsonLd: true },
      } satisfies ProductCandidate;
    });
}
