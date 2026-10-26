import { DataQualityList } from "@/components/DataQualityList";
import { DebtLiquidityPanel } from "@/components/DebtLiquidityPanel";
import { FinancialTrendsPanel } from "@/components/FinancialTrendsPanel";
import { MetricDashboard } from "@/components/MetricDashboard";
import type { CreditAnalysisResult } from "@/lib/types/credit-analysis";

const CATEGORY_ORDER = [
  "leverage",
  "cash_flow",
  "refinancing",
  "capital_allocation",
  "downside_protection",
  "other",
] as const;

const CATEGORY_LABELS: Record<(typeof CATEGORY_ORDER)[number], string> = {
  leverage: "Leverage",
  cash_flow: "Cash flow",
  refinancing: "Refinancing",
  capital_allocation: "Capital allocation",
  downside_protection: "Downside protection",
  other: "Other",
};

function severityClass(severity: "Low" | "Moderate" | "High"): string {
  switch (severity) {
    case "Low":
      return "border-slate-200 bg-slate-50 text-slate-700";
    case "Moderate":
      return "border-amber-200 bg-amber-50 text-amber-950";
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
  const questions = CATEGORY_ORDER.map((category) => ({
    category,
    items: result.diligenceQuestions.filter((item) => item.category === category),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="space-y-8">
      {showLiveDisclaimer ? (
        <p className="border border-slate-200 bg-white px-3 py-2 text-xs leading-relaxed text-slate-600">
          First-pass credit screen from the uploaded filings. Figures stay in
          the units used for the calculation; the dashboard shows $M or $B.
          Company-reported amounts and independent calculations are labeled
          separately. This is not a buy, sell, or hold recommendation and it
          does not estimate market prices.
        </p>
      ) : null}

      <nav className="flex flex-wrap gap-2 text-xs" aria-label="Analysis sections">
        {[
          ["credit-overview", "Credit Overview"],
          ["financial-trends", "Financial Trends"],
          ["debt-liquidity", "Debt & Liquidity"],
          ["credit-risks", "Credit Risks & Liquidity"],
          ["investment-considerations", "Investment Considerations"],
        ].map(([id, label]) => (
          <a
            key={id}
            href={`#${id}`}
            className="border border-slate-200 bg-white px-2.5 py-1 text-slate-700 hover:border-slate-400"
          >
            {label}
          </a>
        ))}
      </nav>

      {result.analyzedDocuments.length > 0 ? (
        <p className="text-xs text-slate-600">
          <span className="font-medium text-slate-800">Documents analyzed: </span>
          {result.analyzedDocuments.join("; ")}
        </p>
      ) : null}

      <section id="credit-overview" className="scroll-mt-6 space-y-4">
        <header>
          <h3 className="text-sm font-semibold text-slate-950">Credit Overview</h3>
          <p className="mt-1 text-xs text-slate-500">
            Headline figures use the source scale internally. Open a metric for
            the original amount, period, and source.
          </p>
        </header>
        <div className="border border-slate-200 bg-white px-3 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Overall credit risk
            </p>
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
              AI interpretation
            </p>
          </div>
          <p className="mt-1 text-2xl font-semibold text-slate-950">
            {result.overallCreditRisk}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-slate-700">
            {result.riskSummary}
          </p>
        </div>
        <MetricDashboard metrics={result.dashboard} />
        {result.keyMetrics.reitMetrics.trim() &&
        result.keyMetrics.reitMetrics !== "Not available." ? (
          <div className="border border-slate-200 bg-white px-3 py-2.5">
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Other REIT disclosures
            </p>
            <p className="mt-1 text-xs leading-relaxed text-slate-700">
              {result.keyMetrics.reitMetrics}
            </p>
          </div>
        ) : null}
        <div>
          <h4 className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Data quality
          </h4>
          <div className="mt-2">
            <DataQualityList checks={result.dataQuality} />
          </div>
        </div>
      </section>

      <section id="financial-trends" className="scroll-mt-6 space-y-3">
        <header>
          <h3 className="text-sm font-semibold text-slate-950">Financial Trends</h3>
          <p className="mt-1 text-xs text-slate-500">
            Annual figures use the fiscal years printed in the filing. A ratio
            is blank when its inputs are not both available for that year.
          </p>
        </header>
        <FinancialTrendsPanel trends={result.financialTrends} />
      </section>

      <section id="debt-liquidity" className="scroll-mt-6 space-y-3">
        <header>
          <h3 className="text-sm font-semibold text-slate-950">Debt & Liquidity</h3>
          <p className="mt-1 text-xs text-slate-500">
            Maturity amounts are taken from a schedule printed in the filing.
            Missing schedules stay unavailable.
          </p>
        </header>
        <DebtLiquidityPanel
          schedule={result.maturitySchedule}
          liquidity={result.liquidityAndMaturities}
        />
      </section>

      <section id="credit-risks" className="scroll-mt-6 space-y-3">
        <header>
          <h3 className="text-sm font-semibold text-slate-950">
            Credit Risks & Liquidity
          </h3>
        </header>
        <ul className="space-y-3 border border-slate-200 bg-white px-3 py-3">
          {result.keyCreditRisks.map((risk) => (
            <li
              key={risk.title}
              className="border-b border-slate-100 pb-3 last:border-0 last:pb-0"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-slate-950">
                  {risk.title}
                </span>
                <span
                  className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${severityClass(risk.severity)}`}
                >
                  {risk.severity}
                </span>
              </div>
              <p className="mt-2 text-[11px] font-medium uppercase tracking-wide text-slate-400">
                AI interpretation
              </p>
              <p className="mt-1 text-sm text-slate-700">{risk.explanation}</p>
              <p className="mt-2 text-[11px] font-medium uppercase tracking-wide text-slate-400">
                Factual disclosure
              </p>
              <p className="mt-1 text-sm text-slate-600 italic">
                {risk.supportingEvidence}
              </p>
            </li>
          ))}
        </ul>
        <div className="border border-slate-200 bg-white px-3 py-3">
          <h4 className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Capital expenditures
          </h4>
          <p className="mt-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
            Factual disclosure
          </p>
          <p className="mt-1 text-sm leading-relaxed whitespace-pre-line text-slate-700">
            {result.capitalExpenditures}
          </p>
        </div>
      </section>

      <section id="investment-considerations" className="scroll-mt-6 space-y-3">
        <header>
          <h3 className="text-sm font-semibold text-slate-950">
            Investment Considerations
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Diligence questions are AI interpretations of gaps and disclosed
            risks. They are not a recommendation and they do not imply a price.
          </p>
        </header>
        <div className="space-y-3">
          {questions.map((group) => (
            <div
              key={group.category}
              className="border border-slate-200 bg-white px-3 py-3"
            >
              <h4 className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                {CATEGORY_LABELS[group.category]}
              </h4>
              <ul className="mt-2 list-disc space-y-1.5 pl-4 text-sm text-slate-700">
                {group.items.map((item) => (
                  <li key={item.question}>{item.question}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="border border-slate-200 bg-white px-3 py-3">
          <h4 className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Sources and conflicts
          </h4>
          <p className="mt-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
            Factual disclosure
          </p>
          <p className="mt-1 text-sm leading-relaxed whitespace-pre-line text-slate-700">
            {result.documentConflicts}
          </p>
          <p className="mt-3 text-[11px] font-medium uppercase tracking-wide text-slate-400">
            Calculation notes
          </p>
          <p className="mt-1 text-xs leading-relaxed whitespace-pre-line text-slate-600">
            {result.calculationNotes}
          </p>
        </div>
      </section>

      <p className="sr-only">{heading}</p>
    </div>
  );
}
