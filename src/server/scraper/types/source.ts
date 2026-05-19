import type { NormalizedProduct } from "./product.js";

export type SourceType =
  | "product_url"
  | "category_url"
  | "sitemap"
  | "csv_feed"
  | "xml_feed"
  | "json_feed";

export type SourceMode = "auto" | "static_html" | "browser_rendered" | "feed";

export type ProductSelectors = {
  title?: string;
  price?: string;
  description?: string;
  images?: string;
  variants?: string;
  brand?: string;
  sku?: string;
};

export type SourceInput = {
  url?: string;
  brandKey?: string;
  sourceType: SourceType;
  allowedDomains?: string[];
  mode?: SourceMode;
  customSelectors?: ProductSelectors;
  rateLimit?: {
    requestsPerMinute: number;
    concurrency: number;
  };
};

export type SourceTestStatus =
  | "READY"
  | "PERMISSION_REQUIRED"
  | "SOURCE_RESTRICTED"
  | "ROBOTS_DISALLOWED"
  | "INVALID_URL"
  | "NETWORK_ERROR"
  | "JS_RENDER_REQUIRED"
  | "NO_PRODUCT_DATA_FOUND";

export type SourceTestResult = {
  ok: boolean;
  status: SourceTestStatus;
  reason?: string;
  recommendedMode?: "static_html" | "browser_rendered" | "feed" | "api";
};

export type ExtractionResult = {
  ok: boolean;
  status: SourceTestStatus | "EXTRACTED";
  products: NormalizedProduct[];
  warnings: string[];
  logs: string[];
};

export interface SourceAdapter {
  name: string;
  canHandle(input: SourceInput): Promise<boolean>;
  test(input: SourceInput): Promise<SourceTestResult>;
  extract(input: SourceInput): Promise<ExtractionResult>;
}

export type CategoryCrawlConfig = {
  startUrl: string;
  maxPages: number;
  maxProducts: number;
  includePatterns?: string[];
  excludePatterns?: string[];
  mode: "auto" | "static_html" | "browser_rendered";
};
