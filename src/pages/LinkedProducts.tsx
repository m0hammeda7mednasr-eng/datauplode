import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Link2,
  Loader2,
  RefreshCw,
  Search,
  ShoppingBag,
  Unlink,
} from 'lucide-react';
import axios from 'axios';
import { cn } from '../lib/utils';
import { toast } from 'sonner';
import { apiErrorMessage } from '../lib/api';

const PAGE_SIZE = 100;
const RECONCILE_CONFIRMATION = 'LINK_EXACT_SHOPIFY_CATALOG';

type CatalogResponse = {
  success: boolean;
  legacy?: boolean;
  shopDomain?: string;
  counts: {
    shopifyTotal: number;
    linked: number;
    activeSync: number;
    matchedReady: number;
    needsLink: number;
    needsReview: number;
    pausedOrLinked: number;
  };
  filteredTotal: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  items: any[];
  latestJob?: any;
  scan?: any;
};

function legacyProduct(item: any) {
  let raw: any = {};
  try { raw = JSON.parse(item.raw || '{}'); } catch {}
  const meta = raw?.import || {};
  return {
    key: item.shopifyProduct?.shopifyId || item.id,
    sourceProductId: item.id,
    title: item.title,
    vendor: item.supplier?.name,
    imageUrl: item.images?.[0]?.url || null,
    shopifyProductId: item.shopifyProduct?.shopifyId || null,
    shopifyHandle: item.shopifyProduct?.handle || null,
    shopifyStatus: item.shopifyProduct?.status || null,
    shopifyPrice: item.shopifyProduct?.price ?? null,
    shopifySku: item.variants?.find((v: any) => v?.sku)?.sku || null,
    sourceUrl: item.url,
    sourceCurrency: item.currency,
    sourcePrice: item.price,
    syncStatus: item.syncStatus,
    syncEnabled: item.shopifyProduct?.syncEnabled !== false,
    syncPrice: item.shopifyProduct?.syncPrice !== false,
    syncInventory: item.shopifyProduct?.syncInventory !== false,
    matchStatus: item.syncStatus === 'active' && item.shopifyProduct?.syncEnabled !== false ? 'active' : 'linked',
    matchMethod: 'database',
    sheet: {
      spreadsheetName: meta.spreadsheetId ? 'sheet' : null,
      sheetName: meta.sheetName || null,
      sheetId: meta.sheetId || null,
      sheetRowNumber: meta.excelRowNumber || item.excelRowNumber || null,
      sheetUrl: meta.sheetUrl || null,
      sheetSku: item.variants?.find((v: any) => v?.sku)?.sku || null,
      multiplier: meta.sheetPriceMultiplier || null,
    },
    reason: null,
  };
}

async function loadCatalog(search: string, status: string, offset: number, refresh = false): Promise<CatalogResponse> {
  try {
    const { data } = await axios.get('/api/shopify-catalog/link-state', {
      params: {
        search: search || undefined,
        status: status === 'all' ? undefined : status,
        offset,
        limit: PAGE_SIZE,
        refresh: refresh ? 'true' : undefined,
      },
    });
    if (data?.warming) throw new Error('Shopify catalog snapshot is warming');
    return data;
  } catch (error: any) {
    const status = Number(error?.response?.status || 0);
    if (status === 401 || status === 403) throw error;
    const [{ data }, { data: stats }] = await Promise.all([
      axios.get('/api/products', { params: { limit: 200 } }),
      axios.get('/api/products/stats'),
    ]);
    const items = Array.isArray(data) ? data.map(legacyProduct) : [];
    const linked = Number(stats?.totalLinked || items.length);
    const activeSync = Number(stats?.activeSync || 0);
    return {
      success: true,
      legacy: true,
      counts: {
        shopifyTotal: linked,
        linked,
        activeSync,
        matchedReady: 0,
        needsLink: 0,
        needsReview: Number(stats?.pendingReview || 0),
        pausedOrLinked: Math.max(0, linked - activeSync),
      },
      filteredTotal: items.length,
      offset: 0,
      limit: items.length,
      hasMore: false,
      items,
    };
  }
}

