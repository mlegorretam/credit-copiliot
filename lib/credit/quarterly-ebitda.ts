import type { SourcedAmount } from "@/lib/types/credit-analysis";

type MoneyScale = Exclude<SourcedAmount["scale"], "not_available">;

type QuarterLabel = {
  quarter: 1 | 2 | 3 | 4;
  year: number;
  start: number;
  end: number;
};

type AmountToken = {
  reported: number;
  scale: MoneyScale | null;
  end: number;
};

type Component = {
  label: string;
  quarter: 1 | 2 | 3 | 4;
  year: number;
  absolute: number;
  scale: MoneyScale;
};

type Candidate = {
  start: number;
  end: number;
  headerStart: number;
  score: number;
  endPeriod: number;
  adjusted: boolean;
  sourceDocument: string;
  absolute: number;
  components: Component[];
};

export type ConstructedTtmEbitda = {
  absolute: number;
  sourceDocument: string;
  asOf: string;
  adjusted: boolean;
  bridge: string;
  note: string;
};

const SCALE_FACTOR: Record<MoneyScale, number> = {
  ones: 1,
  thousands: 1_000,
  millions: 1_000_000,
  billions: 1_000_000_000,
};

const QUARTER_RE = /Q([1-4])\s*(20\d{2})(?!\d)/g;
const ADJUSTED_LABEL_RE =
  /Adjusted\s+EBITDA\b(?!\s+Margin\b)(?!\s+Reconciling\b)/gi;
const PLAIN_LABEL_RE = /(?<!adjusted\s)\bEBITDA\b(?!\s+margin\b)/gi;
const LABELED_QUARTER_RE =
  /Q([1-4])\s*(20\d{2})\s*(?:Adjusted\s+EBITDA\s*)?(?:of\s*)?[:\-–—]?\s*\$\s*(\(?\s*-?[\d,]+(?:\.\d+)?\s*\)?)\s*(million|millions|thousand|thousands|billion|billions|bn|mm|m)?\b/gi;
const DOCUMENT_DEFAULT_RE =
  /in\s+(000s|thousands|millions|billions)\s+unless\s+noted/gi;
const SCALE_CUE_RE =
  /(?:\(\s*\$\s*in\s+(millions|thousands|billions)\s*\)|\$\s*in\s+(millions|thousands|billions)|dollars\s+in\s+(thousands|millions|billions)|in\s+(000s|thousands|millions|billions))/gi;

/**
 * Sum four consecutive quarterly Adjusted EBITDA figures into a
 * trailing-twelve-month amount. Returns null when the excerpt does not
 * contain that series.
 */
export function constructTtmAdjustedEbitda(
  excerpt: string,
  fileNames: string[],
): ConstructedTtmEbitda | null {
  const candidates = splitDocuments(excerpt, fileNames).flatMap((section) =>
    collectCandidates(section.text, section.name),
  );
  const chosen = pickCandidate(candidates);
  if (!chosen) return null;
  return present(chosen);
}

/** Spans to keep when a long filing is truncated: the quarterly row and its scale note. */
export function quarterlyDisclosureSpans(
  text: string,
): Array<{ start: number; end: number }> {
  const candidates = collectCandidates(text, "");
  if (candidates.length === 0) return [];
  const spans = candidates.map((candidate) => ({
    start: Math.max(0, candidate.start),
    end: Math.min(text.length, candidate.end),
  }));
  for (const candidate of candidates) {
    const note = lastDocumentDefault(text.slice(0, candidate.headerStart));
    if (note) spans.push(cueSpan(text, note.index, note.length));
  }
  return mergeSpans(spans);
}

