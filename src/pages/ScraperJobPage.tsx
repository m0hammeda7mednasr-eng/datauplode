import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { scraperApi } from "../api/scraperApi";
import ExtractionLogs from "../components/scraper/ExtractionLogs";

export default function ScraperJobPage() {
  const { id = "" } = useParams();
  const { data } = useQuery({ queryKey: ["scraper-job", id], queryFn: () => scraperApi.job(id), refetchInterval: 3000 });
  const logs = data?.logsJson ? JSON.parse(data.logsJson) : [];
  const errors = data?.errorsJson ? JSON.parse(data.errorsJson) : [];
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Extraction Job</h1>
      <div className="grid gap-4 md:grid-cols-4">
        {["status", "progress", "sourceUrl", "finishedAt"].map((key) => (
          <div key={key} className="rounded-lg border border-card-border bg-white p-4">
            <div className="text-xs uppercase text-slate-500">{key}</div>
            <div className="mt-1 truncate text-sm font-semibold">{String(data?.[key] || "-")}</div>
          </div>
        ))}
      </div>
      <ExtractionLogs logs={[...logs, ...errors.map((error: any) => error.message)]} />
    </div>
  );
}
