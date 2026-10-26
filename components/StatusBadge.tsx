import type { MetricBadge } from "@/lib/types/credit-analysis";

export function StatusBadge({ status }: { status: MetricBadge }) {
  const tone =
    status === "Review Required"
      ? "border-amber-300 bg-amber-50 text-amber-950"
      : status === "Calculated"
        ? "border-slate-300 bg-white text-slate-800"
        : "border-slate-200 bg-slate-100 text-slate-700";
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone}`}
    >
      {status}
    </span>
  );
}
