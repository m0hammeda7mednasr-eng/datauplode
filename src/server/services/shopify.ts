import axios from 'axios';
import crypto from 'crypto';
import { decrypt, isDecryptionError } from './encryption.js';

const DEFAULT_SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';

export interface ShopifyConfig {
  shopDomain: string;
  accessToken: string;
  apiVersion: string;
}

export class ShopifyGraphqlClient {
  private config: ShopifyConfig;
  private endpoint: string;

  constructor(config: ShopifyConfig) {
    this.config = config;
    this.endpoint = `https://${config.shopDomain}/admin/api/${config.apiVersion}/graphql.json`;
  }

  async request<T = any>(query: string, variables: any = {}): Promise<T> {
    if (!this.config.accessToken || !this.config.shopDomain) {
      throw new Error('Shopify credentials not configured');
    }

    try {
      const response = await axios.post(
        this.endpoint,
        { query, variables },
        {
          timeout: 30000,
          headers: {
            'X-Shopify-Access-Token': this.config.accessToken,
            'Content-Type': 'application/json',
          },
        }
      );

      const { data, errors, extensions } = response.data;

      if (errors && errors.length > 0) {
        console.error('Shopify GraphQL Errors:', errors);
        throw new Error(`Shopify API error: ${errors[0].message}`);
      }

      // Handle throttling
      if (extensions?.cost) {
        const { requestedCost, actualCost, throttleStatus } = extensions.cost;
        if (throttleStatus.currentlyAvailable < requestedCost) {
          console.warn('Shopify throttle warning:', throttleStatus);
        }
      }

      return data;
    } catch (error: any) {
      if (error.response?.status === 429) {
        throw new Error('Shopify rate limit exceeded. Please wait.');
      }
      throw error;
    }
  }
}

// Global client for legacy support (if any)
export const shopifyClient = new ShopifyGraphqlClient({
  shopDomain: process.env.SHOPIFY_SHOP_DOMAIN || '',
  accessToken: process.env.SHOPIFY_ACCESS_TOKEN || '',
  apiVersion: DEFAULT_SHOPIFY_API_VERSION,
});

// Helper for mutations
export class ShopifyService {
  static async getClientFromDb(prisma: any) {
    const connection = await prisma.shopifyConnection.findFirst({
      where: { isConnected: true }
    });
    
    if (!connection || !connection.accessTokenEnc) {
      throw new Error('No active Shopify connection found');
    }

    try {
      return new ShopifyGraphqlClient({
        shopDomain: connection.shopDomain,
        accessToken: decrypt(connection.accessTokenEnc),
        apiVersion: DEFAULT_SHOPIFY_API_VERSION
      });
    } catch (error) {
      if (isDecryptionError(error)) {
        throw Object.assign(
          new Error('Shopify connection needs to be reconnected. The stored token cannot be decrypted with the current encryption key.'),
          { code: 'SHOPIFY_RECONNECT_REQUIRED', statusCode: 409 },
        );
      }

      throw error;
    }
  }

  static async getCollections(client: ShopifyGraphqlClient) {
    const query = `
      query {
        collections(first: 100) {
          edges {
            node {
              id
              title
              handle
            }
          }
        }
      }
    `;
    const data = await client.request(query);
    return data.collections.edges.map((e: any) => e.node);
  }

  static async getPublications(client: ShopifyGraphqlClient) {
    const query = `
      query SalesChannelPublications {
        publications(first: 50) {
          nodes {
            id
            autoPublish
            supportsFuturePublishing
            channels(first: 10) {
              nodes {
                id
                name
                handle
              }
            }
          }
        }
      }
    `;
    const data = await client.request(query);
    return data.publications?.nodes || [];
  }

