import axios from "axios";
import type { SourceRow } from "../types/source";

export const sourcesApi = {
  list: async (): Promise<SourceRow[]> => (await axios.get("/api/sources")).data,
  test: async (id: string) => (await axios.post(`/api/sources/${id}/test`)).data,
  update: async (id: string, payload: unknown) => (await axios.patch(`/api/sources/${id}`, payload)).data,
};
