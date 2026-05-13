import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  ArrowLeft, 
  ExternalLink, 
  RefreshCw, 
  Pause, 
  Play, 
  Settings, 
  History, 
  DollarSign, 
  Package, 
  CheckCircle2, 
  AlertTriangle,
  Clock,
  ChevronRight,
  ShoppingCart,
  Zap,
  Info
} from 'lucide-react';
import axios from 'axios';
import { cn } from '../lib/utils';
import { toast } from 'sonner';
import { motion } from 'motion/react';

export default function ProductDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: product, isLoading } = useQuery({
    queryKey: ['product', id],
    queryFn: async () => {
      const { data } = await axios.get(`/api/products/${id}`);
      return data;
    }
  });

  const { data: shopifyConfig } = useQuery({
    queryKey: ['shopify-config'],
    queryFn: async () => {
      const { data } = await axios.get('/api/settings/shopify');
      return data;
    }
  });

  const syncMutation = useMutation({
    mutationFn: async () => axios.post(`/api/products/${id}/sync`),
    onSuccess: () => {
      toast.success('Manual sync triggered');
      queryClient.invalidateQueries({ queryKey: ['product', id] });
    }
  });

  const updateStatusMutation = useMutation({
    mutationFn: async (syncStatus: string) => axios.patch(`/api/products/${id}`, { syncStatus }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['product', id] });
      toast.success('Sync status updated');
    }
  });

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <RefreshCw className="h-8 w-8 animate-spin text-primary" />
        <p className="text-slate-500 font-medium animate-pulse">Loading product details...</p>
      </div>
    );
  }

  if (!product) return <div>Product not found</div>;

  const shopifyId = product.shopifyProduct?.shopifyId?.split('/').pop();
  const shopifyAdminUrl = shopifyConfig?.shopDomain && shopifyId
    ? `https://${shopifyConfig.shopDomain}/admin/products/${shopifyId}`
    : null;

  return (
    <div className="space-y-8 max-w-6xl mx-auto pb-12">
      {/* Header */}
      <div className="flex flex-col gap-4">
        <button 
          onClick={() => navigate('/products')}
          className="flex items-center gap-2 text-slate-500 hover:text-slate-900 transition-colors text-xs font-bold uppercase tracking-wider w-fit"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to list
        </button>
        
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
          <div className="flex gap-6 items-center">
            <div className="w-20 h-24 bg-white rounded-xl border border-card-border overflow-hidden shadow-sm shrink-0">
              {product.images?.[0] && <img src={product.images[0].url} className="w-full h-full object-cover" />}
            </div>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-3xl font-bold tracking-tight text-slate-900">{product.title}</h1>
                <div className={cn(
                  "px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-tight flex items-center gap-1.5",
                  product.syncStatus === 'active' ? "bg-emerald-50 text-emerald-600 border border-emerald-100" : "bg-amber-50 text-amber-600 border border-amber-100"
                )}>
                  <div className={cn("w-1.5 h-1.5 rounded-full", product.syncStatus === 'active' ? "bg-emerald-500" : "bg-amber-500")} />
                  {product.syncStatus}
                </div>
              </div>
              <p className="text-slate-500 font-medium mt-1">
                Linked to Shopify product <span className="font-mono text-slate-900">#{shopifyId || 'N/A'}</span> / {product.supplier?.name}
              </p>
            </div>
          </div>
          
          <div className="flex gap-3">
             <button 
              onClick={() => updateStatusMutation.mutate(product.syncStatus === 'active' ? 'paused' : 'active')}
              className={cn(
                "px-5 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest flex items-center gap-2 transition-all border",
                product.syncStatus === 'active' 
                  ? "bg-amber-50 text-amber-600 border-amber-100 hover:bg-amber-100" 
                  : "bg-emerald-50 text-emerald-600 border-emerald-100 hover:bg-emerald-100"
              )}
            >
              {product.syncStatus === 'active' ? <Pause size={14} /> : <Play size={14} />}
              {product.syncStatus === 'active' ? 'Pause Sync' : 'Resume Sync'}
            </button>
            <button 
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              className="bg-primary text-white px-5 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest flex items-center gap-2 hover:opacity-90 transition-all shadow-lg shadow-indigo-100"
            >
              {syncMutation.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Zap size={14} />}
              Sync Now
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main Info */}
        <div className="lg:col-span-2 space-y-8">
          {/* Comparison Card */}
          <div className="bg-white rounded-2xl border border-card-border shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-card-border bg-slate-50/50 flex justify-between items-center">
              <h3 className="font-bold text-slate-900 flex items-center gap-2">
                <RefreshCw size={16} className="text-primary" />
                Data Synchronization Status
              </h3>
              <span className="text-[10px] font-black text-slate-400 uppercase">Last checked: {new Date(product.updatedAt).toLocaleString()}</span>
            </div>
            
            <div className="p-0">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-50">
                    <th className="px-6 py-3 text-left text-[10px] font-black text-slate-400 uppercase tracking-widest">Field</th>
                    <th className="px-6 py-3 text-left text-[10px] font-black text-slate-400 uppercase tracking-widest bg-slate-50/30">Source ({product.supplier?.name})</th>
                    <th className="px-6 py-3 text-left text-[10px] font-black text-slate-400 uppercase tracking-widest bg-indigo-50/30">Shopify Store</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  <ComparisonRow 
                    label="Price" 
                    source={`${product.currency} ${product.price}`} 
                    target={`$${product.shopifyProduct?.price || 'N/A'}`}
                    highlight={product.price * 1.5 !== product.shopifyProduct?.price} // simplified check
                  />
                  <ComparisonRow 
                    label="Availability" 
                    source="In Stock" 
                    target={product.shopifyProduct?.status === 'active' ? 'Active' : 'Draft'}
                  />
                  <ComparisonRow 
                    label="Variants" 
                    source={`${product.variants?.length || 0} discovered`} 
                    target={`${product.shopifyProduct?.variants?.length || 0} linked`}
                  />
                  <ComparisonRow 
                    label="SKU" 
                    source={product.variants?.[0]?.sku || 'None'} 
                    target={product.shopifyProduct?.variants?.[0]?.sku || 'None'}
                  />
                </tbody>
              </table>
            </div>
          </div>

          {/* Sync History */}
          <div className="bg-white rounded-2xl border border-card-border shadow-sm">
            <div className="px-6 py-4 border-b border-card-border flex justify-between items-center">
              <h3 className="font-bold text-slate-900 flex items-center gap-2">
                <History size={16} className="text-slate-400" />
                Recent Audit Logs
              </h3>
            </div>
            <div className="divide-y divide-slate-50">
              {product.auditLogs?.length === 0 ? (
                <div className="p-8 text-center text-slate-400 italic text-sm">No activity logs recorded yet.</div>
              ) : product.auditLogs?.map((log: any) => (
                <div key={log.id} className="p-4 flex gap-4 items-start hover:bg-slate-50/50 transition-colors">
                  <div className={cn(
                    "w-8 h-8 rounded-full flex items-center justify-center shrink-0",
                    log.action.includes('success') ? "bg-emerald-50 text-emerald-500" : "bg-slate-100 text-slate-500"
                  )}>
                    {log.action.includes('success') ? <CheckCircle2 size={14} /> : <Clock size={14} />}
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-bold text-slate-900">{log.action}</p>
                    <div className="flex gap-3 text-[10px] font-medium text-slate-400 uppercase tracking-tight">
                      <span>{new Date(log.createdAt).toLocaleString()}</span>
                      <span>User ID: {log.userId || 'System'}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Sidebar Widgets */}
        <div className="space-y-8">
          {/* Quick Stats Card */}
          <div className="bg-slate-900 rounded-2xl p-6 text-white shadow-xl">
            <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4">Sync Performance</h4>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <p className="text-2xl font-bold">100%</p>
                <p className="text-[10px] font-bold text-slate-400 uppercase">Uptime</p>
              </div>
              <div className="space-y-1">
                <p className="text-2xl font-bold">14s</p>
                <p className="text-[10px] font-bold text-slate-400 uppercase">Avg Latency</p>
              </div>
            </div>
            <div className="mt-6 pt-6 border-t border-slate-800 flex items-center justify-between">
               <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-xs font-bold text-emerald-400">Live Monitoring</span>
              </div>
              <ChevronRight size={14} className="text-slate-500" />
            </div>
          </div>

          {/* Pricing Config Card */}
          <div className="bg-white rounded-2xl border border-card-border shadow-sm p-6 space-y-6">
            <h3 className="font-bold text-slate-900 flex items-center gap-2">
              <DollarSign size={16} className="text-slate-400" />
              Pricing Engine
            </h3>
            
            <div className="space-y-4">
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex justify-between items-center">
                <div>
                  <p className="text-[10px] font-black text-slate-400 uppercase">Current Markup</p>
                  <p className="text-sm font-bold text-slate-900">Standard Retail Rule</p>
                </div>
                <button 
                  onClick={() => navigate('/pricing')}
                  className="p-1.5 hover:bg-slate-200 rounded-lg transition-all text-slate-400"
                >
                  <Settings size={14} />
                </button>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between text-xs font-medium">
                  <span className="text-slate-500">Base Multiplier</span>
                  <span className="text-slate-900">1.5x</span>
                </div>
                <div className="flex justify-between text-xs font-medium">
                  <span className="text-slate-500">Fixed Markup</span>
                  <span className="text-slate-900 text-emerald-600">+$2.00</span>
                </div>
                <div className="flex justify-between text-xs font-medium">
                  <span className="text-slate-500">Rounding</span>
                  <span className="text-slate-900">Smart (.99)</span>
                </div>
              </div>
            </div>
          </div>

          {/* Shopify Details */}
          <div className="bg-white rounded-2xl border border-card-border shadow-sm p-6 space-y-4">
             <h3 className="font-bold text-slate-900 flex items-center gap-2">
              <ShoppingCart size={16} className="text-slate-400" />
              Store Information
            </h3>
            <div className="space-y-3">
              <DetailRow label="Shopify ID" value={shopifyId || 'Not Linked'} mono />
              <DetailRow label="Handle" value={product.shopifyProduct?.handle || 'None'} />
              <DetailRow label="Collection" value={product.shopifyProduct?.collectionIds || 'General'} />
              <DetailRow label="Status" value={product.shopifyProduct?.status || 'Draft'} uppercase />
            </div>
            {product.shopifyProduct && shopifyAdminUrl && (
              <a 
                href={shopifyAdminUrl}
                target="_blank"
                rel="noreferrer"
                className="w-full mt-2 flex items-center justify-center gap-2 py-2 border rounded-lg text-[10px] font-black uppercase tracking-widest text-slate-500 hover:bg-slate-50 transition-all font-sans"
              >
                <ExternalLink size={12} />
                View in Shopify
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ComparisonRow({ label, source, target, highlight }: { label: string, source: string, target: string, highlight?: boolean }) {
  return (
    <tr className="group">
      <td className="px-6 py-4">
        <span className="text-xs font-bold text-slate-700">{label}</span>
      </td>
      <td className="px-6 py-4 bg-slate-50/20 group-hover:bg-slate-50 transition-colors">
        <span className="text-xs font-medium text-slate-600">{source}</span>
      </td>
      <td className={cn(
        "px-6 py-4 transition-colors bg-indigo-50/10 group-hover:bg-indigo-50/30",
        highlight && "bg-amber-50/50"
      )}>
        <span className={cn(
          "text-xs font-bold",
          highlight ? "text-amber-600" : "text-indigo-600"
        )}>{target}</span>
      </td>
    </tr>
  );
}

function DetailRow({ label, value, mono, uppercase }: { label: string, value: string, mono?: boolean, uppercase?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">{label}</span>
      <span className={cn(
        "text-sm font-bold text-slate-700 truncate",
        mono && "font-mono text-xs",
        uppercase && "uppercase tracking-tighter"
      )}>{value}</span>
    </div>
  );
}
