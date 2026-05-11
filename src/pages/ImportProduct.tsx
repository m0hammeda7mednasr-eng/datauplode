import { useState, useEffect } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Search, Loader2, CheckCircle2, AlertTriangle, ExternalLink, ChevronDown } from 'lucide-react';
import axios from 'axios';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';

export default function ImportProduct() {
  const [url, setUrl] = useState('');
  const [analysisResult, setAnalysisResult] = useState<any>(null);
  const [selectedCollections, setSelectedCollections] = useState<string[]>([]);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [publishLoading, setPublishLoading] = useState(false);

  const { data: collections } = useQuery({
    queryKey: ['shopify-collections'],
    queryFn: async () => {
      const { data } = await axios.get('/api/shopify/collections');
      return data;
    }
  });

  const analyzeMutation = useMutation({
    mutationFn: async (productUrl: string) => {
      const { data } = await axios.post('/api/imports/analyze', { url: productUrl });
      return data;
    },
    onSuccess: (data) => {
      setAnalysisResult(data);
      toast.success('Product analyzed successfully!');
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to analyze product');
    }
  });

  const handleAnalyze = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;
    analyzeMutation.mutate(url);
  };

  useEffect(() => {
    setSelectedImageIndex(0);
  }, [analysisResult?.source?.url]);

  const activeImage = analysisResult?.images?.[selectedImageIndex] || analysisResult?.images?.[0];
  const imageUnavailableReason =
    !activeImage && (
      analysisResult?.raw?.imageUnavailableReason ||
      (analysisResult?.raw?.seoSnapshotFallback
        ? 'SHEIN blocked the product media response, so this analysis used a product snapshot without image URLs.'
        : null)
    );

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
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          {analysisResult && (
            <div className="px-3 py-1 bg-white rounded text-[10px] font-black text-primary uppercase border border-slate-200">
              {analysisResult.source.supplier} DETECTED
            </div>
          )}
          <button
            type="submit"
            disabled={analyzeMutation.isPending || !url}
            className="bg-primary text-white px-6 py-2 rounded-md font-semibold hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-all text-sm shadow-sm"
          >
            {analyzeMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'ANALYZE URL'}
          </button>
        </form>
      </div>

      <AnimatePresence>
        {analysisResult && (
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
                    {analysisResult.images?.length || 0} Found
                  </span>
                </div>
                <div className="aspect-[3/4] rounded-lg overflow-hidden border border-slate-100 bg-slate-50 relative group flex items-center justify-center">
                  {activeImage ? (
                    <img
                      src={activeImage.url}
                      alt={activeImage.alt || analysisResult.title}
                      className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                    />
                  ) : (
                    <span className="text-slate-400 font-bold text-xs uppercase tracking-widest">Image Unavailable</span>
                  )}
                </div>
                {imageUnavailableReason && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-semibold leading-snug text-amber-900 flex gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>{imageUnavailableReason}</span>
                  </div>
                )}
                {analysisResult.images?.length > 1 && (
                  <div className="grid grid-cols-5 gap-2 max-h-28 overflow-y-auto pr-1">
                    {analysisResult.images.map((image: any, index: number) => (
                      <button
                        key={`${image.url}-${index}`}
                        type="button"
                        onClick={() => setSelectedImageIndex(index)}
                        className={cn(
                          "aspect-square rounded-md overflow-hidden border bg-slate-50 transition-all",
                          selectedImageIndex === index
                            ? "border-primary ring-2 ring-primary/20"
                            : "border-slate-200 hover:border-slate-300"
                        )}
                        title={image.alt || `Image ${index + 1}`}
                      >
                        <img
                          src={image.url}
                          alt={image.alt || `${analysisResult.title} image ${index + 1}`}
                          className="w-full h-full object-cover"
                        />
                      </button>
                    ))}
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
                <div className="px-6 py-4 border-b border-card-border flex justify-between items-center bg-slate-50/50">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Pricing Engine</label>
                    <div className="text-sm font-bold">{analysisResult.currency} &rarr; USD Conversion</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Applied Rule</div>
                    <span className="bg-emerald-100 text-emerald-800 text-[10px] font-black px-2 py-0.5 rounded uppercase tracking-wider border border-emerald-200">
                      Standard Merchant Markup
                    </span>
                  </div>
                </div>
                <div className="p-6 grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="bg-slate-50 p-4 rounded-lg border border-slate-100">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">Source Price</label>
                    <div className="text-lg font-bold text-slate-700">{analysisResult.currency} {analysisResult.price}</div>
                  </div>
                  <div className="bg-slate-50 p-4 rounded-lg border border-slate-100">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">Multiplier</label>
                    <div className="text-lg font-bold text-slate-700">x 1.5</div>
                  </div>
                  <div className="bg-indigo-50/50 p-4 rounded-lg border border-indigo-100">
                    <label className="text-[10px] font-black text-primary uppercase tracking-widest block mb-1">Target Price</label>
                    <div className="text-lg font-bold text-primary">${analysisResult.calculatedPrice}</div>
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
                <div className="flex-1 overflow-auto max-h-[440px]">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-slate-50/30 border-b border-slate-100">
                        <th className="px-6 py-3 text-left font-black text-slate-400 uppercase tracking-widest">Variant ID</th>
                        <th className="px-6 py-3 text-left font-black text-slate-400 uppercase tracking-widest">Options</th>
                        <th className="px-6 py-3 text-left font-black text-slate-400 uppercase tracking-widest">Status</th>
                        <th className="px-6 py-3 text-right font-black text-slate-400 uppercase tracking-widest">Shopify Price</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {analysisResult.variants?.map((v: any, i: number) => (
                        <tr key={i} className="hover:bg-slate-50/30 transition-colors">
                          <td className="px-6 py-4 font-mono text-[10px] text-slate-500">{v.sourceVariantId || 'DEFAULT'}</td>
                          <td className="px-6 py-4 font-bold text-slate-700">
                            {v.optionValues
                              ? Object.entries(v.optionValues).map(([name, value]: any) => `${name}: ${value}`).join(' / ')
                              : [v.color, v.size].filter(Boolean).join(' / ') || 'One Size'}
                          </td>
                          <td className="px-6 py-4">
                            <div className={cn(
                              "flex items-center gap-1.5 font-bold uppercase text-[9px]",
                              v.stockStatus === 'in_stock' ? "text-emerald-500" : "text-rose-500"
                            )}>
                              <div className={cn("w-1.5 h-1.5 rounded-full", v.stockStatus === 'in_stock' ? "bg-emerald-500" : "bg-rose-500")} />
                              {v.stockStatus === 'in_stock' ? 'In Stock' : 'Out of Stock'}
                            </div>
                          </td>
                          <td className="px-6 py-4 text-right font-bold text-slate-900">
                            ${v.calculatedPrice ?? analysisResult.calculatedPrice}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                
                <div className="px-6 py-4 border-t border-card-border bg-slate-50/20">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-3">Add to Shopify Collections</label>
                  <div className="flex flex-wrap gap-2">
                    {collections?.map((col: any) => (
                      <button
                        key={col.id}
                        onClick={() => {
                          if (selectedCollections.includes(col.id)) {
                            setSelectedCollections(prev => prev.filter(id => id !== col.id));
                          } else {
                            setSelectedCollections(prev => [...prev, col.id]);
                          }
                        }}
                        className={cn(
                          "px-3 py-1.5 rounded-full text-[10px] font-bold border transition-all",
                          selectedCollections.includes(col.id)
                            ? "bg-primary border-primary text-white shadow-md shadow-primary/20"
                            : "bg-white border-slate-200 text-slate-500 hover:border-slate-300"
                        )}
                      >
                        {col.title}
                      </button>
                    ))}
                    {!collections && <p className="text-[10px] text-slate-400 italic font-medium">Loading collections or Shopify not connected...</p>}
                  </div>
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
                          productData: analysisResult,
                          pricingRuleId: analysisResult.pricingRule?.id,
                          collections: selectedCollections
                        }),
                        {
                          loading: 'ENQUEUING PUBLISH JOB...',
                          success: (res) => {
                            setPublishLoading(false);
                            setSelectedCollections([]);
                            setAnalysisResult(null);
                            return `QUEUED FOR SHOPIFY (ID: ${res.data.productId.slice(-6)})`;
                          },
                          error: (error: any) => {
                            setPublishLoading(false);
                            return error.response?.data?.error || 'FAILED TO ENQUEUE PUBLICATION';
                          }
                        }
                      );
                    }}
                    disabled={publishLoading}
                    className="bg-primary text-white px-6 py-2.5 rounded-md text-xs font-bold hover:opacity-90 transition-all uppercase tracking-widest shadow-lg shadow-indigo-100 flex items-center gap-2"
                  >
                    {publishLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Publish As Draft'}
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
