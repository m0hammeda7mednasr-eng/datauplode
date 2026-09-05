import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { toast } from 'sonner';

const PAGE_SIZE = 50;

type AuditRow = {
  id: string;
  numericId: string;
  title: string;
  handle: string;
  vendor: string;
  status: string;
  productType: string;
  inventory: number;
  variantCount: number;
  defaultValues: string[];
  sampleVariants: Array<{ title: string; sku: string | null }>;
  issueType: 'single_default' | 'multi_placeholder';
  recommendedAction: 'expand_or_normalize' | 'clean_placeholder';
  sourceUrl: string | null;
  sourceVariantCount: number | null;
  sourceSyncStatus: string | null;
  sourceLastScrapedAt: string | null;
  difficulty: 'easy' | 'medium' | 'hard' | 'review';
  difficultyReason: string;
  repairStatus: 'queued' | 'checking' | 'confirmed_single' | 'failed' | 'needs_review' | 'needs_source';
  repairMessage: string;
  lastRepairAt: string | null;
};

type AuditResponse = {
  success: boolean;
  generatedAt: string;
  cacheAgeSeconds: number;
  summary: {
    total: number;
    issueType: Record<string, number>;
    difficulty: Record<string, number>;
    repairStatus: Record<string, number>;
  };
  operations?: {
    worker: {
      enabled: boolean;
      defaultVariantsOnly: boolean;
      targetDomains: string[];
      batchSize: number;
      intervalMinutes: number;
      failureRetryMinutes: number;
    };
    credits: { usedToday: number; dailyLimit: number; remainingToday: number | null };
    last24h: { verified: number; failed: number; skipped: number };
    latestJob: null | {
      id: string;
      status: string;
      createdAt: string;
      completedAt: string | null;
      runningSeconds: number;
      stalled: boolean;
      selected: number;
      completed: number;
      failed: number;
      readbackVerified: number;
    };
    sources: Array<{ domain: string; verified: number; failed: number; skipped: number; successRate: number | null }>;
    generatedAt: string;
  };
  vendors: string[];
  totalFiltered: number;
  offset: number;
  limit: number;
  rows: AuditRow[];
  note: string;
};

async function loadAudit(params: {
  search: string;
  issueType: string;
  difficulty: string;
  repairStatus: string;
  vendor: string;
  offset: number;
  refresh?: boolean;
}) {
  const { data } = await axios.get<AuditResponse>('/api/shopify-catalog/default-variant-audit', {
    params: {
      search: params.search || undefined,
      issueType: params.issueType === 'all' ? undefined : params.issueType,
      difficulty: params.difficulty === 'all' ? undefined : params.difficulty,
      repairStatus: params.repairStatus === 'all' ? undefined : params.repairStatus,
      vendor: params.vendor === 'all' ? undefined : params.vendor,
      offset: params.offset,
      limit: PAGE_SIZE,
      refresh: params.refresh ? 'true' : undefined,
    },
  });
  return data;
}

function badgeClass(value: string) {
  if (['easy', 'confirmed_single'].includes(value)) return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (['medium', 'queued', 'checking'].includes(value)) return 'bg-amber-50 text-amber-700 border-amber-200';
  if (['hard', 'failed'].includes(value)) return 'bg-rose-50 text-rose-700 border-rose-200';
  return 'bg-slate-50 text-slate-600 border-slate-200';
}

function StatusBadge({ value }: { value: string }) {
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize', badgeClass(value))}>
      {value.replaceAll('_', ' ')}
    </span>
  );
}

function StatCard({ label, value, hint, tone = 'default' }: { label: string; value: number; hint: string; tone?: 'default' | 'warn' | 'danger' | 'good' }) {
  const toneClass = {
    default: 'border-slate-200',
    warn: 'border-amber-200 bg-amber-50/30',
    danger: 'border-rose-200 bg-rose-50/30',
    good: 'border-emerald-200 bg-emerald-50/30',
  }[tone];
  return (
    <div className={cn('rounded-xl border bg-white p-4 shadow-sm', toneClass)}>
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-3xl font-bold tracking-tight text-slate-900">{value.toLocaleString()}</div>
      <div className="mt-1 text-xs text-slate-500">{hint}</div>
    </div>
  );
}

