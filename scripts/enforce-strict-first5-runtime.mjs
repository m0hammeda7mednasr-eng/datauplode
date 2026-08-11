import fs from "node:fs";

const path = "src/server/firstFiveSheetsReconcile.ts";
let source = fs.readFileSync(path, "utf8");

const start = source.indexOf("async function findShopifyProduct(");
const end = source.indexOf("\nfunction resultRows(", start);
if (start < 0 || end < 0) {
  throw new Error("Could not locate first-five Shopify matcher");
}

const strictMatcher = `async function findShopifyProduct(
  client: ShopifyGraphqlClient,
  row: SheetRow,
  fresh: NormalizedProduct,
  productCode: string,
) {
  const dbId = await findDbProduct(row.normalizedUrl, productCode);
  if (dbId) {
    const state = await getProductState(client, dbId);
    if (state?.status === "ACTIVE") {
      return { product: state, ambiguous: false, matchSource: "database" as const };
    }
  }

  const vendor = sourceVendor(row.normalizedUrl);
  const freshTitle = clean(fresh.title);
  const sourceIdentifiers = [
    compact(fresh?.source?.productId),
    ...(fresh.variants || []).flatMap((variant: any) => [
      compact(variant?.sku),
      compact(variant?.sourceVariantId),
    ]),
  ]
    .filter((value, index, values) => value.length >= 5 && values.indexOf(value) === index)
    .slice(0, 12);

  if (!vendor || !freshTitle || sourceIdentifiers.length === 0) {
    return { product: null, ambiguous: true, matchSource: "shopify_fallback" as const };
  }

  const query = \`query FirstFiveFindStrict($query: String!) {
    products(first: 30, query: $query) {
      nodes {
        id title handle vendor status
        variants(first: 250) {
          nodes {
            id title price sku inventoryQuantity
            selectedOptions { name value }
            inventoryItem { id sku tracked }
          }
        }
      }
    }
  }\`;
  const vendorFilter = \`vendor:\${shopifySearchValue(vendor)}\`;
  const requests = [
    \`status:active AND \${vendorFilter} AND title:\${shopifySearchValue(freshTitle)}\`,
    ...sourceIdentifiers.map(
      (identifier) => \`status:active AND \${vendorFilter} AND sku:\${identifier}*\`,
    ),
  ];
  const found = new Map<string, any>();
  const searchErrors: string[] = [];

  for (const queryText of requests) {
    try {
      const data: any = await client.request(query, { query: queryText });
      for (const product of data?.products?.nodes || []) {
        if (product?.id && product.status === "ACTIVE") {
          found.set(product.id, {
            ...product,
            variants: product.variants?.nodes || [],
          });
        }
      }
    } catch (error) {
      console.warn("[first5-reconcile] strict Shopify search failed", {
        queryText,
        error: clean((error as any)?.message || error),
      });
      searchErrors.push(clean((error as any)?.message || error));
    }
  }

  const eligible = [...found.values()]
    .map((product) => {
      const vendorExact = clean(product.vendor).toLowerCase() === vendor.toLowerCase();
      const titleExact = clean(product.title).toLowerCase() === freshTitle.toLowerCase();
      const candidateSkus = product.variants
        .map((variant: any) => compact(variant?.inventoryItem?.sku || variant?.sku))
        .filter(Boolean);
      const identityExact = sourceIdentifiers.some((identifier) =>
        candidateSkus.some((sku: string) => sku === identifier),
      );
      const confidence =
        (vendorExact ? 30 : 0) +
        (titleExact ? 30 : 0) +
        (identityExact ? 60 : 0);
      return { product, vendorExact, titleExact, identityExact, confidence };
    })
    .filter(
      (entry) =>
        entry.vendorExact &&
        entry.titleExact &&
        entry.identityExact &&
        entry.confidence >= 120,
    );

  if (eligible.length === 1) {
    return {
      product: eligible[0].product,
      ambiguous: false,
      matchSource: "shopify_fallback" as const,
    };
  }
  if (eligible.length > 1) {
    return { product: null, ambiguous: true, matchSource: "shopify_fallback" as const };
  }
  if (searchErrors.length > 0) {
    return {
      product: null,
      ambiguous: true,
      matchSource: "shopify_fallback" as const,
      reason:
        "Shopify strict product search failed temporarily. No automatic create/update was made to avoid duplicate products.",
    };
  }
  return { product: null, ambiguous: false, matchSource: "shopify_fallback" as const };
}
`;

source = source.slice(0, start) + strictMatcher + source.slice(end);

if (!source.includes("Max product has multiple Shopify colors")) {
  const anchor = `  if (\n    fresh.raw?.repairedFlattenedNextVariants === true &&\n    product.variants.length < sourceVariants.length\n  ) {`;
  const guard = `  if (brandCode(group.url) === "MAX") {\n    const shopifyColors = new Set(\n      product.variants\n        .map((variant: any) => clean(shopifyOptions(variant).color).toLowerCase())\n        .filter(Boolean),\n    );\n    const sourceColors = new Set(\n      sourceVariants\n        .map((variant: any) => clean(sourceOptions(variant).color).toLowerCase())\n        .filter(Boolean),\n    );\n    if (shopifyColors.size > 1 && sourceColors.size <= 1) {\n      return {\n        status: "ambiguous",\n        url: group.url,\n        rows: resultRows(group),\n        multiplier: group.multiplier,\n        productCode,\n        shopifyProductId: product.id,\n        shopifyHandle: clean(product.handle),\n        shopifyTitle: clean(product.title),\n        matchSource: located.matchSource,\n        reason: "Max product has multiple Shopify colors but the source URL resolves to at most one explicit color. Color-scoped mapping is not explicit, so no variant write was made.",\n      };\n    }\n  }\n\n`;
  if (!source.includes(anchor)) {
    throw new Error("Could not locate Max multi-color guard anchor");
  }
  source = source.replace(anchor, guard + anchor);
}

fs.writeFileSync(path, source, "utf8");
console.log("Applied strict first-five Shopify matcher and Max multi-color guard");
