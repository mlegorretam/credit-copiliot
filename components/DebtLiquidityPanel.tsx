import type { DisclosedMaturitySchedule } from "@/lib/types/credit-analysis";

export function DebtLiquidityPanel({
  schedule,
  liquidity,
}: {
  schedule: DisclosedMaturitySchedule;
  liquidity: string;
}) {
  return (
    <div className="space-y-3">
      <section className="border border-slate-200 bg-white px-3 py-3">
        <h4 className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Debt maturities
        </h4>
        {schedule.buckets ? (
          <div className="mt-3 space-y-2">
            {schedule.buckets.map((bar) => (
              <div
                key={bar.label}
                className="grid grid-cols-[6.5rem_1fr_4.75rem] items-center gap-2"
              >
                <span className="text-xs text-slate-600">{bar.label}</span>
                <div className="h-2 bg-slate-100">
                  <div
                    className="h-2 bg-slate-700"
                    style={{ width: `${Math.max(2, bar.share * 100)}%` }}
                  />
                </div>
                <span className="text-right text-xs tabular-nums text-slate-800">
                  {bar.display}
                </span>
              </div>
            ))}
            <p className="text-[11px] leading-relaxed text-slate-500">{schedule.message}</p>
            {schedule.reconciliation ? (
              <div className="mt-3 border-t border-slate-100 pt-3">
                <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  Reconciliation to carrying amount
                </p>
                <dl className="mt-2 space-y-1 text-xs text-slate-700">
                  <div className="flex items-baseline justify-between gap-3">
                    <dt>Contractual maturities</dt>
                    <dd className="tabular-nums text-slate-900">
                      {schedule.reconciliation.grossDisplay}
                    </dd>
                  </div>
                  {schedule.reconciliation.lines.map((line) => (
                    <div
                      key={`${line.label}:${line.absolute}`}
                      className="flex items-baseline justify-between gap-3"
                    >
                      <dt>{line.label}</dt>
                      <dd className="tabular-nums text-slate-900">{line.display}</dd>
                    </div>
                  ))}
                  <div className="flex items-baseline justify-between gap-3 border-t border-slate-100 pt-1">
                    <dt>{schedule.reconciliation.carryingLabel}</dt>
                    <dd className="tabular-nums text-slate-900">
                      {schedule.reconciliation.carryingDisplay}
                    </dd>
                  </div>
                </dl>
                <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                  {schedule.reconciliation.note}
                </p>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="mt-2 text-sm text-slate-700">{schedule.message}</p>
        )}
      </section>

      <div className="border border-slate-200 bg-white px-3 py-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
          Liquidity
        </p>
        <p className="mt-1 text-sm leading-relaxed whitespace-pre-line text-slate-700">
          {liquidity}
        </p>
      </div>
    </div>
  );
}
