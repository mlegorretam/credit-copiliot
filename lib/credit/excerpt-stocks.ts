import {
  latestReportingDate,
  sourceDocumentAt,
  splitFinancialSegments,
} from "@/lib/credit/financial-segments";
import { parseNumericToken } from "@/lib/credit/excerpt-figures";
import { SCALE_FACTOR, type MoneyScale } from "@/lib/credit/format-money";

export type ExcerptStock = {
  absolute: number;
  reported: number;
  scale: Exclude<MoneyScale, "ones">;
  asOf: string;
  asOfTime: number | null;
  sourceDocument: string;
  description: string;
};

export function extractTotalDebt(excerpt: string, fileNames: string[]): ExcerptStock | null {
  const explicit = stocksMatching(excerpt, fileNames, (segment) => {
    if (!/\btotal debt\b|\btotal borrowings\b/i.test(segment)) return false;
    if (/\bnet debt\b/i.test(segment) && !/\btotal debt\b/i.test(segment)) return false;
    return true;
  }, "Total debt");
  const picked = pickStock(explicit);
  if (picked) return picked;
  return sumDebtComponents(excerpt, fileNames);
}

export function extractCash(excerpt: string, fileNames: string[]): ExcerptStock | null {
  const found: ExcerptStock[] = [];
  for (const segment of splitFinancialSegments(excerpt)) {
    if (/cash interest|cash flow|cash paid|cash provided|operating cash/i.test(segment)) {
      continue;
    }
    if (!/\bcash and cash equivalents\b|\bcash\b/i.test(segment)) continue;
    if (liquidityTotalIn(segment) && /\b(?:undrawn|unused)\b/i.test(segment)) continue;
    const equivalents = amountNearest(segment, /cash and cash equivalents(?:\s+of)?/i, {
      after: true,
    });
    const standalone =
      /^(?:cash\b|cash and cash equivalents\b)|(?:cash of\b|cash:?\s*\$)/i.test(segment.trim());
    if (!equivalents && !standalone) continue;
    const money = equivalents ?? amountNearest(segment, /\bcash\b/i, { after: true });
    if (!money) continue;
    const liquidityTotal = liquidityTotalIn(segment);
    if (liquidityTotal && close(money.absolute, liquidityTotal.absolute)) continue;
    found.push(
      toStock(
        excerpt,
        fileNames,
        segment,
        money,
        equivalents ? "Cash and cash equivalents" : "Cash",
      ),
    );
  }
  const named = found.filter((item) => item.description === "Cash and cash equivalents");
  return pickStock(named.length > 0 ? named : found);
}

export function extractUndrawn(excerpt: string, fileNames: string[]): ExcerptStock | null {
  const found: ExcerptStock[] = [];
  for (const segment of splitFinancialSegments(excerpt)) {
    if (!/\b(?:undrawn|unused|availability|available capacity)\b/i.test(segment)) continue;
    if (!/\b(?:revolv(?:ing|er)?s?|credit facility|credit facilities|commitment)\b/i.test(segment)) continue;
    const money =
      amountNearest(segment, /\b(?:undrawn|unused)\b/i) ??
      amountNearest(segment, /\b(?:available capacity|availability)\b/i);
    if (!money) continue;
    const liquidityTotal = liquidityTotalIn(segment);
    if (liquidityTotal && close(money.absolute, liquidityTotal.absolute)) continue;
    found.push(toStock(excerpt, fileNames, segment, money, "Undrawn availability"));
  }
  return pickStock(found);
}

/**
 * Read a disclosed liquidity total such as "liquidity of $X, including cash and undrawn".
 * Component amounts are not treated as the total.
 */
export function extractLiquidity(excerpt: string, fileNames: string[]): ExcerptStock | null {
  const found: ExcerptStock[] = [];
  for (const segment of splitFinancialSegments(excerpt)) {
    const money = liquidityTotalIn(segment);
    if (!money) continue;
    found.push(toStock(excerpt, fileNames, segment, money, "Liquidity"));
  }
  return pickStock(found);
}

