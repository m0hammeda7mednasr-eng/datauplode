import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { 
  Search, 
  Filter, 
  ExternalLink, 
  RefreshCw, 
  UploadCloud,
  CheckCircle2,
  X,
  Eye,
  Trash2,
  AlertTriangle,
  Loader2
} from 'lucide-react';
import axios from 'axios';
import { cn } from '../lib/utils';
import { toast } from 'sonner';
import { apiErrorMessage } from '../lib/api';

export default function LinkedProducts() {
  const [selectedCollection, setSelectedCollection] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  
  const { data: products, isLoading, refetch } = useQuery({
    queryKey: ['products', selectedCollection],
    queryFn: async () => {
      const { data } = await axios.get('/api/products', {
        params: { collectionId: selectedCollection, limit: 200 }
      });
      return data;
    },
    refetchInterval: 8000,
    refetchOnWindowFocus: true,
  });

  const { data: collections } = useQuery({
    queryKey: ['shopify-collections'],
    queryFn: async () => {
      const { data } = await axios.get('/api/shopify/collections');
      return data;
    },
    retry: false,
    refetchOnWindowFocus: false,
  });

  const { data: shopifyConfig } = useQuery({
    queryKey: ['shopify-config'],
    queryFn: async () => {
      const { data } = await axios.get('/api/settings/shopify');
      return data;
    }
  });

  const { data: catalogStatus } = useQuery({
    queryKey: ['catalog-worker-status'],
    queryFn: async () => {
      const { data } = await axios.get('/api/imports/excel/auto-sync/status');
      return data?.worker;
    },
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const catalogTotal = Number(catalogStatus?.total || 0);
  const catalogVerified = Number(catalogStatus?.verified || 0);
  const catalogPercent = catalogTotal > 0
    ? Math.min(100, Math.round((catalogVerified / catalogTotal) * 100))
    : 0;
  const stageLabel: Record<string, string> = {
    starting: 'Starting worker',
    update_existing_first: 'Updating existing products first',
    publish_missing_products: 'Publishing verified missing products',
    idle_monitoring: 'Waiting for the next retry cycle',
    target_complete_monitoring: 'Target complete — monitoring sheet changes',
    cycle_failed_retrying: 'Retrying after a temporary error',
  };

  const handleSyncNow = async (id: string) => {
    toast.promise(axios.post(`/api/products/${id}/sync`), {
      loading: 'Queuing sync job...',
      success: 'Sync job started!',
      error: 'Failed to start sync'
    });
  };

  const handleRepublish = async (id: string) => {
    toast.promise(axios.post(`/api/products/${id}/republish`), {
      loading: 'Queuing republish job...',
      success: 'Republish job started!',
      error: (error) => apiErrorMessage(error, 'Failed to republish product')
    });
  };

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => axios.delete(`/api/products/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['recent-products'] });
      toast.success('Product removed from Syncly');
      setDeleteTarget(null);
    },
    onError: (error: any) => {
      toast.error(apiErrorMessage(error, 'Failed to delete product'));
    }
  });

  const confirmDelete = () => {
    if (!deleteTarget?.id) return;
    deleteMutation.mutate(deleteTarget.id);
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900">Linked Products</h1>
          <p className="text-muted-foreground font-medium">Manage and monitor Shopify inventory synchronization.</p>
        </div>
        <button 
          onClick={() => refetch()}
          className="p-2 border rounded-lg hover:bg-zinc-50 transition-all" title="Refresh List"
        >
          <RefreshCw className={cn("h-5 w-5", isLoading && "animate-spin")} />
        </button>
      </div>

      {catalogStatus && (
        <div className="rounded-2xl border border-sky-200 bg-sky-50/70 p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                {catalogStatus.running ? (
                  <Loader2 className="h-4 w-4 animate-spin text-sky-600" />
                ) : (
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                )}
                <p className="font-black text-slate-900">First 8 sheets · 5,000-product run</p>
              </div>
              <p className="mt-1 text-xs font-medium text-slate-600">
                {stageLabel[catalogStatus.stage] || catalogStatus.stage}
              </p>
            </div>
            <div className="text-right">
              <p className="text-2xl font-black text-slate-900">{catalogVerified.toLocaleString()} / {catalogTotal.toLocaleString()}</p>
              <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">verified products</p>
            </div>
          </div>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-white">
            <div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${catalogPercent}%` }} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-5">
            <WorkerMetric label="Updated" value={catalogStatus.existingUpdated} />
            <WorkerMetric label="Published" value={catalogStatus.published} />
            <WorkerMetric label="Remaining" value={catalogStatus.remaining} />
            <WorkerMetric label="Retry events" value={catalogStatus.errors} />
            <WorkerMetric label="SKU pending" value={catalogStatus.sheetWritePending} />
          </div>
          <p className="mt-3 text-[11px] text-slate-500">
            Retry events are cumulative attempts, not incomplete products. Products missing a valid multiplier or full source data are not published.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-4">
        <div className="flex gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search by title, SKU, or URL..."
              className="w-full pl-10 pr-4 py-2 border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-black"
            />
          </div>
          <button className="flex items-center gap-2 px-4 py-2 border rounded-lg bg-white hover:bg-zinc-50 font-medium">
            <Filter className="h-4 w-4" />
            Filter
          </button>
        </div>

        {collections && collections.length > 0 && (
          <div className="flex flex-wrap gap-2 py-1 items-center">
            <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider mr-2">Filter by Collection:</span>
            <button
              onClick={() => setSelectedCollection(null)}
              className={cn(
                "px-3 py-1 rounded-full text-[10px] font-bold border transition-all",
                selectedCollection === null
                  ? "bg-primary border-primary text-white shadow-sm"
                  : "bg-white border-slate-200 text-slate-500 hover:border-slate-300"
              )}
            >
              All Products
            </button>
            {collections.map((col: any) => (
              <button
                key={col.id}
                onClick={() => setSelectedCollection(col.id)}
                className={cn(
                  "px-3 py-1 rounded-full text-[10px] font-bold border transition-all flex items-center gap-1.5",
                  selectedCollection === col.id
                    ? "bg-primary border-primary text-white shadow-sm"
                    : "bg-white border-slate-200 text-slate-500 hover:border-slate-300"
                )}
              >
                {col.title}
                {selectedCollection === col.id && (
                  <X 
                    className="h-3 w-3 hover:text-white/80" 
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedCollection(null);
                    }} 
                  />
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 border-b border-zinc-100 uppercase text-[10px] tracking-widest font-bold text-zinc-500">
            <tr>
              <th className="px-6 py-4 text-left">Product</th>
              <th className="px-6 py-4 text-left">Sheet Row</th>
              <th className="px-6 py-4 text-left">Links</th>
              <th className="px-6 py-4 text-left">Status</th>
              <th className="px-6 py-4 text-left">Pricing</th>
              <th className="px-6 py-4 text-left">Last Sync</th>
              <th className="px-6 py-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-50">
            {products?.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-6 py-12 text-center text-muted-foreground italic">
                  No linked products yet. Start by importing a new product.
                </td>
              </tr>
            ) : products?.map((p: any) => (
              <tr 
                key={p.id} 
                className="group hover:bg-zinc-50/50 transition-colors cursor-pointer"
                onClick={() => navigate(`/products/${p.id}`)}
              >
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-12 bg-zinc-100 rounded border shrink-0 overflow-hidden">
                      {p.images?.[0] && <img src={p.images[0].url} className="w-full h-full object-cover" />}
                    </div>
                    <div>
                      <p className="font-bold text-zinc-900 group-hover:text-primary transition-colors">{p.title}</p>
                      <p className="text-[10px] uppercase font-bold text-zinc-400 tracking-tighter">{p.supplier?.name}</p>
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-slate-600">
                    {p.excelRowNumber ? `Row ${p.excelRowNumber}` : '-'}
                  </span>
                </td>
                <td className="px-6 py-4">
                  <div className="flex gap-2" onClick={e => e.stopPropagation()}>
                    <a href={p.url} target="_blank" rel="noreferrer" className="p-1.5 border rounded hover:bg-zinc-100 transition-all text-zinc-400 hover:text-zinc-900" title="Source URL">
                      <ExternalLink className="h-3 w-3" />
                    </a>
                    {p.shopifyProduct && shopifyConfig?.shopDomain && (
                      <a href={`https://${shopifyConfig.shopDomain}/admin/products/${p.shopifyProduct.shopifyId.split('/').pop()}`} target="_blank" rel="noreferrer" className="p-1.5 border rounded hover:bg-zinc-100 text-zinc-400 hover:text-green-600 transition-all" title="Shopify Admin">
                        <CheckCircle2 className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                </td>
                <td className="px-6 py-4">
                  <div className={cn(
                    "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-tight",
                    p.syncStatus === 'active' ? "bg-green-100 text-green-700" : 
                    p.syncStatus === 'paused' ? "bg-amber-100 text-amber-700" : "bg-zinc-100 text-zinc-700"
                  )}>
                    <div className={cn("w-1 h-1 rounded-full", p.syncStatus === 'active' ? "bg-green-500" : "bg-zinc-400")} />
                    {p.syncStatus}
                  </div>
                </td>
                <td className="px-6 py-4 font-mono text-xs">
                  <p className="font-bold">${p.shopifyProduct?.price ?? 'N/A'}</p>
                  <p className="text-zinc-400 italic">orig: {p.currency} {p.price}</p>
                </td>
                <td className="px-6 py-4 text-muted-foreground text-xs italic">
                  {new Date(p.updatedAt).toLocaleDateString()}
                </td>
                <td className="px-6 py-4 text-right">
                  <div className="flex justify-end gap-2" onClick={e => e.stopPropagation()}>
                    <button 
                      onClick={() => handleSyncNow(p.id)}
                      className="p-2 hover:bg-zinc-100 rounded-lg transition-all text-zinc-400 hover:text-zinc-900" title="Sync Now"
                    >
                      <RefreshCw className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => handleRepublish(p.id)}
                      className="p-2 hover:bg-emerald-50 rounded-lg transition-all text-zinc-400 hover:text-emerald-600"
                      title="Republish to Shopify"
                    >
                      <UploadCloud className="h-4 w-4" />
                    </button>
                    <button 
                      onClick={() => navigate(`/products/${p.id}`)}
                      className="p-2 hover:bg-zinc-100 rounded-lg transition-all text-zinc-400 hover:text-zinc-900" title="View Details"
                    >
                      <Eye className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setDeleteTarget(p)}
                      className="p-2 hover:bg-rose-50 rounded-lg transition-all text-zinc-400 hover:text-rose-600"
                      title="Delete from Syncly"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-start gap-3 border-b border-slate-100 px-5 py-4">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-rose-50 text-rose-600">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h2 className="font-bold text-slate-950">Delete linked product?</h2>
                <p className="mt-1 text-xs font-medium leading-relaxed text-slate-500">
                  This removes the product, variants, images, sync link, and local logs from Syncly. The Shopify product itself will not be deleted.
                </p>
              </div>
            </div>

            <div className="px-5 py-4">
              <div className="flex items-center gap-3 rounded-lg border border-slate-100 bg-slate-50 p-3">
                <div className="h-12 w-10 overflow-hidden rounded border border-slate-200 bg-white">
                  {deleteTarget.images?.[0] && (
                    <img src={deleteTarget.images[0].url} className="h-full w-full object-cover" />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-slate-900">{deleteTarget.title}</p>
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                    {deleteTarget.supplier?.name || 'Supplier'}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-4">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleteMutation.isPending}
                className="rounded-md border border-slate-200 bg-white px-4 py-2 text-xs font-black uppercase tracking-widest text-slate-500 transition-all hover:bg-slate-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={deleteMutation.isPending}
                className="flex items-center gap-2 rounded-md bg-rose-600 px-4 py-2 text-xs font-black uppercase tracking-widest text-white transition-all hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function WorkerMetric({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="rounded-lg border border-sky-100 bg-white/80 px-3 py-2">
      <p className="font-black text-slate-900">{Number(value || 0).toLocaleString()}</p>
      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</p>
    </div>
  );
}
