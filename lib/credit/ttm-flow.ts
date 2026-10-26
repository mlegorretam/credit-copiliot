import {
  parseReportingDate,
  sourceDocumentAt,
  splitFinancialSegments,
  type ReportingDate,
} from "@/lib/credit/financial-segments";
import { parseNumericToken } from "@/lib/credit/excerpt-figures";
import { SCALE_FACTOR, type MoneyScale } from "@/lib/credit/format-money";
import type { SourcedAmount } from "@/lib/types/credit-analysis";

export type FlowMetric = "cash_interest" | "interest_expense" | "capex" | "operating_cash_flow";

type PeriodKind = "ttm" | "annual" | "six_month" | "nine_month" | "quarterly";

type Observation = {
  metric: FlowMetric;
  period: PeriodKind;
  absolute: number;
  scale: MoneyScale;
  reported: number;
  year: number;
  quarter: number | null;
  asOf: string;
  sourceDocument: string;
  label: string;
};

export type FlowTtm = {
  metric: FlowMetric;
  absolute: number;
  reported: number;
  scale: MoneyScale;
  sourceDocument: string;
  asOf: string;
  description: string;
  bridge: string;
  note: string;
  method: "stated" | "bridge" | "quarters";
};

const METRIC_LABEL: Record<FlowMetric, string> = {
  cash_interest: "cash interest",
  interest_expense: "interest expense",
  capex: "capital expenditures",
  operating_cash_flow: "operating cash flow",
};

/**
 * Build a trailing-twelve-month flow from an explicit TTM figure, from
 * fiscal year + current stub − prior stub, or from four consecutive quarters.
 * Partial periods are not annualized here.
 */
export function constructFlowTtm(
  excerpt: string,
  metric: FlowMetric,
  fileNames: string[],
): FlowTtm | null {
  const observations = collectObservations(excerpt, metric, fileNames);
  const stated = uniquePeriod(observations.filter((item) => item.period === "ttm"));
  if (stated) return presentStated(stated);
  const bridged = bridgeObservations(observations);
  if (bridged) return bridged;
  return quarterSum(observations);
}

function collectObservations(
  excerpt: string,
  metric: FlowMetric,
  fileNames: string[],
): Observation[] {
  const observations: Observation[] = [];
  for (const segment of splitFinancialSegments(excerpt)) {
    if (classifyMetric(segment) !== metric) continue;
    const period = detectPeriod(segment);
    const money = moneyIn(segment);
    const when = periodEnd(segment);
    if (!period || !money || !when) continue;
    observations.push({
      metric,
      period: period.kind,
      absolute: money.absolute,
      scale: money.scale,
      reported: money.reported,
      year: when.year,
      quarter: period.quarter,
      asOf: when.label,
      sourceDocument: sourceDocumentAt(excerpt, Math.max(0, excerpt.indexOf(segment)), fileNames),
      label: period.label,
    });
  }
  return observations;
}

function classifyMetric(segment: string): FlowMetric | null {
  if (/cash interest|interest paid/i.test(segment) && !/interest expense/i.test(segment)) {
    return "cash_interest";
  }
  if (/interest expense/i.test(segment)) return "interest_expense";
  if (/capital expenditures|\bcapex\b/i.test(segment)) return "capex";
  if (
    /cash flows? from operating activities|net cash provided by operating activities|operating cash flow/i.test(
      segment,
    )
  ) {
    return "operating_cash_flow";
  }
  return null;
}

