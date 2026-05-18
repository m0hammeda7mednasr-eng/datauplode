import axios from "axios";
import type { ScraperBrandStrategy, SourceInput } from "../types/source";

export const scraperApi = {
  test: async (input: SourceInput) => (await axios.post("/api/scraper/test", input)).data,
  extract: async (input: SourceInput) => (await axios.post("/api/scraper/extract", input)).data,
  category: async (payload: unknown) => (await axios.post("/api/scraper/category", payload)).data,
  job: async (id: string) => (await axios.get(`/api/scraper/jobs/${id}`)).data,
  brands: async (): Promise<ScraperBrandStrategy[]> =>
    (await axios.get("/api/scraper/brands")).data?.brands || [],
};
