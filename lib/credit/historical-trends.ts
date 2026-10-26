import { sourceDocumentAt } from "@/lib/credit/financial-segments";
import {
  formatCompactAbsolute,
  formatMultiple,
  formatPercent,
  SCALE_FACTOR,
  type MoneyScale,
} from "@/lib/credit/format-money";
import { alignToColumns, lineScale, parseAmounts } from "@/lib/credit/table-amounts";
import { NOT_AVAILABLE } from "@/lib/types/credit-analysis";
import type {
  FinancialTrendRow,
  FinancialTrends,
  TrendCell,
} from "@/lib/types/credit-analysis";

type MetricId =
  | "revenue"
  | "operatingIncome"
  | "ebitda"
  | "segmentEbitda"
  | "operatingCashFlow"
  | "capex"
  | "interestExpense"
  | "totalDebt"
  | "cash";

type Observation = {
  id: MetricId;
  priority: number;
  definition: string;
  source: string;
  scale: MoneyScale;
  year: string;
  period: string;
  reported: number;
  absolute: number;
};

const MONTH =
  "January|February|March|April|May|June|July|August|September|October|November|December";

const TREND_NOTE =
  "Fiscal years are the years printed in the filing. The detail under each figure keeps the reported unit, definition, and source. Revenue growth, EBITDA margin, free cash flow, and net leverage are calculated only when the required inputs are available for the same year. Historical EBITDA is shown only when the filing states EBITDA or Adjusted EBITDA.";

export type VerifiedTrendAmount = {
  id: "ebitda" | "capex" | "totalDebt" | "cash";
  reported: number;
  scale: MoneyScale;
  absolute: number;
  year: string;
  period: string;
  definition: string;
  source: string;
};

export type AnnualStatementAmount = {
  reported: number;
  scale: MoneyScale;
  absolute: number;
  year: string;
  period: string;
  definition: string;
  source: string;
};

export type EbitdaReading = {
  year: string;
  absolute: number;
  reported: number;
  scale: MoneyScale;
  definition: string;
  source: string;
  period: string;
};

/**
 * Read comparative annual columns from consolidated financial statements.
 * Ratios are computed here. EBITDA is never derived from other lines.
 * Verified overview amounts fill a blank fiscal-year cell only when that year is still missing.
 */
export function extractFinancialTrends(
  excerpt: string,
  fileNames: string[],
  verified: VerifiedTrendAmount[] = [],
): FinancialTrends {
  return buildTrends(collectObservations(excerpt, fileNames), verified);
}

/**
 * Latest comparative annual amount for a statement line, used so Credit Overview
 * can reuse the same validated figure as Financial Trends.
 */
export function latestAnnualStatementAmount(
  excerpt: string,
  fileNames: string[],
  id: "capex" | "cash" | "totalDebt" | "interestExpense" | "revenue" | "operatingIncome" | "ebitda",
): AnnualStatementAmount | null {
  const selected = selectMetric(collectObservations(excerpt, fileNames), id, { current: false });
  if (!selected || selected.size === 0) return null;
  const years = [...selected.keys()].sort((left, right) => Number(left) - Number(right));
  const year = years[years.length - 1];
  const observation = year ? selected.get(year) : undefined;
  if (!observation || !year) return null;
  return {
    reported: observation.reported,
    scale: observation.scale,
    absolute: observation.absolute,
    year,
    period: observation.period,
    definition: observation.definition,
    source: observation.source,
  };
}

/**
 * Consolidated Adjusted EBITDA is the company total.
 * Reportable-segment subtotals stay separate so they are not used as that total.
 */
export function readEbitdaReadings(
  excerpt: string,
  fileNames: string[],
): { consolidated: EbitdaReading[]; segment: EbitdaReading[] } {
  const observations = collectObservations(excerpt, fileNames);
  const consolidatedMap = selectMetric(observations, "ebitda", { current: false });
  return {
    consolidated: consolidatedMap ? [...consolidatedMap.values()].map(toEbitdaReading) : [],
    segment: observations
      .filter((item) => item.id === "segmentEbitda")
      .map(toEbitdaReading),
  };
}

