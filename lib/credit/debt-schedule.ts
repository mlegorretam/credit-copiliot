import {
  latestReportingDate,
  reportingDatesIn,
  sourceDocumentAt,
  splitFinancialSegments,
  type ReportingDate,
} from "@/lib/credit/financial-segments";
import { numericVariants, parseNumericToken } from "@/lib/credit/excerpt-figures";
import { SCALE_FACTOR, type MoneyScale } from "@/lib/credit/format-money";
import { escapeRegExp } from "@/lib/credit/excerpt-figures";

export type DebtKind = "outstanding" | "undrawn" | "historical";
export type AmountBasis = "principal" | "carrying" | "unlabeled";

export type ParsedInstrument = {
  name: string;
  principal: number | null;
  carrying: number | null;
  unlabeled: number | null;
  basis: AmountBasis;
  rateText: string;
  rateType: "fixed" | "floating" | "mixed" | "not_disclosed";
  coupon: number | null;
  allIn: boolean;
  maturityText: string;
  maturityYear: number | null;
  secured: "Secured" | "Unsecured" | "Not disclosed";
  kind: DebtKind;
  reportingDate: string;
  sourceDocument: string;
  rowText: string;
};

const INSTRUMENT_RE =
  /\b(?:senior notes|senior note|term loan|revolving credit|credit facility|debentures?|mortgage notes?|notes due|bonds due)\b/i;
const NEXT_INSTRUMENT_RE =
  /\b(?:senior notes|senior note|term loan|revolving credit|credit facility|debentures?|mortgage notes?|notes due|bonds due)\b/gi;
const GENERIC_TOKENS = new Set([
  "senior",
  "notes",
  "note",
  "loan",
  "loans",
  "credit",
  "facility",
  "revolving",
  "revolver",
  "term",
  "unsecured",
  "secured",
  "bonds",
  "bond",
  "debentures",
  "mortgage",
  "other",
  "debt",
  "tranche",
  "borrowings",
]);

const SCALE_RE =
  /(?:\(\s*\$?\s*in\s+(thousands|millions|billions)\s*\)|\$\s*in\s+(thousands|millions|billions)|in\s+(000s|thousands|millions|billions))/gi;

/**
 * Read debt rows from the excerpt. Each row keeps only the amount, rate,
 * and maturity printed on that row.
 */
