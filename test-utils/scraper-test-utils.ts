import type { NormalizedProduct } from "../src/server/services/scraper";

export function validateBasicProduct(product: NormalizedProduct): string[] {
  const issues: string[] = [];
  if (!product.title?.trim()) issues.push("missing title");
  if (!product.price || product.price <= 0)
    issues.push(`invalid price: ${product.price}`);
  if (!product.currency?.trim()) issues.push("missing currency");
  if (!product.images?.length) issues.push("no images");
  if (!product.variants?.length) issues.push("no variants");
  issues.push(...validateImportantBrandMedia(product));
  return issues;
}

export function validateImportantBrandMedia(product: NormalizedProduct): string[] {
  const supplier = String(product.source?.supplier || "").toLowerCase();
  const isImportantBrand =
    supplier === "next" || supplier === "zara" || supplier === "max fashion";
  if (!isImportantBrand || !product.images?.length || !product.variants?.length) {
    return [];
  }

  const imageUrls = new Set(product.images.map((image) => image.url).filter(Boolean));
  const variantWithoutImage = product.variants.find((variant) => !variant.imageUrl);
  const variantWithUnknownImage = product.variants.find(
    (variant) => variant.imageUrl && !imageUrls.has(variant.imageUrl),
  );
  const colors = [
    ...new Set(product.variants.map((variant) => variant.color).filter(Boolean)),
  ];
  const untaggedImage =
    colors.length === 1 && product.images.find((image) => !image.color);

  const issues: string[] = [];
  if (variantWithoutImage) issues.push("important brand variant missing imageUrl");
  if (variantWithUnknownImage)
    issues.push("important brand variant imageUrl is not in product images");
  if (untaggedImage) issues.push("important brand image missing color tag");
  return issues;
}

export function isManualSnapshotRequired(error: unknown): boolean {
  const typedError = error as {
    code?: string;
    retryWithSnapshot?: boolean;
    message?: string;
  };
  const message = String(typedError?.message || "");
  return (
    typedError?.code === "SOURCE_BLOCKED" ||
    typedError?.retryWithSnapshot === true ||
    /blocked automated server access|http 403/i.test(message)
  );
}
