import type { CreditAnalysisResult } from "@/lib/types/credit-analysis";

const METRIC_LABELS: Array<{
  key: keyof CreditAnalysisResult["keyMetrics"];
  label: string;
  wide?: boolean;
}> = [
  { key: "totalDebt", label: "Total debt" },
  { key: "cash", label: "Cash" },
  { key: "netDebt", label: "Net debt" },
  { key: "ebitda", label: "EBITDA" },
  { key: "netLeverage", label: "Net leverage (independent)" },
  { key: "reportedLeverage", label: "Reported leverage" },
  { key: "interestCoverage", label: "Interest coverage" },
  { key: "liquidity", label: "Liquidity" },
  { key: "affo", label: "AFFO" },
  { key: "reitMetrics", label: "REIT metrics", wide: true },
];

function severityClass(severity: "Low" | "Moderate" | "High"): string {
  switch (severity) {
    case "Low":
      return "border-emerald-200 bg-emerald-50 text-emerald-900";
    case "Moderate":
      return "border-amber-200 bg-amber-50 text-amber-900";
    case "High":
      return "border-red-200 bg-red-50 text-red-900";
  }
}

type AnalysisResultsProps = {
  result: CreditAnalysisResult;
  heading?: string;
  showLiveDisclaimer?: boolean;
};

export function AnalysisResults({
  result,
  heading = "Analysis results",
  showLiveDisclaimer = false,
}: AnalysisResultsProps) {
  return (
    <div className="space-y-6">
      {showLiveDisclaimer ? (
        <p className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-600">
          AI-assisted first-pass credit screen only. Verify all figures, ratios,
          and conclusions against the source filings and independent research.
          Not investment advice.
        </p>
      ) : null}

      {result.analyzedDocuments.length > 0 ? (
        <p className="text-xs text-slate-600">
          <span className="font-medium text-slate-700">Documents analyzed: </span>
          {result.analyzedDocuments.join("; ")}
        </p>
      ) : null}

      <div className="rounded-lg border border-slate-200 bg-white p-5 sm:p-6">
        <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Overall credit risk
        </h3>
        <p className="mt-2 text-2xl font-semibold text-slate-900">
          {result.overallCreditRisk}
        </p>
        <p className="mt-2 text-xs font-medium uppercase tracking-wide text-slate-400">
          AI interpretation
        </p>
        <p className="mt-1 text-sm text-slate-600">{result.riskSummary}</p>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-5 sm:p-6">
        <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Key metrics
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          From the uploaded documents when stated, with the source document
          identified. Otherwise &ldquo;Not available.&rdquo; Independent ratios
          are labeled separately from company-reported ratios.
        </p>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {METRIC_LABELS.map(({ key, label, wide }) => (
            <div
              key={key}
              className={`rounded-md border border-slate-100 bg-slate-50/80 px-4 py-3 ${
                wide ? "sm:col-span-2 lg:col-span-3" : ""
              }`}
            >
              <dt className="text-xs font-medium text-slate-500">{label}</dt>
              <dd className="mt-1 text-sm font-semibold leading-snug text-slate-900">
                {result.keyMetrics[key]}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-xs font-medium uppercase tracking-wide text-slate-400">
          Independent calculation check
        </p>
        <p className="mt-1 text-sm leading-relaxed whitespace-pre-line text-slate-600">
          {result.calculationNotes}
        </p>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-5 sm:p-6">
        <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Sources and document conflicts
        </h3>
        <p className="mt-2 text-xs font-medium uppercase tracking-wide text-slate-400">
          From filings
        </p>
        <p className="mt-1 text-sm leading-relaxed whitespace-pre-line text-slate-700">
          {result.documentConflicts}
        </p>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-5 sm:p-6">
        <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Key credit risks
        </h3>
        <ul className="mt-4 space-y-4">
          {result.keyCreditRisks.map((risk) => (
            <li
              key={risk.title}
              className="border-b border-slate-100 pb-4 last:border-0 last:pb-0"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-slate-900">
                  {risk.title}
                </span>
                <span
                  className={`inline-flex rounded border px-2 py-0.5 text-xs font-medium ${severityClass(risk.severity)}`}
                >
                  {risk.severity}
                </span>
              </div>
              <p className="mt-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                AI interpretation
              </p>
              <p className="mt-1 text-sm text-slate-700">{risk.explanation}</p>
              <p className="mt-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                Supporting evidence (from filing)
              </p>
              <p className="mt-1 text-sm text-slate-600 italic">
                {risk.supportingEvidence}
              </p>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-5 sm:p-6">
        <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Liquidity &amp; debt maturities
        </h3>
        <p className="mt-2 text-xs font-medium uppercase tracking-wide text-slate-400">
          From filings
        </p>
        <p className="mt-1 text-sm leading-relaxed text-slate-700 whitespace-pre-line">
          {result.liquidityAndMaturities}
        </p>
        <h4 className="mt-5 text-xs font-medium uppercase tracking-wide text-slate-500">
          Capital expenditure requirements
        </h4>
        <p className="mt-2 text-xs font-medium uppercase tracking-wide text-slate-400">
          From filings
        </p>
        <p className="mt-1 text-sm leading-relaxed text-slate-700 whitespace-pre-line">
          {result.capitalExpenditures}
        </p>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-5 sm:p-6">
        <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Questions for further diligence
        </h3>
        <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-slate-700">
          {result.diligenceQuestions.map((q) => (
            <li key={q}>{q}</li>
          ))}
        </ol>
      </div>

      <p className="sr-only">{heading}</p>
    </div>
  );
}