function splitDocuments(
  excerpt: string,
  fileNames: string[],
): Array<{ name: string; text: string }> {
  const marker = /===== DOCUMENT \d+ of \d+: ([^\n=]+) =====/g;
  const matches = [...excerpt.matchAll(marker)];
  if (matches.length === 0) {
    return [
      {
        name: fileNames.length === 1 ? fileNames[0] : "",
        text: excerpt,
      },
    ];
  }
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end =
      index + 1 < matches.length
        ? (matches[index + 1].index ?? excerpt.length)
        : excerpt.length;
    return {
      name: match[1].replace(/,\s*\d+\s+pages\s*$/i, "").trim(),
      text: excerpt.slice(start, end),
    };
  });
}

function collectCandidates(text: string, sourceDocument: string): Candidate[] {
  return [
    ...tableCandidates(text, sourceDocument),
    ...labeledCandidates(text, sourceDocument),
  ];
}

function tableCandidates(text: string, sourceDocument: string): Candidate[] {
  const runs = headerRuns(text);
  const candidates: Candidate[] = [];
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    const next = runs[index + 1];
    const regionEnd = Math.min(
      next ? next.start : text.length,
      run.end + 2500,
    );
    const region = text.slice(run.end, regionEnd);
    for (const label of region.matchAll(ADJUSTED_LABEL_RE)) {
      pushTableCandidate(
        candidates,
        text,
        sourceDocument,
        run,
        region,
        label,
        true,
      );
    }
    for (const label of region.matchAll(PLAIN_LABEL_RE)) {
      pushTableCandidate(
        candidates,
        text,
        sourceDocument,
        run,
        region,
        label,
        false,
      );
    }
  }
  return candidates;
}

function pushTableCandidate(
  candidates: Candidate[],
  text: string,
  sourceDocument: string,
  run: { start: number; end: number; quarters: QuarterLabel[] },
  region: string,
  label: RegExpMatchArray,
  adjusted: boolean,
) {
  const labelOffset = run.end + (label.index ?? 0);
  const after = region.slice((label.index ?? 0) + label[0].length);
  const amounts = readAmountSequence(after);
  if (amounts.length !== run.quarters.length || amounts.length < 4) return;
  const points = run.quarters.map((quarter, amountIndex) => ({
    quarter: quarter.quarter,
    year: quarter.year,
    reported: amounts[amountIndex].reported,
    unitScale: amounts[amountIndex].scale,
  }));
  const amountEnd =
    labelOffset +
    label[0].length +
    amounts[amounts.length - 1].end;
  const candidate = toCandidate({
    text,
    sourceDocument,
    adjusted,
    headerStart: run.start,
    labelIndex: labelOffset,
    start: Math.max(0, run.start - 80),
    end: Math.min(text.length, amountEnd + 40),
    points,
  });
  if (candidate) candidates.push(candidate);
}

function labeledCandidates(text: string, sourceDocument: string): Candidate[] {
  const matches = [...text.matchAll(LABELED_QUARTER_RE)];
  const candidates: Candidate[] = [];
  let cluster: RegExpMatchArray[] = [];

  const flush = () => {
    if (cluster.length >= 4) {
      const candidate = labeledCluster(text, sourceDocument, cluster);
      if (candidate) candidates.push(candidate);
    }
    cluster = [];
  };

  for (const match of matches) {
    const start = match.index ?? 0;
    const previous = cluster[cluster.length - 1];
    const previousEnd = previous
      ? (previous.index ?? 0) + previous[0].length
      : 0;
    if (cluster.length > 0 && start - previousEnd > 400) flush();
    cluster.push(match);
  }
  flush();
  return candidates;
}

