import axios, { type AxiosResponse } from "axios";

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

type ReadBackResponse = AxiosResponse<any>;

function required(name: string) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function boundedInteger(name: string, fallback: number, min: number, max: number) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function normalizeShopDomain(value: string) {
  const raw = value.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(raw)) {
    throw new Error("SHOPIFY_SHOP_DOMAIN must be an exact *.myshopify.com hostname");
  }
  return raw;
}

function normalizeApiVersion(value: string) {
  const version = value.trim();
  if (!/^20\d{2}-(01|04|07|10)$/.test(version)) {
    throw new Error("SHOPIFY_API_VERSION must use Shopify's YYYY-MM quarterly format");
  }
  return version;
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
  if (parsed.length > 250) {
    throw new Error("CANARY_EXPECTED_VARIANTS_JSON cannot contain more than 250 variants");
  }

  const ids = new Set<string>();
  const skus = new Set<string>();

  return parsed.map((entry, index) => {
    const sku = String((entry as any)?.sku || "").trim();
    const price = (entry as any)?.price;
    const id = String((entry as any)?.id || "").trim() || undefined;
    if (!sku) throw new Error(`Expected variant ${index + 1} is missing sku`);
    if (price === undefined || price === null || String(price).trim() === "") {
      throw new Error(`Expected variant ${index + 1} is missing price`);
    }
    if (!Number.isFinite(Number(price)) || Number(price) < 0) {
      throw new Error(`Expected variant ${index + 1} has an invalid price`);
    }
    if (id && !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(id)) {
      throw new Error(`Expected variant ${index + 1} has an invalid Shopify variant GID`);
    }
    if (skus.has(sku)) throw new Error(`Duplicate expected SKU: ${sku}`);
    if (id && ids.has(id)) throw new Error(`Duplicate expected variant ID: ${id}`);
    skus.add(sku);
    if (id) ids.add(id);
    return { id, sku, price };
  });
}

function money(value: string | number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error(`Invalid monetary value: ${value}`);
  return numeric.toFixed(2);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(response: ReadBackResponse, attempt: number) {
  const retryAfter = Number(response.headers?.["retry-after"]);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(retryAfter * 1000, 10000);
  }
  return Math.min(500 * 2 ** attempt, 5000);
}

async function fetchReadBack(
  endpoint: string,
  accessToken: string,
  query: string,
  productId: string,
  timeoutMs: number,
  retries: number,
) {
  let response: ReadBackResponse | undefined;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    response = await axios.post(
      endpoint,
      { query, variables: { id: productId } },
      {
        timeout: timeoutMs,
        maxRedirects: 0,
        validateStatus: () => true,
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      },
    );

    if (response.status === 200) return { response, attempts: attempt + 1 };

    if (response.status === 401) {
      throw new Error("Shopify read-back authentication failed with HTTP 401");
    }
    if (response.status === 403) {
      throw new Error("Shopify read-back was blocked with HTTP 403; this is not an out-of-stock result");
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === retries) break;
    await sleep(retryDelayMs(response, attempt));
  }

  throw new Error(`Shopify read-back failed with HTTP ${response?.status ?? "unknown"}`);
}

async function main() {
  const shopDomain = normalizeShopDomain(required("SHOPIFY_SHOP_DOMAIN"));
  const accessToken = required("SHOPIFY_ACCESS_TOKEN");
  const apiVersion = normalizeApiVersion(String(process.env.SHOPIFY_API_VERSION || "2026-04"));
  const productId = normalizeProductId(required("CANARY_SHOPIFY_PRODUCT_ID"));
  const expected = parseExpectedVariants();
  const timeoutMs = boundedInteger("CANARY_READBACK_TIMEOUT_MS", 30000, 1000, 120000);
  const retries = boundedInteger("CANARY_READBACK_RETRIES", 2, 0, 5);

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
  const { response, attempts } = await fetchReadBack(
    endpoint,
    accessToken,
    query,
    productId,
    timeoutMs,
    retries,
  );

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
    attempts,
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
