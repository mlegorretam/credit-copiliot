import { StatusBadge } from "@/components/StatusBadge";
import type { DashboardMetric } from "@/lib/types/credit-analysis";

export function MetricDashboard({ metrics }: { metrics: DashboardMetric[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
      {metrics.map((metric) => (
        <article
          key={metric.id}
          className="min-w-0 border border-slate-200 bg-white px-3 py-2.5"
        >
          <div className="flex items-start justify-between gap-2">
            <h4 className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              {metric.label}
            </h4>
          </div>
          <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-slate-950">
            {metric.value}
          </p>
          <p className="mt-1 text-[11px] leading-4 text-slate-500">
            {metric.period}
            {metric.asOf !== "Date not stated" &&
            metric.asOf !== "Period not stated" &&
            metric.asOf !== "Not disclosed" &&
            metric.asOf !== "As disclosed"
              ? ` · ${metric.asOf}`
              : ""}
          </p>
          <div className="mt-2 flex flex-wrap gap-1">
            {metric.badge === "Review Required" ? (
              <StatusBadge status="Review Required" />
            ) : (
              <StatusBadge status={metric.badge} />
            )}
            {metric.review && metric.badge !== "Review Required" ? (
              <StatusBadge status="Review Required" />
            ) : null}
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer text-[11px] font-medium text-slate-500 hover:text-slate-800">
              Calculation & source
            </summary>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
              {metric.source}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed whitespace-pre-line text-slate-600">
              {metric.calculation}
            </p>
          </details>
        </article>
      ))}
    </div>
  );
}
