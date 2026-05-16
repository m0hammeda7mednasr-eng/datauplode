export default function VariantEditor({ variants }: { variants: Array<{ title?: string; sku?: string; price?: number; currency?: string; optionValues: Record<string, string>; inStock?: boolean }> }) {
  return (
    <div className="overflow-hidden rounded-lg border border-card-border bg-white">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
          <tr><th className="p-3">Variant</th><th className="p-3">SKU</th><th className="p-3">Price</th><th className="p-3">Stock</th></tr>
        </thead>
        <tbody>
          {variants.map((variant, index) => (
            <tr key={`${variant.sku || variant.title || index}`} className="border-t border-card-border">
              <td className="p-3">{variant.title || Object.values(variant.optionValues).join(" / ") || "Default"}</td>
              <td className="p-3 text-slate-500">{variant.sku || "-"}</td>
              <td className="p-3">{variant.price ? `${variant.price} ${variant.currency || ""}` : "-"}</td>
              <td className="p-3">{variant.inStock === false ? "Out" : "Available"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
