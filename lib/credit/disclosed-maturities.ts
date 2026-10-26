import { sourceDocumentAt } from "@/lib/credit/financial-segments";
import { formatCompactAbsolute, SCALE_FACTOR, type MoneyScale } from "@/lib/credit/format-money";
import { alignToColumns, lineScale, parseAmounts, wordScale } from "@/lib/credit/table-amounts";
import { NOT_AVAILABLE } from "@/lib/types/credit-analysis";
import type {
  DisclosedMaturitySchedule,
  MaturityBucket,
  MaturityReconciliation,
} from "@/lib/types/credit-analysis";

type BridgeAmount = {
  label: string;
  absolute: number;
};

type Candidate = {
  buckets: Array<{ label: string; absolute: number }>;
  source: string;
  scale: MoneyScale;
  reconciliation: MaturityReconciliation | null;
};

const BUCKET_RE =
  /^(fiscal\s+20\d{2}|fy\s*20\d{2}|20\d{2}(?:\s*[-–]\s*20\d{2})?|thereafter|later years|beyond(?:\s+20\d{2})?)\b\s*([\s\S]*)$/i;

export const MATURITY_CUE_RE =
  /\b(?:scheduled maturities|aggregate maturities|principal maturities|annual maturities|contractual maturities|maturities of (?:our |the )?(?:total |long-term )?debt|maturities on (?:our |the )?(?:total |long-term )?debt|long-term debt matures)\b/i;

/**
 * Read a debt maturity schedule only when the filing prints one.
 * Instrument rows and chart images are not converted into buckets.
 */
export function extractDisclosedMaturities(
  excerpt: string,
  fileNames: string[],
): DisclosedMaturitySchedule {
  const lines = splitLines(excerpt);
  const candidates: Candidate[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isCue(lines, index)) continue;
    const parsed = parseRegion(lines, index, excerpt, fileNames);
    if (parsed) candidates.push(parsed);
  }
  return scheduleFrom(candidates, excerpt);
}

function scheduleFrom(
  candidates: Candidate[],
  excerpt?: string,
): DisclosedMaturitySchedule {
  if (candidates.length === 0) {
    return {
      buckets: null,
      message: partialMaturityMessage(excerpt) ?? NOT_AVAILABLE,
      reconciliation: null,
    };
  }
  const signatures = new Set(candidates.map(signature));
  if (signatures.size !== 1) {
    return { buckets: null, message: NOT_AVAILABLE, reconciliation: null };
  }
  const selected = candidates[0];
  if (!selected) return { buckets: null, message: NOT_AVAILABLE, reconciliation: null };
  const max = Math.max(...selected.buckets.map((bucket) => bucket.absolute), 0);
  const buckets: MaturityBucket[] = selected.buckets.map((bucket) => ({
    label: bucket.label,
    absolute: bucket.absolute,
    display: formatCompactAbsolute(bucket.absolute),
    share: max > 0 ? bucket.absolute / max : 0,
  }));
  const unit =
    selected.scale === "thousands"
      ? "thousand"
      : selected.scale === "millions"
        ? "million"
        : selected.scale === "billions"
          ? "billion"
          : "units";
  const reconciliations = candidates
    .map((candidate) => candidate.reconciliation)
    .filter((item): item is MaturityReconciliation => item != null);
  const reconKeys = new Set(reconciliations.map(reconciliationKey));
  return {
    buckets,
    message: `Disclosed maturity schedule${selected.source ? ` (${selected.source})` : ""}, in ${unit} as reported. Buckets are contractual principal amounts as printed, including any Thereafter amount. These amounts were not estimated from a chart or rebuilt from individual debt instruments.`,
    reconciliation: reconKeys.size === 1 ? (reconciliations[0] ?? null) : null,
  };
}

