import axios from "axios";
import type { SourceScanResponse } from "../types/sourceScan";

export const sourceScanApi = {
  scan: async (url: string): Promise<SourceScanResponse> =>
    (await axios.post("/api/source-scan", { url })).data,

  get: async (id: string) => (await axios.get(`/api/source-scan/${id}`)).data,

  list: async (page = 1, limit = 20) =>
    (await axios.get("/api/source-scans", { params: { page, limit } })).data,

  startExtraction: async (
    id: string,
    payload?: {
      sourceInput?: {
        url?: string;
        sourceType?:
          | "product_url"
          | "category_url"
          | "sitemap"
          | "csv_feed"
          | "xml_feed"
          | "json_feed";
        mode?: "auto" | "static_html" | "browser_rendered" | "feed";
      };
    },
  ) =>
    (await axios.post(`/api/source-scan/${id}/start-extraction`, payload || {})).data,
};