export type ReportedLeverage = {
  multiple: number;
  name: string;
  definition: string;
  maximumText: string;
  sourceDocument: string;
  asOf: string;
};

const REPORTED_LEVERAGE_RE =
  /\b(net\s+total\s+lease[-\s]adjusted\s+leverage\s+ratio|(?:lease[-\s]adjusted\s+)?(?:net\s+)?leverage\s+ratio|(?:net\s+)?leverage)\b(?:\s+(?:was|of|at|is|equals?|equal\s+to)){0,2}\s+(\d+(?:\.\d+)?)(?:\s*(x|times)\b)?/gi;

/**
 * Read a leverage ratio only when the filing states the number.
 * A ratio may be printed without an "x". Limits and coverage ratios are not the actual ratio.
 */
export function extractReportedLeverage(
  excerpt: string,
  fileNames: string[],
): ReportedLeverage | null {
  const found: Array<ReportedLeverage & { time: number }> = [];
  for (const match of excerpt.matchAll(REPORTED_LEVERAGE_RE)) {
    const index = match.index ?? 0;
    const name = (match[1] ?? "").replace(/\s+/g, " ").trim();
    const hasRatio = /ratio/i.test(name);
    const hasMultipleMark = Boolean(match[3]);
    if (!hasRatio && !hasMultipleMark) continue;
    if (/interest coverage|fixed charge/i.test(excerpt.slice(Math.max(0, index - 40), index + name.length))) {
      continue;
    }
    if (limitOnSameLine(excerpt, index)) continue;
    const multiple = parseNumericToken(match[2] ?? "");
    if (multiple == null || multiple <= 0 || multiple > 25) continue;
    const windowStart = Math.max(0, index - 2600);
    const window = excerpt.slice(windowStart, index + (match[0]?.length ?? 0) + 180);
    const dated = latestReportingDate(window);
    const definition = covenantDefinition(excerpt.slice(windowStart, index), name);
    found.push({
      multiple,
      name,
      definition,
      maximumText: maximumPhrase(excerpt.slice(index, index + 200)),
      sourceDocument: sourceDocumentAt(excerpt, index, fileNames),
      asOf: dated?.label ?? "",
      time: dated?.time ?? 0,
    });
  }
  if (found.length === 0) return null;
  const latestTime = Math.max(...found.map((item) => item.time));
  const pool = found.filter((item) => item.time === latestTime);
  const unique = uniqueNumbers(pool.map((item) => item.multiple));
  if (unique.length !== 1) return null;
  const selected = pool[0];
  if (!selected) return null;
  return {
    multiple: selected.multiple,
    name: selected.name,
    definition: selected.definition,
    maximumText: selected.maximumText,
    sourceDocument: selected.sourceDocument,
    asOf: selected.asOf,
  };
}

function limitOnSameLine(excerpt: string, index: number): boolean {
  const prior = excerpt.slice(Math.max(0, index - 80), index);
  const sameLine = prior.includes("\n") ? prior.slice(prior.lastIndexOf("\n") + 1) : prior;
  return /maximum|minimum|not to exceed|no more than|allowable/i.test(sameLine);
}

function maximumPhrase(after: string): string {
  const match = after.match(
    /maximum\s+allowable\s+of\s+\d+(?:\.\d+)?|maximum\s+(?:of\s+)?\d+(?:\.\d+)?\s*(?:x|times)\b/i,
  );
  return match ? match[0].replace(/\s+/g, " ").trim() : "";
}