function detectPeriod(
  segment: string,
): { kind: PeriodKind; quarter: number | null; label: string } | null {
  const interim = /six[- ]months?|nine[- ]months?|three[- ]months?|quarter/i.test(segment);
  const ttm = /trailing twelve|\bttm\b|\bltm\b/i.test(segment);
  if (ttm && interim) return null;
  if (ttm) return { kind: "ttm", quarter: null, label: "trailing twelve months" };
  if (/nine[- ]months?/i.test(segment)) return { kind: "nine_month", quarter: null, label: "nine months" };
  if (/six[- ]months?|first half|second half/i.test(segment)) {
    return { kind: "six_month", quarter: null, label: "six months" };
  }
  const quarter = segment.match(/\bQ([1-4])\s+(20\d{2})\b/i);
  if (quarter) {
    return {
      kind: "quarterly",
      quarter: Number(quarter[1]),
      label: `Q${quarter[1]} ${quarter[2]}`,
    };
  }
  if (/three[- ]months?|quarter ended/i.test(segment)) {
    return { kind: "quarterly", quarter: null, label: "quarter" };
  }
  if (/year ended|fiscal year|full[- ]year|\bannual\b/i.test(segment)) {
    return { kind: "annual", quarter: null, label: "fiscal year" };
  }
  return null;
}

