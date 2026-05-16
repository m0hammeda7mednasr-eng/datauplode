import { NormalizedProductSchema, type NormalizedProduct } from "../types/product.js";

export function validateProduct(product: NormalizedProduct) {
  return NormalizedProductSchema.safeParse(product);
}
