import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { productsApi } from "../api/productsApi";
import ConfidenceBadge from "../components/scraper/ConfidenceBadge";
import ImageGallery from "../components/scraper/ImageGallery";
import ProductWarnings from "../components/scraper/ProductWarnings";
import VariantEditor from "../components/scraper/VariantEditor";
import type { NormalizedProduct } from "../types/product";

export default function ProductEditorPage() {
  const { id = "" } = useParams();
  const { data, refetch } = useQuery({ queryKey: ["extracted-product", id], queryFn: () => productsApi.extractedOne(id) });
  const approve = useMutation({ mutationFn: () => productsApi.updateExtracted(id, { status: "READY" }), onSuccess: () => refetch() });
  const product: NormalizedProduct | null = data ? JSON.parse(data.normalizedJson) : null;
  if (!product) return null;
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div><h1 className="text-2xl font-bold tracking-tight">{product.identity.title}</h1><p className="mt-1 text-sm text-slate-500">{product.source.url}</p></div>
        <div className="flex items-center gap-3"><ConfidenceBadge value={product.confidence.overall} /><button onClick={() => approve.mutate()} className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white">Approve</button></div>
      </div>
      <ProductWarnings warnings={product.warnings} />
      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <section className="rounded-lg border border-card-border bg-white p-5"><h2 className="mb-3 text-sm font-semibold uppercase text-slate-500">Images</h2><ImageGallery images={product.media.images} /></section>
          <section className="rounded-lg border border-card-border bg-white p-5"><h2 className="mb-3 text-sm font-semibold uppercase text-slate-500">Variants</h2><VariantEditor variants={product.variants} /></section>
        </div>
        <aside className="space-y-4">
          <div className="rounded-lg border border-card-border bg-white p-5"><h2 className="text-sm font-semibold uppercase text-slate-500">Pricing</h2><div className="mt-3 text-2xl font-bold">{product.pricing.price || "-"} {product.pricing.currency}</div></div>
          <div className="rounded-lg border border-card-border bg-white p-5"><h2 className="text-sm font-semibold uppercase text-slate-500">Description</h2><p className="mt-3 text-sm leading-6 text-slate-700">{product.content.descriptionText || "No description found."}</p></div>
          <details className="rounded-lg border border-card-border bg-white p-5"><summary className="cursor-pointer text-sm font-semibold uppercase text-slate-500">Raw Debug</summary><pre className="mt-3 max-h-80 overflow-auto text-xs">{JSON.stringify(product.raw, null, 2)}</pre></details>
        </aside>
      </div>
    </div>
  );
}
