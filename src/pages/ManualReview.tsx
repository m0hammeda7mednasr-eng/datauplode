import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  CheckCircle2, 
  XCircle, 
  ExternalLink, 
  AlertTriangle,
  ChevronRight,
  TrendingUp,
  Package
} from 'lucide-react';
import axios from 'axios';
import { toast } from 'sonner';
import { cn } from '../lib/utils';

export default function ManualReview() {
  const queryClient = useQueryClient();
  
  const { data: items, isLoading } = useQuery({
    queryKey: ['manual-review'],
    queryFn: async () => {
      const { data } = await axios.get('/api/manual-review');
      return data;
    }
  });

  const resolveMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string, status: string }) => 
      axios.post(`/api/manual-review/${id}/${status}`),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['manual-review'] });
      toast.success(`Request ${variables.status === 'approve' ? 'approved' : 'rejected'}`);
    }
  });

  return (
    <div className="space-y-8 max-w-6xl mx-auto pb-12">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">Manual Review</h1>
        <p className="text-slate-500 font-medium">Flagged state changes requiring human verification before Shopify update.</p>
      </div>

      <div className="space-y-4">
        {items?.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-20 bg-white border border-card-border rounded-2xl text-center space-y-4">
            <div className="w-16 h-16 bg-emerald-50 text-emerald-500 rounded-full flex items-center justify-center">
              <CheckCircle2 size={32} />
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-900">Clear Skies!</h2>
              <p className="text-slate-500">No products currently require manual verification.</p>
            </div>
          </div>
        ) : items?.map((item: any) => (
          <div key={item.id} className="bg-white rounded-xl border border-card-border shadow-sm overflow-hidden group hover:border-primary transition-all">
            <div className="p-6 flex flex-col md:flex-row gap-6 items-start md:items-center">
              <div className="w-16 h-20 bg-slate-100 rounded border border-slate-100 shrink-0 overflow-hidden">
                {/* Product Image placeholder */}
              </div>
              
              <div className="flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="bg-amber-100 text-amber-800 text-[9px] font-black px-1.5 py-0.5 rounded uppercase tracking-wider border border-amber-200">
                    Verification Needed
                  </span>
                  <span className="text-xs text-slate-400 font-bold uppercase tracking-widest">{item.sourceProduct?.supplier?.name}</span>
                </div>
                <h3 className="font-bold text-slate-900 text-lg leading-tight">{item.sourceProduct?.title}</h3>
                <p className="text-xs text-slate-500 flex items-center gap-1">
                  <AlertTriangle size={12} className="text-amber-500" />
                  Reason: <span className="font-bold text-slate-700">{item.reason}</span>
                </p>
                <p className="text-[11px] font-bold text-slate-600 uppercase tracking-wider">
                  Sheet Row: {item.excelRowNumber ? item.excelRowNumber : '-'}
                </p>
              </div>

              <div className="flex gap-3 shrink-0">
                <button 
                  onClick={() => resolveMutation.mutate({ id: item.id, status: 'reject' })}
                  className="px-4 py-2 text-xs font-bold text-rose-500 hover:bg-rose-50 rounded-md transition-all uppercase tracking-widest"
                >
                  Reject & Pause
                </button>
                <button 
                  onClick={() => resolveMutation.mutate({ id: item.id, status: 'approve' })}
                  className="bg-primary text-white px-6 py-2.5 rounded-md text-xs font-bold hover:opacity-90 transition-all uppercase tracking-widest shadow-lg shadow-indigo-100"
                >
                  Approve Sync
                </button>
              </div>
            </div>
            
            <div className="px-6 py-3 bg-slate-50 border-t border-card-border flex justify-between items-center">
              <div className="flex gap-4 text-[10px] font-black uppercase tracking-widest text-slate-400">
                <div className="flex items-center gap-1"><Package size={10} /> Variants: 4</div>
                <div className="flex items-center gap-1"><TrendingUp size={10} /> Logic: Price Drift</div>
              </div>
              <button className="text-[10px] font-black text-primary uppercase tracking-widest flex items-center gap-1 hover:underline">
                View Detailed Delta <ChevronRight size={10} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
