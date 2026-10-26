import {
  NOT_AVAILABLE,
  type DisclosedMaturitySchedule,
  type QualityCheck,
} from "@/lib/types/credit-analysis";
import { periodLabel, type ReportingPeriod } from "@/lib/credit/period-label";

export type QualityInput = {
  totalDebtFound: boolean;
  cashFound: boolean;
  ebitdaFound: boolean;
  interestFound: boolean;
  ebitdaPeriod: ReportingPeriod | null;
  interestPeriod: ReportingPeriod | null;
  ebitdaFromQuarters: boolean;
  leverageApproximated: boolean;
  coverageApproximated: boolean;
  coverageMixed: boolean;
  leverageMultiple: number | null;
  reportedLeverageMultiple: number | null;
  missingSources: string[];
  labelNotes: string[];
  maturitySchedule: DisclosedMaturitySchedule;
  dateConflict: string | null;
  missingBalanceSheet: string[];
  flowBridge: boolean;
};

export function buildDataQuality(input: QualityInput): QualityCheck[] {
  return [
    balanceSheet(input),
    reportingPeriods(input),
    annualizedTtm(input),
    ttmLabels(input),
    reportingDates(input),
    missingInformation(input),
    leverageDefinitions(input),
    maturitySchedule(input.maturitySchedule),
  ];
}

function balanceSheet(input: QualityInput): QualityCheck {
  if (input.missingBalanceSheet.length > 0) {
    return {
      id: "balance-sheet",
      label: "Missing balance sheet metric",
      status: "Review Required",
      detail: `Missing balance sheet metric: ${input.missingBalanceSheet.join(" and ")}. The amount was not estimated.`,
    };
  }
  return {
    id: "balance-sheet",
    label: "Missing balance sheet metric",
    status: "Reported",
    detail: "Total debt and cash were both found for the balance-sheet view.",
  };
}

function annualizedTtm(input: QualityInput): QualityCheck {
  if (input.coverageApproximated || input.leverageApproximated) {
    const which = [
      input.leverageApproximated ? "leverage" : "",
      input.coverageApproximated ? "interest coverage" : "",
    ].filter(Boolean);
    return {
      id: "annualized-ttm",
      label: "Annualized rather than actual TTM calculation",
      status: "Review Required",
      detail: `Annualized rather than actual TTM calculation for ${which.join(" and ")}. A partial-period amount was scaled to twelve months and is not labeled as trailing-twelve-month.`,
    };
  }
  if (input.ebitdaFromQuarters || input.flowBridge) {
    return {
      id: "annualized-ttm",
      label: "Annualized rather than actual TTM calculation",
      status: "Calculated",
      detail:
        "Trailing-twelve-month figures were calculated from disclosed periods. Those amounts were not produced by annualizing a partial period.",
    };
  }
  return {
    id: "annualized-ttm",
    label: "Annualized rather than actual TTM calculation",
    status: "Reported",
    detail: "No partial-period amount was annualized and presented as trailing twelve months.",
  };
}

function reportingDates(input: QualityInput): QualityCheck {
  if (input.dateConflict) {
    return {
      id: "reporting-dates",
      label: "Conflicting reporting dates",
      status: "Review Required",
      detail: input.dateConflict,
    };
  }
  return {
    id: "reporting-dates",
    label: "Conflicting reporting dates",
    status: "Reported",
    detail:
      "Balance-sheet amounts used together share a reporting date, or the filing did not disclose one.",
  };
}

function reportingPeriods(input: QualityInput): QualityCheck {
  if (!input.ebitdaFound) {
    return {
      id: "reporting-periods",
      label: "Reporting periods",
      status: "Review Required",
      detail:
        "EBITDA was missing or was not found in the extracted text, so the reporting period used for leverage could not be checked.",
    };
  }
  if (input.leverageApproximated || input.coverageApproximated) {
    return {
      id: "reporting-periods",
      label: "Reporting periods",
      status: "Review Required",
      detail:
        "A partial-period figure was scaled to twelve months. That ratio is an annualized approximation, not trailing-twelve-month EBITDA or coverage.",
    };
  }
  if (input.coverageMixed) {
    return {
      id: "reporting-periods",
      label: "Reporting periods",
      status: "Review Required",
      detail:
        "EBITDA and cash interest both cover about twelve months, but one is trailing-twelve-month and the other is a fiscal year.",
    };
  }
  if (input.ebitdaPeriod === "ttm" && (!input.interestFound || input.interestPeriod === "ttm")) {
    return {
      id: "reporting-periods",
      label: "Reporting periods",
      status: input.ebitdaFromQuarters ? "Calculated" : "Reported",
      detail: input.ebitdaFromQuarters
        ? "Trailing-twelve-month EBITDA was calculated by adding four reported quarters. Partial-period amounts were not annualized."
        : "The EBITDA used for leverage is a trailing-twelve-month figure disclosed in the extracted text. Partial-period amounts were not annualized.",
    };
  }
  if (input.ebitdaPeriod === "annual" && (!input.interestFound || input.interestPeriod === "annual")) {
    return {
      id: "reporting-periods",
      label: "Reporting periods",
      status: "Reported",
      detail:
        "Full-year figures were used. They are not labeled as trailing-twelve-month amounts.",
    };
  }
  return {
    id: "reporting-periods",
    label: "Reporting periods",
    status: "Review Required",
    detail: `The EBITDA period is ${input.ebitdaPeriod ? periodLabel(input.ebitdaPeriod) : "unidentified"}. It was not treated as trailing-twelve-month EBITDA.`,
  };
}

