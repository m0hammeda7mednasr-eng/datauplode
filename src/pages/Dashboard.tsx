import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Link2,
  TrendingUp,
} from "lucide-react";
import axios from "axios";
import { cn } from "../lib/utils";

function formatRelative(value?: string) {
  if (!value) return "-";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "-";
  const diffMs = Date.now() - time;
  const mins = Math.max(0, Math.floor(diffMs / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function Dashboard() {
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard-real-data"],
    queryFn: async () => {
      const [statsRes, linkedRes] = await Promise.all([
        axios.get("/api/products/stats"),
        axios.get("/api/products", { params: { limit: 12 } }),
      ]);
      const linked = Array.isArray(linkedRes.data) ? linkedRes.data : [];
      const stats = statsRes.data || {};
      return { linked, stats };
    },
    refetchInterval: 10000,
    refetchOnWindowFocus: true,
  });

  const linked = data?.linked || [];
  const stats = useMemo(() => {
    const totalLinked = Number(data?.stats?.totalLinked || linked.length || 0);
    const activeSync = Number(data?.stats?.activeSync || 0);
    return {
      totalLinked,
      activeSync,
      pendingReview: Number(data?.stats?.pendingReview || 0),
      sourceLinks24h: Number(data?.stats?.sourceLinks24h?.success || 0),
      catalogSuccess24h: Number(data?.stats?.catalog24h?.success || 0),
      catalogFailed24h: Number(data?.stats?.catalog24h?.failed || 0),
    };
  }, [data?.stats, linked.length]);

  const recentLinked = linked.slice(0, 6);
  const recentCatalogUpdates = Array.isArray(data?.stats?.catalog24h?.recent)
    ? data.stats.catalog24h.recent
    : [];
  const recentSourceLinks = Array.isArray(data?.stats?.sourceLinks24h?.recent)
    ? data.stats.sourceLinks24h.recent
    : [];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">Dashboard</h1>
        <p className="text-sm font-medium text-slate-500">
          Live data from your saved products, extracted queue, and review status.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
        <StatCard icon={Link2} label="Linked Products" value={stats.totalLinked} tone="indigo" />
        <StatCard icon={TrendingUp} label="Active Sync" value={stats.activeSync} tone="emerald" />
        <StatCard icon={AlertCircle} label="Needs Review" value={stats.pendingReview} tone="amber" />
        <StatCard icon={Link2} label="Source Links 24h" value={stats.sourceLinks24h} tone="indigo" />
        <StatCard icon={CheckCircle2} label="Catalog 24h" value={stats.catalogSuccess24h} tone="slate" />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <section className="xl:col-span-2 space-y-4">
          <div className="rounded-xl border border-card-border bg-white p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-black uppercase tracking-widest text-slate-500">Recent Linked</h2>
              <Link className="text-xs font-bold text-primary hover:underline" to="/products">
                Open Linked Products
              </Link>
            </div>
            <div className="space-y-2">
              {isLoading && <p className="text-sm text-slate-500">Loading...</p>}
              {!isLoading && recentLinked.length === 0 && (
                <p className="text-sm text-slate-500">No linked products found yet.</p>
              )}
              {recentLinked.map((item: any) => (
                <div key={item.id} className="flex items-center justify-between rounded-lg border border-slate-100 p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-900">{item.title}</p>
                    <p className="text-[11px] font-medium text-slate-500">
                      {item.supplier?.name || "Supplier"} | {item.currency || "-"} {item.price ?? "-"}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-widest",
                        item.syncStatus === "active"
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-slate-100 text-slate-600",
                      )}
                    >
                      {item.syncStatus || "unknown"}
                    </span>
                    <Link className="text-primary hover:underline text-xs font-bold" to={`/products/${item.id}`}>
                      Details
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-card-border bg-white p-5">
            <div className="mb-4 flex items-center justify-between gap-4">
              <h2 className="text-sm font-black uppercase tracking-widest text-slate-500">Source Links 24h</h2>
              <span className="text-xs font-bold text-emerald-700">{stats.sourceLinks24h} linked</span>
            </div>
            <div className="space-y-2">
              {!isLoading && recentSourceLinks.length === 0 && (
                <p className="text-sm text-slate-500">No source links completed in the last 24 hours.</p>
              )}
              {recentSourceLinks.map((item: any) => (
                <div key={item.id} className="flex items-center justify-between gap-4 rounded-lg border border-slate-100 p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-900">{item.title}</p>
                    <p className="text-[11px] font-medium text-slate-500">
                      {item.supplier || "Supplier"} | {formatRelative(item.createdAt)} | {Math.round(Number(item.titleOverlap || 0) * 100)}% title match
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-widest text-emerald-700">
                    Linked
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-card-border bg-white p-5">
            <div className="mb-4 flex items-center justify-between gap-4">
              <h2 className="text-sm font-black uppercase tracking-widest text-slate-500">Catalog Updates 24h</h2>
              <div className="flex items-center gap-3 text-xs font-bold">
                <span className="text-emerald-700">{stats.catalogSuccess24h} verified</span>
                <span className="text-rose-700">{stats.catalogFailed24h} failed</span>
              </div>
            </div>
            <div className="space-y-2">
              {!isLoading && recentCatalogUpdates.length === 0 && (
                <p className="text-sm text-slate-500">No catalog updates in the last 24 hours.</p>
              )}
              {recentCatalogUpdates.map((item: any) => (
                <div key={item.id} className="flex items-center justify-between gap-4 rounded-lg border border-slate-100 p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-900">{item.title}</p>
                    <p className="text-[11px] font-medium text-slate-500">
                      {formatRelative(item.createdAt)} | {item.variants || 0} variants | {item.images || 0} images
                    </p>
                  </div>
                  <span className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-widest",
                    item.status === "success"
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-rose-100 text-rose-700",
                  )}>
                    {item.status === "success" ? "Verified" : "Failed"}
                  </span>
                </div>
              ))}
            </div>
          </div>

        </section>

        <aside className="space-y-4">
          <div className="rounded-xl border border-card-border bg-white p-5">
            <h3 className="text-sm font-black uppercase tracking-widest text-slate-500">All Departments</h3>
            <div className="mt-3 space-y-2 text-sm">
              <QuickLink to="/import" icon={ExternalLink} label="Import Product" />
              <QuickLink to="/products" icon={ExternalLink} label="Linked Products" />
              <QuickLink to="/review" icon={AlertCircle} label="Manual Review" />
              <QuickLink to="/pricing" icon={ExternalLink} label="Pricing Rules" />
              <QuickLink to="/sync-jobs" icon={ExternalLink} label="Sync Jobs" />
              <QuickLink to="/sources" icon={ExternalLink} label="Sources" />
              <QuickLink to="/settings" icon={ExternalLink} label="Settings" />
            </div>
          </div>

          <div className="rounded-xl border border-card-border bg-white p-5">
            <h3 className="text-sm font-black uppercase tracking-widest text-slate-500">Live Status</h3>
            <div className="mt-3 space-y-2 text-sm">
              <div className="flex items-center gap-2 text-xs text-slate-500">
                Last refresh: {formatRelative(new Date().toISOString())}
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function QuickLink({ to, label, icon: Icon }: { to: string; label: string; icon: any }) {
  return (
    <Link to={to} className="flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:border-primary hover:text-primary">
      <Icon className="h-3.5 w-3.5" />
      {label}
    </Link>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: any;
  label: string;
  value: number;
  tone: "indigo" | "emerald" | "amber" | "slate";
}) {
  return (
    <div className="rounded-xl border border-card-border bg-white p-4">
      <div className="mb-3 flex items-center gap-2">
        <div
          className={cn(
            "rounded-lg border p-2",
            tone === "indigo" && "border-indigo-200 bg-indigo-50 text-indigo-700",
            tone === "emerald" && "border-emerald-200 bg-emerald-50 text-emerald-700",
            tone === "amber" && "border-amber-200 bg-amber-50 text-amber-700",
            tone === "slate" && "border-slate-200 bg-slate-50 text-slate-700",
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">{label}</p>
      </div>
      <p className="text-2xl font-black text-slate-900">{value}</p>
    </div>
  );
}
