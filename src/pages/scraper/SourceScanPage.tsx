import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AlertTriangle, Play, Search, ShieldCheck } from "lucide-react";
import { sourceScanApi } from "../../api/sourceScanApi";
import type { SourceCapabilityReport } from "../../types/sourceScan";

export default function SourceScanPage() {
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [scanId, setScanId] = useState<string | null>(null);
  const [report, setReport] = useState<SourceCapabilityReport | null>(null);
  const [readinessMessage, setReadinessMessage] = useState("");

  const scanMutation = useMutation({
    mutationFn: sourceScanApi.scan,
    onSuccess: (data) => {
      setScanId(data.scanId);
      setReport(data.report);
      setReadinessMessage(data.extractionReadiness?.message || "");
      toast.success(data.cached ? "Scan loaded from cache" : "Scan completed");
    },
    onError: (error: any) => {
      toast.error(error?.response?.data?.error || error.message || "Scan failed");
    },
  });

  const startMutation = useMutation({
    mutationFn: () =>
      sourceScanApi.startExtraction(scanId!, {
        sourceInput: {
          url: report?.sourceUrl,
        },
      }),
    onSuccess: (data) => {
      toast.success("Extraction job created");
      if (data.jobId) {
        navigate(`/scraper/jobs/${data.jobId}`);
      }
    },
    onError: (error: any) => {
      toast.error(error?.response?.data?.message || error?.response?.data?.error || error.message);
    },
  });

  const isRestricted = report?.recommendedStrategy.mode === "restricted";
  const canStart = Boolean(report && scanId && !isRestricted);

  const rows = useMemo(() => {
    if (!report) return [];

    return [
      {
        title: "Brand detected",
        content: report.brandName
          ? `${report.brandName}${report.brandKey ? ` (${report.brandKey})` : ""}`
          : "Unknown",
      },
      {
        title: "Access status",
        content: `robots: ${report.access.robotsStatus}`,
      },
      {
        title: "Discovery status",
        content: `sitemaps: ${report.discovery.sitemapUrls.length}, products: ${report.discovery.productUrlsFound}`,
      },
      {
        title: "Extraction signals",
        content: `JSON-LD: ${report.extractionSignals.hasJsonLdProduct ? "yes" : "no"}, static html: ${report.extractionSignals.hasStaticProductHtml ? "yes" : "no"}`,
      },
      {
        title: "Recommended strategy",
        content: `${report.recommendedStrategy.mode} (${report.recommendedStrategy.confidence}%)`,
      },
      {
        title: "Free safe limits",
        content: `conc: ${report.freeSafeLimits.maxConcurrency}, rpm: ${report.freeSafeLimits.maxRequestsPerMinute}`,
      },
    ];
  }, [report]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Source Capability Scanner</h1>
        <p className="mt-1 text-sm text-slate-500">
          Free and legal scanner for public ecommerce sources. It respects robots, limits, and restriction pages.
        </p>
      </div>

      <div className="rounded-lg border border-card-border bg-white p-5">
        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
          <input
            className="w-full rounded-md border border-card-border px-3 py-2 text-sm"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://www.example.com/product/..."
          />
          <button
            onClick={() => scanMutation.mutate(url)}
            disabled={!url || scanMutation.isPending}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            <Search className="h-4 w-4" />
            {scanMutation.isPending ? "Scanning..." : "Scan"}
          </button>
        </div>
      </div>

      {report && (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {rows.map((row) => (
              <div key={row.title} className="rounded-lg border border-card-border bg-white p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{row.title}</p>
                <p className="mt-2 text-sm font-medium text-slate-900 break-words">{row.content}</p>
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-card-border bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Restriction warnings</p>
            {report.warnings.length === 0 ? (
              <p className="mt-2 text-sm text-emerald-700">No warnings detected.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {report.warnings.map((warning, index) => (
                  <li key={`${warning.code}-${index}`} className="flex items-start gap-2 text-sm text-amber-700">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      <strong>{warning.code}</strong>: {warning.message}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-lg border border-card-border bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Strategy reason</p>
            <p className="mt-2 text-sm text-slate-800">{report.recommendedStrategy.reason}</p>
            {readinessMessage ? <p className="mt-2 text-xs text-slate-500">{readinessMessage}</p> : null}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => startMutation.mutate()}
              disabled={!canStart || startMutation.isPending}
              className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              <Play className="h-4 w-4" />
              {startMutation.isPending
                ? "Starting..."
                : "Start Extraction Using Recommended Strategy"}
            </button>

            {isRestricted ? (
              <div className="inline-flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                <ShieldCheck className="h-4 w-4" />
                This source needs permission, feed, API, or manual import.
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
