import { z } from "zod";

export const ProductWarningCodeSchema = z.enum([
  "MISSING_TITLE",
  "MISSING_PRICE",
  "MISSING_IMAGES",
  "NO_VARIANTS",
  "DUPLICATE_SKU",
  "LOW_CONFIDENCE",
  "PRICE_PARSE_FAILED",
  "CURRENCY_UNKNOWN",
  "SOURCE_RESTRICTED",
  "ROBOTS_DISALLOWED",
  "PERMISSION_REQUIRED",
]);

export const NormalizedProductSchema = z.object({
  source: z.object({
    url: z.string().url(),
    canonicalUrl: z.string().url().optional(),
    domain: z.string().min(1),
    adapter: z.string().min(1),
    extractedAt: z.string().datetime(),
  }),
  identity: z.object({
    title: z.string().min(1),
    handle: z.string().optional(),
    sku: z.string().optional(),
    barcode: z.string().optional(),
    brand: z.string().optional(),
    vendor: z.string().optional(),
  }),
  content: z.object({
    descriptionText: z.string().optional(),
    descriptionHtml: z.string().optional(),
    shortDescription: z.string().optional(),
    bullets: z.array(z.string()).optional(),
    specs: z.record(z.string(), z.string()).optional(),
  }),
  pricing: z.object({
    price: z.number().nonnegative().optional(),
    compareAtPrice: z.number().nonnegative().optional(),
    currency: z.string().min(3).max(3).optional(),
    rawPriceText: z.string().optional(),
  }),
  media: z.object({
    images: z.array(
      z.object({
        url: z.string().url(),
        alt: z.string().optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        source: z.enum(["json_ld", "open_graph", "dom", "feed"]).optional(),
      }),
    ),
  }),
  classification: z.object({
    category: z.string().optional(),
    breadcrumbs: z.array(z.string()).optional(),
    tags: z.array(z.string()),
    productType: z.string().optional(),
  }),
  availability: z.object({
    inStock: z.boolean().optional(),
    quantity: z.number().int().nonnegative().optional(),
    availabilityText: z.string().optional(),
  }),
  options: z.array(
    z.object({
      name: z.string().min(1),
      values: z.array(z.string().min(1)),
    }),
  ),
  variants: z.array(
    z.object({
      title: z.string().optional(),
      sku: z.string().optional(),
      barcode: z.string().optional(),
      optionValues: z.record(z.string(), z.string()),
      price: z.number().nonnegative().optional(),
      compareAtPrice: z.number().nonnegative().optional(),
      currency: z.string().min(3).max(3).optional(),
      image: z.string().url().optional(),
      inStock: z.boolean().optional(),
      quantity: z.number().int().nonnegative().optional(),
      raw: z.unknown().optional(),
    }),
  ),
  confidence: z.object({
    overall: z.number().min(0).max(100),
    title: z.number().min(0).max(100),
    price: z.number().min(0).max(100),
    images: z.number().min(0).max(100),
    variants: z.number().min(0).max(100),
    description: z.number().min(0).max(100),
  }),
  warnings: z.array(
    z.object({
      code: ProductWarningCodeSchema,
      message: z.string(),
      field: z.string().optional(),
    }),
  ),
  raw: z
    .object({
      jsonLd: z.unknown().optional(),
      meta: z.record(z.string(), z.string()).optional(),
      extractedHtmlSnippet: z.string().optional(),
      adapterResult: z.unknown().optional(),
    })
    .optional(),
});

export type NormalizedProduct = z.infer<typeof NormalizedProductSchema>;
export type ProductWarning = NormalizedProduct["warnings"][number];

export type ProductCandidate = {
  url?: string;
  canonicalUrl?: string;
  title?: string;
  handle?: string;
  sku?: string;
  barcode?: string;
  brand?: string;
  vendor?: string;
  descriptionText?: string;
  descriptionHtml?: string;
  shortDescription?: string;
  bullets?: string[];
  specs?: Record<string, string>;
  price?: number;
  compareAtPrice?: number;
  currency?: string;
  rawPriceText?: string;
  images?: NormalizedProduct["media"]["images"];
  category?: string;
  breadcrumbs?: string[];
  tags?: string[];
  productType?: string;
  inStock?: boolean;
  quantity?: number;
  availabilityText?: string;
  options?: NormalizedProduct["options"];
  variants?: NormalizedProduct["variants"];
  raw?: Record<string, unknown>;
  signals?: {
    jsonLd?: boolean;
    openGraph?: boolean;
    embeddedState?: boolean;
    dom?: boolean;
    canonical?: boolean;
  };
};
