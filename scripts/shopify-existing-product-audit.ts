import axios, { AxiosError } from "axios";

type ExpectedSku = {
  sku: string;
  expectedProductId?: string;
};

type VariantNode = {
  id: string;
  sku: string | null;
  product: {
    id: string;
    title: string;
    handle: string;
  };
};

type GraphQlResponse = {
  data?: {
    productVariants?: {
      nodes?: VariantNode[];
      pageInfo?: {
        hasNextPage?: boolean;
      };
    };
  };
  errors?: Array<{ message?: string }>;
};

const env = (name: string): string => (process.env[name] || "").trim();

const shopDomain = env("SHOPIFY_SHOP_DOMAIN");
const accessToken = env("SHOPIFY_ACCESS_TOKEN");
const apiVersion = env("SHOPIFY_API_VERSION") || "2026-04";
const timeoutMs = boundedInteger(env("EXISTING_PRODUCT_AUDIT_TIMEOUT_MS") || "30000", 1000, 120000, "timeout");
const maxRetries = boundedInteger(env("EXISTING_PRODUCT_AUDIT_MAX_RETRIES") || "2", 0, 5, "max retries");
const expected = parseExpectedSkus(env("EXISTING_PRODUCT_AUDIT_SKUS_JSON"));

validateConfiguration();

const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
const query = `
  query ExistingProductAudit($query: String!) {
    productVariants(first: 250, query: $query) {
      nodes {
        id
        sku
        product {
          id
          title
          handle
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

const findings: Array<{
  sku: string;
  status: "missing" | "unique" | "duplicate" | "product_mismatch";
  matchCount: number;
  productIds: string[];
  variantIds: string[];
}> = [];

let requestCount = 0;
let retryCount = 0;

for (const item of expected) {
  const response = await requestWithRetry(item.sku);
  const productVariants = response.data?.productVariants;
  if (productVariants?.pageInfo?.hasNextPage === true) {
    throw new Error(
      `Existing-product audit search for SKU ${item.sku} was truncated after 250 variants; uniqueness cannot be verified safely`,
    );
  }

  const exactMatches = (productVariants?.nodes || []).filter(
    (variant) => (variant.sku || "").trim() === item.sku,
  );
  const productIds = [...new Set(exactMatches.map((variant) => variant.product.id))];
  const variantIds = exactMatches.map((variant) => variant.id);

  let status: "missing" | "unique" | "duplicate" | "product_mismatch";
  if (exactMatches.length === 0) {
    status = "missing";
  } else if (exactMatches.length > 1) {
    status = "duplicate";
  } else if (item.expectedProductId && exactMatches[0].product.id !== item.expectedProductId) {
    status = "product_mismatch";
  } else {
    status = "unique";
  }

  findings.push({
    sku: item.sku,
    status,
    matchCount: exactMatches.length,
    productIds,
    variantIds,
  });
}

const counts = findings.reduce(
  (acc, finding) => {
    acc[finding.status] += 1;
    return acc;
  },
  { missing: 0, unique: 0, duplicate: 0, product_mismatch: 0 },
);

const ok = counts.duplicate === 0 && counts.product_mismatch === 0;
const report = {
  ok,
  readOnly: true,
  completeSearchResultsRequired: true,
  queriedSkus: expected.length,
  requestCount,
  retryCount,
  counts,
  findings,
  http403Classification: "blocked_not_out_of_stock",
  shop: shopDomain,
};

console.log(JSON.stringify(report, null, 2));
if (!ok) process.exit(1);

async function requestWithRetry(sku: string): Promise<GraphQlResponse> {
  let attempt = 0;
  while (true) {
    requestCount += 1;
    try {
      const response = await axios.post<GraphQlResponse>(
        endpoint,
        { query, variables: { query: `sku:${escapeSearchValue(sku)}` } },
        {
          timeout: timeoutMs,
          maxRedirects: 0,
          validateStatus: () => true,
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
        },
      );

      if (response.status === 401) throw new Error("Shopify authentication failed with HTTP 401");
      if (response.status === 403) {
        throw new Error("Shopify returned HTTP 403; this is blocked access, not an out-of-stock result");
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt < maxRetries) {
          attempt += 1;
          retryCount += 1;
          await sleep(retryDelayMs(response.headers["retry-after"], attempt));
          continue;
        }
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Shopify audit failed with HTTP ${response.status}`);
      }
      if (response.data.errors?.length) {
        throw new Error(`Shopify GraphQL audit failed: ${response.data.errors.map((error) => error.message || "unknown").join("; ")}`);
      }
      return response.data;
    } catch (error) {
      if (error instanceof AxiosError && !error.response && attempt < maxRetries) {
        attempt += 1;
        retryCount += 1;
        await sleep(retryDelayMs(undefined, attempt));
        continue;
      }
      throw error;
    }
  }
}

function validateConfiguration(): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shopDomain)) {
    throw new Error("SHOPIFY_SHOP_DOMAIN must be an exact *.myshopify.com hostname");
  }
  if (!accessToken) throw new Error("SHOPIFY_ACCESS_TOKEN is required");
  if (!/^20\d{2}-(01|04|07|10)$/.test(apiVersion)) throw new Error("SHOPIFY_API_VERSION is invalid");
  if (expected.length === 0) throw new Error("At least one SKU is required");
  if (expected.length > 50) throw new Error("Existing-product audit is limited to 50 SKUs per run");
}

function parseExpectedSkus(raw: string): ExpectedSku[] {
  if (!raw) throw new Error("EXISTING_PRODUCT_AUDIT_SKUS_JSON is required");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("EXISTING_PRODUCT_AUDIT_SKUS_JSON must be an array");
  const seen = new Set<string>();
  return parsed.map((value, index) => {
    if (!value || typeof value !== "object") throw new Error(`SKU entry ${index} must be an object`);
    const item = value as Record<string, unknown>;
    const sku = typeof item.sku === "string" ? item.sku.trim() : "";
    const expectedProductId = typeof item.expectedProductId === "string" ? item.expectedProductId.trim() : undefined;
    if (!sku || sku.length > 100 || /[\r\n\u0000]/.test(sku)) throw new Error(`SKU entry ${index} is invalid`);
    if (seen.has(sku)) throw new Error(`Duplicate expected SKU: ${sku}`);
    seen.add(sku);
    if (expectedProductId && !/^gid:\/\/shopify\/Product\/\d+$/.test(expectedProductId)) {
      throw new Error(`expectedProductId for SKU ${sku} is invalid`);
    }
    return { sku, expectedProductId };
  });
}

function escapeSearchValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function boundedInteger(raw: string, min: number, max: number, label: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function retryDelayMs(retryAfter: unknown, attempt: number): number {
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30000);
  return Math.min(1000 * 2 ** (attempt - 1), 10000);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