function collectObservations(excerpt: string, fileNames: string[]): Observation[] {
  const lines = splitLines(mergeWrappedLines(excerpt));
  const observations: Observation[] = [];
  let scale: { scale: MoneyScale; line: number } | null = null;
  let header: { years: string[]; periods: string[]; line: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index]?.text ?? "";
    const foundScale = lineScale(text);
    if (foundScale) scale = { scale: foundScale, line: index };

    const parsedHeader = readHeader(lines, index);
    if (parsedHeader) {
      header = { ...parsedHeader, line: index };
      continue;
    }
    if (!header || index - header.line > 70) continue;

    const labeled = labeledAmounts(text);
    if (!labeled) continue;
    const aligned = alignToColumns(labeled.amounts, header.years.length);
    if (!aligned) continue;
    const classified = classify(labeled.label);
    if (!classified) continue;

    const contextScale = scale && index - scale.line <= 80 ? scale.scale : null;
    const resolved = aligned.map((amount) => amount.explicitScale ?? contextScale);
    if (resolved.some((item) => item == null)) continue;
    const scales = new Set(resolved);
    if (scales.size !== 1) continue;
    const amountScale = resolved[0];
    if (!amountScale) continue;

    const source = sourceDocumentAt(excerpt, lines[index]?.index ?? 0, fileNames);
    header.years.forEach((year, column) => {
      const amount = aligned[column];
      if (!amount || !Number.isFinite(amount.reported)) return;
      observations.push({
        ...classified,
        source,
        scale: amountScale,
        year,
        period: header?.periods[column] || year,
        reported: amount.reported,
        absolute: amount.reported * SCALE_FACTOR[amountScale],
      });
    });
  }

  return observations;
}

function toEbitdaReading(observation: Observation): EbitdaReading {
  return {
    year: observation.year,
    absolute: observation.absolute,
    reported: observation.reported,
    scale: observation.scale,
    definition: observation.definition,
    source: observation.source,
    period: observation.period,
  };
}

function buildTrends(
  observations: Observation[],
  verified: VerifiedTrendAmount[],
): FinancialTrends {
  const ambiguous = { current: false };
  const revenue = selectMetric(observations, "revenue", ambiguous);
  const operatingIncome = selectMetric(observations, "operatingIncome", ambiguous);
  const ebitda = fillVerified(selectMetric(observations, "ebitda", ambiguous), verified, "ebitda");
  const operatingCashFlow = selectMetric(observations, "operatingCashFlow", ambiguous);
  const capex = fillVerified(selectMetric(observations, "capex", ambiguous), verified, "capex");
  const interestExpense = selectMetric(observations, "interestExpense", ambiguous);
  const totalDebt = fillVerified(selectMetric(observations, "totalDebt", ambiguous), verified, "totalDebt");
  const cash = fillVerified(selectMetric(observations, "cash", ambiguous), verified, "cash");

  const years = uniqueYears([
    revenue,
    operatingIncome,
    ebitda,
    operatingCashFlow,
    capex,
    interestExpense,
    totalDebt,
  ]);
  if (years.length === 0) {
    return { years: [], rows: [], note: NOT_AVAILABLE };
  }

  const rows: FinancialTrendRow[] = [
    reportedRow("revenue", "Revenue", years, revenue),
    {
      id: "revenueGrowth",
      label: "Revenue growth",
      cells: years.map((year) => growthCell(revenue, year)),
    },
    reportedRow("operatingIncome", "Operating income", years, operatingIncome),
    reportedRow("ebitda", ebitdaLabel(ebitda), years, ebitda),
    {
      id: "ebitdaMargin",
      label: "EBITDA margin",
      cells: years.map((year) => marginCell(ebitda, revenue, year)),
    },
    reportedRow("operatingCashFlow", "Operating cash flow", years, operatingCashFlow),
    reportedRow("capitalExpenditures", "Capital expenditures", years, capex),
    {
      id: "freeCashFlow",
      label: "Free cash flow",
      cells: years.map((year) => freeCashFlowCell(operatingCashFlow, capex, year)),
    },
    reportedRow("interestExpense", "Interest expense", years, interestExpense),
    reportedRow("totalDebt", "Total debt", years, totalDebt),
    {
      id: "netLeverage",
      label: "Net leverage",
      cells: years.map((year) => leverageCell(totalDebt, cash, ebitda, year)),
    },
  ];

  return {
    years,
    rows,
    note: ambiguous.current
      ? `${TREND_NOTE} A line was left blank when the excerpt contained more than one annual amount for it.`
      : TREND_NOTE,
  };
}

