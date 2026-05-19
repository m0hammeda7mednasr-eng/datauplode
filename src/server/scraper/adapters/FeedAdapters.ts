import type { ExtractionResult, SourceAdapter, SourceInput, SourceTestResult } from "../types/source.js";
import type { ProductCandidate } from "../types/product.js";
import { ScraperError } from "../types/errors.js";
import { assertAllowedUrl, assertRobotsAllowed } from "../services/PermissionService.js";
import { normalizeProduct } from "../normalization/normalizeProduct.js";
import { parsePrice } from "../extractors/parsePrice.js";
import { cleanText } from "../extractors/utils.js";

function csvRows(text: string) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = (lines.shift() || "").split(",").map((header) => header.trim());
  return lines.map((line) => {
    const values = line.match(/("([^"]|"")*"|[^,]+)/g) || [];
    return Object.fromEntries(headers.map((header, index) => [header, values[index]?.replace(/^"|"$/g, "").replace(/""/g, '"') || ""]));
  });
}

function candidateFromRecord(record: any, url: string): ProductCandidate {
  const rawPrice = record.price || record.sale_price || record.amount || record["g:price"];
  const parsed = parsePrice(rawPrice);
  const image = record.image || record.image_link || record["g:image_link"];
  return {
    url: record.url || record.link || url,
    title: cleanText(record.title || record.name || record.product_name),
    sku: cleanText(record.sku || record.id || record.product_id),
    brand: cleanText(record.brand || record.vendor),
    descriptionText: cleanText(record.description),
    price: parsed.amount,
    currency: cleanText(record.currency) || parsed.currency,
    rawPriceText: parsed.raw,
    images: image ? [{ url: String(image), source: "feed" }] : [],
    variants: [],
    options: [],
    raw: { feedRecord: record },
  };
}

abstract class BaseFeedAdapter implements SourceAdapter {
  abstract name: string;
  abstract sourceType: SourceInput["sourceType"];
  abstract parse(text: string): ProductCandidate[];

  async canHandle(input: SourceInput) {
    return input.sourceType === this.sourceType || input.mode === "feed";
  }

  async test(input: SourceInput): Promise<SourceTestResult> {
    try {
      const result = await this.extract(input);
      return result.products.length ? { ok: true, status: "READY", recommendedMode: "feed" } : { ok: false, status: "NO_PRODUCT_DATA_FOUND" };
    } catch (error: any) {
      if (error instanceof ScraperError) return { ok: false, status: error.code as any, reason: error.message };
      return { ok: false, status: "NETWORK_ERROR", reason: error.message };
    }
  }

  async extract(input: SourceInput): Promise<ExtractionResult> {
    const url = assertAllowedUrl(input.url, input.allowedDomains);
    await assertRobotsAllowed(url);
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new ScraperError("NETWORK_ERROR", `Feed returned HTTP ${response.status}.`);
    const text = await response.text();
    const candidates = this.parse(text).slice(0, 500);
    const products = candidates
      .filter((candidate) => candidate.title || candidate.sku)
      .map((candidate) =>
        normalizeProduct({
          sourceUrl: candidate.url || url.toString(),
          adapter: this.name,
          candidates: [candidate],
        }),
      );
    return { ok: true, status: "EXTRACTED", products, warnings: [], logs: [`Parsed ${products.length} product(s).`] };
  }
}

export class CsvFeedAdapter extends BaseFeedAdapter {
  name = "csv_feed";
  sourceType = "csv_feed" as const;
  parse(text: string) {
    return csvRows(text).map((record) => candidateFromRecord(record, record.url || record.link || ""));
  }
}

export class JsonFeedAdapter extends BaseFeedAdapter {
  name = "json_feed";
  sourceType = "json_feed" as const;
  parse(text: string) {
    const parsed = JSON.parse(text);
    const items = Array.isArray(parsed) ? parsed : parsed.products || parsed.items || parsed.data || [];
    return (Array.isArray(items) ? items : []).map((record: any) => candidateFromRecord(record, record.url || record.link || ""));
  }
}

export class XmlFeedAdapter extends BaseFeedAdapter {
  name = "xml_feed";
  sourceType = "xml_feed" as const;
  parse(text: string) {
    const products = [...text.matchAll(/<(?:item|product)\b[\s\S]*?<\/(?:item|product)>/gi)].map((match) => match[0]);
    return products.map((xml) => {
      const get = (tag: string) => cleanText(xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, ""));
      return candidateFromRecord(
        {
          title: get("title") || get("name") || get("g:title"),
          description: get("description"),
          price: get("price") || get("g:price"),
          currency: get("currency") || get("g:currency"),
          image: get("image_link") || get("g:image_link") || get("image"),
          link: get("link") || get("url"),
          sku: get("sku") || get("id") || get("g:id"),
          brand: get("brand") || get("g:brand"),
        },
        "",
      );
    });
  }
}
