export type SourceInput = {
  url: string;
  sourceType: "product_url" | "category_url" | "sitemap" | "csv_feed" | "xml_feed" | "json_feed";
  mode: "auto" | "static_html" | "browser_rendered" | "feed";
  allowedDomains?: string[];
  customSelectors?: Record<string, string>;
};

export type SourceRow = {
  id: string;
  name: string;
  baseUrl: string;
  domain: string;
  type: string;
  mode: string;
  status: string;
  updatedAt: string;
};
