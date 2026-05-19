import axios from "axios";
import type { ExtractedProductRow } from "../types/product";

export const productsApi = {
  extracted: async (): Promise<ExtractedProductRow[]> => (await axios.get("/api/extracted-products")).data,
  extractedOne: async (id: string): Promise<ExtractedProductRow> => (await axios.get(`/api/extracted-products/${id}`)).data,
  updateExtracted: async (id: string, payload: unknown) => (await axios.patch(`/api/extracted-products/${id}`, payload)).data,
};
