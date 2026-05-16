export type ExtractedProductRow = {
  id: string;
  sourceUrl: string;
  canonicalUrl?: string;
  title: string;
  normalizedJson: string;
  rawJson?: string;
  confidence: number;
  status: "DRAFT" | "NEEDS_REVIEW" | "READY" | "FAILED" | "RESTRICTED";
  warnings: Array<{ id: string; code: string; message: string; field?: string }>;
  source?: { id: string; name: string; domain: string; status: string };
  updatedAt: string;
};

export type NormalizedProduct = {
  source: { url: string; canonicalUrl?: string; domain: string; adapter: string; extractedAt: string };
  identity: { title: string; sku?: string; brand?: string; vendor?: string };
  content: { descriptionText?: string; descriptionHtml?: string };
  pricing: { price?: number; compareAtPrice?: number; currency?: string; rawPriceText?: string };
  media: { images: Array<{ url: string; alt?: string; source?: string }> };
  options: Array<{ name: string; values: string[] }>;
  variants: Array<{ title?: string; sku?: string; optionValues: Record<string, string>; price?: number; currency?: string; image?: string; inStock?: boolean }>;
  confidence: { overall: number; title: number; price: number; images: number; variants: number; description: number };
  warnings: Array<{ code: string; message: string; field?: string }>;
  raw?: unknown;
};
