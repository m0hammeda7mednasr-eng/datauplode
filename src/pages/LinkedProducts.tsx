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
    sheetRows?: number;
    sheetErrors?: number;
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
  const raw = (() => {
    try {
      return JSON.parse(item.raw || '{}');
    } catch {
      return {};
    }
  })();
  const importMeta = raw?.import || {};
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
    shopifySku: item.variants?.find((variant: any) => variant?.sku)?.sku || null,
    sourceUrl: item.url,
    sourceCurrency: item.currency,
    sourcePrice: item.price,
    syncStatus: item.syncStatus,
    syncEnabled: item.shopifyProduct?.syncEnabled !== false,
    matchStatus:
      item.syncStatus === 'active' && item.shopifyProduct?.syncEnabled !== false
        ? 'active'
        : 'linked',
    matchMethod: 'database',
    evidence: ['database_link'],
    sheet: {
      spreadsheetName: importMeta.spreadsheetId ? 'sheet' : null,
      sheetName: importMeta.sheetName || null,
      sheetId: importMeta.sheetId || null,
      sheetRowNumber: importMeta.excelRowNumber || item.excelRowNumber || null,
      sheetUrl: importMeta.sheetUrl || null,
      sheetSku: item.variants?.find((variant: any) => variant?.sku)?.sku || null,
      multiplier: importMeta.sheetPriceMultiplier || null,
    },
    reason: null,
    updatedAt: item.updatedAt,
  };
}

