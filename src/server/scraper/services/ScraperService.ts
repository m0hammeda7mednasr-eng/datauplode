import type { ExtractionResult, SourceAdapter, SourceInput, SourceTestResult } from "../types/source.js";
import { BrowserRenderedProductAdapter } from "../adapters/BrowserRenderedProductAdapter.js";
import { CsvFeedAdapter, JsonFeedAdapter, XmlFeedAdapter } from "../adapters/FeedAdapters.js";
import { ManualUrlAdapter } from "../adapters/ManualUrlAdapter.js";
import { SitemapProductDiscoveryAdapter } from "../adapters/SitemapProductDiscoveryAdapter.js";
import { StaticHtmlProductAdapter } from "../adapters/StaticHtmlProductAdapter.js";
import { ScraperError } from "../types/errors.js";

export class ProductExtractionEngine {
  private adapters: SourceAdapter[];

  constructor(adapters?: SourceAdapter[]) {
    this.adapters =
      adapters || [
        new CsvFeedAdapter(),
        new XmlFeedAdapter(),
        new JsonFeedAdapter(),
        new SitemapProductDiscoveryAdapter(),
        new ManualUrlAdapter(),
        new StaticHtmlProductAdapter(),
        new BrowserRenderedProductAdapter(),
      ];
  }

  async adapterFor(input: SourceInput) {
    for (const adapter of this.adapters) {
      if (await adapter.canHandle(input)) return adapter;
    }
    throw new ScraperError("INVALID_URL", `No source adapter can handle source type ${input.sourceType}.`);
  }

  async test(input: SourceInput): Promise<SourceTestResult> {
    return (await this.adapterFor(input)).test(input);
  }

  async extract(input: SourceInput): Promise<ExtractionResult> {
    return (await this.adapterFor(input)).extract(input);
  }
}

export const productExtractionEngine = new ProductExtractionEngine();