function periodEnd(segment: string): (ReportingDate & { year: number }) | null {
  const explicit = segment.match(
    /\b(?:as of|ended)\s+((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+20\d{2})/i,
  );
  if (explicit) {
    const parsed = parseReportingDate(explicit[1]);
    if (!parsed) return null;
    return { ...parsed, year: Number(explicit[1].match(/20\d{2}/)?.[0]) };
  }
  const quarter = segment.match(/\bQ[1-4]\s+(20\d{2})\b/i);
  if (quarter) {
    const year = Number(quarter[1]);
    return { label: quarter[0], time: Date.UTC(year, 0, 1), year };
  }
  const yearOnly = segment.match(/\b(?:fiscal year|year ended|for)\s+(20\d{2})\b/i);
  if (yearOnly) {
    const year = Number(yearOnly[1]);
    return { label: yearOnly[1], time: Date.UTC(year, 11, 31), year };
  }
  return null;
}

function moneyIn(
  segment: string,
): { absolute: number; reported: number; scale: MoneyScale } | null {
  const match = segment.match(
    /\$?\s*(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)\s*(billion|million|thousand|billions|millions|thousands)\b/i,
  );
  if (!match) return null;
  const reported = parseNumericToken(match[1]);
  const scale = wordScale(match[2]);
  if (reported == null || !scale) return null;
  return { absolute: reported * SCALE_FACTOR[scale], reported, scale };
}

function wordScale(word: string): MoneyScale | null {
  const normalized = word.toLowerCase();
  if (normalized.startsWith("billion")) return "billions";
  if (normalized.startsWith("million")) return "millions";
  if (normalized.startsWith("thousand")) return "thousands";
  return null;
}

function uniquePeriod(items: Observation[]): Observation | null {
  if (items.length === 0) return null;
  const first = items[0];
  if (items.some((item) => !close(item.absolute, first.absolute))) return null;
  return first;
}

function bridgeObservations(observations: Observation[]): FlowTtm | null {
  const annuals = observations.filter((item) => item.period === "annual");
  const stubs = observations.filter(
    (item) => item.period === "six_month" || item.period === "nine_month",
  );
  let best: FlowTtm | null = null;
  for (const current of stubs) {
    const prior = stubs.find(
      (item) =>
        item.period === current.period &&
        item.year === current.year - 1 &&
        item !== current,
    );
    const fiscal = annuals.find((item) => item.year === current.year - 1);
    if (!prior || !fiscal) continue;
    const absolute = fiscal.absolute + current.absolute - prior.absolute;
    if (!(absolute > 0)) continue;
    const scale = sharedScale([fiscal, current, prior]) ?? "millions";
    const reported = absolute / SCALE_FACTOR[scale];
    const name = METRIC_LABEL[current.metric];
    const formula = `TTM ${name} = ${fiscal.label} ended ${fiscal.asOf} ${formatReported(fiscal)} + ${current.label} ended ${current.asOf} ${formatReported(current)} − ${prior.label} ended ${prior.asOf} ${formatReported(prior)} = ${formatAbsolute(absolute, scale)}.`;
    const candidate: FlowTtm = {
      metric: current.metric,
      absolute,
      reported,
      scale,
      sourceDocument: joinSources([fiscal, current, prior]),
      asOf: current.asOf,
      description: metricDescription(current.metric),
      bridge: formula,
      note: `${formula} This uses disclosed fiscal-year and year-to-date periods. It is not an annualized approximation.`,
      method: "bridge",
    };
    if (!best || current.year > Number(best.asOf.match(/20\d{2}/)?.[0] ?? 0)) best = candidate;
  }
  return best;
}

function quarterSum(observations: Observation[]): FlowTtm | null {
  const quarters = observations.filter(
    (item) => item.period === "quarterly" && item.quarter != null,
  );
  const byPeriod = new Map<number, Observation>();
  for (const item of quarters) {
    const key = item.year * 4 + (item.quarter ?? 1) - 1;
    if (!byPeriod.has(key)) byPeriod.set(key, item);
  }
  const ordered = [...byPeriod.entries()].sort((a, b) => a[0] - b[0]);
  let run: Observation[] = [];
  let previous = Number.NaN;
  let best: Observation[] | null = null;
  for (const [key, item] of ordered) {
    if (run.length === 0 || key === previous + 1) run.push(item);
    else run = [item];
    previous = key;
    if (run.length >= 4) best = run.slice(-4);
  }
  if (!best) return null;
  const scale = sharedScale(best);
  if (!scale) return null;
  const absolute = best.reduce((sum, item) => sum + item.absolute, 0);
  const parts = best.map((item) => `${item.label} ${formatReported(item)}`);
  const formula = `TTM ${METRIC_LABEL[best[0].metric]} = ${parts.join(" + ")} = ${formatAbsolute(absolute, "millions")}.`;
  const last = best[best.length - 1];
  return {
    metric: last.metric,
    absolute,
    reported: absolute / SCALE_FACTOR.millions,
    scale: "millions",
    sourceDocument: joinSources(best),
    asOf: last.asOf,
    description: metricDescription(last.metric),
    bridge: `Calculated as the sum of four consecutive quarters: ${formula}`,
    note: `${formula} No annualization was applied.`,
    method: "quarters",
  };
}

function presentStated(item: Observation): FlowTtm {
  return {
    metric: item.metric,
    absolute: item.absolute,
    reported: item.reported,
    scale: item.scale,
    sourceDocument: item.sourceDocument,
    asOf: item.asOf,
    description: metricDescription(item.metric),
    bridge: `The extracted text states trailing-twelve-month ${METRIC_LABEL[item.metric]} of ${formatReported(item)}.`,
    note: `Trailing-twelve-month ${METRIC_LABEL[item.metric]} was read from the extracted text. No annualization was applied.`,
    method: "stated",
  };
}

function metricDescription(metric: FlowMetric): string {
  switch (metric) {
    case "cash_interest":
      return "Cash interest";
    case "interest_expense":
      return "Interest expense";
    case "capex":
      return "Capital expenditures";
    case "operating_cash_flow":
      return "Operating cash flow";
  }
}

function sharedScale(items: Observation[]): MoneyScale | null {
  const scales = new Set(items.map((item) => item.scale));
  if (scales.size === 1) return items[0]?.scale ?? null;
  return "millions";
}

function joinSources(items: Observation[]): string {
  const names = [...new Set(items.map((item) => item.sourceDocument).filter(Boolean))];
  return names.join("; ");
}

function formatReported(item: Observation): string {
  return formatAbsolute(item.absolute, item.scale);
}

function formatAbsolute(absolute: number, scale: MoneyScale): string {
  const scaled = absolute / SCALE_FACTOR[scale];
  const body = scaled.toLocaleString("en-US", { maximumFractionDigits: 3 });
  const unit =
    scale === "thousands" ? " thousand" : scale === "millions" ? " million" : scale === "billions" ? " billion" : "";
  return `$${body}${unit}`;
}

function close(a: number, b: number): boolean {
  const base = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / base <= 0.005;
}

export function flowPeriodFromSegment(segment: string): SourcedAmount["period"] | null {
  const detected = detectPeriod(segment);
  return detected?.kind ?? null;
}