function reportedRow(
  id: FinancialTrendRow["id"],
  label: string,
  years: string[],
  values: Map<string, Observation> | null,
): FinancialTrendRow {
  return {
    id,
    label,
    cells: years.map((year) => reportedCell(values?.get(year))),
  };
}

function reportedCell(observation: Observation | undefined): TrendCell {
  if (!observation) return { display: "n/a", detail: "" };
  return {
    display: formatCompactAbsolute(observation.absolute),
    detail: sentence([
      "Reported",
      formatReported(observation.reported, observation.scale),
      observation.definition,
      observation.period,
      observation.source ? `Source: ${observation.source}` : "",
    ]),
  };
}

function growthCell(
  revenue: Map<string, Observation> | null,
  year: string,
): TrendCell {
  const priorYear = String(Number(year) - 1);
  const current = revenue?.get(year);
  const previous = revenue?.get(priorYear);
  if (!current || !previous || previous.absolute === 0) return { display: "n/a", detail: "" };
  if (!sameSource(current, previous) || !sameDefinition(current, previous)) {
    return { display: "n/a", detail: "" };
  }
  const growth =
    ((current.absolute - previous.absolute) / Math.abs(previous.absolute)) * 100;
  return {
    display: formatPercent(growth),
    detail: sentence([
      "Calculated",
      `Revenue growth versus ${priorYear}`,
      `(${formatCompactAbsolute(current.absolute)} − ${formatCompactAbsolute(previous.absolute)}) / ${formatCompactAbsolute(Math.abs(previous.absolute))}`,
      current.definition,
      current.source ? `Source: ${current.source}` : "",
    ]),
  };
}

function marginCell(
  ebitda: Map<string, Observation> | null,
  revenue: Map<string, Observation> | null,
  year: string,
): TrendCell {
  const earnings = ebitda?.get(year);
  const sales = revenue?.get(year);
  if (!earnings || !sales || sales.absolute === 0) return { display: "n/a", detail: "" };
  if (!sameSource(earnings, sales)) return { display: "n/a", detail: "" };
  const margin = (earnings.absolute / sales.absolute) * 100;
  return {
    display: formatPercent(margin),
    detail: sentence([
      "Calculated",
      `${earnings.definition} / ${sales.definition}`,
      `${formatCompactAbsolute(earnings.absolute)} / ${formatCompactAbsolute(sales.absolute)}`,
      earnings.period,
      earnings.source ? `Source: ${earnings.source}` : "",
    ]),
  };
}

function freeCashFlowCell(
  cashFlow: Map<string, Observation> | null,
  capex: Map<string, Observation> | null,
  year: string,
): TrendCell {
  const operating = cashFlow?.get(year);
  const spending = capex?.get(year);
  if (!operating || !spending) return { display: "n/a", detail: "" };
  if (!sameSource(operating, spending)) return { display: "n/a", detail: "" };
  const outflow = spending.absolute < 0 ? -spending.absolute : spending.absolute;
  const freeCashFlow = operating.absolute - outflow;
  return {
    display: formatCompactAbsolute(freeCashFlow),
    detail: sentence([
      "Calculated",
      "Operating cash flow minus capital expenditures",
      `${formatCompactAbsolute(operating.absolute)} − ${formatCompactAbsolute(outflow)}`,
      `${operating.definition}; ${spending.definition}`,
      operating.period,
      operating.source ? `Source: ${operating.source}` : "",
    ]),
  };
}

