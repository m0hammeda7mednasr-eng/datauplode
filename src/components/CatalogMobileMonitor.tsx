import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  PackagePlus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { cn } from '../lib/utils';

const JOB_PREFIX = 'CATALOG_SOURCE_AUTHORITY:';

function parseResult(value: unknown) {
  if (!value) return {} as Record<string, any>;
  if (typeof value === 'object') return value as Record<string, any>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {} as Record<string, any>;
  }
}

function number(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function Stat({ label, value, icon: Icon, tone }: { label: string; value: number; icon: any; tone: string }) {
  return (
    <div className="min-w-[128px] flex-1 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-black uppercase tracking-wide text-slate-400">{label}</span>
        <Icon className={cn('h-3.5 w-3.5', tone)} />
      </div>
      <p className="mt-1 text-xl font-black tracking-tight text-slate-950">{value.toLocaleString()}</p>
    </div>
  );
}

export default function CatalogMobileMonitor() {
  const jobsQuery = useQuery({
    queryKey: ['source-authority-jobs-mobile'],
    queryFn: async () => (await axios.get('/api/sync-jobs')).data,
    refetchInterval: (query) => {
      const jobs = Array.isArray(query.state.data) ? query.state.data : [];
      const current = jobs.find((job: any) => String(job?.type || '').startsWith(JOB_PREFIX));
      return current?.status === 'running' ? 8_000 : 45_000;
    },
    staleTime: 5_000,
  });

  const jobs = Array.isArray(jobsQuery.data) ? jobsQuery.data : [];
  const job = jobs.find((entry: any) => String(entry?.type || '').startsWith(JOB_PREFIX));
  const result = parseResult(job?.result);
  const running = job?.status === 'running' || job?.status === 'pending';
  const failed = job?.status === 'failed';
  const completed = job?.status === 'completed';

  return (
    <section className="border-b border-slate-200 bg-slate-50/90 px-3 py-3 md:hidden">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {running ? <Loader2 className="h-4 w-4 animate-spin text-sky-600" /> : failed ? <AlertTriangle className="h-4 w-4 text-rose-600" /> : completed ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <RefreshCw className="h-4 w-4 text-slate-500" />}
            <p className="truncate text-xs font-black text-slate-900">Source Catalog Monitor</p>
          </div>
          <p className="mt-0.5 truncate text-[10px] font-semibold text-slate-500">
            {job ? `${job.status} · ${String(result.stage || 'waiting').replaceAll('_', ' ')}` : 'Waiting for first source-authority cycle'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => jobsQuery.refetch()}
          disabled={jobsQuery.isFetching}
          className="rounded-xl border border-slate-200 bg-white p-2 text-slate-600 disabled:opacity-50"
          aria-label="Refresh catalog monitor"
        >
          <RefreshCw className={cn('h-4 w-4', jobsQuery.isFetching && 'animate-spin')} />
        </button>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <Stat label="New" value={number(result.newPublished)} icon={PackagePlus} tone="text-emerald-600" />
        <Stat label="Drafts deleted" value={number(result.shopifyDraftDeleted)} icon={Trash2} tone="text-rose-600" />
        <Stat label="Failed removed" value={number(result.failedSourcePurged)} icon={Trash2} tone="text-amber-600" />
        <Stat label="Missing removed" value={number(result.missingSourcePurged)} icon={Trash2} tone="text-sky-600" />
      </div>

      {Boolean(result.missingSourceGuarded) && (
        <div className="mt-2 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] font-bold text-amber-900">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Missing-product deletion is safety-locked because the source scan looked incomplete or abnormal.
        </div>
      )}
    </section>
  );
}
