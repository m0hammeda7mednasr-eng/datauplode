import { useQuery } from '@tanstack/react-query';
import { 
  History, 
  RotateCcw, 
  CheckCircle2, 
  XCircle, 
  Clock, 
  Loader2,
  ExternalLink,
  ChevronRight
} from 'lucide-react';
import axios from 'axios';
import { cn } from '../lib/utils';

export default function SyncJobs() {
  const { data: jobs, isLoading } = useQuery({
    queryKey: ['sync-jobs'],
    queryFn: async () => {
      const { data } = await axios.get('/api/sync-jobs');
      return data;
    },
    refetchInterval: 5000 // Refresh every 5s while viewing
  });

  return (
    <div className="space-y-8 max-w-6xl mx-auto pb-12">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Sync Journal</h1>
          <p className="text-slate-500 font-medium">Real-time status of background scraping and synchronization workers.</p>
        </div>
        <div className="px-4 py-2 bg-white border border-card-border rounded-xl shadow-sm text-xs font-bold uppercase tracking-widest flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          Active Workers: 2
        </div>
      </div>

      <div className="bg-white rounded-xl border border-card-border shadow-sm overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 border-b border-card-border">
            <tr>
              <th className="px-6 py-4 text-left font-black text-slate-400 uppercase tracking-widest">Job Type</th>
              <th className="px-6 py-4 text-left font-black text-slate-400 uppercase tracking-widest">Status</th>
              <th className="px-6 py-4 text-left font-black text-slate-400 uppercase tracking-widest">Runtime</th>
              <th className="px-6 py-4 text-right font-black text-slate-400 uppercase tracking-widest">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {jobs?.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-6 py-12 text-center text-slate-400 italic">No sync jobs recorded yet.</td>
              </tr>
            ) : jobs?.map((job: any) => (
              <tr key={job.id} className="hover:bg-slate-50/50 transition-colors">
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded bg-slate-100 flex items-center justify-center text-slate-600 border border-slate-100">
                      {job.type === 'SCRAPE_PRODUCT' ? <RotateCcw size={14} /> : <History size={14} />}
                    </div>
                    <div>
                      <p className="font-bold text-slate-900">{job.type.replace(/_/g, ' ')}</p>
                      <p className="text-[10px] text-slate-400 font-mono">ID: {job.id.slice(-8).toUpperCase()}</p>
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <div className={cn(
                    "inline-flex items-center gap-1.5 px-2 py-0.5 rounded font-black uppercase text-[9px] tracking-tight",
                    job.status === 'completed' ? "bg-emerald-100 text-emerald-800" : 
                    job.status === 'failed' ? "bg-rose-100 text-rose-800" :
                    job.status === 'running' ? "bg-blue-100 text-blue-800" : "bg-slate-100 text-slate-600"
                  )}>
                    {job.status === 'running' ? <Loader2 className="h-2 w-2 animate-spin" /> : 
                     job.status === 'completed' ? <CheckCircle2 size={10} /> : <XCircle size={10} />}
                    {job.status}
                  </div>
                </td>
                <td className="px-6 py-4 text-slate-500 font-mono text-[10px]">
                  {job.startedAt ? new Date(job.startedAt).toLocaleTimeString() : '--:--'}
                  {job.completedAt && ` → ${new Date(job.completedAt).toLocaleTimeString()}`}
                </td>
                <td className="px-6 py-4 text-right">
                  <button className="text-[10px] font-black text-primary uppercase tracking-widest flex items-center gap-1 ml-auto hover:underline">
                    View Logs <ChevronRight size={10} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