function leverageCell(
  debt: Map<string, Observation> | null,
  cash: Map<string, Observation> | null,
  ebitda: Map<string, Observation> | null,
  year: string,
): TrendCell {
  const debtAmount = debt?.get(year);
  const cashAmount = cash?.get(year);
  const earnings = ebitda?.get(year);
  if (!debtAmount || !cashAmount || !earnings || earnings.absolute === 0) {
    return { display: "n/a", detail: "" };
  }
  const sources = [debtAmount.source, cashAmount.source, earnings.source].filter(Boolean);
  if (new Set(sources).size > 1) return { display: "n/a", detail: "" };
  const multiple = (debtAmount.absolute - cashAmount.absolute) / earnings.absolute;
  return {
    display: formatMultiple(multiple),
    detail: sentence([
      "Calculated",
      `(Total debt − cash) / ${earnings.definition} for ${year}`,
      `${formatCompactAbsolute(debtAmount.absolute)} − ${formatCompactAbsolute(cashAmount.absolute)}, divided by ${formatCompactAbsolute(earnings.absolute)}`,
      "This is not a company-reported covenant ratio",
      debtAmount.source ? `Source: ${debtAmount.source}` : "",
    ]),
  };
}

function selectMetric(
  observations: Observation[],
  id: MetricId,
  ambiguous: { current: boolean },
): Map<string, Observation> | null {
  const rows = observations.filter((item) => item.id === id);
  if (rows.length === 0) return new Map();
  const best = Math.min(...rows.map((item) => item.priority));
  const chosen = rows.filter((item) => item.priority === best);
  const byYear = new Map<string, Observation>();
  for (const row of chosen) {
    const existing = byYear.get(row.year);
    if (!existing) {
      byYear.set(row.year, row);
      continue;
    }
    const base = Math.max(Math.abs(existing.absolute), Math.abs(row.absolute), 1);
    if (Math.abs(existing.absolute - row.absolute) / base > 0.001 || !sameDefinition(existing, row)) {
      if (
        sameDefinition(existing, row) &&
        Math.abs(Math.abs(existing.absolute) - Math.abs(row.absolute)) / base <= 0.001
      ) {
        continue;
      }
      ambiguous.current = true;
      return null;
    }
  }
  return byYear;
}

function classify(
  label: string,
): { id: MetricId; priority: number; definition: string } | null {
  const definition = label.replace(/\s+/g, " ").trim();
  const text = definition
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.length > 90) return null;
  if (/per share|weighted average|shares outstanding/.test(text)) return null;
  if (/carryforward|deferred tax|valuation allowance|net operating loss/.test(text)) return null;

  if (/^total (?:net )?revenues?$/.test(text)) {
    return { id: "revenue", priority: 1, definition };
  }
  if (/^(?:net )?revenues?$/.test(text)) {
    return { id: "revenue", priority: 2, definition };
  }
  if (
    /^(?:operating income|operating loss|income from operations|loss from operations|operating profit)$/.test(
      text,
    )
  ) {
    return { id: "operatingIncome", priority: 1, definition };
  }
  if (/\bebitda\b/.test(text)) {
    if (/margin|per share/.test(text)) return null;
    if (/segment|reportable/.test(text)) {
      return { id: "segmentEbitda", priority: 1, definition };
    }
    if (/^(?:total |consolidated )?adjusted ebitda$/.test(text)) {
      return { id: "ebitda", priority: 1, definition };
    }
    if (/^(?:total |consolidated )?ebitda$/.test(text)) {
      return { id: "ebitda", priority: 2, definition };
    }
    return null;
  }
  if (
    text === "net cash provided by operating activities" ||
    text === "net cash from operating activities" ||
    text === "net cash used in operating activities" ||
    text === "cash provided by operating activities" ||
    text === "cash flows from operating activities" ||
    text === "operating cash flow"
  ) {
    return { id: "operatingCashFlow", priority: 1, definition };
  }
  if (/^capital expenditures?$/.test(text)) {
    return { id: "capex", priority: 1, definition };
  }
  if (/purchases of property|purchase of property|additions to property/.test(text)) {
    if (/proceeds|sale of|accounts payable|accrued|commitment/.test(text)) return null;
    return { id: "capex", priority: 2, definition };
  }
  if (
    /^interest expense(?: net)?$/.test(text) ||
    /^interest expense net of (?:interest )?capitalized$/.test(text)
  ) {
    return { id: "interestExpense", priority: 1, definition };
  }
  if (
    /^interest expense\b/.test(text) &&
    !/cash|paid|income|lease|carryforward/.test(text) &&
    (!/capitalized/.test(text) || /net of (?:interest )?capitalized/.test(text))
  ) {
    return { id: "interestExpense", priority: 2, definition };
  }
  if (text === "total debt") return { id: "totalDebt", priority: 1, definition };
  if (text === "total borrowings") return { id: "totalDebt", priority: 2, definition };
  if (text === "total long term debt") return { id: "totalDebt", priority: 3, definition };
  if (text === "cash and cash equivalents") return { id: "cash", priority: 1, definition };
  if (text === "cash") return { id: "cash", priority: 2, definition };
  return null;
}