function covenantDefinition(before: string, name: string): string {
  const sentences = proseSentences(before).filter(
    (sentence) =>
      sentence.length >= 40 &&
      sentence.length <= 520 &&
      !/\bas follows\b/i.test(sentence) &&
      !/\$?\s*\d{1,3}(?:,\d{3})+/.test(sentence),
  );
  const definitional = sentences.filter(
    (sentence) =>
      (/leverage|ratio/i.test(sentence) &&
        /ebitdar|trailing four|not directly comparable|credit agreement|indenture/i.test(
          sentence,
        )) ||
      (/not directly comparable to adjusted ebitda|trailing four fiscal quarter/i.test(sentence) &&
        /credit agreement|indenture/i.test(sentence)),
  );
  const basis = definitional.filter((sentence) =>
    /uses?\s+ebitdar|ebitdar-based calculations/i.test(sentence),
  );
  const scope = definitional.filter((sentence) =>
    /trailing four|not directly comparable/i.test(sentence),
  );
  const picked = [...basis.slice(-1), ...scope.slice(-1)].filter(
    (sentence, index, all) => all.indexOf(sentence) === index,
  );
  if (picked.length > 0) return picked.join(" ");
  return definitional[definitional.length - 1] || name;
}

function proseSentences(before: string): string[] {
  const lines = before
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line && !line.startsWith("=====") && !/^\(?in thousands\)?$/i.test(line));
  const merged: string[] = [];
  for (const line of lines) {
    const previous = merged[merged.length - 1];
    if (previous && /^[a-z]/.test(line)) merged[merged.length - 1] = `${previous} ${line}`;
    else merged.push(line);
  }
  return merged.flatMap((block) =>
    block
      .split(/(?<=\.)\s+/)
      .map((sentence) => sentence.replace(/\s+/g, " ").trim())
      .filter(Boolean),
  );
}

function sumDebtComponents(excerpt: string, fileNames: string[]): ExcerptStock | null {
  const current = stocksMatching(
    excerpt,
    fileNames,
    (segment) =>
      /current portion of (?:long-term )?debt|current maturities of long-term debt/i.test(segment),
    "Current portion of long-term debt",
  );
  const longTerm = stocksMatching(
    excerpt,
    fileNames,
    (segment) =>
      /\blong-term debt\b/i.test(segment) &&
      !/current portion|current maturities/i.test(segment),
    "Long-term debt",
  );
  const currentPick = pickStock(current);
  const longPick = pickStock(longTerm);
  if (!currentPick || !longPick) return null;
  if (currentPick.scale !== longPick.scale) return null;
  if (currentPick.asOf && longPick.asOf && currentPick.asOf !== longPick.asOf) return null;
  if (currentPick.sourceDocument && longPick.sourceDocument && currentPick.sourceDocument !== longPick.sourceDocument) {
    return null;
  }
  return {
    absolute: currentPick.absolute + longPick.absolute,
    reported: currentPick.reported + longPick.reported,
    scale: currentPick.scale,
    asOf: currentPick.asOf || longPick.asOf,
    asOfTime: currentPick.asOfTime ?? longPick.asOfTime,
    sourceDocument: currentPick.sourceDocument || longPick.sourceDocument,
    description: "Current portion of long-term debt plus long-term debt",
  };
}

function stocksMatching(
  excerpt: string,
  fileNames: string[],
  accept: (segment: string) => boolean,
  description: string,
): ExcerptStock[] {
  const found: ExcerptStock[] = [];
  for (const segment of splitFinancialSegments(excerpt)) {
    if (!accept(segment)) continue;
    const money = moneyIn(segment);
    if (!money) continue;
    const dated = latestReportingDate(segment);
    found.push({
      ...money,
      asOf: dated?.label ?? "",
      asOfTime: dated?.time ?? null,
      sourceDocument: sourceDocumentAt(excerpt, Math.max(0, excerpt.indexOf(segment)), fileNames),
      description,
    });
  }
  return found;
}

function pickStock(items: ExcerptStock[]): ExcerptStock | null {
  if (items.length === 0) return null;
  const dated = items.filter((item) => item.asOfTime != null);
  const pool = dated.length > 0 ? dated.filter((item) => item.asOfTime === Math.max(...dated.map((item) => item.asOfTime ?? 0))) : items;
  const unique = uniqueAmounts(pool);
  if (unique.length !== 1) return null;
  return pool.find((item) => close(item.absolute, unique[0])) ?? null;
}

