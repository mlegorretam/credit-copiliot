import { formatCompactAbsolute, formatRatio } from "@/lib/credit/format-money";
import { periodLabel, type ReportingPeriod } from "@/lib/credit/period-label";
import type { DashboardMetric, MetricBadge } from "@/lib/types/credit-analysis";

export type DashboardAmount = {
  absolute: number;
  period: ReportingPeriod;
  sourceDocument: string;
  asOf: string;
  description: string;
  bridge?: string;
};

export type DashboardInput = {
  totalDebt: DashboardAmount | null;
  cash: DashboardAmount | null;
  netDebtAbsolute: number | null;
  netDebtReportedOnly: boolean;
  netDebtConflicts: boolean;
  statedNetDebt: DashboardAmount | null;
  ebitda: DashboardAmount | null;
  leverageMultiple: number | null;
  leverageApproximated: boolean;
  reportedLeverageMultiple: number | null;
  reportedLeverageLabel: string;
  reportedLeverageAsOf: string;
  leverageConflicts: boolean;
  coverageUsesCashInterest: boolean;
  coverageMultiple: number | null;
  coverageApproximated: boolean;
  coverageMixed: boolean;
  coveragePeriod: string;
  affo: DashboardAmount | null;
  liquidity: DashboardAmount | null;
  liquidityCalculated: boolean;
  capex: DashboardAmount | null;
  sentences: Record<DashboardMetric["id"], string>;
  reviewNotes: Partial<Record<DashboardMetric["id"], boolean>>;
};

export function buildDashboard(input: DashboardInput): DashboardMetric[] {
  return [
    moneyCard(input, "totalDebt", "Total debt", input.totalDebt, "Reported"),
    moneyCard(input, "cash", "Cash", input.cash, "Reported"),
    netDebtCard(input),
    ebitdaCard(input),
    ratioCard(input, "netLeverage", "Net leverage", input.leverageMultiple, "Calculated", {
      review:
        input.leverageApproximated ||
        input.leverageConflicts ||
        input.leverageMultiple == null,
    }),
    ratioCard(
      input,
      "reportedLeverage",
      input.reportedLeverageLabel,
      input.reportedLeverageMultiple,
      "Reported",
      { review: input.leverageConflicts || input.reportedLeverageMultiple == null },
    ),
    ratioCard(
      input,
      "interestCoverage",
      input.coverageUsesCashInterest ? "Cash Interest Coverage" : "Interest coverage",
      input.coverageMultiple,
      "Calculated",
      {
        review:
          input.coverageApproximated ||
          input.coverageMixed ||
          input.coverageMultiple == null,
      },
    ),
    liquidityCard(input),
    flowCard(input, "affo", "AFFO", input.affo),
    flowCard(input, "capitalExpenditures", "Capital expenditures", input.capex),
  ];
}

function moneyCard(
  input: DashboardInput,
  id: DashboardMetric["id"],
  label: string,
  amount: DashboardAmount | null,
  badge: MetricBadge,
): DashboardMetric {
  if (!amount) return missingCard(id, label, input.sentences[id]);
  return {
    id,
    label,
    value: formatCompactAbsolute(amount.absolute),
    period: periodLabel(amount.period),
    asOf: amount.asOf || "Date not stated",
    badge,
    review: input.reviewNotes[id] === true,
    source: sourceLine(amount),
    calculation: input.sentences[id],
  };
}

function netDebtCard(input: DashboardInput): DashboardMetric {
  if (input.netDebtAbsolute == null) {
    return missingCard("netDebt", "Net debt", input.sentences.netDebt);
  }
  return {
    id: "netDebt",
    label: "Net debt",
    value: formatCompactAbsolute(input.netDebtAbsolute),
    period: "Point in time",
    asOf: input.totalDebt?.asOf || input.statedNetDebt?.asOf || "Date not stated",
    badge: input.netDebtReportedOnly ? "Reported" : "Calculated",
    review: input.netDebtConflicts,
    source: input.netDebtReportedOnly
      ? sourceLine(input.statedNetDebt)
      : sourceLine(input.totalDebt),
    calculation: input.sentences.netDebt,
  };
}

