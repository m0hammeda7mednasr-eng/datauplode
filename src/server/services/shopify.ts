import axios from 'axios';
import { decrypt } from './encryption.js';
import { PrismaClient } from '@prisma/client';

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

    return new ShopifyGraphqlClient({
      shopDomain: connection.shopDomain,
      accessToken: decrypt(connection.accessTokenEnc),
      apiVersion: DEFAULT_SHOPIFY_API_VERSION
    });
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
  ) {
    const mutation = `
      mutation productVariantsBulkCreate(
        $productId: ID!,
        $variants: [ProductVariantsBulkInput!]!,
        $strategy: ProductVariantsBulkCreateStrategy
      ) {
        productVariantsBulkCreate(
          productId: $productId,
          variants: $variants,
          strategy: $strategy
        ) {
          productVariants {
            id
            title
            price
            inventoryItem {
              sku
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
      strategy: 'REMOVE_STANDALONE_VARIANT',
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