function ttmLabels(input: QualityInput): QualityCheck {
  if (input.labelNotes.length > 0) {
    return {
      id: "ttm-labels",
      label: "TTM versus interim labels",
      status: "Review Required",
      detail: input.labelNotes.join(" "),
    };
  }
  return {
    id: "ttm-labels",
    label: "TTM versus interim labels",
    status: "Reported",
    detail:
      "No six-month, nine-month, quarterly, or year-to-date figure used in the dashboard was labeled as trailing twelve months.",
  };
}

function missingInformation(input: QualityInput): QualityCheck {
  const missing: string[] = [];
  if (!input.totalDebtFound) missing.push("total debt");
  if (!input.cashFound) missing.push("cash");
  if (!input.ebitdaFound) missing.push("EBITDA");
  if (!input.interestFound) missing.push("cash interest");
  const ambiguous =
    input.missingSources.length > 0
      ? ` Source not identified for ${input.missingSources.join(", ")}.`
      : "";
  if (missing.length > 0 || input.missingSources.length > 0) {
    const gap =
      missing.length > 0
        ? `Missing or not found in the extracted text: ${missing.join(", ")}.`
        : "Core amounts were found, but at least one source document was not identified.";
    return {
      id: "missing-information",
      label: "Missing or ambiguous information",
      status: "Review Required",
      detail: `${gap}${ambiguous} Empty fields were left blank rather than estimated.`,
    };
  }
  return {
    id: "missing-information",
    label: "Missing or ambiguous information",
    status: "Reported",
    detail:
      "Total debt, cash, EBITDA, and cash interest were found in the extracted text and each names a source. Other metrics remain n/a when the filing does not disclose them.",
  };
}

function leverageDefinitions(input: QualityInput): QualityCheck {
  if (input.leverageMultiple == null && input.reportedLeverageMultiple == null) {
    return {
      id: "leverage-definitions",
      label: "Reported versus calculated leverage",
      status: "Review Required",
      detail:
        "Neither a company-reported leverage ratio nor an independent leverage calculation was available.",
    };
  }
  if (input.leverageMultiple == null) {
    return {
      id: "leverage-definitions",
      label: "Reported versus calculated leverage",
      status: "Review Required",
      detail:
        "Only the company-reported leverage ratio is available. Independent leverage was not calculated, and the reported ratio may use a covenant definition.",
    };
  }
  if (input.reportedLeverageMultiple == null) {
    return {
      id: "leverage-definitions",
      label: "Reported versus calculated leverage",
      status: "Calculated",
      detail:
        "Missing company-reported leverage. Independent leverage was calculated from net debt and EBITDA. No company-reported ratio was found in the extracted text, so this is not a covenant leverage figure.",
    };
  }
  const gap = Math.abs(input.leverageMultiple - input.reportedLeverageMultiple);
  if (gap >= 0.1) {
    return {
      id: "leverage-definitions",
      label: "Reported versus calculated leverage",
      status: "Review Required",
      detail: `Company-reported leverage differs from independently calculated leverage by ${gap.toFixed(2)}x. The company figure may use a covenant definition. Both ratios are shown and neither replaces the other.`,
    };
  }
  return {
    id: "leverage-definitions",
    label: "Reported versus calculated leverage",
    status: "Calculated",
    detail:
      "Company-reported leverage and the independent calculation are within 0.10x. Both are shown because the definitions can still differ.",
  };
}

function maturitySchedule(schedule: DisclosedMaturitySchedule): QualityCheck {
  if (schedule.buckets && schedule.buckets.length >= 2) {
    return {
      id: "maturity-schedule",
      label: "Maturity schedule",
      status: "Reported",
      detail: schedule.message,
    };
  }
  return {
    id: "maturity-schedule",
    label: "Maturity schedule",
    status: "Review Required",
    detail: `${NOT_AVAILABLE} No disclosed debt maturity schedule with verified amounts was found. Maturities were not reconstructed from individual instruments.`,
  };
}