function ebitdaCard(input: DashboardInput): DashboardMetric {
  const amount = input.ebitda;
  if (!amount) return missingCard("ebitda", "EBITDA", input.sentences.ebitda);
  const calculated = Boolean(amount.bridge);
  const interim = amount.period !== "ttm";
  return {
    id: "ebitda",
    label: amount.period === "ttm" ? "TTM EBITDA" : "EBITDA",
    value: formatCompactAbsolute(amount.absolute),
    period: periodLabel(amount.period),
    asOf: amount.asOf || "Period not stated",
    badge: calculated ? "Calculated" : "Reported",
    review: interim || input.reviewNotes.ebitda === true,
    source: sourceLine(amount),
    calculation: input.sentences.ebitda,
  };
}

function ratioCard(
  input: DashboardInput,
  id: DashboardMetric["id"],
  label: string,
  multiple: number | null,
  badge: MetricBadge,
  options: { review: boolean },
): DashboardMetric {
  if (multiple == null) return missingCard(id, label, input.sentences[id]);
  const amount = id === "reportedLeverage" ? null : input.ebitda;
  const period =
    id === "interestCoverage" && input.coveragePeriod
      ? input.coveragePeriod
      : amount
        ? periodLabel(amount.period)
        : "As disclosed";
  return {
    id,
    label,
    value: formatRatio(multiple),
    period,
    asOf:
      amount?.asOf ||
      (id === "reportedLeverage" ? input.reportedLeverageAsOf : "") ||
      "Date not stated",
    badge,
    review: options.review || input.reviewNotes[id] === true,
    source: id === "reportedLeverage" ? "Company disclosure" : sourceLine(input.ebitda),
    calculation: input.sentences[id],
  };
}

function liquidityCard(input: DashboardInput): DashboardMetric {
  const amount = input.liquidity;
  if (!amount) return missingCard("liquidity", "Liquidity", input.sentences.liquidity);
  return {
    id: "liquidity",
    label: "Liquidity",
    value: formatCompactAbsolute(amount.absolute),
    period: periodLabel(amount.period),
    asOf: amount.asOf || "Date not stated",
    badge: input.liquidityCalculated ? "Calculated" : "Reported",
    review: input.reviewNotes.liquidity === true,
    source: sourceLine(amount),
    calculation: input.sentences.liquidity,
  };
}

function flowCard(
  input: DashboardInput,
  id: "affo" | "capitalExpenditures",
  label: string,
  amount: DashboardAmount | null,
): DashboardMetric {
  if (!amount) return missingCard(id, label, input.sentences[id]);
  return {
    id,
    label: amount.period === "ttm" ? `TTM ${label}` : label,
    value: formatCompactAbsolute(amount.absolute),
    period: periodLabel(amount.period),
    asOf: amount.asOf || "Period not stated",
    badge: "Reported",
    review: input.reviewNotes[id] === true || (id === "affo" && amount.period !== "ttm" && input.reviewNotes.affo === true),
    source: sourceLine(amount),
    calculation: input.sentences[id],
  };
}

function missingCard(
  id: DashboardMetric["id"],
  label: string,
  calculation: string,
): DashboardMetric {
  return {
    id,
    label,
    value: "n/a",
    period: "Not disclosed",
    asOf: "Not disclosed",
    badge: "Review Required",
    review: true,
    source: "Not identified",
    calculation,
  };
}

function sourceLine(amount: DashboardAmount | null): string {
  if (!amount) return "Not identified";
  const source = amount.sourceDocument.trim() || "Source document not identified";
  return amount.asOf ? `${source} · ${amount.asOf}` : source;
}
