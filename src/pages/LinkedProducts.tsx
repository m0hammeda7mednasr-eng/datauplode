import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { 
  Search, 
  Filter, 
  ExternalLink, 
  RefreshCw, 
  MoreVertical,
  AlertCircle,
  CheckCircle2,
  Pause,
  Play,
  X,
  Eye
} from 'lucide-react';
import axios from 'axios';
import { cn } from '../lib/utils';
import { toast } from 'sonner';

export default function LinkedProducts() {
  const [selectedCollection, setSelectedCollection] = useState<string | null>(null);
  const navigate = useNavigate();
  
  const { data: products, isLoading, refetch } = useQuery({
    queryKey: ['products', selectedCollection],
    queryFn: async () => {
      const { data } = await axios.get('/api/products', {
        params: { collectionId: selectedCollection }
      });
      return data;
    }
  });

  const { data: collections } = useQuery({
    queryKey: ['shopify-collections'],
    queryFn: async () => {
      const { data } = await axios.get('/api/shopify/collections');
      return data;
    }
  });

  const handleSyncNow = async (id: string) => {
    toast.promise(axios.post(`/api/products/${id}/sync`), {
      loading: 'Queuing sync job...',
      success: 'Sync job started!',
      error: 'Failed to start sync'
    });
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
                <td colSpan={6} className="px-6 py-12 text-center text-muted-foreground italic">
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
                  <div className="flex gap-2" onClick={e => e.stopPropagation()}>
                    <a href={p.url} target="_blank" rel="noreferrer" className="p-1.5 border rounded hover:bg-zinc-100 transition-all text-zinc-400 hover:text-zinc-900" title="Source URL">
                      <ExternalLink className="h-3 w-3" />
                    </a>
                    {p.shopifyProduct && (
                      <a href={`https://myshop.myshopify.com/admin/products/${p.shopifyProduct.shopifyId.split('/').pop()}`} target="_blank" rel="noreferrer" className="p-1.5 border rounded hover:bg-zinc-100 text-zinc-400 hover:text-green-600 transition-all" title="Shopify Admin">
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
                      onClick={() => navigate(`/products/${p.id}`)}
                      className="p-2 hover:bg-zinc-100 rounded-lg transition-all text-zinc-400 hover:text-zinc-900" title="View Details"
                    >
                      <Eye className="h-4 w-4" />
                    </button>
                    <button className="p-2 hover:bg-zinc-100 rounded-lg transition-all text-zinc-400 hover:text-zinc-900">
                      <MoreVertical className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

