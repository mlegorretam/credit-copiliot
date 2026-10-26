import { StatusBadge } from "@/components/StatusBadge";
import type { QualityCheck } from "@/lib/types/credit-analysis";

export function DataQualityList({ checks }: { checks: QualityCheck[] }) {
  return (
    <ul className="divide-y divide-slate-100 border border-slate-200 bg-white">
      {checks.map((check) => (
        <li
          key={check.id}
          className="grid gap-2 px-3 py-2.5 sm:grid-cols-[14rem_8.5rem_1fr] sm:items-start"
        >
          <p className="text-xs font-medium text-slate-800">{check.label}</p>
          <div>
            <StatusBadge status={check.status} />
          </div>
          <p className="text-xs leading-relaxed text-slate-600">{check.detail}</p>
        </li>
      ))}
    </ul>
  );
}
