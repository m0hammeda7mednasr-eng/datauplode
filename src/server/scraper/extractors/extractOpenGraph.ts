import * as cheerio from "cheerio";
import type { ProductCandidate } from "../types/product.js";
import { parsePrice } from "./parsePrice.js";
import { cleanText, getMeta } from "./utils.js";

export function extractOpenGraph(html: string): Partial<ProductCandidate> {
  const $ = cheerio.load(html);
  const rawPrice = getMeta($, "product:price:amount");
  const parsed = parsePrice(rawPrice);
  const image = getMeta($, "og:image") || getMeta($, "twitter:image");
  return {
    canonicalUrl: $("link[rel='canonical']").attr("href"),
    title: cleanText(getMeta($, "og:title") || getMeta($, "twitter:title")),
    descriptionText: cleanText(getMeta($, "og:description") || getMeta($, "twitter:description")),
    price: parsed.amount,
    currency: getMeta($, "product:price:currency") || parsed.currency,
    rawPriceText: rawPrice || parsed.raw,
    images: image ? [{ url: image, source: "open_graph" }] : [],
    raw: {
      meta: Object.fromEntries(
        $("meta")
          .toArray()
          .map((node) => [$(node).attr("property") || $(node).attr("name"), $(node).attr("content")])
          .filter(([key, value]) => key && value) as Array<[string, string]>,
      ),
    },
    signals: { openGraph: true, canonical: Boolean($("link[rel='canonical']").attr("href")) },
  };
}