function parseRegion(
  lines: Array<{ text: string; index: number }>,
  start: number,
  excerpt: string,
  fileNames: string[],
): Candidate | null {
  const source = sourceDocumentAt(excerpt, lines[start]?.index ?? 0, fileNames);
  let scale = scaleBefore(lines, start);
  let columns: string[] | null = null;
  const buckets: Array<{ label: string; absolute: number; scale: MoneyScale }> = [];
  const adjustments: BridgeAmount[] = [];
  let carrying: BridgeAmount | null = null;
  let total: number | null = null;
  let sawBucket = false;
  const end = Math.min(lines.length, start + 32);

  for (let index = start; index < end; index += 1) {
    const text = lines[index]?.text ?? "";
    const trimmed = text.trim();
    if (!trimmed) continue;
    const foundScale =
      lineScale(trimmed) ??
      lineScale(`${trimmed} ${lines[index + 1]?.text.trim() ?? ""}`.slice(-180));
    if (foundScale) scale = foundScale;

    const header = dateHeader(trimmed);
    if (header) {
      columns = header;
      continue;
    }

    const totalAmounts = totalLine(trimmed, scale);
    if (totalAmounts) {
      const chosen = chooseColumn(totalAmounts, columns);
      if (chosen == null) return null;
      total = chosen;
      sawBucket = true;
      continue;
    }

    const bucket = bucketLine(trimmed, scale, columns);
    if (bucket) {
      buckets.push(bucket);
      sawBucket = true;
      continue;
    }

    if (sawBucket && scale && bareFooting(trimmed, scale, buckets)) continue;

    const adjustment = sawBucket ? adjustmentLine(trimmed, scale) : null;
    if (adjustment) {
      adjustments.push(adjustment);
      continue;
    }

    const carried = sawBucket ? carryingLine(trimmed, scale) : null;
    if (carried) {
      carrying = carried;
      continue;
    }

    if (sawBucket && !isSkippable(trimmed)) break;
  }

  const lined = finish(buckets, total, source);
  if (lined) {
    const gross = lined.buckets.reduce((sum, bucket) => sum + bucket.absolute, 0);
    const bridged =
      adjustments.length > 0 && carrying
        ? { adjustments, carrying }
        : scale
          ? bridgeFromWindow(
              lines
                .slice(start, end)
                .map((line) => line.text)
                .join("\n"),
              scale,
              gross,
            )
          : null;
    return {
      ...lined,
      reconciliation: bridged
        ? buildReconciliation(gross, lined.scale, bridged.adjustments, bridged.carrying)
        : null,
    };
  }
  return inlineRegion(
    lines.slice(start, Math.min(lines.length, start + 8)).map((line) => line.text).join(" "),
    scale,
    source,
  );
}

function finish(
  buckets: Array<{ label: string; absolute: number; scale: MoneyScale }>,
  total: number | null,
  source: string,
): Candidate | null {
  if (buckets.length < 2) return null;
  if (new Set(buckets.map((bucket) => bucket.label.toLowerCase())).size !== buckets.length) {
    return null;
  }
  const scales = new Set(buckets.map((bucket) => bucket.scale));
  if (scales.size !== 1) return null;
  const scale = buckets[0]?.scale;
  if (!scale) return null;
  if (buckets.some((bucket) => !Number.isFinite(bucket.absolute) || bucket.absolute < 0)) {
    return null;
  }
  const sum = buckets.reduce((totalAmount, bucket) => totalAmount + bucket.absolute, 0);
  if (total != null) {
    if (!close(sum, total)) return null;
  } else if (buckets.length < 3) {
    return null;
  }
  return {
    source,
    scale,
    buckets: buckets.map((bucket) => ({ label: bucket.label, absolute: bucket.absolute })),
    reconciliation: null,
  };
}

function bucketLine(
  line: string,
  scale: MoneyScale | null,
  columns: string[] | null,
): { label: string; absolute: number; scale: MoneyScale } | null {
  if (/%/.test(line)) return null;
  if (/\b(?:lease|interest payment|purchase commitment|commitment)\b/i.test(line)) return null;
  const match = line.trim().match(BUCKET_RE);
  if (!match) return null;
  const label = (match[1] ?? "").replace(/\s+/g, " ").trim();
  const rest = match[2] ?? "";
  if (/^(?:senior|notes?|term|loan|bonds?|revolv|credit|debenture|facility)\b/i.test(rest)) {
    return null;
  }
  const amounts = parseAmounts(rest, { bare: true });
  const width = columns && columns.length >= 2 ? columns.length : 1;
  const aligned = alignToColumns(amounts, width);
  if (!aligned) return null;
  const chosen = chooseColumn(aligned.map((amount) => amount.reported), columns);
  const selected = aligned[columnIndex(columns)];
  if (chosen == null || !selected) return null;
  const resolved = selected.explicitScale ?? scale;
  if (!resolved) return null;
  if (selected.explicitScale && scale && selected.explicitScale !== scale) return null;
  return {
    label,
    absolute: chosen * SCALE_FACTOR[resolved],
    scale: resolved,
  };
}