async function loadCatalog(params: {
  search: string;
  status: string;
  offset: number;
  refresh?: boolean;
}): Promise<CatalogResponse> {
  try {
    const { data } = await axios.get('/api/shopify-catalog/link-state', {
      params: {
        search: params.search || undefined,
        status: params.status || undefined,
        offset: params.offset,
        limit: PAGE_SIZE,
        refresh: params.refresh ? 'true' : undefined,
      },
    });
    return data;
  } catch (error: any) {
    if (error?.response?.status !== 404) throw error;
    const { data } = await axios.get('/api/products', { params: { limit: 200 } });
    const items = Array.isArray(data) ? data.map(legacyProduct) : [];
    const activeSync = items.filter((item) => item.matchStatus === 'active').length;
    return {
      success: true,
      legacy: true,
      counts: {
        shopifyTotal: items.length,
        linked: items.length,
        activeSync,
        matchedReady: 0,
        needsLink: 0,
        needsReview: 0,
        pausedOrLinked: items.length - activeSync,
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
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
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
    queryFn: () => loadCatalog({ search, status, offset }),
    refetchInterval: (query) => {
      const current = query.state.data as CatalogResponse | undefined;
      return ['pending', 'running'].includes(String(current?.latestJob?.status || '')) ? 5000 : 30000;
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
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil((catalog?.filteredTotal || 0) / PAGE_SIZE));
  const reconcileRunning = ['pending', 'running'].includes(String(catalog?.latestJob?.status || ''));

  const reconcileMutation = useMutation({
    mutationFn: async () => {
      const { data } = await axios.post('/api/shopify-catalog/reconcile', {
        confirm: RECONCILE_CONFIRMATION,
      });
      return data;
    },
    onSuccess: (data) => {
      toast.success(
        data?.alreadyRunning
          ? 'Catalog linking is already running.'
          : 'Shopify catalog linking started — no ScraperAPI credits are used for discovery.',
      );
      queryClient.invalidateQueries({ queryKey: ['shopify-catalog-link-state'] });
    },
    onError: (error) => {
      toast.error(apiErrorMessage(error, 'Failed to start Shopify catalog linking'));
    },
  });

  const statusOptions = useMemo(
    () => [
      { value: 'all', label: 'All Shopify', count: counts.shopifyTotal },
      { value: 'linked', label: 'Linked', count: counts.linked },
      { value: 'active', label: 'Active Sync', count: counts.activeSync },
      { value: 'matched', label: 'Ready to Link', count: counts.matchedReady },
      { value: 'needs_review', label: 'Needs Review', count: counts.needsReview },
      { value: 'needs_link', label: 'No Match', count: counts.needsLink },
    ],
    [counts],
  );

  const forceRefresh = async () => {
    try {
      await loadCatalog({ search, status, offset, refresh: true });
      await catalogQuery.refetch();
      toast.success('Shopify + sheet catalog refreshed');
    } catch (error) {
      toast.error(apiErrorMessage(error, 'Failed to refresh catalog'));
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-500">
            <ShoppingBag className="h-4 w-4" />
            Shopify catalog is the source of truth
          </div>
          <h1 className="mt-1 text-3xl font-black tracking-tight text-zinc-900">Linked Products</h1>
          <p className="mt-1 max-w-3xl text-sm font-medium text-slate-500">
            Every Shopify product appears here. Sync Engine searches the connected sheets for its exact source URL / SKU, saves the mapping in the database, then sync uses that stored source link.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={forceRefresh}
            disabled={catalogQuery.isFetching}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-black text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={cn('h-4 w-4', catalogQuery.isFetching && 'animate-spin')} />
            Refresh Shopify + Sheets
          </button>
          {!catalog?.legacy && (
            <button
              onClick={() => reconcileMutation.mutate()}
              disabled={reconcileMutation.isPending || reconcileRunning}
              className="inline-flex items-center gap-2 rounded-xl bg-slate-950 px-4 py-2.5 text-xs font-black text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-50"
            >
              {reconcileMutation.isPending || reconcileRunning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Link2 className="h-4 w-4" />
              )}
              {reconcileRunning ? 'Linking catalog…' : 'Link all exact matches'}
            </button>
          )}
        </div>
      </div>

      {catalog?.legacy && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-bold text-amber-800">
          The frontend is ready, but the live backend is still on the older Railway revision. Showing the previous Linked Products API until Railway deploys the new catalog endpoint.
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <MetricCard label="Shopify Products" value={counts.shopifyTotal} tone="slate" />
        <MetricCard label="Linked" value={counts.linked} tone="blue" />
        <MetricCard label="Active Sync" value={counts.activeSync} tone="green" />
        <MetricCard label="Ready to Link" value={counts.matchedReady} tone="sky" />
        <MetricCard label="Needs Review" value={counts.needsReview} tone="amber" />
        <MetricCard label="No Match" value={counts.needsLink} tone="rose" />
      </div>

      {catalog?.latestJob && !catalog?.legacy && (
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              {reconcileRunning ? (
                <Loader2 className="h-4 w-4 animate-spin text-sky-600" />
              ) : catalog.latestJob.status === 'completed' ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-amber-600" />
              )}
              <div>
                <p className="text-xs font-black text-slate-900">Catalog mapping job · {catalog.latestJob.status}</p>
                <p className="text-[11px] text-slate-500">
                  {Number(catalog.latestJob.result?.linked || 0).toLocaleString()} linked ·{' '}
                  {Number(catalog.latestJob.result?.failed || 0).toLocaleString()} conflicts/failures · 0 ScraperAPI credits
                </p>
              </div>
            </div>
            {catalog.scan && (
              <div className="text-right text-[10px] font-bold uppercase tracking-wide text-slate-400">
                {Number(catalog.scan.shopifyProductsRead || 0).toLocaleString()} Shopify products ·{' '}
                {Number(catalog.scan.sheetRowsRead || 0).toLocaleString()} sheet rows
              </div>
            )}
          </div>
        </div>
      )}

      {Number(catalog?.scan?.sheetErrors?.length || 0) > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-800">
          {catalog.scan.sheetErrors.length} sheet tab(s) could not be read in the last scan. They remain excluded until the next successful refresh.
        </div>
      )}

      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="relative w-full xl:max-w-xl">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search product, Shopify ID, SKU, source URL, sheet…"
              className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-10 pr-4 text-sm font-medium outline-none transition focus:border-slate-400 focus:bg-white"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {statusOptions.map((option) => (
              <button
                key={option.value}
                onClick={() => {
                  setStatus(option.value);
                  setOffset(0);
                }}
                className={cn(
                  'rounded-full border px-3 py-1.5 text-[10px] font-black uppercase tracking-wide transition',
                  status === option.value
                    ? 'border-slate-950 bg-slate-950 text-white'
                    : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300',
                )}
              >
                {option.label} · {Number(option.count || 0).toLocaleString()}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1500px] text-sm">
            <thead className="border-b border-zinc-100 bg-zinc-50 text-[10px] font-black uppercase tracking-widest text-zinc-500">
              <tr>
                <th className="px-5 py-4 text-left">Product</th>
                <th className="px-5 py-4 text-left">Shopify</th>
                <th className="px-5 py-4 text-left">Source Link</th>
                <th className="px-5 py-4 text-left">Sheet / Row</th>
                <th className="px-5 py-4 text-left">SKU</th>
                <th className="px-5 py-4 text-left">Mapping</th>
                <th className="px-5 py-4 text-left">Sync</th>
                <th className="px-5 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {catalogQuery.isLoading ? (
                <tr>
                  <td colSpan={8} className="px-6 py-20 text-center">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-slate-400" />
                    <p className="mt-3 text-xs font-bold text-slate-500">Reading Shopify catalog and connected sheets…</p>
                  </td>
                </tr>
              ) : catalogQuery.isError ? (
                <tr>
                  <td colSpan={8} className="px-6 py-16 text-center text-sm font-bold text-rose-600">
                    {apiErrorMessage(catalogQuery.error, 'Could not load Shopify catalog')}
                  </td>
                </tr>
              ) : catalog?.items?.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-16 text-center text-sm font-semibold text-slate-500">
                    No products match this filter.
                  </td>
                </tr>
              ) : (
                catalog?.items?.map((product: any) => (
                  <CatalogRow
                    key={product.key || product.shopifyProductId || product.sourceProductId}
                    product={product}
                    shopDomain={catalog.shopDomain}
                    onOpen={() => {
                      if (product.sourceProductId) navigate(`/products/${product.sourceProductId}`);
                    }}
                    onSync={async () => {
                      if (!product.sourceProductId) return;
                      try {
                        await axios.post(`/api/products/${product.sourceProductId}/sync`);
                        toast.success('Sync job started');
                      } catch (error) {
                        toast.error(apiErrorMessage(error, 'Failed to start sync'));
                      }
                    }}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-4">
          <p className="text-xs font-semibold text-slate-500">
            Showing {catalog?.items?.length || 0} of {Number(catalog?.filteredTotal || 0).toLocaleString()} matching products
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
              className="rounded-lg border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-50 disabled:opacity-30"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="min-w-24 text-center text-xs font-black text-slate-700">
              {currentPage} / {totalPages}
            </span>
            <button
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={!catalog?.hasMore}
              className="rounded-lg border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-50 disabled:opacity-30"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CatalogRow({
  product,
  shopDomain,
  onOpen,
  onSync,
}: {
  product: any;
  shopDomain?: string;
  onOpen: () => void;
  onSync: () => void;
}) {
  const shopifyNumericId = String(product.shopifyProductId || '').split('/').pop();
  const shopifyUrl = shopDomain && shopifyNumericId
    ? `https://${shopDomain}/admin/products/${shopifyNumericId}`
    : null;
  const sheetUrl = product.sheet?.sheetUrl && product.sheet?.sheetRowNumber
    ? `${String(product.sheet.sheetUrl).split('#')[0]}#gid=${product.sheet.sheetId}&range=A${product.sheet.sheetRowNumber}`
    : product.sheet?.sheetUrl || null;

  return (
    <tr
      className={cn(
        'group transition-colors hover:bg-slate-50/70',
        product.sourceProductId && 'cursor-pointer',
      )}
      onClick={onOpen}
    >
      <td className="px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="h-14 w-12 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
            {product.imageUrl ? (
              <img src={product.imageUrl} alt="" className="h-full w-full object-cover" />
            ) : null}
          </div>
          <div className="min-w-0 max-w-[270px]">
            <p className="truncate font-black text-slate-900" title={product.title}>{product.title}</p>
            <p className="mt-0.5 truncate text-[10px] font-bold uppercase tracking-wide text-slate-400">
              {product.vendor || '—'}
            </p>
          </div>
        </div>
      </td>

      <td className="px-5 py-4">
        <div className="space-y-1">
          <StatusPill status={String(product.shopifyStatus || '').toLowerCase()} label={product.shopifyStatus || 'Unknown'} />
          <p className="max-w-[170px] truncate font-mono text-[10px] text-slate-400" title={product.shopifyProductId}>
            {shopifyNumericId || '—'}
          </p>
        </div>
      </td>

      <td className="px-5 py-4" onClick={(event) => event.stopPropagation()}>
        {product.sourceUrl ? (
          <a
            href={product.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="group/link flex max-w-[290px] items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs font-semibold text-slate-600 transition hover:border-slate-300 hover:bg-white hover:text-slate-950"
            title={product.sourceUrl}
          >
            <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="line-clamp-2 break-all">{product.sourceUrl}</span>
          </a>
        ) : (
          <div className="flex items-center gap-2 text-xs font-bold text-slate-400">
            <Unlink className="h-4 w-4" /> No source link yet
          </div>
        )}
      </td>

      <td className="px-5 py-4" onClick={(event) => event.stopPropagation()}>
        {product.sheet ? (
          <a href={sheetUrl || '#'} target="_blank" rel="noreferrer" className="block text-xs font-bold text-slate-700 hover:text-slate-950">
            <span className="block">{product.sheet.spreadsheetName || 'Sheet'} · {product.sheet.sheetName || '—'}</span>
            <span className="mt-1 inline-flex rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-black uppercase text-slate-500">
              Row {product.sheet.sheetRowNumber || '—'}
            </span>
          </a>
        ) : (
          <span className="text-xs font-semibold text-slate-400">—</span>
        )}
      </td>

      <td className="px-5 py-4">
        <div className="max-w-[220px]">
          <p className="truncate font-mono text-[11px] font-bold text-slate-700" title={product.shopifySku || product.sheet?.sheetSku || ''}>
            {product.shopifySku || product.sheet?.sheetSku || '—'}
          </p>
          {product.sheet?.multiplier ? (
            <p className="mt-1 text-[10px] font-bold text-slate-400">Multiplier ×{product.sheet.multiplier}</p>
          ) : null}
        </div>
      </td>

      <td className="px-5 py-4">
        <div className="space-y-1.5">
          <MappingPill status={product.matchStatus} />
          <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
            {mappingMethod(product.matchMethod)}
          </p>
          {product.reason ? (
            <p className="max-w-[220px] text-[10px] font-medium leading-4 text-rose-600" title={product.reason}>
              {product.reason}
            </p>
          ) : null}
        </div>
      </td>

      <td className="px-5 py-4">
        <div className="space-y-1.5">
          <StatusPill
            status={product.matchStatus === 'active' ? 'active' : product.syncStatus}
            label={product.matchStatus === 'active' ? 'ACTIVE 24/7' : String(product.syncStatus || 'unlinked').toUpperCase()}
          />
          <p className="text-[10px] font-semibold text-slate-400">
            {product.syncPrice ? 'Price ✓' : 'Price —'} · {product.syncInventory ? 'Stock ✓' : 'Stock —'}
          </p>
        </div>
      </td>

      <td className="px-5 py-4 text-right" onClick={(event) => event.stopPropagation()}>
        <div className="flex justify-end gap-2">
          {shopifyUrl ? (
            <a
              href={shopifyUrl}
              target="_blank"
              rel="noreferrer"
              title="Open Shopify Admin"
              className="rounded-lg border border-slate-200 p-2 text-slate-400 transition hover:bg-emerald-50 hover:text-emerald-600"
            >
              <ShoppingBag className="h-4 w-4" />
            </a>
          ) : null}
          {product.sourceProductId ? (
            <button
              onClick={onSync}
              title="Sync now"
              className="rounded-lg border border-slate-200 p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-900"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function mappingMethod(method: string) {
  const labels: Record<string, string> = {
    database: 'Saved DB mapping',
    source_url: 'Exact source URL',
    exact_sku: 'Exact SKU',
    dab_product_prefix: 'DAB product identity',
    source_url_not_in_sheets: 'Source URL missing from sheets',
    ambiguous: 'Conflicting evidence',
    none: 'No exact evidence',
  };
  return labels[method] || method || '—';
}

function MappingPill({ status }: { status: string }) {
  const config: Record<string, { label: string; className: string }> = {
    active: { label: 'Linked', className: 'bg-emerald-100 text-emerald-700' },
    linked: { label: 'Linked', className: 'bg-blue-100 text-blue-700' },
    matched: { label: 'Ready to Link', className: 'bg-sky-100 text-sky-700' },
    needs_review: { label: 'Needs Review', className: 'bg-amber-100 text-amber-800' },
    needs_link: { label: 'No Match', className: 'bg-rose-100 text-rose-700' },
  };
  const item = config[status] || { label: status || 'Unknown', className: 'bg-slate-100 text-slate-600' };
  return <span className={cn('inline-flex rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wide', item.className)}>{item.label}</span>;
}

function StatusPill({ status, label }: { status: string; label: string }) {
  const normalized = String(status || '').toLowerCase();
  const className =
    normalized === 'active'
      ? 'bg-emerald-100 text-emerald-700'
      : normalized === 'paused' || normalized === 'draft'
        ? 'bg-amber-100 text-amber-700'
        : normalized === 'error' || normalized === 'archived'
          ? 'bg-rose-100 text-rose-700'
          : 'bg-slate-100 text-slate-600';
  return <span className={cn('inline-flex rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wide', className)}>{label}</span>;
}

function MetricCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'slate' | 'blue' | 'green' | 'sky' | 'amber' | 'rose';
}) {
  const tones: Record<string, string> = {
    slate: 'border-slate-200 bg-white text-slate-900',
    blue: 'border-blue-200 bg-blue-50/60 text-blue-900',
    green: 'border-emerald-200 bg-emerald-50/60 text-emerald-900',
    sky: 'border-sky-200 bg-sky-50/60 text-sky-900',
    amber: 'border-amber-200 bg-amber-50/60 text-amber-900',
    rose: 'border-rose-200 bg-rose-50/60 text-rose-900',
  };
  return (
    <div className={cn('rounded-2xl border p-4 shadow-sm', tones[tone])}>
      <p className="text-[10px] font-black uppercase tracking-widest opacity-60">{label}</p>
      <p className="mt-1 text-2xl font-black">{Number(value || 0).toLocaleString()}</p>
    </div>
  );
}
