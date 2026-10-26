import type { SourcedAmount } from "@/lib/types/credit-analysis";

export type ReportingPeriod = SourcedAmount["period"];

const TTM_RE = /trailing twelve|\bttm\b|\bltm\b/i;
const SIX_RE = /six[- ]months?|first half|second half/i;
const NINE_RE = /nine[- ]months?/i;
const QUARTER_RE = /three[- ]months?|\bquarterly\b|\bquarter\b/i;
const YTD_RE = /year[- ]to[- ]date|\bytd\b/i;

export function periodLabel(period: ReportingPeriod): string {
  switch (period) {
    case "ttm":
      return "Trailing twelve months";
    case "annual":
      return "Fiscal year";
    case "quarterly":
      return "Quarter";
    case "six_month":
      return "Six months";
    case "nine_month":
      return "Nine months";
    case "ytd":
      return "Year to date";
    case "point_in_time":
      return "Point in time";
    default:
      return "Period not identified";
  }
}

/**
 * When a structured TTM or annual tag conflicts with one interim description,
 * return that interim period. Ambiguous descriptions are not relabeled.
 */
export function descriptionPeriodOverride(
  description: string,
  period: ReportingPeriod,
): ReportingPeriod | null {
  if (period !== "ttm" && period !== "annual") return null;
  if (TTM_RE.test(description)) return null;
  const six = SIX_RE.test(description);
  const nine = NINE_RE.test(description);
  const quarter = QUARTER_RE.test(description);
  const ytd = YTD_RE.test(description);
  const hits = [six, nine, quarter, ytd].filter(Boolean).length;
  if (hits !== 1) return null;
  if (six) return "six_month";
  if (nine) return "nine_month";
  if (quarter) return "quarterly";
  return "ytd";
}

export function ambiguousPeriodLabel(
  description: string,
  period: ReportingPeriod,
): boolean {
  if (period !== "ttm" && period !== "annual") return false;
  if (TTM_RE.test(description)) return false;
  if (descriptionPeriodOverride(description, period)) return false;
  return SIX_RE.test(description) || NINE_RE.test(description) || QUARTER_RE.test(description) || YTD_RE.test(description);
}

export function textClaimsTtm(text: string): boolean {
  return TTM_RE.test(text);
}

export function textClaimsInterim(text: string): boolean {
  return SIX_RE.test(text) || NINE_RE.test(text) || QUARTER_RE.test(text) || YTD_RE.test(text);
}
