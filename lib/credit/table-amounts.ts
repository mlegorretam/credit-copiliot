import { parseNumericToken } from "@/lib/credit/excerpt-figures";
import type { MoneyScale } from "@/lib/credit/format-money";

export type ParsedAmount = {
  reported: number;
  explicitScale: MoneyScale | null;
  paren: boolean;
  index: number;
};

const MONTH =
  "January|February|March|April|May|June|July|August|September|October|November|December";

const AMOUNT_RE =
  /(?:\((?:\$\s*)?(\d[\d,]*(?:\.\d+)?)\)|\$\s*(\d[\d,]*(?:\.\d+)?)|(?<![\d.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+)(?![\d.])|(?<![\d.])(\d+)(?![\d.]))/g;

export function lineScale(line: string): MoneyScale | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parentheticalScale = /\(\s*\$?\s*in\s+(?:thousands|millions|billions)/i.test(trimmed);
  if (trimmed.length > 180 && !parentheticalScale) return null;
  if (/\bin\s+(?:thousands|millions|billions)\s+of\s+(?!dollars\b)/i.test(trimmed)) {
    return null;
  }
  const match = trimmed.match(
    /(?:\(\s*\$?\s*in\s+(thousands|millions|billions)|\$\s*in\s+(thousands|millions|billions)|\bin\s+(000s|thousands|millions|billions)\b)/i,
  );
  if (!match) return null;
  const word = match.slice(1).find((part) => part);
  return word ? wordScale(word) : null;
}

export function parseAmounts(line: string, options: { bare: boolean }): ParsedAmount[] {
  const found: ParsedAmount[] = [];
  for (const match of line.matchAll(AMOUNT_RE)) {
    const index = match.index ?? 0;
    const raw = match[1] ?? match[2] ?? match[3] ?? match[4];
    const bare = Boolean(match[4]);
    if (!raw) continue;
    if (bare && !options.bare) continue;
    const before = line.slice(Math.max(0, index - 24), index);
    if (new RegExp(`(?:${MONTH})\\s*$`, "i").test(before)) continue;
    const after = line.slice(index + match[0].length, index + match[0].length + 18);
    if (/^\s*(?:%|percent\b)/i.test(after)) continue;
    const reported = parseNumericToken(raw);
    if (reported == null) continue;
    if (
      bare &&
      reported >= 1990 &&
      reported <= 2100 &&
      !raw.includes(",") &&
      !raw.includes(".")
    ) {
      continue;
    }
    const paren = Boolean(match[1]);
    const scaleWord = after.match(
      /^\s*(billion|million|thousand|billions|millions|thousands)\b/i,
    );
    found.push({
      reported: paren ? -Math.abs(reported) : reported,
      explicitScale: scaleWord ? wordScale(scaleWord[1]) : null,
      paren,
      index,
    });
  }
  return found;
}

export function alignToColumns(
  amounts: ParsedAmount[],
  columns: number,
): ParsedAmount[] | null {
  if (columns < 1) return null;
  if (amounts.length === columns) return amounts;
  const withoutNotes = amounts.filter(
    (amount) =>
      !(amount.paren && Number.isInteger(amount.reported) && Math.abs(amount.reported) <= 9),
  );
  if (withoutNotes.length === columns) return withoutNotes;
  return null;
}

export function wordScale(word: string): MoneyScale | null {
  const normalized = word.toLowerCase();
  if (!normalized) return null;
  if (normalized === "000s" || normalized.startsWith("thousand")) return "thousands";
  if (normalized.startsWith("million")) return "millions";
  if (normalized.startsWith("billion")) return "billions";
  return null;
}