  static async publishProductToSalesChannels(client: ShopifyGraphqlClient, productId: string) {
    const publications = await this.getPublications(client);
    const publicationInput = publications
      .filter((publication: any) => publication?.id)
      .map((publication: any) => ({ publicationId: publication.id }));

    if (publicationInput.length === 0) {
      return { publishedCount: 0, publications: [], userErrors: [] };
    }

    const mutation = `
      mutation publishProductToSalesChannels($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) {
          publishable {
            availablePublicationsCount {
              count
            }
            resourcePublicationsCount {
              count
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;
    const data = await client.request(mutation, {
      id: productId,
      input: publicationInput,
    });
    const userErrors = data.publishablePublish?.userErrors || [];

    return {
      publishedCount: data.publishablePublish?.publishable?.resourcePublicationsCount?.count ?? publicationInput.length,
      publications: publications.map((publication: any) => ({
        id: publication.id,
        channels: publication.channels?.nodes || [],
        autoPublish: publication.autoPublish,
      })),
      userErrors,
    };
  }

  static async getInventoryLocation(client: ShopifyGraphqlClient) {
    const query = `
      query {
        locations(first: 10) {
          nodes {
            id
            name
            isActive
            fulfillsOnlineOrders
          }
        }
      }
    `;
    const data = await client.request(query);
    const locations = data.locations?.nodes || [];
    const location =
      locations.find((entry: any) => entry.isActive && entry.fulfillsOnlineOrders) ||
      locations.find((entry: any) => entry.isActive) ||
      locations[0];

    if (!location?.id) {
      throw new Error('No Shopify inventory location found. Create or activate a Shopify location first.');
    }

    return location;
  }

  static async createProduct(client: ShopifyGraphqlClient, input: any) {
    const mutation = `
      mutation productCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
        productCreate(product: $product, media: $media) {
          product {
            id
            handle
            title
            status
            variants(first: 100) {
              nodes {
                id
                title
                price
                inventoryItem {
                  sku
                }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;
    return client.request(mutation, {
      product: input.product,
      media: input.media || [],
    });
  }

  static async createVariantsBulk(
    client: ShopifyGraphqlClient,
    productId: string,
    variants: any[],
    media: any[] = [],
  ) {
    const mutation = `
      mutation productVariantsBulkCreate(
        $productId: ID!,
        $variants: [ProductVariantsBulkInput!]!,
        $media: [CreateMediaInput!],
        $strategy: ProductVariantsBulkCreateStrategy
      ) {
        productVariantsBulkCreate(
          productId: $productId,
          variants: $variants,
          media: $media,
          strategy: $strategy
        ) {
          productVariants {
            id
            title
            price
            inventoryItem {
              id
              sku
              tracked
            }
            media(first: 10) {
              nodes {
                id
                alt
                mediaContentType
                preview {
                  status
                }
              }
            }
            selectedOptions {
              name
              value
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;
    return client.request(mutation, {
      productId,
      variants,
      media,
      strategy: 'REMOVE_STANDALONE_VARIANT',
    });
  }

  static async getProductInventoryVariants(client: ShopifyGraphqlClient, productId: string) {
    const query = `
      query ProductInventoryVariants($id: ID!) {
        product(id: $id) {
          variants(first: 250) {
            nodes {
              id
              title
              sku
              inventoryItem {
                id
                sku
                tracked
              }
              selectedOptions {
                name
                value
              }
              media(first: 10) {
                nodes {
                  id
                  alt
                  mediaContentType
                }
              }
            }
          }
        }
      }
    `;
    const data = await client.request(query, { id: productId });
    return data.product?.variants?.nodes || [];
  }

  static async updateVariantsBulkMedia(
    client: ShopifyGraphqlClient,
    productId: string,
    variants: any[],
    media: any[] = [],
  ) {
    if (variants.length === 0) {
      return { productVariantsBulkUpdate: { productVariants: [], userErrors: [] } };
    }

    const mutation = `
      mutation productVariantsBulkUpdateMedia(
        $productId: ID!,
        $variants: [ProductVariantsBulkInput!]!,
        $media: [CreateMediaInput!],
        $allowPartialUpdates: Boolean
      ) {
        productVariantsBulkUpdate(
          productId: $productId,
          variants: $variants,
          media: $media,
          allowPartialUpdates: $allowPartialUpdates
        ) {
          productVariants {
            id
            media(first: 10) {
              nodes {
                id
                alt
                mediaContentType
                preview {
                  status
                }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    return client.request(mutation, {
      productId,
      variants,
      media,
      allowPartialUpdates: true,
    });
  }

  static async setInventoryQuantities(
    client: ShopifyGraphqlClient,
    input: {
      locationId: string;
      quantities: Array<{ inventoryItemId: string; quantity: number }>;
      referenceDocumentUri?: string;
    },
  ) {
    if (input.quantities.length === 0) {
      return { inventorySetQuantities: { inventoryAdjustmentGroup: null, userErrors: [] } };
    }

    const mutation = `
      mutation inventorySetQuantities($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
        inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
          inventoryAdjustmentGroup {
            reason
            referenceDocumentUri
            changes {
              name
              delta
              quantityAfterChange
            }
          }
          userErrors {
            code
            field
            message
          }
        }
      }
    `;

    return client.request(mutation, {
      idempotencyKey: crypto.randomUUID(),
      input: {
        name: 'available',
        reason: 'correction',
        referenceDocumentUri: input.referenceDocumentUri,
        quantities: input.quantities.map(quantity => ({
          inventoryItemId: quantity.inventoryItemId,
          locationId: input.locationId,
          quantity: quantity.quantity,
          changeFromQuantity: null,
        })),
      },
    });
  }

  static async updateVariant(client: ShopifyGraphqlClient, input: any) {
    const mutation = `
      mutation productVariantUpdate($input: ProductVariantInput!) {
        productVariantUpdate(input: $input) {
          productVariant {
            id
            price
            inventoryQuantity
          }
          userErrors {
            field
            message
          }
        }
      }
    `;
    return client.request(mutation, { input });
  }

  static async addProductToCollection(client: ShopifyGraphqlClient, productId: string, collectionId: string) {
    const mutation = `
      mutation collectionAddProducts($id: ID!, $productIds: [ID!]!) {
        collectionAddProducts(id: $id, productIds: $productIds) {
          collection {
            id
            title
          }
          userErrors {
            field
            message
          }
        }
      }
    `;
    return client.request(mutation, { id: collectionId, productIds: [productId] });
  }
}
