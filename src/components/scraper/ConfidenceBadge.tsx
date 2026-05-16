export default function ConfidenceBadge({ value }: { value: number }) {
  const tone =
    value >= 90 ? "bg-emerald-100 text-emerald-700" : value >= 70 ? "bg-blue-100 text-blue-700" : value >= 50 ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700";
  return <span className={`inline-flex min-w-14 justify-center rounded-md px-2 py-1 text-xs font-semibold ${tone}`}>{value}%</span>;
}
