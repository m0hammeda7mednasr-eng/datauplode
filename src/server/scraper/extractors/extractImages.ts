import * as cheerio from "cheerio";
import type { NormalizedProduct } from "../types/product.js";
import { bestFromSrcset, cleanText, getMeta, toAbsoluteUrl } from "./utils.js";

function rejectImage(url: string) {
  return /logo|icon|sprite|placeholder|payment|visa|mastercard|apple-pay|favicon|blank\./i.test(url);
}

export function extractImages(html: string, baseUrl: string): NormalizedProduct["media"]["images"] {
  const $ = cheerio.load(html);
  const images: NormalizedProduct["media"]["images"] = [];
  const push = (url: unknown, alt?: unknown, source: "open_graph" | "dom" = "dom") => {
    const absolute = toAbsoluteUrl(url, baseUrl);
    if (!absolute || rejectImage(absolute)) return;
    if (images.some((image) => image.url === absolute)) return;
    images.push({ url: absolute, alt: cleanText(alt) || undefined, source });
  };

  push(getMeta($, "og:image"), getMeta($, "og:title"), "open_graph");
  $("img[src], img[srcset]").each((_, element) => {
    const node = $(element);
    push(bestFromSrcset(node.attr("srcset"), baseUrl) || node.attr("src"), node.attr("alt"));
  });
  $("picture source[srcset]").each((_, element) => {
    push(bestFromSrcset($(element).attr("srcset"), baseUrl));
  });

  return images.slice(0, 40);
}
