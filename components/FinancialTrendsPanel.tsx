import type { FinancialTrends } from "@/lib/types/credit-analysis";

export function FinancialTrendsPanel({ trends }: { trends: FinancialTrends }) {
  if (trends.years.length === 0) {
    return (
      <p className="border border-dashed border-slate-300 bg-slate-50 px-3 py-3 text-sm text-slate-700">
        {trends.note}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto border border-slate-200 bg-white">
        <table className="min-w-full text-left text-xs">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">Metric</th>
              {trends.years.map((year) => (
                <th key={year} className="px-3 py-2 text-right font-medium">
                  {year}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {trends.rows.map((row) => (
              <tr key={row.id} className="border-t border-slate-100 align-top">
                <td className="px-3 py-2 font-medium text-slate-900">{row.label}</td>
                {row.cells.map((cell, index) => (
                  <td
                    key={`${row.id}-${trends.years[index] ?? index}`}
                    className="px-3 py-2 text-right"
                  >
                    <div className="tabular-nums text-slate-900">{cell.display}</div>
                    {cell.detail ? (
                      <p className="mt-1 max-w-48 text-[10px] leading-snug text-slate-500 ml-auto">
                        {cell.detail}
                      </p>
                    ) : null}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] leading-relaxed text-slate-500">{trends.note}</p>
    </div>
  );
}