function labeledCluster(
  text: string,
  sourceDocument: string,
  cluster: RegExpMatchArray[],
): Candidate | null {
  const firstStart = cluster[0].index ?? 0;
  const context = text.slice(Math.max(0, firstStart - 600), firstStart + 80);
  if (!/adjusted\s+ebitda/i.test(context)) return null;
  const points = cluster.map((match) => ({
    quarter: Number(match[1]) as 1 | 2 | 3 | 4,
    year: Number(match[2]),
    reported: parseMoney(match[3] ?? "") ?? Number.NaN,
    unitScale: wordScale(match[4] ?? ""),
  }));
  if (points.some((point) => !Number.isFinite(point.reported))) return null;
  const last = cluster[cluster.length - 1];
  const end = (last.index ?? 0) + last[0].length;
  return toCandidate({
    text,
    sourceDocument,
    adjusted: true,
    headerStart: firstStart,
    labelIndex: firstStart,
    start: Math.max(0, firstStart - 200),
    end: Math.min(text.length, end + 40),
    points,
  });
}

function toCandidate(input: {
  text: string;
  sourceDocument: string;
  adjusted: boolean;
  headerStart: number;
  labelIndex: number;
  start: number;
  end: number;
  points: Array<{
    quarter: 1 | 2 | 3 | 4;
    year: number;
    reported: number;
    unitScale: MoneyScale | null;
  }>;
}): Candidate | null {
  const selected = latestFour(input.points);
  if (!selected) return null;
  const explicit = selected.map((point) => point.unitScale);
  const uniqueUnits = new Set(explicit.filter((scale): scale is MoneyScale => scale != null));
  if (explicit.some((scale) => scale == null) && uniqueUnits.size > 0) return null;
  if (uniqueUnits.size > 1) return null;
  const scale =
    [...uniqueUnits][0] ??
    scaleForTable(
      input.text,
      input.headerStart,
      selected.map((point) => point.reported),
    );
  if (!scale) return null;
  const components: Component[] = selected.map((point) => ({
    label: `Q${point.quarter} ${point.year}`,
    quarter: point.quarter,
    year: point.year,
    absolute: Math.round(point.reported * SCALE_FACTOR[scale]),
    scale,
  }));
  const absolute = components.reduce((sum, component) => sum + component.absolute, 0);
  const endPeriod =
    components[components.length - 1].year * 4 +
    components[components.length - 1].quarter -
    1;
  return {
    start: input.start,
    end: input.end,
    headerStart: input.headerStart,
    score: scoreCandidate(
      input.text,
      input.headerStart,
      input.labelIndex,
      input.adjusted,
    ),
    endPeriod,
    adjusted: input.adjusted,
    sourceDocument: input.sourceDocument,
    absolute,
    components,
  };
}

function latestFour(
  points: Array<{
    quarter: 1 | 2 | 3 | 4;
    year: number;
    reported: number;
    unitScale: MoneyScale | null;
  }>,
): Array<{
  quarter: 1 | 2 | 3 | 4;
  year: number;
  reported: number;
  unitScale: MoneyScale | null;
}> | null {
  const byPeriod = new Map<number, (typeof points)[number]>();
  for (const point of points) {
    const key = point.year * 4 + point.quarter - 1;
    if (!byPeriod.has(key)) byPeriod.set(key, point);
  }
  const ordered = [...byPeriod.entries()].sort((a, b) => a[0] - b[0]);
  let run: Array<(typeof points)[number]> = [];
  let previous = Number.NaN;
  let best: Array<(typeof points)[number]> | null = null;
  for (const [key, point] of ordered) {
    if (run.length === 0 || key === previous + 1) run.push(point);
    else run = [point];
    previous = key;
    if (run.length >= 4) best = run.slice(-4);
  }
  return best;
}

function pickCandidate(candidates: Candidate[]): Candidate | null {
  const viable = candidates.filter((candidate) => candidate.score > 0);
  if (viable.length === 0) return null;
  const newest = Math.max(...viable.map((candidate) => candidate.endPeriod));
  const current = viable
    .filter((candidate) => candidate.endPeriod === newest)
    .sort((a, b) => b.score - a.score || b.absolute - a.absolute);
  const best = current[0];
  if (!best) return null;
  const conflict = current.find(
    (candidate) =>
      candidate !== best &&
      !closeMoney(candidate.absolute, best.absolute) &&
      best.score - candidate.score < 3,
  );
  return conflict ? null : best;
}

