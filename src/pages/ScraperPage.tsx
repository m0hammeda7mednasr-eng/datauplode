import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Play, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { scraperApi } from "../api/scraperApi";
import type { ScraperBrandStrategy, SourceInput } from "../types/source";

const FALLBACK_BRANDS: ScraperBrandStrategy[] = [
  { key: "next", name: "Next", sourceType: "product_url", mode: "auto", notes: "Auto strategy with retailer-specific extraction chain." },
  { key: "max", name: "Max Fashion", sourceType: "product_url", mode: "browser_rendered", notes: "Prefer browser-rendered product extraction for reliability." },
  { key: "shein", name: "SHEIN", sourceType: "product_url", mode: "feed", notes: "Use feed/manual-safe path to reduce block loops." },
  { key: "hm", name: "H&M", sourceType: "product_url", mode: "browser_rendered", notes: "Browser-rendered strategy for dynamic product pages." },
  { key: "lefties", name: "Lefties", sourceType: "product_url", mode: "browser_rendered", notes: "Browser-rendered extraction with conservative pacing." },
  { key: "centrepoint", name: "Centrepoint", sourceType: "product_url", mode: "browser_rendered", notes: "Browser-rendered extraction for stable variant capture." },
  { key: "gap", name: "Gap", sourceType: "product_url", mode: "auto", notes: "Auto strategy with direct HTML first." },
  { key: "zara", name: "Zara", sourceType: "product_url", mode: "browser_rendered", notes: "Browser-rendered strategy for modern storefront scripts." },
  { key: "marks_and_spencer", name: "Marks & Spencer", sourceType: "product_url", mode: "auto", notes: "Auto strategy with supplier-specific parser." },
  { key: "primark", name: "Primark", sourceType: "product_url", mode: "auto", notes: "Auto strategy for product page extraction." },
  { key: "mothercare", name: "Mothercare", sourceType: "product_url", mode: "auto", notes: "Auto strategy for direct product URLs." },
  { key: "other", name: "Other", sourceType: "product_url", mode: "auto", notes: "Fallback strategy for unsupported/unknown brands." },
];

export default function ScraperPage() {
  const [input, setInput] = useState<SourceInput>({ url: "", brandKey: "other", sourceType: "product_url", mode: "auto" });
  const [result, setResult] = useState<any>(null);

  const { data: brandOptions = FALLBACK_BRANDS } = useQuery({
    queryKey: ["scraper-brands"],
    queryFn: scraperApi.brands,
    staleTime: 60 * 60 * 1000,
  });

  const selectedBrand = useMemo(() => {
    return (
      brandOptions.find((brand) => brand.key === (input.brandKey || "other")) ||
      brandOptions.find((brand) => brand.key === "other") ||
      FALLBACK_BRANDS[FALLBACK_BRANDS.length - 1]
    );
  }, [brandOptions, input.brandKey]);

  const applyBrandStrategy = (brandKey: string) => {
    const strategy =
      brandOptions.find((brand) => brand.key === brandKey) ||
      brandOptions.find((brand) => brand.key === "other") ||
      FALLBACK_BRANDS[FALLBACK_BRANDS.length - 1];

    setInput((current) => ({
      ...current,
      brandKey: strategy.key,
      sourceType: strategy.sourceType,
      mode: strategy.mode,
    }));
  };

  const testMutation = useMutation({ mutationFn: scraperApi.test, onSuccess: setResult, onError: (error: any) => toast.error(error.message) });
  const extractMutation = useMutation({ mutationFn: scraperApi.extract, onSuccess: (data) => { setResult(data); toast.success("Extraction completed"); }, onError: (error: any) => toast.error(error.response?.data?.error || error.message) });

  const updateUrl = (value: string) => setInput((current) => ({ ...current, url: value }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Product Extraction Engine</h1>
        <p className="mt-1 text-sm text-slate-500">Extract public product data from permitted pages, feeds, and sitemaps with review-first validation.</p>
      </div>
      <div className="rounded-lg border border-card-border bg-white p-5">
        <div className="grid gap-4 md:grid-cols-[1fr_240px]">
          <label className="space-y-2 text-sm font-medium">
            Source URL
            <input className="w-full rounded-md border border-card-border px-3 py-2" value={input.url} onChange={(event) => updateUrl(event.target.value)} placeholder="https://supplier.com/products/item" />
          </label>
          <label className="space-y-2 text-sm font-medium">
            Brand
            <select
              className="w-full rounded-md border border-card-border px-3 py-2"
              value={input.brandKey || "other"}
              onChange={(event) => applyBrandStrategy(event.target.value)}
            >
              {brandOptions.map((brand) => (
                <option key={brand.key} value={brand.key}>
                  {brand.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <span className="font-semibold text-slate-700">Strategy:</span>{" "}
          {selectedBrand?.name} uses <span className="font-mono">{selectedBrand?.mode}</span> on{" "}
          <span className="font-mono">{selectedBrand?.sourceType}</span>. {selectedBrand?.notes}
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