function totalLine(
  line: string,
  scale: MoneyScale | null,
): number[] | null {
  const match = line.trim().match(/^total(?:\s+(?:long-term\s+)?debt)?\b\s*(.*)$/i);
  if (!match) return null;
  const rest = match[1] ?? "";
  if (/[A-Za-z]{4,}/.test(rest)) return null;
  const amounts = parseAmounts(rest, { bare: scale != null });
  if (amounts.length === 0) return null;
  return amounts.map((amount) => {
    const resolved = amount.explicitScale ?? scale;
    if (!resolved) return Number.NaN;
    return amount.reported * SCALE_FACTOR[resolved];
  });
}

function inlineRegion(text: string, scale: MoneyScale | null, source: string): Candidate | null {
  if (!MATURITY_CUE_RE.test(text)) return null;
  if (/\b(?:lease|interest payment|purchase commitment)\b/i.test(text) && !/\bdebt|borrow|principal\b/i.test(text)) {
    return null;
  }
  const buckets: Array<{ label: string; absolute: number; scale: MoneyScale }> = [];
  const pattern =
    /\$\s*(\d[\d,]*(?:\.\d+)?)\s*(billion|million|thousand|billions|millions|thousands)\b\s*(?:(?:in|due in|maturing in)\s+)?(20\d{2}|thereafter)\b/gi;
  for (const match of text.matchAll(pattern)) {
    const reported = Number((match[1] ?? "").replace(/,/g, ""));
    const amountScale = wordScale(match[2] ?? "");
    const label = match[3] ?? "";
    if (!Number.isFinite(reported) || !amountScale || !label) return null;
    buckets.push({
      label,
      absolute: reported * SCALE_FACTOR[amountScale],
      scale: amountScale,
    });
  }
  if (buckets.length < 3) return null;
  if (scale && buckets.some((bucket) => bucket.scale !== scale) && new Set(buckets.map((bucket) => bucket.scale)).size !== 1) {
    return null;
  }
  return finish(buckets, null, source);
}

function chooseColumn(amounts: number[], columns: string[] | null): number | null {
  if (amounts.some((amount) => !Number.isFinite(amount))) return null;
  if (amounts.length === 1) return amounts[0] ?? null;
  if (!columns || columns.length !== amounts.length) return null;
  return amounts[columnIndex(columns)] ?? null;
}

function columnIndex(columns: string[] | null): number {
  if (!columns || columns.length === 0) return 0;
  let best = 0;
  let year = -1;
  columns.forEach((value, index) => {
    const parsed = Number(value);
    if (parsed >= year) {
      year = parsed;
      best = index;
    }
  });
  return best;
}

function dateHeader(line: string): string[] | null {
  const dated = [...line.matchAll(
    /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+(20\d{2})\b/gi,
  )].map((match) => match[1] ?? "");
  if (dated.length >= 2) return dated.filter(Boolean);
  const years = [...line.matchAll(/\b(20\d{2})\b/g)].map((match) => match[1] ?? "");
  const rest = line.replace(/\b20\d{2}\b/g, "");
  if (years.length >= 2 && !/\d/.test(rest)) return years.filter(Boolean);
  return null;
}

function isCue(lines: Array<{ text: string }>, index: number): boolean {
  const window = lines
    .slice(index, Math.min(lines.length, index + 3))
    .map((line) => line.text)
    .join(" ");
  if (!MATURITY_CUE_RE.test(window)) return false;
  if (/\bleases?\b/i.test(window) && !/\bdebt|borrow|notes?\b/i.test(window)) return false;
  return true;
}

function scaleBefore(
  lines: Array<{ text: string }>,
  start: number,
): MoneyScale | null {
  let scale: MoneyScale | null = null;
  for (let index = Math.max(0, start - 120); index <= start; index += 1) {
    const current = lines[index]?.text ?? "";
    const found =
      lineScale(current) ??
      lineScale(`${current} ${lines[index + 1]?.text ?? ""}`.replace(/\s+/g, " ").slice(-180));
    if (found) scale = found;
  }
  return scale;
}

function isSkippable(line: string): boolean {
  return (
    /^[$\s()]+$/.test(line) ||
    /^year(?:\s*\(\d+\))?$/i.test(line) ||
    /^amount$/i.test(line)
  );
}

