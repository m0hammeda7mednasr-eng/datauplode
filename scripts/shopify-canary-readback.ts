import axios from "axios";

type ExpectedVariant = {
  id?: string;
  sku: string;
  price: string | number;
};

type ShopifyVariant = {
  id: string;
  sku: string | null;
  price: string;
  inventoryItem?: { sku?: string | null } | null;
};

function required(name: string) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function normalizeShopDomain(value: string) {
  const raw = value.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(raw)) {
    throw new Error("SHOPIFY_SHOP_DOMAIN must be an exact *.myshopify.com hostname");
  }
  return raw;
}

function normalizeProductId(value: string) {
  const trimmed = value.trim();
  if (/^gid:\/\/shopify\/Product\/\d+$/.test(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) return `gid://shopify/Product/${trimmed}`;
  throw new Error("CANARY_SHOPIFY_PRODUCT_ID must be a numeric ID or Shopify Product GID");
}

function parseExpectedVariants(): ExpectedVariant[] {
  const raw = required("CANARY_EXPECTED_VARIANTS_JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("CANARY_EXPECTED_VARIANTS_JSON must be valid JSON");
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("CANARY_EXPECTED_VARIANTS_JSON must be a non-empty array");
  }

  return parsed.map((entry, index) => {
    const sku = String((entry as any)?.sku || "").trim();
    const price = (entry as any)?.price;
    const id = String((entry as any)?.id || "").trim() || undefined;
    if (!sku) throw new Error(`Expected variant ${index + 1} is missing sku`);
    if (price === undefined || price === null || String(price).trim() === "") {
      throw new Error(`Expected variant ${index + 1} is missing price`);
    }
    if (!Number.isFinite(Number(price))) {
      throw new Error(`Expected variant ${index + 1} has an invalid price`);
    }
    return { id, sku, price };
  });
}

function money(value: string | number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error(`Invalid monetary value: ${value}`);
  return numeric.toFixed(2);
}

async function main() {
  const shopDomain = normalizeShopDomain(required("SHOPIFY_SHOP_DOMAIN"));
  const accessToken = required("SHOPIFY_ACCESS_TOKEN");
  const apiVersion = String(process.env.SHOPIFY_API_VERSION || "2026-04").trim();
  const productId = normalizeProductId(required("CANARY_SHOPIFY_PRODUCT_ID"));
  const expected = parseExpectedVariants();

  const query = `
    query CanaryReadBack($id: ID!) {
      product(id: $id) {
        id
        title
        status
        updatedAt
        variants(first: 250) {
          nodes {
            id
            sku
            price
            inventoryItem { sku }
          }
        }
      }
    }
  `;

  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  const response = await axios.post(
    endpoint,
    { query, variables: { id: productId } },
    {
      timeout: Number(process.env.CANARY_READBACK_TIMEOUT_MS || 30000),
      maxRedirects: 0,
      validateStatus: () => true,
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    },
  );

  if (response.status !== 200) {
    throw new Error(`Shopify read-back failed with HTTP ${response.status}`);
  }
  if (Array.isArray(response.data?.errors) && response.data.errors.length > 0) {
    throw new Error(`Shopify GraphQL read-back failed: ${response.data.errors[0]?.message || "unknown error"}`);
  }

  const product = response.data?.data?.product;
  if (!product?.id) throw new Error("Canary product was not found during Shopify read-back");
  if (product.id !== productId) throw new Error(`Read-back product mismatch: expected ${productId}, received ${product.id}`);

  const actual: ShopifyVariant[] = product.variants?.nodes || [];
  const failures: string[] = [];
  const matchedIds = new Set<string>();

  for (const expectedVariant of expected) {
    const match = expectedVariant.id
      ? actual.find((variant) => variant.id === expectedVariant.id)
      : actual.find((variant) => (variant.sku || variant.inventoryItem?.sku || "") === expectedVariant.sku);

    if (!match) {
      failures.push(`Missing expected variant sku=${expectedVariant.sku}${expectedVariant.id ? ` id=${expectedVariant.id}` : ""}`);
      continue;
    }

    matchedIds.add(match.id);
    const actualSku = String(match.sku || match.inventoryItem?.sku || "").trim();
    if (actualSku !== expectedVariant.sku) {
      failures.push(`SKU mismatch for ${match.id}: expected ${expectedVariant.sku}, received ${actualSku || "<empty>"}`);
    }
    if (money(match.price) !== money(expectedVariant.price)) {
      failures.push(`Price mismatch for ${match.id}: expected ${money(expectedVariant.price)}, received ${money(match.price)}`);
    }
  }

  if (matchedIds.size !== expected.length) {
    failures.push(`Expected ${expected.length} unique matched variants, received ${matchedIds.size}`);
  }

  const report = {
    ok: failures.length === 0,
    readOnly: true,
    shopDomain,
    product: {
      id: product.id,
      title: product.title,
      status: product.status,
      updatedAt: product.updatedAt,
    },
    expectedVariants: expected.length,
    shopifyVariants: actual.length,
    matchedVariants: matchedIds.size,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, readOnly: true, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