function readHeader(
  lines: Array<{ text: string }>,
  index: number,
): { years: string[]; periods: string[] } | null {
  const current = lines[index]?.text.trim() ?? "";
  if (!current || current.length > 180) return null;
  const years = uniqueYearTokens(current);
  if (years.length < 2 || years.length > 4) return null;
  if (parseAmounts(current, { bare: false }).length > 0) return null;
  if (!yearHeaderLine(current)) return null;
  const window = lines
    .slice(Math.max(0, index - 3), index + 1)
    .map((line) => line.text)
    .join(" ");
  if (!isAnnualContext(window)) return null;
  return {
    years,
    periods: years.map((year) => periodFor(window, year)),
  };
}

function isAnnualContext(window: string): boolean {
  const interim =
    /three months|six months|nine months|quarter ended|quarters ended|three-month|six-month|nine-month/i.test(
      window,
    );
  const annual = /years?\s+ended|fiscal\s+years?|twelve months ended/i.test(window);
  if (interim) return false;
  if (annual) return true;
  if (new RegExp(`\\b(?:${MONTH})\\s+\\d{1,2},\\s+20\\d{2}`, "i").test(window)) return true;
  return (
    new RegExp(`\\b(?:${MONTH})\\s+\\d{1,2}\\b`, "i").test(window) &&
    /\b20\d{2}\b/.test(window) &&
    !/\b(?:change|percent|percentage|currency)\b/i.test(window)
  );
}

function periodFor(window: string, year: string): string {
  const exact = window.match(
    new RegExp(`\\b(${MONTH})\\s+(\\d{1,2}),\\s+${year}\\b`, "i"),
  );
  if (exact) {
    const date = `${titleCase(exact[1] ?? "")} ${Number(exact[2])}, ${year}`;
    if (/years?\s+ended/i.test(window)) return `Year ended ${date}`;
    if (/\bas of\b/i.test(window)) return `As of ${date}`;
    return date;
  }
  const shared = window.match(new RegExp(`\\b(${MONTH})\\s+(\\d{1,2})\\b`, "i"));
  if (shared && /years?\s+ended/i.test(window)) {
    return `Year ended ${titleCase(shared[1] ?? "")} ${Number(shared[2])}, ${year}`;
  }
  if (shared) {
    return `As of ${titleCase(shared[1] ?? "")} ${Number(shared[2])}, ${year}`;
  }
  if (/years?\s+ended/i.test(window)) return `Year ended ${year}`;
  return year;
}

function labeledAmounts(
  line: string,
): { label: string; amounts: ReturnType<typeof parseAmounts> } | null {
  const cleaned = withoutNarrativeParentheses(line);
  const amounts = parseAmounts(cleaned, { bare: true });
  if (amounts.length === 0) return null;
  const label = cleaned.slice(0, amounts[0]?.index ?? 0).trim();
  if (!/[A-Za-z]/.test(label) || label.length > 100) return null;
  return { label, amounts };
}

function fillVerified(
  values: Map<string, Observation> | null,
  verified: VerifiedTrendAmount[],
  id: VerifiedTrendAmount["id"],
): Map<string, Observation> | null {
  if (!values) return null;
  const existing = [...values.values()][0];
  for (const item of verified) {
    if (item.id !== id || values.has(item.year)) continue;
    if (!/^\d{4}$/.test(item.year) || !Number.isFinite(item.absolute)) continue;
    if (existing && normalize(existing.definition) !== normalize(item.definition)) continue;
    values.set(item.year, {
      id,
      priority: 1,
      definition: item.definition,
      source: item.source,
      scale: item.scale,
      year: item.year,
      period: item.period,
      reported: item.reported,
      absolute: item.absolute,
    });
  }
  return values;
}

