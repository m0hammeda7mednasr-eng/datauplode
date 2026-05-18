import { useState, useEffect, useRef, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Search, Loader2, AlertTriangle, Image as ImageIcon, Check, FolderOpen, RefreshCw, ChevronDown, ExternalLink } from 'lucide-react';
import axios from 'axios';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';
import { apiErrorMessage } from '../lib/api';

function normalizeLabel(value: any) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function labelContainsLabel(haystack: any, needle: any) {
  const normalizedHaystack = normalizeLabel(haystack);
  const normalizedNeedle = normalizeLabel(needle);
  if (!normalizedHaystack || !normalizedNeedle) return false;
  if (normalizedHaystack === normalizedNeedle) return true;

  const escapedNeedle = normalizedNeedle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escapedNeedle}($|[^a-z0-9])`, 'i').test(normalizedHaystack);
}

function getVariantColor(variant: any) {
  return String(variant?.color || variant?.optionValues?.Color || variant?.optionValues?.Colour || '').trim();
}

function getVariantOptionsLabel(variant: any) {
  if (variant?.optionValues) {
    return Object.entries(variant.optionValues)
      .map(([name, value]: any) => `${name}: ${value}`)
      .join(' / ');
  }

  return [variant?.color, variant?.size].filter(Boolean).join(' / ') || 'One Size';
}

function getVariantGroupKey(variant: any, index: number) {
  const color = getVariantColor(variant);
  if (color) return `color:${normalizeLabel(color)}`;
  return `variant:${variant?.sourceVariantId || variant?.sku || index}`;
}

function getVariantGroupLabel(variant: any, index: number) {
  const color = getVariantColor(variant);
  if (color) return color;
  return getVariantOptionsLabel(variant) || `Variant ${index + 1}`;
}

function hasMultipleVariantColors(variants: any[] = []) {
  const colors = new Set(
    variants
      .map(getVariantColor)
      .map(normalizeLabel)
      .filter(Boolean),
  );

  return colors.size > 1;
}

function calculatePrice(basePrice: any, rule: any) {
  const sourcePrice = Number(basePrice);
  if (!Number.isFinite(sourcePrice)) return 0;
  if (!rule) return Number(sourcePrice.toFixed(2));

  let price = sourcePrice * (Number(rule.multiplier) || 1);
  price += Number(rule.fixedMarkup) || 0;
  price += (sourcePrice * (Number(rule.percentageMarkup) || 0)) / 100;

  if (rule.rounding === '.99') {
    price = Math.floor(price) + 0.99;
  } else if (rule.rounding === '.00') {
    price = Math.round(price);
  }

  if (rule.minPrice && price < Number(rule.minPrice)) price = Number(rule.minPrice);
  if (rule.maxPrice && price > Number(rule.maxPrice)) price = Number(rule.maxPrice);

  return Number(price.toFixed(2));
}

function formatPrice(value: any) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue.toFixed(2) : '0.00';
}

function variantStockDisplay(variant: any) {
  if (variant?.available === false || variant?.stockStatus === 'out_of_stock') {
    return { label: 'Out of Stock', textClass: 'text-rose-500', dotClass: 'bg-rose-500' };
  }
  if (variant?.stockStatus === 'low_stock') {
    return { label: 'Low Stock', textClass: 'text-amber-500', dotClass: 'bg-amber-500' };
  }
  if (variant?.stockStatus === 'in_stock') {
    return { label: 'In Stock', textClass: 'text-emerald-500', dotClass: 'bg-emerald-500' };
  }
  return { label: 'No Stock Set', textClass: 'text-slate-400', dotClass: 'bg-slate-400' };
}

function getCategoryCandidates(result: any) {
  return result?.categoryCandidates || result?.raw?.productCandidates || [];
}

function isCategoryDiscoveryResult(result: any) {
  return Boolean(result?.raw?.categoryDiscovery || getCategoryCandidates(result).length);
}

export default function ImportProduct() {
  const [url, setUrl] = useState('');
  const [analysisResult, setAnalysisResult] = useState<any>(null);
  const [selectedCollections, setSelectedCollections] = useState<string[]>([]);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [selectedImageUrls, setSelectedImageUrls] = useState<string[]>([]);
  const [variantImageOverrides, setVariantImageOverrides] = useState<Record<string, string>>({});
  const [selectedPricingRuleId, setSelectedPricingRuleId] = useState<string | null>(null);
  const [collectionSearch, setCollectionSearch] = useState('');
  const [publishLoading, setPublishLoading] = useState(false);
  const [nextSnapshotText, setNextSnapshotText] = useState('');
  const [blockedImport, setBlockedImport] = useState<any>(null);
  const [prewarmStatus, setPrewarmStatus] = useState<'idle' | 'warming' | 'ready'>('idle');
  const lastPrewarmedUrlRef = useRef('');

  const {
    data: collections = [],
    isLoading: collectionsLoading,
    isError: collectionsError,
    refetch: refetchCollections,
  } = useQuery({
    queryKey: ['shopify-collections'],
    queryFn: async () => {
      const { data } = await axios.get('/api/shopify/collections');
      return data;
    }
  });

  const {
    data: pricingRules = [],
    isLoading: pricingRulesLoading,
    isError: pricingRulesError,
  } = useQuery({
    queryKey: ['pricing-rules'],
    queryFn: async () => {
      const { data } = await axios.get('/api/pricing-rules');
      return data;
    }
  });

  const analyzeMutation = useMutation({
    mutationFn: async ({ productUrl, pageText }: { productUrl: string; pageText?: string }) => {
      const { data } = await axios.post('/api/imports/analyze', { url: productUrl, pageText });
      return data;
    },
    onSuccess: (data) => {
      setAnalysisResult(data);
      setBlockedImport(null);
      setNextSnapshotText('');
      setSelectedCollections([]);
      setSelectedImageUrls((data.images || []).map((image: any) => image.url).filter(Boolean));
      setVariantImageOverrides({});
      setSelectedPricingRuleId(data.pricingRule?.id || null);
      setCollectionSearch('');
      toast.success('Product analyzed successfully!');
    },
    onError: (error: any) => {
      const responsePayload = error?.response?.data;
      if (
        responsePayload?.retryWithSnapshot &&
        (responsePayload?.code === 'SOURCE_BLOCKED' || responsePayload?.code === 'NEXT_SIZE_VALUES_MISSING')
      ) {
        setBlockedImport(responsePayload);
      }
      toast.error(apiErrorMessage(error, 'Failed to analyze product'));
    }
  });

  const handleAnalyze = (e: FormEvent) => {
    e.preventDefault();
    if (!url) return;
    setBlockedImport(null);
    analyzeMutation.mutate({ productUrl: url });
  };

  const handleAnalyzeSnapshot = () => {
    if (!url || !nextSnapshotText.trim()) {
      toast.error('Paste the product page text first.');
      return;
    }

    analyzeMutation.mutate({ productUrl: url, pageText: nextSnapshotText });
  };

  const handleAnalyzeCandidate = (productUrl: string) => {
    setUrl(productUrl);
    setBlockedImport(null);
    setAnalysisResult(null);
    analyzeMutation.mutate({ productUrl });
  };

  const handlePasteAndAnalyzeSnapshot = async () => {
    if (!url) {
      toast.error('Paste product URL first.');
      return;
    }

    try {
      const clipboardText = await navigator.clipboard.readText();
      if (!clipboardText.trim()) {
        toast.error('Clipboard is empty.');
        return;
      }

      setNextSnapshotText(clipboardText);
      analyzeMutation.mutate({ productUrl: url, pageText: clipboardText });
    } catch {
      toast.error('Could not read clipboard. Paste manually then click Analyze Snapshot.');
    }
  };

  useEffect(() => {
    setSelectedImageIndex(0);
    setSelectedImageUrls((analysisResult?.images || []).map((image: any) => image.url).filter(Boolean));
    setVariantImageOverrides({});
  }, [analysisResult?.source?.url]);

  useEffect(() => {
    const productUrl = url.trim();
    let pollTimer: number | undefined;
    let startTimer: number | undefined;
    let cancelled = false;
    const canPrewarm =
      /^https?:\/\/\S+\.\S+/i.test(productUrl) &&
      (/(?:next\.[a-z.]+|nextdirect\.com)\/.+\/style\/[a-z0-9]+\/[a-z0-9]+/i.test(productUrl) ||
        /maxfashion\.com/i.test(productUrl));

    if (!canPrewarm) {
      setPrewarmStatus('idle');
      lastPrewarmedUrlRef.current = '';
      return;
    }

    const prewarm = async (attempt = 0) => {
      try {
        if (lastPrewarmedUrlRef.current !== productUrl) {
          lastPrewarmedUrlRef.current = productUrl;
        }

        const { data } = await axios.post('/api/imports/prewarm', { url: productUrl });
        if (cancelled) return;

        if (data?.status === 'cached') {
          setPrewarmStatus('ready');
          return;
        }

        if (data?.status === 'warming') {
          setPrewarmStatus('warming');
          if (attempt < 20) {
            pollTimer = window.setTimeout(() => prewarm(attempt + 1), 1500);
          }
          return;
        }

        setPrewarmStatus('idle');
      } catch {
        if (!cancelled) {
          setPrewarmStatus('idle');
          lastPrewarmedUrlRef.current = '';
        }
      }
    };

    setPrewarmStatus('warming');
    startTimer = window.setTimeout(() => {
      prewarm();
    }, 650);

    return () => {
      cancelled = true;
      if (startTimer) window.clearTimeout(startTimer);
      if (pollTimer) window.clearTimeout(pollTimer);
    };
  }, [url]);

  useEffect(() => {
    if (!analysisResult || isCategoryDiscoveryResult(analysisResult) || pricingRules.length === 0) return;
    const selectedRuleStillExists = selectedPricingRuleId && pricingRules.some((rule: any) => rule.id === selectedPricingRuleId);
    if (selectedRuleStillExists) return;

    const nextRule = pricingRules.find((rule: any) => rule.id === analysisResult.pricingRule?.id)
      || pricingRules.find((rule: any) => rule.isDefault)
      || pricingRules[0];
    setSelectedPricingRuleId(nextRule?.id || null);
  }, [analysisResult, pricingRules, selectedPricingRuleId]);

  const allImages = analysisResult?.images || [];
  const categoryCandidates = getCategoryCandidates(analysisResult);
  const isCategoryResult = isCategoryDiscoveryResult(analysisResult);
  const selectedImageSet = new Set(selectedImageUrls);
  const selectedImages = allImages.filter((image: any) => selectedImageSet.has(image.url));
  const activeImage = allImages[selectedImageIndex] || allImages[0];
  const activeImageSelected = activeImage ? selectedImageSet.has(activeImage.url) : false;
  const selectedPricingRule = pricingRules.find((rule: any) => rule.id === selectedPricingRuleId)
    || analysisResult?.pricingRule
    || null;
  const previewProductPrice = analysisResult
    ? calculatePrice(analysisResult.price, selectedPricingRule)
    : 0;
  const productHasMultipleColors = hasMultipleVariantColors(analysisResult?.variants || []);
  const getVariantImagePool = (variant: any) => {
    const color = normalizeLabel(getVariantColor(variant));
    const directImage = variant?.imageUrl && selectedImageSet.has(variant.imageUrl)
      ? selectedImages.filter((image: any) => image.url === variant.imageUrl)
      : [];

    if (!color) return selectedImages;

    const colorImages = selectedImages.filter((image: any) => {
      const imageColor = normalizeLabel(image.color);
      const imageAlt = normalizeLabel(image.alt);
      return imageColor === color || labelContainsLabel(imageAlt, color);
    });

    if (colorImages.length) return colorImages;
    if (directImage.length) return directImage;

    return productHasMultipleColors ? [] : selectedImages;
  };
  const getVariantImage = (variant: any, index = 0) => {
    const override = variantImageOverrides[getVariantGroupKey(variant, index)];
    const imagePool = getVariantImagePool(variant);
    if (override && imagePool.some((image: any) => image.url === override)) return override;
    if (variant?.imageUrl && selectedImageSet.has(variant.imageUrl)) return variant.imageUrl;

    const color = normalizeLabel(getVariantColor(variant));
    if (color) {
      const matchedImage = imagePool.find((image: any) => {
        const imageColor = normalizeLabel(image.color);
        const imageAlt = normalizeLabel(image.alt);
        return imageColor === color || labelContainsLabel(imageAlt, color);
      });
      if (matchedImage?.url) return matchedImage.url;
    }

    if (imagePool.length === 1 || !productHasMultipleColors) {
      return imagePool[0]?.url;
    }

    return undefined;
  };
  const variantImageGroups = (() => {
    const groups = new Map<string, any>();

    (analysisResult?.variants || []).forEach((variant: any, index: number) => {
      const key = getVariantGroupKey(variant, index);
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
        existing.examples.push(variant);
        return;
      }

      groups.set(key, {
        key,
        label: getVariantGroupLabel(variant, index),
        count: 1,
        variant,
        index,
        examples: [variant],
      });
    });

    return [...groups.values()];
  })();
  const selectedCollectionTitles = collections
    .filter((collection: any) => selectedCollections.includes(collection.id))
    .map((collection: any) => collection.title);
  const selectedCollectionSummary = selectedCollectionTitles.length
    ? selectedCollectionTitles.join(', ')
    : 'No collection selected';
  const filteredCollections = collections.filter((collection: any) =>
    normalizeLabel(collection.title).includes(normalizeLabel(collectionSearch)),
  );
  const applyVariantImage = (groupKey: string, imageUrl: string) => {
    setVariantImageOverrides(prev => ({
      ...prev,
      [groupKey]: imageUrl,
    }));
  };
  const toggleCollection = (collectionId: string) => {
    setSelectedCollections(prev =>
      prev.includes(collectionId)
        ? prev.filter(id => id !== collectionId)
        : [...prev, collectionId],
    );
  };
  const toggleProductImage = (imageUrl: string) => {
    if (selectedImageSet.has(imageUrl)) {
      setSelectedImageUrls(prev => prev.filter(url => url !== imageUrl));
      setVariantImageOverrides(prev => Object.fromEntries(
        Object.entries(prev).filter(([, value]) => value !== imageUrl),
      ));
      return;
    }

    setSelectedImageUrls(prev => [...prev, imageUrl]);
  };
  const buildProductDataForPublish = () => {
    if (!analysisResult) return analysisResult;

    return {
      ...analysisResult,
      images: selectedImages,
      variants: (analysisResult.variants || []).map((variant: any, index: number) => ({
        ...variant,
        calculatedPrice: calculatePrice(variant.price || analysisResult.price, selectedPricingRule),
        imageUrl: getVariantImage(variant, index),
      })),
    };
  };
  const imageUnavailableReason =
    !activeImage && (
      analysisResult?.raw?.imageUnavailableReason ||
      (analysisResult?.raw?.seoSnapshotFallback
        ? 'SHEIN blocked the product media response, so this analysis used a product snapshot without image URLs.'
        : null)
    );
  const blockedSupplierName = blockedImport?.supplier || analysisResult?.source?.supplier || 'Supplier';

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-12">
      <div className="bg-white rounded-xl border border-card-border p-2 shadow-sm">
        <form onSubmit={handleAnalyze} className="flex gap-2 bg-slate-100 p-2 rounded-lg items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <input
              type="text"
              placeholder="Paste supplier product URL (Zara, Shein, H&M...)"
              className="w-full pl-10 pr-4 py-2 border-none bg-transparent focus:outline-none text-sm"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setBlockedImport(null);
              }}
            />
          </div>
          {analysisResult && (
            <div className="px-3 py-1 bg-white rounded text-[10px] font-black text-primary uppercase border border-slate-200">
              {analysisResult.source.supplier} DETECTED
            </div>
          )}
          {prewarmStatus !== 'idle' && (
            <div className={cn(
              'hidden sm:flex items-center gap-1.5 px-3 py-1 rounded text-[10px] font-black uppercase border',
              prewarmStatus === 'ready'
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : 'bg-amber-50 text-amber-700 border-amber-200',
            )}>
              {prewarmStatus === 'warming' && <Loader2 className="h-3 w-3 animate-spin" />}
              {prewarmStatus === 'ready' ? 'FAST READY' : 'PREPARING FAST'}
            </div>
          )}
          <button
            type="submit"
            disabled={analyzeMutation.isPending || !url}
            className="bg-primary text-white px-6 py-2 rounded-md font-semibold hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-all text-sm shadow-sm"
          >
            {analyzeMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : prewarmStatus === 'ready' ? 'ANALYZE FAST' : 'ANALYZE URL'}
          </button>
        </form>
        {blockedImport?.retryWithSnapshot && (
          <div className="m-2 mt-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-950">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1 space-y-3">
                <div>
                  <div className="text-xs font-black uppercase tracking-widest">{blockedSupplierName} blocked server analysis</div>
                  <p className="mt-1 text-xs font-semibold leading-relaxed text-amber-900">
                    Use a browser page snapshot for this product so Syncly does not spend managed bypass credits.
                  </p>
                </div>
                <textarea
                  value={nextSnapshotText}
                  onChange={(event) => setNextSnapshotText(event.target.value)}
                  rows={7}
                  placeholder="Product title, price, product code, colour, size, description..."
                  className="w-full rounded-lg border border-amber-200 bg-white p-3 text-xs font-semibold text-slate-700 outline-none focus:ring-2 focus:ring-amber-300"
                />
                <div className="flex flex-wrap justify-end gap-2">
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-2 rounded-md border border-amber-300 bg-white px-4 py-2 text-xs font-black uppercase tracking-widest text-amber-800 shadow-sm"
                  >
                    <ExternalLink className="h-4 w-4" />
                    Open Page
                  </a>
                  <button
                    type="button"
                    onClick={handlePasteAndAnalyzeSnapshot}
                    disabled={analyzeMutation.isPending}
                    className="flex items-center gap-2 rounded-md border border-amber-300 bg-white px-4 py-2 text-xs font-black uppercase tracking-widest text-amber-900 shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Paste + Analyze
                  </button>
                  <button
                    type="button"
                    onClick={handleAnalyzeSnapshot}
                    disabled={analyzeMutation.isPending || !nextSnapshotText.trim()}
                    className="flex items-center gap-2 rounded-md bg-amber-600 px-4 py-2 text-xs font-black uppercase tracking-widest text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {analyzeMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Analyze Snapshot'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <AnimatePresence>
        {analysisResult && isCategoryResult && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-5 shadow-sm"
          >
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <div className="text-xs font-black uppercase tracking-widest text-emerald-700">Next category detected</div>
                <h2 className="mt-1 text-xl font-black text-slate-950">Choose a product from this listing</h2>
                <p className="mt-2 max-w-3xl text-sm font-semibold leading-relaxed text-emerald-900">
                  This URL is a listing page, not a single product. Syncly found product links automatically and started warming the first results, so pick one below and it will analyze directly.
                </p>
              </div>
              <div className="rounded-lg border border-emerald-200 bg-white px-3 py-2 text-xs font-black uppercase tracking-widest text-emerald-700">
                {categoryCandidates.length} products found
              </div>
            </div>

            {categoryCandidates.length > 0 ? (
              <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {categoryCandidates.slice(0, 12).map((candidate: any, index: number) => (
                  <div key={candidate.url || index} className="rounded-lg border border-emerald-100 bg-white p-4 shadow-sm">
                    <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Product {index + 1}</div>
                    <div className="mt-1 text-sm font-black text-slate-900">{candidate.title || 'Next product'}</div>
                    <div className="mt-2 truncate text-[11px] font-mono text-slate-500" title={candidate.url}>
                      {candidate.url}
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => handleAnalyzeCandidate(candidate.url)}
                        disabled={analyzeMutation.isPending}
                        className="rounded-md bg-primary px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {analyzeMutation.isPending ? 'Analyzing...' : 'Analyze This'}
                      </button>
                      <a
                        href={candidate.url}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-md border border-slate-200 bg-white px-3 py-2 text-[10px] font-black uppercase tracking-widest text-slate-500"
                      >
                        Open
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-900">
                No product links were found on this listing. Try a narrower Next category page or paste a direct `/style/...` product link.
              </div>
            )}
          </motion.div>
        )}

        {analysisResult && !isCategoryResult && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-8 items-start"
          >
            {/* Left Card: Summary */}
            <div className="bg-white rounded-xl border border-card-border p-5 shadow-sm space-y-4">
              <div className="bg-rose-50 border border-rose-100 text-rose-800 p-3 rounded-lg flex gap-2.5 items-start">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <div className="text-[12px] leading-tight font-medium">
                  <strong>Verification Required:</strong> Detected price markup rules will be applied upon publishing.
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Images</label>
                  <span className="text-[10px] font-black text-primary uppercase tracking-widest">
                    {selectedImages.length}/{allImages.length} Included
                  </span>
                </div>
                <div className="aspect-[3/4] rounded-lg overflow-hidden border border-slate-100 bg-slate-50 relative group flex items-center justify-center">
                  {activeImage ? (
                    <>
                      <img
                        src={activeImage.url}
                        alt={activeImage.alt || analysisResult.title}
                        className={cn(
                          "w-full h-full object-cover transition-transform duration-500 group-hover:scale-105",
                          !activeImageSelected && "opacity-45 grayscale"
                        )}
                      />
                      <button
                        type="button"
                        onClick={() => toggleProductImage(activeImage.url)}
                        className={cn(
                          "absolute left-3 top-3 flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[10px] font-black uppercase tracking-widest shadow-sm transition-all",
                          activeImageSelected
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : "border-slate-200 bg-white text-slate-500"
                        )}
                      >
                        {activeImageSelected && <Check size={12} />}
                        {activeImageSelected ? 'Included' : 'Include'}
                      </button>
                    </>
                  ) : (
                    <span className="text-slate-400 font-bold text-xs uppercase tracking-widest">Image Unavailable</span>
                  )}
                </div>
                {allImages.length > 0 && selectedImages.length === 0 && (
                  <div className="rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-[11px] font-semibold leading-snug text-rose-700">
                    Select at least one real product image before publishing.
                  </div>
                )}
                {imageUnavailableReason && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-semibold leading-snug text-amber-900 flex gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>{imageUnavailableReason}</span>
                  </div>
                )}
                {allImages.length > 1 && (
                  <div className="grid grid-cols-5 gap-2 max-h-28 overflow-y-auto pr-1">
                    {allImages.map((image: any, index: number) => {
                      const included = selectedImageSet.has(image.url);

                      return (
                        <button
                          key={`${image.url}-${index}`}
                          type="button"
                          onClick={() => setSelectedImageIndex(index)}
                          className={cn(
                            "relative aspect-square rounded-md overflow-hidden border bg-slate-50 transition-all",
                            selectedImageIndex === index
                              ? "border-primary ring-2 ring-primary/20"
                              : "border-slate-200 hover:border-slate-300",
                            !included && "opacity-45"
                          )}
                          title={image.alt || `Image ${index + 1}`}
                        >
                          <img
                            src={image.url}
                            alt={image.alt || `${analysisResult.title} image ${index + 1}`}
                            className="w-full h-full object-cover"
                          />
                          {included && (
                            <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-white">
                              <Check size={10} />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div>
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">Product Title</label>
                <div className="text-sm font-semibold text-slate-900 leading-snug">{analysisResult.title}</div>
              </div>

              <div>
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">Source Price</label>
                <div className="text-sm font-mono">{analysisResult.currency} {analysisResult.price}</div>
              </div>

              <div>
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">Description Snippet</label>
                <p className="text-[12px] text-slate-600 line-clamp-4 leading-relaxed">
                  {analysisResult.description || 'No description detected in source HTML.'}
                </p>
              </div>
            </div>

            {/* Right Side: Pricing & Variants */}
            <div className="space-y-6">
              {/* Pricing Engine Card */}
              <div className="bg-white rounded-xl border border-card-border shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-card-border flex flex-col gap-4 bg-slate-50/50 md:flex-row md:items-center md:justify-between">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Pricing Engine</label>
                    <div className="text-sm font-bold">Choose the exact markup rule before publishing</div>
                  </div>
                  <div className="relative min-w-[240px]">
                    <select
                      value={selectedPricingRuleId || ''}
                      onChange={(event) => setSelectedPricingRuleId(event.target.value || null)}
                      disabled={pricingRulesLoading || pricingRules.length === 0}
                      className="w-full appearance-none rounded-lg border border-slate-200 bg-white px-3 py-2 pr-9 text-xs font-bold text-slate-700 outline-none focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {pricingRules.length === 0 && selectedPricingRule ? (
                        <option value={selectedPricingRule.id}>
                          {selectedPricingRule.name} (x{selectedPricingRule.multiplier})
                        </option>
                      ) : pricingRules.length === 0 ? (
                        <option value="">No pricing rules</option>
                      ) : pricingRules.map((rule: any) => (
                        <option key={rule.id} value={rule.id}>
                          {rule.name} (x{rule.multiplier})
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  </div>
                </div>
                {pricingRulesError && (
                  <div className="border-b border-amber-100 bg-amber-50 px-6 py-3 text-xs font-bold text-amber-800">
                    Could not load pricing rules. The source price will be used unless the server finds a default rule.
                  </div>
                )}
                <div className="p-6 grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="bg-slate-50 p-4 rounded-lg border border-slate-100">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">Source Price</label>
                    <div className="text-lg font-bold text-slate-700">{analysisResult.currency} {formatPrice(analysisResult.price)}</div>
                  </div>
                  <div className="bg-slate-50 p-4 rounded-lg border border-slate-100">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">Multiplier</label>
                    <div className="text-lg font-bold text-slate-700">x {selectedPricingRule?.multiplier ?? 1}</div>
                    <div className="mt-1 text-[10px] font-semibold text-slate-400">
                      +{formatPrice(selectedPricingRule?.fixedMarkup || 0)} fixed / {selectedPricingRule?.percentageMarkup || 0}%
                    </div>
                  </div>
                  <div className="bg-indigo-50/50 p-4 rounded-lg border border-indigo-100">
                    <label className="text-[10px] font-black text-primary uppercase tracking-widest block mb-1">Target Price</label>
                    <div className="text-lg font-bold text-primary">${formatPrice(previewProductPrice)}</div>
                    <div className="mt-1 text-[10px] font-semibold text-primary/70">
                      {selectedPricingRule?.name || 'No rule selected'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Variants Card */}
              <div className="bg-white rounded-xl border border-card-border shadow-sm overflow-hidden flex flex-col min-h-[400px]">
                <div className="px-6 py-4 border-b border-card-border flex justify-between items-center bg-slate-50/50">
                  <div className="flex items-center gap-3">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Normalized Variants ({analysisResult.variants?.length || 0})</label>
                    {analysisResult.variants?.some((v: any) => v.stockStatus !== 'in_stock') && (
                      <span className="bg-amber-100 text-amber-800 text-[9px] font-black px-1.5 py-0.5 rounded uppercase tracking-wider">
                        Out of stock items detected
                      </span>
                    )}
                  </div>
                </div>
                {analysisResult.options?.some((option: any) => option.name !== 'Default') && (
                  <div className="px-6 py-4 border-b border-card-border bg-white">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {analysisResult.options
                        .filter((option: any) => option.name !== 'Default')
                        .map((option: any) => (
                          <div key={option.name} className="space-y-2">
                            <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                              {option.name} ({option.values?.length || 0})
                            </div>
                            <div className="max-h-32 overflow-y-auto rounded-md border border-slate-100 bg-slate-50/50 divide-y divide-slate-100">
                              {option.values?.map((value: string) => (
                                <div key={`${option.name}-${value}`} className="px-3 py-2 text-[11px] font-bold text-slate-700">
                                  {value}
                                </div>
                              ))}
                            </div>
                          </div>
                      ))}
                    </div>
                  </div>
                )}
                {selectedImages.length > 0 && variantImageGroups.length > 0 && (
                  <div className="px-6 py-4 border-b border-card-border bg-slate-50/40">
                    <div className="flex items-center justify-between gap-3 mb-3">
                      <div>
                        <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Variant Image Mapping</div>
                        <div className="text-xs font-semibold text-slate-600">
                          {variantImageGroups.length} image group{variantImageGroups.length === 1 ? '' : 's'} / {selectedImages.length} selected images
                        </div>
                      </div>
                      <div className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500">
                        <ImageIcon size={15} />
                      </div>
                    </div>

                    <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
                      {variantImageGroups.map((group: any) => {
                        const currentImage = getVariantImage(group.variant, group.index);
                        const groupImages = getVariantImagePool(group.variant);

                        return (
                          <div key={group.key} className="rounded-lg border border-slate-200 bg-white p-3">
                            <div className="flex items-center gap-3">
                              <div className="h-12 w-12 overflow-hidden rounded-md border border-slate-100 bg-slate-50 shrink-0">
                                {currentImage ? (
                                  <img src={currentImage} alt={group.label} className="h-full w-full object-cover" />
                                ) : (
                                  <div className="flex h-full w-full items-center justify-center text-slate-300">
                                    <ImageIcon size={16} />
                                  </div>
                                )}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-bold text-slate-900 truncate">{group.label}</div>
                                <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                                  {group.count} variant{group.count === 1 ? '' : 's'} / {groupImages.length} matched image{groupImages.length === 1 ? '' : 's'}
                                </div>
                              </div>
                            </div>

                            {groupImages.length > 0 ? (
                              <div className="mt-3 grid grid-cols-6 sm:grid-cols-8 md:grid-cols-10 gap-2">
                              {groupImages.map((image: any, imageIndex: number) => {
                                const isSelected = currentImage === image.url;

                                return (
                                  <button
                                    key={`${group.key}-${image.url}-${imageIndex}`}
                                    type="button"
                                    onClick={() => applyVariantImage(group.key, image.url)}
                                    className={cn(
                                      "relative aspect-square overflow-hidden rounded-md border bg-slate-50 transition-all",
                                      isSelected
                                        ? "border-primary ring-2 ring-primary/20"
                                        : "border-slate-200 hover:border-slate-300"
                                    )}
                                    title={image.alt || `Image ${imageIndex + 1}`}
                                  >
                                    <img
                                      src={image.url}
                                      alt={image.alt || `${analysisResult.title} image ${imageIndex + 1}`}
                                      className="h-full w-full object-cover"
                                    />
                                    {isSelected && (
                                      <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-white">
                                        <Check size={10} />
                                      </span>
                                    )}
                                  </button>
                                );
                              })}
                              </div>
                            ) : (
                              <div className="mt-3 rounded-md border border-amber-100 bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-800">
                                No selected image is tagged for this variant group. Re-analyze the URL or include a matching image above.
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                <div className="flex-1 overflow-auto max-h-[440px]">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-slate-50/30 border-b border-slate-100">
                        <th className="px-6 py-3 text-left font-black text-slate-400 uppercase tracking-widest">Image</th>
                        <th className="px-6 py-3 text-left font-black text-slate-400 uppercase tracking-widest">Variant ID</th>
                        <th className="px-6 py-3 text-left font-black text-slate-400 uppercase tracking-widest">Options</th>
                        <th className="px-6 py-3 text-left font-black text-slate-400 uppercase tracking-widest">Status</th>
                        <th className="px-6 py-3 text-right font-black text-slate-400 uppercase tracking-widest">Shopify Price</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {analysisResult.variants?.map((v: any, i: number) => {
                        const variantImage = getVariantImage(v, i);
                        const stockDisplay = variantStockDisplay(v);

                        return (
                        <tr key={i} className="hover:bg-slate-50/30 transition-colors">
                          <td className="px-6 py-4">
                            <div className="h-10 w-10 overflow-hidden rounded-md border border-slate-100 bg-slate-50">
                              {variantImage ? (
                                <img
                                  src={variantImage}
                                  alt={[v.color, v.size, analysisResult.title].filter(Boolean).join(' / ')}
                                  className="h-full w-full object-cover"
                                />
                              ) : (
                                <div className="h-full w-full bg-slate-100" />
                              )}
                            </div>
                          </td>
                          <td className="px-6 py-4 font-mono text-[10px] text-slate-500">{v.sourceVariantId || 'DEFAULT'}</td>
                          <td className="px-6 py-4 font-bold text-slate-700">
                            {getVariantOptionsLabel(v)}
                          </td>
                          <td className="px-6 py-4">
                            <div className={cn(
                              "flex items-center gap-1.5 font-bold uppercase text-[9px]",
                              stockDisplay.textClass
                            )}>
                              <div className={cn("w-1.5 h-1.5 rounded-full", stockDisplay.dotClass)} />
                              {stockDisplay.label}
                            </div>
                          </td>
                          <td className="px-6 py-4 text-right font-bold text-slate-900">
                            ${formatPrice(calculatePrice(v.price || analysisResult.price, selectedPricingRule))}
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                
                <div className="px-6 py-4 border-t border-card-border bg-slate-50/20 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Publish To Collections</label>
                      <div className="max-w-[42rem] truncate text-xs font-semibold text-slate-600">
                        {selectedCollectionSummary}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => refetchCollections()}
                      className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-[10px] font-black uppercase tracking-widest text-slate-500 hover:bg-slate-50"
                    >
                      <RefreshCw size={12} />
                      Refresh
                    </button>
                  </div>

                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Choose Shopify collection"
                      value={collectionSearch}
                      onChange={(event) => setCollectionSearch(event.target.value)}
                      className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-xs font-semibold text-slate-700 outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </div>

                  {collectionsLoading ? (
                    <div className="rounded-lg border border-slate-200 bg-white p-4 text-xs font-bold text-slate-400">
                      Loading Shopify collections...
                    </div>
                  ) : collectionsError ? (
                    <div className="rounded-lg border border-rose-100 bg-rose-50 p-4 text-xs font-bold text-rose-700">
                      Could not load Shopify collections.
                    </div>
                  ) : filteredCollections.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-52 overflow-y-auto pr-1">
                      {filteredCollections.map((col: any) => {
                        const selected = selectedCollections.includes(col.id);

                        return (
                          <button
                            key={col.id}
                            type="button"
                            role="checkbox"
                            aria-checked={selected}
                            onClick={() => toggleCollection(col.id)}
                            className={cn(
                              "flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all",
                              selected
                                ? "border-primary bg-primary/5 text-primary"
                                : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                            )}
                          >
                            <span className={cn(
                              "flex h-5 w-5 shrink-0 items-center justify-center rounded border",
                              selected ? "border-primary bg-primary text-white" : "border-slate-300 bg-white"
                            )}>
                              {selected && <Check size={12} />}
                            </span>
                            <FolderOpen size={14} className="shrink-0" />
                            <span className="min-w-0 truncate text-xs font-bold">{col.title}</span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-slate-200 bg-white p-4 text-xs font-bold text-slate-400">
                      No Shopify collections found.
                    </div>
                  )}
                </div>

                <div className="p-6 border-t border-card-border bg-slate-50/30 flex gap-3 justify-end items-center">
                   <button 
                    onClick={() => setAnalysisResult(null)}
                    className="px-5 py-2 text-xs font-bold text-slate-500 hover:text-slate-900 transition-colors uppercase tracking-widest"
                  >
                    Discard
                  </button>
                  <button className="px-5 py-2 text-xs font-bold border border-card-border bg-white rounded-md hover:bg-slate-50 transition-all uppercase tracking-widest shadow-sm">
                    Manual Review
                  </button>
                  <button 
                    onClick={() => {
                      setPublishLoading(true);
                      toast.promise(
                        axios.post('/api/imports/publish', {
                          productData: buildProductDataForPublish(),
                          pricingRuleId: selectedPricingRule?.id || selectedPricingRuleId,
                          collections: selectedCollections
                        }),
                        {
                          loading: 'ENQUEUING PUBLISH JOB...',
                          success: (res) => {
                            setPublishLoading(false);
                            setSelectedCollections([]);
                            setSelectedImageUrls([]);
                            setAnalysisResult(null);
                            return `QUEUED FOR SHOPIFY (ID: ${res.data.productId.slice(-6)})`;
                          },
                          error: (error: any) => {
                            setPublishLoading(false);
                            return apiErrorMessage(error, 'FAILED TO ENQUEUE PUBLICATION');
                          }
                        }
                      );
                    }}
                    disabled={publishLoading || (allImages.length > 0 && selectedImages.length === 0)}
                    className="bg-primary text-white px-6 py-2.5 rounded-md text-xs font-bold hover:opacity-90 transition-all uppercase tracking-widest shadow-lg shadow-indigo-100 flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {publishLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Publish Active'}
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