export default function DefaultVariants() {
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [issueType, setIssueType] = useState('all');
  const [difficulty, setDifficulty] = useState('all');
  const [repairStatus, setRepairStatus] = useState('all');
  const [vendor, setVendor] = useState('all');
  const [offset, setOffset] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const queryKey = ['default-variant-audit', search, issueType, difficulty, repairStatus, vendor, offset];
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey,
    queryFn: () => loadAudit({ search, issueType, difficulty, repairStatus, vendor, offset }),
    staleTime: 45_000,
  });

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil((data?.totalFiltered || 0) / PAGE_SIZE));
  const hasFilters = search || issueType !== 'all' || difficulty !== 'all' || repairStatus !== 'all' || vendor !== 'all';
  const vendors = data?.vendors || [];

  const statusTotal = useMemo(() => ({
    failed: data?.summary.repairStatus.failed || 0,
    confirmedSingle: data?.summary.repairStatus.confirmed_single || 0,
    noSource: data?.summary.repairStatus.needs_source || 0,
  }), [data]);

  function applySearch() {
    setOffset(0);
    setSearch(searchInput.trim());
  }

  function resetFilters() {
    setSearchInput('');
    setSearch('');
    setIssueType('all');
    setDifficulty('all');
    setRepairStatus('all');
    setVendor('all');
    setOffset(0);
  }

  async function forceRefresh() {
    setRefreshing(true);
    try {
      await loadAudit({ search, issueType, difficulty, repairStatus, vendor, offset, refresh: true });
      await queryClient.invalidateQueries({ queryKey: ['default-variant-audit'] });
      toast.success('Default variant audit refreshed from Shopify');
    } catch (refreshError: any) {
      toast.error(refreshError?.response?.data?.error || refreshError?.message || 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[420px] items-center justify-center">
        <div className="text-center">
          <Loader2 className="mx-auto h-7 w-7 animate-spin text-primary" />
          <p className="mt-3 text-sm text-slate-500">Scanning Shopify for Default variants…</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">
        <div className="font-semibold">Default variant audit could not load.</div>
        <div className="mt-1">{(error as any)?.response?.data?.error || (error as any)?.message || 'Unknown error'}</div>
      </div>
    );
  }

  const operations: NonNullable<AuditResponse['operations']> = data.operations || {
    worker: { enabled: false, defaultVariantsOnly: false, targetDomains: [], batchSize: 0, intervalMinutes: 0, failureRetryMinutes: 0 },
    credits: { usedToday: 0, dailyLimit: 0, remainingToday: null },
    last24h: { verified: 0, failed: 0, skipped: 0 },
    latestJob: null,
    sources: [],
    generatedAt: data.generatedAt,
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-6 w-6 text-amber-500" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">Default Variant Audit</h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-500">
            Default Title, Default 1, plain Default, and Default placeholders inside otherwise real variants. Fresh source data decides the safe fix.
          </p>
        </div>
        <button
          type="button"
          onClick={forceRefresh}
          disabled={refreshing || isFetching}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw className={cn('h-4 w-4', (refreshing || isFetching) && 'animate-spin')} />
          Refresh Shopify
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <StatCard label="All Default Issues" value={data.summary.total} hint="Live candidates" tone="warn" />
        <StatCard label="Single Default" value={data.summary.issueType.single_default || 0} hint="Verify: expand or normalize" />
        <StatCard label="Multi Placeholder" value={data.summary.issueType.multi_placeholder || 0} hint="Clean only the bad option" />
        <StatCard label="Confirmed Single" value={statusTotal.confirmedSingle} hint="Do not invent variants" tone="good" />
        <StatCard label="Failed" value={statusTotal.failed} hint="Retry / fallback required" tone="danger" />
        <StatCard label="Needs Source" value={statusTotal.noSource} hint="Link source before writing" />
      </div>

      <section className="border-y border-slate-200 bg-white py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Activity className={cn('h-5 w-5', operations.worker.enabled ? 'text-emerald-600' : 'text-slate-400')} />
            <div>
              <div className="text-sm font-semibold text-slate-900">Catalog repair runtime</div>
              <div className="text-xs text-slate-500">
                {operations.worker.targetDomains.join(', ') || 'No target'} · {operations.worker.batchSize} per {operations.worker.intervalMinutes} min
              </div>
            </div>
          </div>
          <StatusBadge value={operations.latestJob?.stalled ? 'stalled' : operations.latestJob?.status || (operations.worker.enabled ? 'queued' : 'disabled')} />
        </div>

        <div className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
          <div>
            <div className="text-[11px] font-semibold uppercase text-slate-500">Verified · 24h</div>
            <div className="mt-1 text-xl font-bold text-emerald-700">{operations.last24h.verified.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase text-slate-500">Failed safely · 24h</div>
            <div className="mt-1 text-xl font-bold text-rose-700">{operations.last24h.failed.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase text-slate-500">ScraperAPI today</div>
            <div className="mt-1 text-xl font-bold text-slate-900">
              {operations.credits.usedToday.toLocaleString()} / {operations.credits.dailyLimit.toLocaleString()}
            </div>
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase text-slate-500">Latest read-back</div>
            <div className="mt-1 text-xl font-bold text-slate-900">
              {(operations.latestJob?.readbackVerified || 0).toLocaleString()} / {(operations.latestJob?.selected || 0).toLocaleString()}
            </div>
          </div>
        </div>

        {operations.sources.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {operations.sources.slice(0, 8).map((source) => (
              <div key={source.domain} className="flex items-center gap-2 border-l-2 border-slate-200 px-2 py-1 text-xs">
                <span className="font-semibold text-slate-700">{source.domain}</span>
                <span className="text-emerald-700">{source.verified} verified</span>
                <span className="text-rose-700">{source.failed} failed</span>
                {source.successRate !== null && <span className="text-slate-400">{source.successRate}%</span>}
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-3 lg:grid-cols-4">
        {(['easy', 'medium', 'hard', 'review'] as const).map((level) => (
          <button
            type="button"
            key={level}
            onClick={() => { setDifficulty(difficulty === level ? 'all' : level); setOffset(0); }}
            className={cn(
              'rounded-xl border bg-white p-4 text-left shadow-sm transition hover:border-slate-300',
              difficulty === level && 'ring-2 ring-primary/20 border-primary',
            )}
          >
            <div className="flex items-center justify-between">
              <StatusBadge value={level} />
              <span className="text-2xl font-bold text-slate-900">{(data.summary.difficulty[level] || 0).toLocaleString()}</span>
            </div>
            <div className="mt-2 text-xs text-slate-500">
              {level === 'easy' && 'Known direct source'}
              {level === 'medium' && 'Fresh richer scrape needed'}
              {level === 'hard' && 'Restricted/dynamic source'}
              {level === 'review' && 'No linked source yet'}
            </div>
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 p-4">
          <div className="flex flex-wrap gap-2">
            <div className="flex min-w-[280px] flex-1 items-center rounded-lg border border-slate-200 bg-white px-3">
              <Search className="h-4 w-4 text-slate-400" />
              <input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && applySearch()}
                placeholder="Search product, vendor, handle or SKU…"
                className="w-full border-0 bg-transparent px-2 py-2.5 text-sm outline-none"
              />
              <button onClick={applySearch} className="text-xs font-semibold text-primary">Search</button>
            </div>

            <select value={issueType} onChange={(event) => { setIssueType(event.target.value); setOffset(0); }} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
              <option value="all">All issue types</option>
              <option value="single_default">Single Default</option>
              <option value="multi_placeholder">Multi Placeholder</option>
            </select>
            <select value={difficulty} onChange={(event) => { setDifficulty(event.target.value); setOffset(0); }} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
              <option value="all">All difficulty</option>
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
              <option value="review">Needs source</option>
            </select>
            <select value={repairStatus} onChange={(event) => { setRepairStatus(event.target.value); setOffset(0); }} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
              <option value="all">All repair states</option>
              <option value="queued">Queued</option>
              <option value="checking">Checking</option>
              <option value="confirmed_single">Confirmed single</option>
              <option value="failed">Failed</option>
              <option value="needs_review">Needs review</option>
              <option value="needs_source">Needs source</option>
            </select>
            <select value={vendor} onChange={(event) => { setVendor(event.target.value); setOffset(0); }} className="max-w-[190px] rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
              <option value="all">All vendors</option>
              {vendors.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
            {hasFilters && (
              <button onClick={resetFilters} className="inline-flex items-center gap-1 rounded-lg px-3 py-2 text-sm text-slate-500 hover:bg-slate-50">
                <XCircle className="h-4 w-4" /> Reset
              </button>
            )}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-left text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Default problem</th>
                <th className="px-4 py-3">Variants</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Difficulty</th>
                <th className="px-4 py-3">Repair status</th>
                <th className="px-4 py-3">Recommended action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.rows.map((row) => (
                <tr key={row.id} className="align-top hover:bg-slate-50/60">
                  <td className="px-4 py-4">
                    <div className="max-w-[330px] font-semibold text-slate-900">{row.title}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span>{row.vendor}</span>
                      <span>#{row.numericId}</span>
                      <span className="uppercase">{row.status}</span>
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <StatusBadge value={row.issueType} />
                    <div className="mt-2 flex max-w-[240px] flex-wrap gap-1">
                      {row.defaultValues.map((value) => (
                        <span key={value} className="rounded bg-rose-50 px-1.5 py-0.5 text-[11px] font-semibold text-rose-700">{value}</span>
                      ))}
                    </div>
                    {row.sampleVariants[0]?.sku && <div className="mt-1 text-[11px] text-slate-400">SKU {row.sampleVariants[0].sku}</div>}
                  </td>
                  <td className="px-4 py-4">
                    <div className="font-semibold text-slate-800">Shopify: {row.variantCount}</div>
                    <div className="mt-1 text-xs text-slate-500">Source: {row.sourceVariantCount ?? '—'}</div>
                  </td>
                  <td className="px-4 py-4">
                    {row.sourceUrl ? (
                      <a href={row.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex max-w-[220px] items-center gap-1 text-xs font-semibold text-primary hover:underline">
                        Open source <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <span className="text-xs font-semibold text-rose-600">Not linked</span>
                    )}
                    {row.sourceSyncStatus && <div className="mt-1 text-[11px] text-slate-400">Source status: {row.sourceSyncStatus}</div>}
                  </td>
                  <td className="px-4 py-4">
                    <StatusBadge value={row.difficulty} />
                    <div className="mt-1 max-w-[190px] text-[11px] leading-4 text-slate-500">{row.difficultyReason}</div>
                  </td>
                  <td className="px-4 py-4">
                    <StatusBadge value={row.repairStatus} />
                    <div className="mt-1 max-w-[250px] text-[11px] leading-4 text-slate-500">{row.repairMessage}</div>
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex items-start gap-2">
                      {row.issueType === 'single_default' ? <Sparkles className="mt-0.5 h-4 w-4 text-amber-500" /> : <ShieldCheck className="mt-0.5 h-4 w-4 text-emerald-500" />}
                      <div className="max-w-[220px] text-xs font-medium text-slate-700">
                        {row.issueType === 'single_default'
                          ? 'Fresh scrape → expand only when the source has real variants; otherwise normalize the one real option.'
                          : 'Keep the real variants and replace/remove only the Default placeholder using source + SKU evidence.'}
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
              {data.rows.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-sm text-slate-500">No products match these filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3">
          <div className="text-xs text-slate-500">
            Showing {data.totalFiltered ? offset + 1 : 0}–{Math.min(offset + PAGE_SIZE, data.totalFiltered)} of {data.totalFiltered.toLocaleString()} filtered · audit cache {data.cacheAgeSeconds}s old
          </div>
          <div className="flex items-center gap-2">
            <button
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              className="rounded-lg border border-slate-200 p-2 text-slate-600 disabled:opacity-30"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="min-w-[90px] text-center text-xs font-semibold text-slate-600">Page {page} / {totalPages}</span>
            <button
              disabled={page >= totalPages}
              onClick={() => setOffset(offset + PAGE_SIZE)}
              className="rounded-lg border border-slate-200 p-2 text-slate-600 disabled:opacity-30"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <span className="font-semibold">Safety rule:</span> a Default label alone does not prove variants are missing. The repair flow must verify the fresh source first, so genuine one-size products are normalized rather than expanded with fake variants.
        </div>
      </div>
    </div>
  );
}