function yearHeaderLine(line: string): boolean {
  if (new RegExp(`\\b(?:${MONTH})\\b`, "i").test(line)) return true;
  const residue = line
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/\b(?:fy|fiscal)\b/gi, " ")
    .replace(/[^A-Za-z]+/g, " ")
    .trim();
  return residue.length === 0;
}

function withoutNarrativeParentheses(line: string): string {
  let result = "";
  let depth = 0;
  let buffer = "";
  for (const char of line) {
    if (char === "(") {
      buffer = depth === 0 ? "(" : `${buffer}(`;
      depth += 1;
      continue;
    }
    if (char === ")" && depth > 0) {
      buffer += ")";
      depth -= 1;
      if (depth === 0) {
        result += /[A-Za-z]/.test(buffer) ? " " : buffer;
        buffer = "";
      }
      continue;
    }
    if (depth > 0) buffer += char;
    else result += char;
  }
  return result + buffer;
}

function mergeWrappedLines(excerpt: string): string {
  const source = excerpt.split("\n");
  const merged: string[] = [];
  let index = 0;
  while (index < source.length) {
    let current = source[index] ?? "";
    let added = 0;
    while (parenDepth(current) > 0 && index + 1 < source.length && added < 2) {
      const next = source[index + 1] ?? "";
      if (next.includes("===== DOCUMENT")) break;
      index += 1;
      added += 1;
      current = `${current} ${next.trim()}`;
    }
    merged.push(current);
    index += 1;
  }
  return merged.join("\n");
}

function parenDepth(text: string): number {
  let depth = 0;
  for (const char of text) {
    if (char === "(") depth += 1;
    else if (char === ")" && depth > 0) depth -= 1;
  }
  return depth;
}

function uniqueYears(groups: Array<Map<string, Observation> | null>): string[] {
  const years = new Set<string>();
  for (const group of groups) {
    if (!group) continue;
    for (const year of group.keys()) years.add(year);
  }
  return [...years].sort((left, right) => Number(left) - Number(right));
}

function uniqueYearTokens(line: string): string[] {
  const years: string[] = [];
  for (const match of line.matchAll(/\b(19\d{2}|20\d{2})\b/g)) {
    const year = match[1];
    if (!year || years.includes(year)) continue;
    const value = Number(year);
    if (value < 1995 || value > 2036) continue;
    years.push(year);
  }
  return years;
}

function ebitdaLabel(values: Map<string, Observation> | null): string {
  if (!values || values.size === 0) return "EBITDA / Adjusted EBITDA";
  const definitions = [...values.values()].map((item) => item.definition.toLowerCase());
  if (definitions.every((definition) => definition.includes("adjusted"))) return "Adjusted EBITDA";
  if (definitions.every((definition) => !definition.includes("adjusted"))) return "EBITDA";
  return "EBITDA / Adjusted EBITDA";
}

function sameSource(left: Observation, right: Observation): boolean {
  if (!left.source || !right.source) return left.source === right.source;
  return left.source === right.source;
}

function sameDefinition(left: Observation, right: Observation): boolean {
  return normalize(left.definition) === normalize(right.definition);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function formatReported(reported: number, scale: MoneyScale): string {
  const sign = reported < 0 ? "-" : "";
  const text = Math.abs(reported).toLocaleString("en-US", { maximumFractionDigits: 3 });
  return `${sign}${text} ${scaleWord(scale)}`;
}

function scaleWord(scale: MoneyScale): string {
  if (scale === "thousands") return "thousand";
  if (scale === "millions") return "million";
  if (scale === "billions") return "billion";
  return "units";
}

function sentence(parts: string[]): string {
  const text = parts
    .map((part) => part.trim().replace(/\.+$/, ""))
    .filter(Boolean)
    .join(". ");
  return text ? `${text}.` : "";
}

function titleCase(value: string): string {
  if (!value) return value;
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1).toLowerCase()}`;
}

function splitLines(excerpt: string): Array<{ text: string; index: number }> {
  const lines: Array<{ text: string; index: number }> = [];
  let index = 0;
  for (const text of excerpt.split("\n")) {
    lines.push({ text, index });
    index += text.length + 1;
  }
  return lines;
}