const MONEY_RE =
  /\$?\s*(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)\s*(billion|million|thousand|billions|millions|thousands)\b/i;

type LocatedMoney = {
  absolute: number;
  reported: number;
  scale: Exclude<MoneyScale, "ones">;
  index: number;
  end: number;
};

function moneyIn(
  segment: string,
): { absolute: number; reported: number; scale: Exclude<MoneyScale, "ones"> } | null {
  return moneyAmountsIn(segment)[0] ?? null;
}

function moneyAmountsIn(segment: string): LocatedMoney[] {
  const found: LocatedMoney[] = [];
  for (const match of segment.matchAll(new RegExp(MONEY_RE.source, "gi"))) {
    const reported = parseNumericToken(match[1] ?? "");
    const scale = wordScale(match[2] ?? "");
    if (reported == null || !scale || scale === "ones" || match.index == null) continue;
    found.push({
      absolute: reported * SCALE_FACTOR[scale],
      reported,
      scale,
      index: match.index,
      end: match.index + match[0].length,
    });
  }
  return found;
}

function liquidityTotalIn(segment: string): LocatedMoney | null {
  return amountNearest(segment, /(?:had\s+)?(?:total\s+)?liquidity\s+(?:of|was|is|stood at)/i, {
    after: true,
  });
}

function amountNearest(
  segment: string,
  cue: RegExp,
  options: { after?: boolean; before?: boolean } = {},
): LocatedMoney | null {
  const amounts = moneyAmountsIn(segment);
  if (amounts.length === 0) return null;
  const flags = cue.flags.includes("g") ? cue.flags : `${cue.flags}g`;
  const cues: Array<{ start: number; end: number }> = [];
  for (const match of segment.matchAll(new RegExp(cue.source, flags))) {
    if (match.index == null) continue;
    cues.push({ start: match.index, end: match.index + match[0].length });
  }
  if (cues.length === 0) return null;

  let best: LocatedMoney | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const hit of cues) {
    for (const amount of amounts) {
      const after = amount.index >= hit.end;
      const before = amount.end <= hit.start;
      if (options.after && !after) continue;
      if (options.before && !before) continue;
      const dist = after
        ? amount.index - hit.end
        : before
          ? hit.start - amount.end
          : Number.POSITIVE_INFINITY;
      if (dist > 90 || dist >= bestDist) continue;
      bestDist = dist;
      best = amount;
    }
  }
  return best;
}

function toStock(
  excerpt: string,
  fileNames: string[],
  segment: string,
  money: LocatedMoney,
  description: string,
): ExcerptStock {
  const dated = latestReportingDate(segment);
  return {
    absolute: money.absolute,
    reported: money.reported,
    scale: money.scale,
    asOf: dated?.label ?? "",
    asOfTime: dated?.time ?? null,
    sourceDocument: sourceDocumentAt(excerpt, Math.max(0, excerpt.indexOf(segment)), fileNames),
    description,
  };
}

function wordScale(word: string): MoneyScale | null {
  const normalized = word.toLowerCase();
  if (normalized.startsWith("billion")) return "billions";
  if (normalized.startsWith("million")) return "millions";
  if (normalized.startsWith("thousand")) return "thousands";
  return null;
}

function uniqueAmounts(items: ExcerptStock[]): number[] {
  const unique: number[] = [];
  for (const item of items) {
    if (!unique.some((value) => close(value, item.absolute))) unique.push(item.absolute);
  }
  return unique;
}

function uniqueNumbers(values: number[]): number[] {
  const unique: number[] = [];
  for (const value of values) {
    if (!unique.some((existing) => Math.abs(existing - value) < 0.001)) unique.push(value);
  }
  return unique;
}

function close(a: number, b: number): boolean {
  const base = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / base <= 0.005;
}
