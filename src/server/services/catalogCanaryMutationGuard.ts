import { AsyncLocalStorage } from "node:async_hooks";
import { ShopifyService } from "./shopify.js";
import {
  catalogCanaryQueueIsQuiescent,
  verifyCatalogCanaryQueueQuiescence,
} from "./catalogCanaryQueueGuard.js";

type CanaryMutationContext = {
  expectedShopifyProductId: string;
};

const canaryMutationContext = new AsyncLocalStorage<CanaryMutationContext>();
const originalUpdateVariantsBulk = ShopifyService.updateVariantsBulk.bind(ShopifyService);
let installed = false;

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function installGuard() {
  if (installed) return;
  installed = true;

  ShopifyService.updateVariantsBulk = async function guardedUpdateVariantsBulk(
    client: any,
    productId: string,
    variants: any[],
    media: any[] = [],
  ) {
    const context = canaryMutationContext.getStore();
    if (context) {
      const actualProductId = clean(productId);
      if (!actualProductId || actualProductId !== context.expectedShopifyProductId) {
        throw Object.assign(
          new Error(
            `Catalog canary Shopify product identity changed before mutation: expected ${context.expectedShopifyProductId}, received ${actualProductId || "<empty>"}.`,
          ),
          {
            code: "CATALOG_AUDIT_CANARY_MUTATION_PRODUCT_MISMATCH",
            statusCode: 412,
          },
        );
      }

      let queueState;
      try {
        queueState = await verifyCatalogCanaryQueueQuiescence();
      } catch {
        throw Object.assign(
          new Error(
            "Catalog canary queue verification is unavailable immediately before Shopify mutation; no write was attempted.",
          ),
          {
            code: "CATALOG_AUDIT_CANARY_QUEUE_CHECK_UNAVAILABLE",
            statusCode: 503,
          },
        );
      }

      if (!catalogCanaryQueueIsQuiescent(queueState)) {
        throw Object.assign(
          new Error(
            `Catalog canary requires a quiescent sync queue immediately before Shopify mutation (pending=${queueState.pending}, running=${queueState.running}, staleRunning=${queueState.staleRunning}, recentFailed=${queueState.recentFailed}).`,
          ),
          {
            code: "CATALOG_AUDIT_CANARY_QUEUE_NOT_QUIESCENT",
            statusCode: 409,
            queueState,
          },
        );
      }
    }

    return originalUpdateVariantsBulk(client, productId, variants, media);
  };
}

installGuard();

export function runWithCatalogCanaryMutationGuard<T>(
  expectedShopifyProductId: string,
  callback: () => T,
): T {
  const expected = clean(expectedShopifyProductId);
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(expected)) {
    throw Object.assign(
      new Error("Catalog canary mutation guard requires an exact Shopify Product GID."),
      {
        code: "CATALOG_AUDIT_CANARY_MUTATION_PRODUCT_INVALID",
        statusCode: 412,
      },
    );
  }

  return canaryMutationContext.run({ expectedShopifyProductId: expected }, callback);
}
