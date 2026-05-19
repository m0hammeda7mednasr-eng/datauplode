export default function ProductWarnings({ warnings }: { warnings: Array<{ code: string; message: string }> }) {
  if (!warnings.length) return <span className="text-xs text-emerald-600">Clear</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {warnings.slice(0, 3).map((warning) => (
        <span key={`${warning.code}-${warning.message}`} title={warning.message} className="rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">
          {warning.code}
        </span>
      ))}
    </div>
  );
}