function partialMaturityMessage(excerpt: string | undefined): string | null {
  if (!excerpt) return null;
  const match = excerpt.match(
    /\$\s*(\d[\d,]*(?:\.\d+)?)\s*(billion|million|thousand|billions|millions|thousands)\b[^.\n]{0,80}\bdebt maturities\b|\bdebt maturities\b[^.\n]{0,80}\$\s*(\d[\d,]*(?:\.\d+)?)\s*(billion|million|thousand|billions|millions|thousands)\b/i,
  );
  if (!match) return null;
  const amount = match[1] || match[3];
  const unit = match[2] || match[4];
  const year = excerpt
    .slice(Math.max(0, (match.index ?? 0) - 80), (match.index ?? 0) + (match[0]?.length ?? 0) + 80)
    .match(/\b(20\d{2})\b/);
  const when = year ? ` in ${year[1]}` : "";
  return `${NOT_AVAILABLE} The filing mentions $${amount} ${unit} of debt maturities${when}, but does not print a complete contractual maturity schedule. Partial year amounts were not expanded into a chart.`;
}

function bareFooting(
  line: string,
  scale: MoneyScale,
  buckets: Array<{ absolute: number }>,
): boolean {
  if (buckets.length === 0) return false;
  if (!/^[$\s]*[\d,]+(?:\.\d+)?[$\s]*$/.test(line.trim())) return false;
  const amounts = parseAmounts(line, { bare: true });
  if (amounts.length !== 1) return false;
  const amount = amounts[0];
  if (!amount) return false;
  const resolved = amount.explicitScale ?? scale;
  const absolute = amount.reported * SCALE_FACTOR[resolved];
  const sum = buckets.reduce((total, bucket) => total + bucket.absolute, 0);
  return close(absolute, sum);
}

function adjustmentLine(line: string, scale: MoneyScale | null): BridgeAmount | null {
  if (!scale || line.length > 160) return null;
  if (/\b(?:lease|purchase commitment|interest payment)\b/i.test(line)) return null;
  const match = line.trim().match(
    /^(net\s+discounts?|net\s+premiums?|unamortized\s+(?:original\s+issue\s+)?discounts?|unamortized\s+premiums?|original\s+issue\s+discounts?|net\s+deferred\s+financing\s+costs?|deferred\s+financing\s+costs?|debt\s+issuance\s+costs?)\b\s*(.*)$/i,
  );
  if (!match) return null;
  return labeledMoney(line.trim(), match[2] ?? "", scale);
}

function carryingLine(line: string, scale: MoneyScale | null): BridgeAmount | null {
  if (!scale || line.length > 220) return null;
  const match = line.trim().match(
    /^(total\s+long-term\s+debt|carrying\s+(?:amount|value)(?:\s+of\s+(?:long-term\s+)?debt)?)\b([\s\S]*)$/i,
  );
  if (!match) return null;
  const tail = match[2] ?? "";
  const amountAt = tail.search(/\(?\s*\$?\s*[\d,]+(?:\.\d+)?\s*\)?\s*$/);
  if (amountAt < 0) return null;
  const amount = labeledMoney(line.trim(), tail.slice(amountAt), scale);
  if (!amount || amount.absolute <= 0) return null;
  return amount;
}

