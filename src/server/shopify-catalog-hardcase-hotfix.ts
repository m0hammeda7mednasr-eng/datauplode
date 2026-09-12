import { ShopifyService } from './services/shopify.js';

let installed = false;

function clean(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function productSetErrors(response: any) {
  return response?.productSet?.userErrors || [];
}

export function installShopifyCatalogHardcaseHotfix() {
  if (installed) return;
  installed = true;

  const originalSnapshot = ShopifyService.getProductCatalogSnapshot.bind(ShopifyService);
  ShopifyService.getProductCatalogSnapshot = async function getProductCatalogSnapshotWithRetry(client: any, productId: string) {
    let lastError: any = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        const snapshot = await originalSnapshot(client, productId);
        if (snapshot?.id === productId) return snapshot;
        lastError = new Error('Shopify returned no product snapshot');
      } catch (error: any) {
        lastError = error;
      }
      if (attempt < 4) await sleep(attempt * 750);
    }
    if (lastError) throw lastError;
    return null;
  } as typeof ShopifyService.getProductCatalogSnapshot;

  const originalSetCatalog = ShopifyService.setProductCatalog.bind(ShopifyService);
  ShopifyService.setProductCatalog = async function setProductCatalogWithSizeFallback(
    client: any,
    productId: string,
    input: Record<string, any>,
  ) {
    const first = await originalSetCatalog(client, productId, input);
    const errors = productSetErrors(first);
    const sizeLinkError = errors.some((entry: any) =>
      /option linked to the ['"]shopify\.size['"] metafield is invalid/i.test(clean(entry?.message)),
    );
    if (!sizeLinkError) return first;

    const retryInput = clone(input);
    const sizeOptions = Array.isArray(retryInput.productOptions)
      ? retryInput.productOptions.filter((option: any) => /^size$/i.test(clean(option?.name)))
      : [];
    if (sizeOptions.length !== 1) return first;

    const oldName = clean(sizeOptions[0].name);
    const newName = 'Source Size';
    sizeOptions[0].name = newName;

    for (const variant of retryInput.variants || []) {
      for (const optionValue of variant.optionValues || []) {
        if (clean(optionValue?.optionName).toLowerCase() === oldName.toLowerCase()) {
          optionValue.optionName = newName;
        }
      }
    }

    const second = await originalSetCatalog(client, productId, retryInput);
    if (productSetErrors(second).length === 0) {
      console.log(`[shopify-hardcase] size taxonomy fallback succeeded for ${productId}`);
      return second;
    }

    return first;
  } as typeof ShopifyService.setProductCatalog;

  console.log('[shopify-hardcase] catalog read retry + size taxonomy fallback installed');
}

installShopifyCatalogHardcaseHotfix();