export default function LinkedProducts() {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [offset, setOffset] = useState(0);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setOffset(0);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const catalogQuery = useQuery({
    queryKey: ['shopify-catalog-link-state', search, status, offset],
    queryFn: () => loadCatalog(search, status, offset),
    refetchInterval: (query) => {
      const data = query.state.data as CatalogResponse | undefined;
      return ['pending', 'running'].includes(String(data?.latestJob?.status || '')) ? 5000 : 30000;
    },
    refetchOnWindowFocus: true,
    staleTime: 5000,
  });

  const catalog = catalogQuery.data;
  const counts = catalog?.counts || {
    shopifyTotal: 0,
    linked: 0,
    activeSync: 0,
    matchedReady: 0,
    needsLink: 0,
    needsReview: 0,
    pausedOrLinked: 0,
  };
  const running = ['pending', 'running'].includes(String(catalog?.latestJob?.status || ''));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil((catalog?.filteredTotal || 0) / PAGE_SIZE));

  const reconcile = useMutation({
    mutationFn: async () => (await axios.post('/api/shopify-catalog/reconcile', { confirm: RECONCILE_CONFIRMATION })).data,
    onSuccess: (data) => {
      toast.success(data?.alreadyRunning ? 'Catalog linking is already running.' : 'Exact Shopify catalog linking started. Discovery uses 0 ScraperAPI credits.');
      queryClient.invalidateQueries({ queryKey: ['shopify-catalog-link-state'] });
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Failed to start catalog linking')),
  });

  const filters = useMemo(() => [
    ['all', 'All Shopify', counts.shopifyTotal],
    ['linked', 'Linked', counts.linked],
    ['active', 'Active Sync', counts.activeSync],
    ['matched', 'Ready to Link', counts.matchedReady],
    ['needs_review', 'Needs Review', counts.needsReview],
    ['needs_link', 'No Match', counts.needsLink],
  ] as const, [counts]);

  async function forceRefresh() {
    try {
      await loadCatalog(search, status, offset, true);
      await catalogQuery.refetch();
      toast.success('Shopify + sheets refreshed');
    } catch (error) {
      toast.error(apiErrorMessage(error, 'Failed to refresh catalog'));
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-500"><ShoppingBag className="h-4 w-4" />Shopify catalog is the source of truth</div>
          <h1 className="mt-1 text-3xl font-black tracking-tight text-zinc-900">Linked Products</h1>
          <p className="mt-1 max-w-4xl text-sm font-medium text-slate-500">Every Shopify product appears here with its Shopify ID, source URL, sheet row, SKU, mapping evidence and live sync state.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={forceRefresh} disabled={catalogQuery.isFetching} className="inline-flex items-center gap-2 rounded-xl border bg-white px-4 py-2.5 text-xs font-black disabled:opacity-50">
            <RefreshCw className={cn('h-4 w-4', catalogQuery.isFetching && 'animate-spin')} />Refresh Shopify + Sheets
          </button>
          {!catalog?.legacy && <button onClick={() => reconcile.mutate()} disabled={reconcile.isPending || running} className="inline-flex items-center gap-2 rounded-xl bg-slate-950 px-4 py-2.5 text-xs font-black text-white disabled:opacity-50">
            {reconcile.isPending || running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}{running ? 'Linking catalog…' : 'Link all exact matches'}
          </button>}
        </div>
      </div>

      {catalog?.legacy && <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-bold text-amber-800">The full Shopify catalog scan is temporarily unavailable. Showing verified database-linked products and current sync totals while Shopify recovers.</div>}

      {!catalog?.legacy && Number(catalog?.scan?.pendingProducts || 0) > 0 && <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-xs font-bold text-sky-900">
        Catalog indexing is in progress: {Number(catalog?.scan?.indexedTotal || 0).toLocaleString()} of {Number(counts.shopifyTotal || 0).toLocaleString()} Shopify products are currently searchable. Existing matches remain available while the remaining products are indexed.
      </div>}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <Metric label="Shopify Products" value={counts.shopifyTotal} tone="slate" />
        <Metric label="Linked" value={counts.linked} tone="blue" />
        <Metric label="Active Sync" value={counts.activeSync} tone="green" />
        <Metric label="Ready to Link" value={counts.matchedReady} tone="sky" />
        <Metric label="Needs Review" value={counts.needsReview} tone="amber" />
        <Metric label="No Match" value={counts.needsLink} tone="rose" />
      </div>

      {catalog?.latestJob && !catalog.legacy && <div className="rounded-xl border bg-white px-4 py-3 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">{running ? <Loader2 className="h-4 w-4 animate-spin text-sky-600" /> : catalog.latestJob.status === 'completed' ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <AlertTriangle className="h-4 w-4 text-amber-600" />}
            <div><p className="text-xs font-black">Catalog mapping · {catalog.latestJob.status}</p><p className="text-[11px] text-slate-500">{Number(catalog.latestJob.result?.linked || 0).toLocaleString()} linked · {Number(catalog.latestJob.result?.failed || 0).toLocaleString()} conflicts · 0 ScraperAPI credits</p></div>
          </div>
          {catalog.scan && <div className="text-[10px] font-bold uppercase text-slate-400">{Number(catalog.scan.shopifyProductsRead || 0).toLocaleString()} Shopify · {Number(catalog.scan.sheetRowsRead || 0).toLocaleString()} sheet rows</div>}
        </div>
      </div>}

      <div className="rounded-2xl border bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="relative w-full xl:max-w-xl"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search product, Shopify ID, SKU, source URL, sheet…" className="w-full rounded-xl border bg-slate-50 py-2.5 pl-10 pr-4 text-sm outline-none" /></div>
          <div className="flex flex-wrap gap-2">{filters.map(([value, label, count]) => <button key={value} onClick={() => { setStatus(value); setOffset(0); }} className={cn('rounded-full border px-3 py-1.5 text-[10px] font-black uppercase', status === value ? 'border-slate-950 bg-slate-950 text-white' : 'bg-white text-slate-500')}>{label} · {Number(count).toLocaleString()}</button>)}</div>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border bg-white shadow-sm"><div className="overflow-x-auto"><table className="w-full min-w-[1500px] text-sm">
        <thead className="border-b bg-zinc-50 text-[10px] font-black uppercase tracking-widest text-zinc-500"><tr><th className="px-5 py-4 text-left">Product</th><th className="px-5 py-4 text-left">Shopify</th><th className="px-5 py-4 text-left">Source Link</th><th className="px-5 py-4 text-left">Sheet / Row</th><th className="px-5 py-4 text-left">SKU</th><th className="px-5 py-4 text-left">Mapping</th><th className="px-5 py-4 text-left">Sync</th><th className="px-5 py-4 text-right">Actions</th></tr></thead>
        <tbody className="divide-y">
          {catalogQuery.isLoading ? <tr><td colSpan={8} className="px-6 py-20 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-slate-400" /><p className="mt-3 text-xs font-bold text-slate-500">Reading Shopify catalog and connected sheets…</p></td></tr>
          : catalogQuery.isError ? <tr><td colSpan={8} className="px-6 py-16 text-center text-sm font-bold text-rose-600">{apiErrorMessage(catalogQuery.error, 'Could not load Shopify catalog')}</td></tr>
          : !catalog?.items?.length ? <tr><td colSpan={8} className="px-6 py-16 text-center text-sm font-semibold text-slate-500">No products match this filter.</td></tr>
          : catalog.items.map((product: any) => <CatalogProductRow key={product.key || product.shopifyProductId || product.sourceProductId} product={product} shopDomain={catalog.shopDomain} onOpen={() => product.sourceProductId && navigate(`/products/${product.sourceProductId}`)} onSync={async () => {
              if (!product.sourceProductId) return;
              try { await axios.post(`/api/products/${product.sourceProductId}/sync`); toast.success('Sync job started'); }
              catch (error) { toast.error(apiErrorMessage(error, 'Failed to start sync')); }
            }} />)}
        </tbody>
      </table></div>
        <div className="flex items-center justify-between border-t px-5 py-4"><p className="text-xs font-semibold text-slate-500">Showing {catalog?.items?.length || 0} of {Number(catalog?.filteredTotal || 0).toLocaleString()}</p><div className="flex items-center gap-2"><button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0} className="rounded-lg border p-2 disabled:opacity-30"><ChevronLeft className="h-4 w-4" /></button><span className="min-w-24 text-center text-xs font-black">{currentPage} / {totalPages}</span><button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={!catalog?.hasMore} className="rounded-lg border p-2 disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button></div></div>
      </div>
    </div>
  );
}

function CatalogProductRow(props: any) {
  const { product, shopDomain, onOpen, onSync } = props;
  const numericId = String(product.shopifyProductId || '').split('/').pop();
  const shopifyUrl = shopDomain && numericId ? `https://${shopDomain}/admin/products/${numericId}` : null;
  const sheetHref = product.sheet?.sheetUrl && product.sheet?.sheetRowNumber ? `${String(product.sheet.sheetUrl).split('#')[0]}#gid=${product.sheet.sheetId}&range=A${product.sheet.sheetRowNumber}` : product.sheet?.sheetUrl || null;
  return <tr onClick={onOpen} className={cn('group hover:bg-slate-50/70', product.sourceProductId && 'cursor-pointer')}>
    <td className="px-5 py-4"><div className="flex items-center gap-3"><div className="h-14 w-12 shrink-0 overflow-hidden rounded-lg border bg-slate-100">{product.imageUrl && <img src={product.imageUrl} alt="" className="h-full w-full object-cover" />}</div><div className="max-w-[270px]"><p className="truncate font-black" title={product.title}>{product.title}</p><p className="truncate text-[10px] font-bold uppercase text-slate-400">{product.vendor || '—'}</p></div></div></td>
    <td className="px-5 py-4"><StatusPill status={product.shopifyStatus} label={product.shopifyStatus || 'Unknown'} /><p className="mt-1 font-mono text-[10px] text-slate-400">{numericId || '—'}</p></td>
    <td className="px-5 py-4" onClick={(e) => e.stopPropagation()}>{product.sourceUrl ? <a href={product.sourceUrl} target="_blank" rel="noreferrer" title={product.sourceUrl} className="flex max-w-[300px] items-start gap-2 rounded-lg border bg-slate-50 px-2.5 py-2 text-xs font-semibold text-slate-600 hover:bg-white"><ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="line-clamp-2 break-all">{product.sourceUrl}</span></a> : <span className="flex items-center gap-2 text-xs font-bold text-slate-400"><Unlink className="h-4 w-4" />No source link yet</span>}</td>
    <td className="px-5 py-4" onClick={(e) => e.stopPropagation()}>{product.sheet ? <a href={sheetHref || '#'} target="_blank" rel="noreferrer" className="text-xs font-bold text-slate-700"><span className="block">{product.sheet.spreadsheetName || 'Sheet'} · {product.sheet.sheetName || '—'}</span><span className="mt-1 inline-flex rounded-full border bg-slate-50 px-2 py-0.5 text-[10px] font-black text-slate-500">ROW {product.sheet.sheetRowNumber || '—'}</span></a> : '—'}</td>
    <td className="px-5 py-4"><p className="max-w-[220px] truncate font-mono text-[11px] font-bold" title={product.shopifySku || product.sheet?.sheetSku || ''}>{product.shopifySku || product.sheet?.sheetSku || '—'}</p>{product.sheet?.multiplier && <p className="mt-1 text-[10px] font-bold text-slate-400">Multiplier ×{product.sheet.multiplier}</p>}</td>
    <td className="px-5 py-4"><MappingPill status={product.matchStatus} /><p className="mt-1 text-[10px] font-bold uppercase text-slate-400">{mappingMethod(product.matchMethod)}</p>{product.reason && <p className="mt-1 max-w-[220px] text-[10px] font-medium text-rose-600">{product.reason}</p>}</td>
    <td className="px-5 py-4"><StatusPill status={product.matchStatus === 'active' ? 'active' : product.syncStatus} label={product.matchStatus === 'active' ? 'ACTIVE 24/7' : String(product.syncStatus || 'unlinked').toUpperCase()} /><p className="mt-1 text-[10px] font-semibold text-slate-400">{product.syncPrice ? 'Price ✓' : 'Price —'} · {product.syncInventory ? 'Stock ✓' : 'Stock —'}</p></td>
    <td className="px-5 py-4 text-right" onClick={(e) => e.stopPropagation()}><div className="flex justify-end gap-2">{shopifyUrl && <a href={shopifyUrl} target="_blank" rel="noreferrer" title="Open Shopify" className="rounded-lg border p-2 text-slate-400 hover:text-emerald-600"><ShoppingBag className="h-4 w-4" /></a>}{product.sourceProductId && <button onClick={onSync} title="Sync now" className="rounded-lg border p-2 text-slate-400 hover:text-slate-900"><RefreshCw className="h-4 w-4" /></button>}</div></td>
  </tr>;
}

function mappingMethod(method: string) {
  const labels: Record<string, string> = { database: 'Saved DB mapping', source_url: 'Exact source URL', exact_sku: 'Exact SKU', dab_product_prefix: 'DAB product identity', source_url_not_in_sheets: 'URL missing from sheets', ambiguous: 'Conflicting evidence', none: 'No exact evidence' };
  return labels[method] || method || '—';
}

function MappingPill({ status }: { status: string }) {
  const map: Record<string, [string, string]> = { active: ['Linked', 'bg-emerald-100 text-emerald-700'], linked: ['Linked', 'bg-blue-100 text-blue-700'], matched: ['Ready to Link', 'bg-sky-100 text-sky-700'], needs_review: ['Needs Review', 'bg-amber-100 text-amber-800'], needs_link: ['No Match', 'bg-rose-100 text-rose-700'] };
  const [label, style] = map[status] || [status || 'Unknown', 'bg-slate-100 text-slate-600'];
  return <span className={cn('inline-flex rounded-full px-2 py-1 text-[10px] font-black uppercase', style)}>{label}</span>;
}

function StatusPill({ status, label }: { status: string; label: string }) {
  const s = String(status || '').toLowerCase();
  const style = s === 'active' ? 'bg-emerald-100 text-emerald-700' : s === 'paused' || s === 'draft' ? 'bg-amber-100 text-amber-700' : s === 'error' || s === 'archived' ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-600';
  return <span className={cn('inline-flex rounded-full px-2 py-1 text-[10px] font-black uppercase', style)}>{label}</span>;
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  const tones: Record<string, string> = { slate: 'border-slate-200 bg-white', blue: 'border-blue-200 bg-blue-50/60', green: 'border-emerald-200 bg-emerald-50/60', sky: 'border-sky-200 bg-sky-50/60', amber: 'border-amber-200 bg-amber-50/60', rose: 'border-rose-200 bg-rose-50/60' };
  return <div className={cn('rounded-2xl border p-4 shadow-sm', tones[tone])}><p className="text-[10px] font-black uppercase tracking-widest text-slate-500">{label}</p><p className="mt-1 text-2xl font-black text-slate-900">{Number(value || 0).toLocaleString()}</p></div>;
}