function present(candidate: Candidate): ConstructedTtmEbitda {
  const parts = candidate.components.map(
    (component) => `${component.label} ${formatMoney(component.absolute, component.scale)}`,
  );
  const total = formatMoney(candidate.absolute, "millions");
  const name = candidate.adjusted ? "Adjusted EBITDA" : "EBITDA";
  const formula = `${parts.join(" + ")} = ${total}`;
  const bridge = `Calculated as the sum of four consecutive quarters: ${formula}.`;
  const note = `Trailing-twelve-month ${name} was calculated from four consecutive quarters in the extracted text: ${formula}. No annualization was applied.`;
  const last = candidate.components[candidate.components.length - 1];
  return {
    absolute: candidate.absolute,
    sourceDocument: candidate.sourceDocument,
    asOf: last.label,
    adjusted: candidate.adjusted,
    bridge,
    note,
  };
}

function scoreCandidate(
  text: string,
  headerStart: number,
  labelIndex: number,
  adjusted: boolean,
): number {
  const before = text.slice(Math.max(0, headerStart - 900), headerStart).toLowerCase();
  const between = text.slice(headerStart, labelIndex).toLowerCase();
  const near = text.slice(Math.max(0, labelIndex - 240), labelIndex).toLowerCase();
  let score = 1;
  if (adjusted) score += 2;
  if (before.includes("financial highlights") || between.includes("financial highlights")) {
    score += 6;
  }
  if (near.includes("total consolidated") || between.includes("total consolidated")) {
    score += 4;
  }
  if (
    /global rim|data center|corporate and other|\bsegment\b/.test(near) &&
    !near.includes("total consolidated")
  ) {
    score -= 8;
  }
  return score;
}

function headerRuns(
  text: string,
): Array<{ start: number; end: number; quarters: QuarterLabel[] }> {
  const quarters: QuarterLabel[] = [];
  for (const match of text.matchAll(QUARTER_RE)) {
    const start = match.index ?? 0;
    const previousChar = start > 0 ? text[start - 1] : "";
    if (previousChar && /[A-Za-z0-9]/.test(previousChar)) continue;
    const quarter = Number(match[1]);
    if (quarter < 1 || quarter > 4) continue;
    quarters.push({
      quarter: quarter as 1 | 2 | 3 | 4,
      year: Number(match[2]),
      start,
      end: start + match[0].length,
    });
  }

  const runs: Array<{ start: number; end: number; quarters: QuarterLabel[] }> = [];
  let current: QuarterLabel[] = [];
  const flush = () => {
    if (current.length >= 4) {
      runs.push({
        start: current[0].start,
        end: current[current.length - 1].end,
        quarters: current,
      });
    }
    current = [];
  };

  for (const quarter of quarters) {
    const previous = current[current.length - 1];
    const between = previous ? text.slice(previous.end, quarter.start) : "";
    const separated =
      !previous ||
      (quarter.start - previous.end <= 40 && /^[\s,|/.\-–—:()]*$/.test(between));
    if (!separated) flush();
    current.push(quarter);
  }
  flush();
  return runs;
}

function readAmountSequence(input: string): AmountToken[] {
  const pattern =
    /\$\s*\(?\s*-?\d[\d,]*(?:\.\d+)?\s*\)?(?:\s*(?:millions?|thousands?|billions?|bn|mm|m)\b)?/gi;
  const found: AmountToken[] = [];
  let cursor = 0;
  while (found.length < 12) {
    pattern.lastIndex = cursor;
    const match = pattern.exec(input);
    if (!match) break;
    const gap = input.slice(cursor, match.index);
    if (!/^[\s|:+\-–—]*$/.test(gap)) break;
    const reported = parseMoney(match[0]);
    if (reported == null) break;
    found.push({
      reported,
      scale: unitScale(match[0]),
      end: match.index + match[0].length,
    });
    cursor = match.index + match[0].length;
  }
  return found;
}

