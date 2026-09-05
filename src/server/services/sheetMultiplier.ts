const APPROVED_SHEET_MULTIPLIERS = new Set([22, 23, 24]);

function clean(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseRaw(raw: string | null | undefined): any {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function isApprovedSheetMultiplier(value: unknown): value is number {
  const numeric = Number(value);
  return Number.isInteger(numeric) && APPROVED_SHEET_MULTIPLIERS.has(numeric);
}

function approvedMultiplierFromSku(value: unknown): number | null {
  const sku = clean(value).toUpperCase();
  const match = sku.match(/-(22|23|24)(?:$|-[A-F0-9]{6}$)/);
  if (!match) return null;
  const multiplier = Number(match[1]);
  return isApprovedSheetMultiplier(multiplier) ? multiplier : null;
}

export function getApprovedSheetMultiplier(input: {
  raw?: string | null;
  variants?: Array<{ sku?: string | null; shopifyVariant?: { sku?: string | null } | null }> | null;
  shopifyProduct?: {
    variants?: Array<{ sku?: string | null }> | null;
  } | null;
}): number | null {
  const importMeta = parseRaw(input.raw)?.import || {};
  const rawMultiplier = Number(importMeta.sheetPriceMultiplier);
  if (isApprovedSheetMultiplier(rawMultiplier)) return rawMultiplier;

  const skus = [
    ...(input.variants || []).flatMap((variant) => [
      variant?.sku,
      variant?.shopifyVariant?.sku,
    ]),
    ...(input.shopifyProduct?.variants || []).map((variant) => variant?.sku),
  ];

  for (const sku of skus) {
    const multiplier = approvedMultiplierFromSku(sku);
    if (multiplier) return multiplier;
  }

  return null;
}
