import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Play, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { scraperApi } from "../api/scraperApi";
import type { SourceInput } from "../types/source";

export default function ScraperPage() {
  const [input, setInput] = useState<SourceInput>({ url: "", sourceType: "product_url", mode: "auto" });
  const [result, setResult] = useState<any>(null);
  const testMutation = useMutation({ mutationFn: scraperApi.test, onSuccess: setResult, onError: (error: any) => toast.error(error.message) });
  const extractMutation = useMutation({ mutationFn: scraperApi.extract, onSuccess: (data) => { setResult(data); toast.success("Extraction completed"); }, onError: (error: any) => toast.error(error.response?.data?.error || error.message) });

  const update = (key: keyof SourceInput, value: string) => setInput((current) => ({ ...current, [key]: value }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Product Extraction Engine</h1>
        <p className="mt-1 text-sm text-slate-500">Extract public product data from permitted pages, feeds, and sitemaps with review-first validation.</p>
      </div>
      <div className="rounded-lg border border-card-border bg-white p-5">
        <div className="grid gap-4 md:grid-cols-[1fr_180px_180px]">
          <label className="space-y-2 text-sm font-medium">
            Source URL
            <input className="w-full rounded-md border border-card-border px-3 py-2" value={input.url} onChange={(event) => update("url", event.target.value)} placeholder="https://supplier.com/products/item" />
          </label>
          <label className="space-y-2 text-sm font-medium">
            Source Type
            <select className="w-full rounded-md border border-card-border px-3 py-2" value={input.sourceType} onChange={(event) => update("sourceType", event.target.value)}>
              <option value="product_url">Product URL</option><option value="category_url">Category URL</option><option value="sitemap">Sitemap</option><option value="csv_feed">CSV Feed</option><option value="xml_feed">XML Feed</option><option value="json_feed">JSON Feed</option>
            </select>
          </label>
          <label className="space-y-2 text-sm font-medium">
            Mode
            <select className="w-full rounded-md border border-card-border px-3 py-2" value={input.mode} onChange={(event) => update("mode", event.target.value)}>
              <option value="auto">Auto</option><option value="static_html">Static HTML</option><option value="browser_rendered">Browser</option><option value="feed">Feed</option>
            </select>
          </label>
        </div>
        <div className="mt-4 flex gap-3">
          <button onClick={() => testMutation.mutate(input)} className="inline-flex items-center gap-2 rounded-md border border-card-border px-4 py-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4" /> Test Source</button>
          <button onClick={() => extractMutation.mutate(input)} className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white"><Play className="h-4 w-4" /> Start Extraction</button>
        </div>
      </div>
      {result && (
        <pre className="max-h-[420px] overflow-auto rounded-lg border border-card-border bg-slate-950 p-4 text-xs text-slate-100">{JSON.stringify(result, null, 2)}</pre>
      )}
    </div>
  );
}