function scaleForTable(
  text: string,
  headerStart: number,
  reportedAmounts: number[],
): MoneyScale | null {
  const local = lastScaleCue(text.slice(Math.max(0, headerStart - 700), headerStart));
  const documentDefault = lastDocumentDefault(text.slice(0, headerStart))?.scale ?? null;
  const largeIntegers = reportedAmounts.every(
    (amount) => Number.isInteger(amount) && Math.abs(amount) >= 100_000,
  );
  if (
    largeIntegers &&
    documentDefault === "thousands" &&
    local !== "thousands"
  ) {
    return "thousands";
  }
  return local ?? documentDefault ?? lastScaleCue(text.slice(0, headerStart));
}

function lastDocumentDefault(
  text: string,
): { index: number; length: number; scale: MoneyScale } | null {
  const matches = [...text.matchAll(DOCUMENT_DEFAULT_RE)];
  const match = matches[matches.length - 1];
  if (!match || match.index == null) return null;
  const scale = cueScale(match[1] ?? "");
  if (!scale) return null;
  return { index: match.index, length: match[0].length, scale };
}

function lastScaleCue(text: string): MoneyScale | null {
  const matches = [...text.matchAll(SCALE_CUE_RE)];
  const match = matches[matches.length - 1];
  if (!match) return null;
  const word = match.slice(1).find((part) => part);
  return word ? cueScale(word) : null;
}

function cueScale(word: string): MoneyScale | null {
  const normalized = word.toLowerCase();
  if (normalized === "000s" || normalized.startsWith("thousand")) return "thousands";
  if (normalized.startsWith("billion")) return "billions";
  if (normalized.startsWith("million")) return "millions";
  return null;
}

function wordScale(word: string): MoneyScale | null {
  if (!word) return null;
  return unitScale(word);
}

function unitScale(raw: string): MoneyScale | null {
  const match = raw
    .toLowerCase()
    .match(/(million|millions|thousand|thousands|billion|billions|bn|mm|m)\s*$/);
  if (!match) return null;
  const unit = match[1];
  if (unit.startsWith("b")) return "billions";
  if (unit.startsWith("t")) return "thousands";
  return "millions";
}

function parseMoney(raw: string): number | null {
  let negative = raw.includes("(") || raw.includes(")");
  let text = raw.toLowerCase().replace(/[$,\s]/g, "").replace(/[()]/g, "");
  text = text.replace(/(million|millions|thousand|thousands|billion|billions|bn|mm|m)$/i, "");
  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

function formatMoney(absolute: number, scale: MoneyScale): string {
  const sign = absolute < 0 ? "-" : "";
  const scaled = Math.abs(absolute) / SCALE_FACTOR[scale];
  const rounded = Math.round(scaled * 1000) / 1000;
  const body = rounded.toLocaleString("en-US", { maximumFractionDigits: 3 });
  const unit =
    scale === "ones"
      ? ""
      : scale === "thousands"
        ? " thousand"
        : scale === "millions"
          ? " million"
          : " billion";
  return `${sign}$${body}${unit}`;
}

function closeMoney(a: number, b: number): boolean {
  const base = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / base <= 0.005;
}

function cueSpan(
  text: string,
  index: number,
  length: number,
): { start: number; end: number } {
  const lineStart = text.lastIndexOf("\n", Math.max(0, index - 1));
  const start = Math.max(lineStart + 1, index - 180);
  const lineEnd = text.indexOf("\n", index + length);
  const end =
    lineEnd === -1
      ? Math.min(text.length, index + length + 180)
      : Math.min(text.length, lineEnd);
  return { start, end: Math.max(end, index + length) };
}

function mergeSpans(
  spans: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const sorted = spans
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (!last || span.start > last.end + 40) merged.push({ ...span });
    else last.end = Math.max(last.end, span.end);
  }
  return merged;
}