export function parseDebtInstruments(
  excerpt: string,
  fileNames: string[],
): ParsedInstrument[] {
  const rows: ParsedInstrument[] = [];
  const seen = new Set<string>();
  const segments = splitFinancialSegments(excerpt);
  let scaleContext: MoneyScale | null = null;
  let dateContext = "";
  let tableBasis: AmountBasis | null = null;
  let columnDates: ReportingDate[] = [];

  for (const segment of segments) {
    const scale = trailingScale(segment);
    if (scale) scaleContext = scale;
    const dated = latestReportingDate(segment);
    if (dated) dateContext = dated.label;
    const headerDates = reportingDatesIn(segment);
    if (headerDates.length >= 2) columnDates = headerDates;
    if (/principal/i.test(segment) && /carrying/i.test(segment)) tableBasis = "principal";
    else if (/\bcarrying (?:amount|value)\b/i.test(segment) && !/\bprincipal\b/i.test(segment)) {
      tableBasis = "carrying";
    }

    if (!INSTRUMENT_RE.test(segment)) continue;
    if (isTotalLine(segment)) continue;
    if (isMaturityBucket(segment)) continue;
    const parsed = parseRow(segment, {
      scaleContext,
      dateContext,
      tableBasis,
      columnDates,
      sourceDocument: sourceDocumentAt(excerpt, excerpt.indexOf(segment), fileNames),
    });
    if (!parsed) continue;
    const key = `${parsed.name.toLowerCase()}|${parsed.kind}|${parsed.principal ?? ""}|${parsed.carrying ?? ""}|${parsed.unlabeled ?? ""}|${parsed.reportingDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(parsed);
  }
  return rows;
}

export function segmentForInstrument(excerpt: string, name: string): string | null {
  const segments = splitFinancialSegments(excerpt);
  const needle = name.trim().toLowerCase();
  if (needle.length >= 4) {
    const exact = segments.find((segment) => segment.toLowerCase().includes(needle));
    if (exact) return exact;
  }
  const tokens = distinctiveTokens(name);
  if (tokens.length === 0) return null;
  let best: { segment: string; score: number } | null = null;
  for (const segment of segments) {
    if (!INSTRUMENT_RE.test(segment)) continue;
    const lower = segment.toLowerCase();
    const score = tokens.filter((token) => lower.includes(token.toLowerCase())).length;
    if (!best || score > best.score) best = { segment, score };
  }
  if (!best || best.score < Math.min(2, tokens.length)) return null;
  return best.segment;
}

/** True when the amount sits on the same row as the instrument, before the next instrument. */
export function amountTiedToInstrument(
  excerpt: string,
  name: string,
  rawAmount: string,
): boolean {
  const segment = segmentForInstrument(excerpt, name);
  if (!segment) return false;
  const variants = numericVariants(rawAmount);
  const lower = segment.toLowerCase();
  const nameLower = name.trim().toLowerCase();
  const origin = lower.includes(nameLower) ? lower.indexOf(nameLower) : 0;
  const nameLength = lower.includes(nameLower) ? nameLower.length : 0;
  for (const variant of variants) {
    const pattern = new RegExp(`(?<![\\d.])${escapeRegExp(variant)}(?![\\d.])`, "ig");
    for (const match of segment.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index < origin) continue;
      const between = segment.slice(origin + nameLength, index);
      if (hasAnotherInstrument(between)) continue;
      return true;
    }
  }
  return false;
}

export function textTiedToInstrument(
  excerpt: string,
  name: string,
  raw: string,
): boolean {
  const segment = segmentForInstrument(excerpt, name);
  if (!segment || !raw.trim()) return false;
  return segment.toLowerCase().includes(raw.trim().toLowerCase());
}

function parseRow(
  segment: string,
  context: {
    scaleContext: MoneyScale | null;
    dateContext: string;
    tableBasis: AmountBasis | null;
    columnDates: ReportingDate[];
    sourceDocument: string;
  },
): ParsedInstrument | null {
  const kind = rowKind(segment);
  const name = instrumentName(segment);
  if (!name) return null;
  const reportedDate = latestReportingDate(segment);
  const maturityYear = maturityYearIn(name) ?? maturityYearIn(segment.slice(0, name.length + 40));
  const rate = rateIn(segment);
  const secured = securityIn(segment);
  const labeledPrincipal = labeledAmount(segment, /principal(?:\s+amount|\s+outstanding)?/i);
  const labeledCarrying = labeledAmount(segment, /carrying\s+(?:amount|value)/i);
  const bare = labeledPrincipal || labeledCarrying ? [] : rowAmounts(segment, context.scaleContext);
  const principal = labeledPrincipal ?? columnAmount(bare, context, "principal");
  const carrying = labeledCarrying ?? columnAmount(bare, context, "carrying");
  const unlabeled =
    principal || carrying ? null : bare.length === 1 ? bare[0] : columnAmount(bare, context, "single");

  if (kind === "outstanding" && !principal && !carrying && !unlabeled) return null;
  if (kind !== "outstanding" && !principal && !carrying && !unlabeled && kind !== "undrawn") {
    return null;
  }

  let basis: AmountBasis = "unlabeled";
  if (principal) basis = "principal";
  else if (carrying && !unlabeled) basis = "carrying";
  else if (context.tableBasis === "carrying" && !principal) basis = "carrying";
  else if (context.tableBasis === "principal" && unlabeled) basis = "principal";

  const principalAbsolute = principal
    ? principal.absolute
    : basis === "principal" && unlabeled
      ? unlabeled.absolute
      : null;
  const carryingAbsolute = carrying
    ? carrying.absolute
    : basis === "carrying" && unlabeled
      ? unlabeled.absolute
      : null;
  const unlabeledAbsolute =
    basis === "unlabeled" ? (unlabeled?.absolute ?? null) : null;

  return {
    name,
    principal: kind === "outstanding" ? principalAbsolute : null,
    carrying: kind === "outstanding" ? carryingAbsolute : null,
    unlabeled: kind === "outstanding" ? unlabeledAbsolute : null,
    basis: kind === "outstanding" ? basis : "unlabeled",
    rateText: rate.rateText,
    rateType: rate.rateType,
    coupon: rate.coupon,
    allIn: rate.allIn,
    maturityText: maturityYear ? `due ${maturityYear}` : "Not disclosed",
    maturityYear,
    secured,
    kind,
    reportingDate: reportedDate?.label || context.dateContext,
    sourceDocument: context.sourceDocument,
    rowText: segment,
  };
}

function rowKind(segment: string): DebtKind {
  const historical =
    /\b(?:issued|issuance|offering|sold)\b/i.test(segment) &&
    !/\b(?:principal|outstanding|carrying)\b/i.test(segment);
  if (historical) return "historical";
  if (/\b(?:undrawn|unused|availability|available capacity|remaining capacity)\b/i.test(segment)) {
    return "undrawn";
  }
  return "outstanding";
}

function instrumentName(segment: string): string | null {
  const withoutAmounts = segment
    .replace(/\$\s*[\d,]+(?:\.\d+)?(?:\s*(?:billion|million|thousand)s?)?/gi, " ")
    .replace(/(?<![\d.%])\d{1,3}(?:,\d{3})+(?:\.\d+)?(?!\s*%)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const match = withoutAmounts.match(
    /((?:\d+(?:\.\d+)?%\s+)?(?:senior\s+)?(?:secured\s+|unsecured\s+)?(?:notes?|term loan|revolving credit(?:\s+facility)?|credit facility|debentures?|mortgage notes?|bonds?)(?:\s+due\s+(?:[A-Za-z]+\s+\d{1,2},\s+)?20\d{2})?)/i,
  );
  if (!match) return null;
  return match[1].replace(/\s+/g, " ").trim();
}

function maturityYearIn(text: string): number | null {
  const match = text.match(/\bdue\s+(?:[A-Za-z]+\s+\d{1,2},\s+)?(20\d{2})\b/i);
  if (!match) return null;
  const year = Number(match[1]);
  if (year < 1990 || year > 2100) return null;
  return year;
}

function rateIn(segment: string): {
  rateText: string;
  rateType: ParsedInstrument["rateType"];
  coupon: number | null;
  allIn: boolean;
} {
  const floating = /\b(?:floating|variable|sofr|libor|bsby|sonia)\b/i.test(segment);
  const percent = segment.match(/(?<![\d.])(\d+(?:\.\d+)?)\s*(?:%|percent)\b/i);
  const allIn = /\ball-in\b|\beffective rate\b|\bweighted average\b/i.test(segment);
  if (floating && percent && !allIn) {
    return {
      rateText: segment.match(/(?:sofr|libor|bsby|sonia)[^.]{0,24}/i)?.[0]?.trim() || "Floating",
      rateType: "floating",
      coupon: null,
      allIn: false,
    };
  }
  if (floating && percent && allIn) {
    return {
      rateText: `${percent[1]}%`,
      rateType: "floating",
      coupon: Number(percent[1]),
      allIn: true,
    };
  }
  if (floating) {
    return { rateText: "Floating", rateType: "floating", coupon: null, allIn: false };
  }
  if (percent) {
    return {
      rateText: `${percent[1]}%`,
      rateType: "fixed",
      coupon: Number(percent[1]),
      allIn: true,
    };
  }
  return { rateText: "", rateType: "not_disclosed", coupon: null, allIn: false };
}

function securityIn(segment: string): ParsedInstrument["secured"] {
  if (/\bunsecured\b/i.test(segment)) return "Unsecured";
  if (/\bsecured\b/i.test(segment)) return "Secured";
  return "Not disclosed";
}

function labeledAmount(
  segment: string,
  label: RegExp,
): { absolute: number } | null {
  const match = segment.match(label);
  if (!match || match.index == null) return null;
  const after = segment.slice(match.index + match[0].length);
  const money = after.match(
    /^\s*(?:of\s*)?\$?\s*([\d,]+(?:\.\d+)?)\s*(billion|million|thousand|billions|millions|thousands)?/i,
  );
  if (!money) return null;
  const reported = parseNumericToken(money[1]);
  const scale = wordScale(money[2] ?? "");
  if (reported == null || !scale) return null;
  return { absolute: reported * SCALE_FACTOR[scale] };
}

function rowAmounts(segment: string, scaleContext: MoneyScale | null): Array<{ absolute: number }> {
  const found: Array<{ absolute: number }> = [];
  const dollar = /\$\s*([\d,]+(?:\.\d+)?)(?:\s*(billion|million|thousand|billions|millions|thousands))?/gi;
  for (const match of segment.matchAll(dollar)) {
    const reported = parseNumericToken(match[1]);
    const scale = wordScale(match[2] ?? "") ?? scaleContext;
    if (reported == null || !scale) continue;
    found.push({ absolute: reported * SCALE_FACTOR[scale] });
  }
  if (found.length > 0 || !scaleContext) return found;
  const barePattern = /(?<![\d.])([\d,]{3,}(?:\.\d+)?)(?![\d.])/g;
  for (const match of segment.matchAll(barePattern)) {
    const index = match.index ?? 0;
    const before = segment.slice(Math.max(0, index - 12), index).toLowerCase();
    if (/\bdue\s+$/.test(before) || before.includes("%")) continue;
    const reported = parseNumericToken(match[1]);
    if (reported == null) continue;
    if (reported >= 1990 && reported <= 2100 && !match[1].includes(",")) continue;
    found.push({ absolute: reported * SCALE_FACTOR[scaleContext] });
  }
  return found;
}

function columnAmount(
  amounts: Array<{ absolute: number }>,
  context: { tableBasis: AmountBasis | null; columnDates: ReportingDate[] },
  role: "principal" | "carrying" | "single",
): { absolute: number } | null {
  if (amounts.length === 0) return null;
  const laterIndex =
    context.columnDates.length >= 2 &&
    context.columnDates[1] &&
    context.columnDates[0] &&
    context.columnDates[1].time > context.columnDates[0].time
      ? 1
      : 0;
  const pairStart = context.columnDates.length >= 2 ? laterIndex * 2 : 0;
  if (role === "principal" && context.tableBasis === "principal") {
    return amounts[pairStart] ?? null;
  }
  if (role === "carrying" && context.tableBasis === "principal") {
    return amounts[pairStart + 1] ?? null;
  }
  if (role === "carrying" && context.tableBasis === "carrying") {
    return amounts[laterIndex] ?? null;
  }
  if (role === "single") return amounts[laterIndex] ?? amounts[0] ?? null;
  return null;
}

function trailingScale(segment: string): MoneyScale | null {
  const matches = [...segment.matchAll(SCALE_RE)];
  const match = matches[matches.length - 1];
  if (!match) return null;
  const word = match.slice(1).find((part) => part);
  return word ? wordScale(word) : null;
}

function wordScale(word: string): MoneyScale | null {
  const normalized = word.toLowerCase();
  if (!normalized) return null;
  if (normalized === "000s" || normalized.startsWith("thousand")) return "thousands";
  if (normalized.startsWith("billion")) return "billions";
  if (normalized.startsWith("million")) return "millions";
  return null;
}

function isTotalLine(segment: string): boolean {
  return /^\s*total\b/i.test(segment.trim());
}

function isMaturityBucket(segment: string): boolean {
  return /^\s*(?:20\d{2}|thereafter)\b/i.test(segment.trim());
}

function hasAnotherInstrument(between: string): boolean {
  NEXT_INSTRUMENT_RE.lastIndex = 0;
  return NEXT_INSTRUMENT_RE.test(between);
}

function distinctiveTokens(name: string): string[] {
  const tokens = name.match(/\d+(?:\.\d+)?%?|\d{4}|[A-Za-z]{5,}/g) ?? [];
  return tokens.filter((token) => !GENERIC_TOKENS.has(token.toLowerCase()));
}