function labeledMoney(line: string, rest: string, scale: MoneyScale): BridgeAmount | null {
  const amounts = parseAmounts(rest, { bare: true });
  if (amounts.length !== 1) return null;
  const amount = amounts[0];
  if (!amount) return null;
  const resolved = amount.explicitScale ?? scale;
  const label = line
    .trim()
    .slice(0, Math.max(0, line.trim().length - rest.length))
    .replace(/[$\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!label) return null;
  return { label, absolute: amount.reported * SCALE_FACTOR[resolved] };
}

function bridgeFromWindow(
  text: string,
  scale: MoneyScale,
  gross: number,
): { adjustments: BridgeAmount[]; carrying: BridgeAmount } | null {
  if (!/\bmatur/i.test(text) || gross <= 0) return null;
  const adjustments: BridgeAmount[] = [];
  const pattern =
    /\b(net\s+discounts?|net\s+premiums?|unamortized\s+(?:original\s+issue\s+)?discounts?|unamortized\s+premiums?|net\s+deferred\s+financing\s+costs?|deferred\s+financing\s+costs?|debt\s+issuance\s+costs?)\b[^$\n]{0,30}?(\(\s*\$?\s*[\d,]+(?:\.\d+)?\s*\)|\$?\s*[\d,]+(?:\.\d+)?)/gi;
  for (const match of text.matchAll(pattern)) {
    const raw = match[2] ?? "";
    const negative = raw.includes("(");
    const reported = Number(raw.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(reported)) continue;
    adjustments.push({
      label: (match[1] ?? "").replace(/\s+/g, " ").trim(),
      absolute: (negative ? -reported : reported) * SCALE_FACTOR[scale],
    });
  }
  const carryingMatch = text.match(
    /\b(total\s+long-term\s+debt(?:\s*\([^)\n]{0,80}\))?|carrying\s+(?:amount|value)(?:\s+of\s+(?:long-term\s+)?debt)?)\s[^$\n\d]{0,80}\$?\s*([\d,]+(?:\.\d+)?)/i,
  );
  if (adjustments.length === 0 || !carryingMatch) return null;
  const carryingReported = Number((carryingMatch[2] ?? "").replace(/[^\d.]/g, ""));
  if (!Number.isFinite(carryingReported)) return null;
  const carrying = {
    label: (carryingMatch[1] ?? "").replace(/\s+/g, " ").trim(),
    absolute: carryingReported * SCALE_FACTOR[scale],
  };
  if (carrying.absolute <= 0) return null;
  const ratio = carrying.absolute / gross;
  if (ratio < 0.5 || ratio > 1.5) return null;
  return { adjustments, carrying };
}

function buildReconciliation(
  gross: number,
  scale: MoneyScale,
  adjustments: BridgeAmount[],
  carrying: BridgeAmount,
): MaturityReconciliation {
  const netAdjustments = adjustments.reduce((sum, line) => sum + line.absolute, 0);
  const foots = Math.abs(gross + netAdjustments - carrying.absolute) <= Math.max(1_000, Math.abs(carrying.absolute) * 0.001);
  const printed = [
    `contractual maturities of ${reportedWords(gross, scale)}`,
    ...adjustments.map(
      (line) => `${line.label} of ${reportedWords(line.absolute, scale)}`,
    ),
    `${carrying.label} of ${reportedWords(carrying.absolute, scale)}`,
  ];
  const note = foots
    ? `The filing reconciles ${printed.join(", ")}. The chart keeps the contractual maturity buckets. No amount was added to force those buckets to equal the carrying amount.`
    : `The maturity note prints ${printed.join(", ")}, but those printed amounts do not fully bridge contractual maturities to the carrying amount. The difference was not plugged.`;
  return {
    grossAbsolute: gross,
    grossDisplay: formatCompactAbsolute(gross),
    lines: adjustments.map((line) => ({
      label: line.label,
      absolute: line.absolute,
      display: formatCompactAbsolute(line.absolute),
    })),
    carryingLabel: carrying.label,
    carryingAbsolute: carrying.absolute,
    carryingDisplay: formatCompactAbsolute(carrying.absolute),
    foots,
    note,
  };
}

function reportedWords(absolute: number, scale: MoneyScale): string {
  const reported = absolute / SCALE_FACTOR[scale];
  const body = Math.abs(reported).toLocaleString("en-US", { maximumFractionDigits: 3 });
  const unit =
    scale === "thousands"
      ? "thousand"
      : scale === "millions"
        ? "million"
        : scale === "billions"
          ? "billion"
          : "";
  const shown = absolute < 0 ? `(${body})` : body;
  return unit ? `${shown} ${unit}` : shown;
}

function reconciliationKey(reconciliation: MaturityReconciliation): string {
  return [
    Math.round(reconciliation.grossAbsolute),
    ...reconciliation.lines.map((line) => `${line.label}:${Math.round(line.absolute)}`),
    Math.round(reconciliation.carryingAbsolute),
  ].join("|");
}

function signature(candidate: Candidate): string {
  return candidate.buckets
    .map((bucket) => `${bucket.label.toLowerCase()}:${Math.round(bucket.absolute)}`)
    .join("|");
}

function close(left: number, right: number): boolean {
  const base = Math.max(Math.abs(left), Math.abs(right), 1);
  return Math.abs(left - right) / base <= 0.02;
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
