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

async function getLinkedSizeOption(client: any, productId: string) {
  try {
    const data = await client.request(
      `
        query CatalogHardcaseProductOptions($id: ID!) {
          product(id: $id) {
            options {
              id
              name
              linkedMetafield {
                namespace
                key
              }
            }
          }
        }
      `,
      { id: productId },
    );
    return (data?.product?.options || []).find((option: any) => {
      const namespace = clean(option?.linkedMetafield?.namespace).toLowerCase();
      const key = clean(option?.linkedMetafield?.key).toLowerCase();
      return (namespace === 'shopify' && key === 'size') || /^size$/i.test(clean(option?.name));
    }) || null;
  } catch (error: any) {
    console.warn(`[shopify-hardcase] could not inspect product options for ${productId}: ${clean(error?.message || error)}`);
    return null;
  }
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
    const incomingVariants = Array.isArray(input?.variants) ? input.variants : [];
    if (incomingVariants.length <= 1) {
      const current = await ShopifyService.getProductCatalogSnapshot(client, productId);
      if ((current?.variants?.length || 0) > 1) {
        throw new Error(
          `Catalog variant collapse rejected before Shopify mutation (${current.variants.length} -> ${incomingVariants.length})`,
        );
      }
    }

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

    const existingSize = await getLinkedSizeOption(client, productId);
    const oldName = clean(sizeOptions[0].name);
    const newName = 'Source Size';

    if (existingSize?.id) sizeOptions[0].id = existingSize.id;
    // ProductSet leaves omitted option fields unchanged. Explicit null clears the
    // taxonomy link so ordinary source size strings are accepted as normal values.
    sizeOptions[0].linkedMetafield = null;
    sizeOptions[0].name = newName;

    for (const variant of retryInput.variants || []) {
      for (const optionValue of variant.optionValues || []) {
        if (clean(optionValue?.optionName).toLowerCase() === oldName.toLowerCase()) {
          optionValue.optionName = newName;
        }
      }
    }

    const second = await originalSetCatalog(client, productId, retryInput);
    const secondErrors = productSetErrors(second);
    if (secondErrors.length === 0) {
      console.log(`[shopify-hardcase] size taxonomy fallback succeeded for ${productId}`);
      return second;
    }

    console.warn(
      `[shopify-hardcase] size taxonomy fallback still rejected for ${productId}: ${secondErrors.map((entry: any) => clean(entry?.message)).filter(Boolean).join(' | ')}`,
    );
    return first;
  } as typeof ShopifyService.setProductCatalog;

  console.log('[shopify-hardcase] catalog read retry + size taxonomy fallback + variant-collapse guard installed');
}

installShopifyCatalogHardcaseHotfix();
