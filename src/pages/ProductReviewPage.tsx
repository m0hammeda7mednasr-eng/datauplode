import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { CheckCircle } from "lucide-react";
import { productsApi } from "../api/productsApi";
import ConfidenceBadge from "../components/scraper/ConfidenceBadge";
import ProductWarnings from "../components/scraper/ProductWarnings";
import type { NormalizedProduct } from "../types/product";

function parseProduct(value: string): NormalizedProduct | null {
  try { return JSON.parse(value); } catch { return null; }
}

export default function ProductReviewPage() {
  const queryClient = useQueryClient();
  const { data = [] } = useQuery({ queryKey: ["extracted-products"], queryFn: productsApi.extracted });
  const approve = useMutation({ mutationFn: (id: string) => productsApi.updateExtracted(id, { status: "READY" }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["extracted-products"] }) });
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Product Review</h1>
      <div className="overflow-hidden rounded-lg border border-card-border bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr><th className="p-3">Product</th><th className="p-3">Price</th><th className="p-3">Confidence</th><th className="p-3">Warnings</th><th className="p-3">Status</th><th className="p-3"></th></tr>
          </thead>
          <tbody>
            {data.map((row) => {
              const product = parseProduct(row.normalizedJson);
              return (
                <tr key={row.id} className="border-t border-card-border">
                  <td className="p-3"><Link className="font-semibold text-primary" to={`/products/review/${row.id}`}>{row.title}</Link><div className="max-w-sm truncate text-xs text-slate-500">{row.sourceUrl}</div></td>
                  <td className="p-3">{product?.pricing.price ? `${product.pricing.price} ${product.pricing.currency || ""}` : "-"}</td>
                  <td className="p-3"><ConfidenceBadge value={row.confidence} /></td>
                  <td className="p-3"><ProductWarnings warnings={row.warnings} /></td>
                  <td className="p-3">{row.status}</td>
                  <td className="p-3"><button onClick={() => approve.mutate(row.id)} className="rounded-md p-2 text-emerald-600 hover:bg-emerald-50" title="Approve"><CheckCircle className="h-4 w-4" /></button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
