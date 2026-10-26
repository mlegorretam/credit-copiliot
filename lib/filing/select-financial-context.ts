import { quarterlyDisclosureSpans } from "@/lib/credit/quarterly-ebitda";
import { latestReportingDate } from "@/lib/credit/financial-segments";

export type FinancialExcerpt = {
  text: string;
  omitted: string[];
};

type Slice = {
  start: number;
  end: number;
  score: number;
  label: string;
};

type Section = {
  title: string;
  start: number;
  end: number;
  text: string;
};

const KEYWORD_RADIUS = 1_200;

const SHARED_KEYWORDS = [
  "total debt",
  "long-term debt",
  "senior notes",
  "term loan",
  "revolving",
  "undrawn",
  "availability",
  "maturity",
  "maturities",
  "covenant",
  "cash interest",
  "interest paid",
  "interest expense",
  "capital expenditure",
  "capex",
  "total revenues",
  "operating income",
  "net cash provided by operating",
  "net leverage",
  "leverage ratio",
  "carrying value",
  "carrying amount",
  "liquidity",
  "affo",
  "credit facility",
] as const;

const TAIL_KEYWORDS = ["ebitda", "ttm", "ltm"] as const;

/**
 * Keep credit-relevant sections instead of the start of a long filing.
 * Omitted section titles are returned so the caller can say what was dropped.
 */
export function selectFinancialExcerpt(
  text: string,
  maxChars: number,
): FinancialExcerpt {
  if (maxChars <= 0) return { text: "", omitted: [] };
  if (text.length <= maxChars) return { text, omitted: [] };

  const sections = splitSections(text);
  const slices: Slice[] = [];

  for (const span of quarterlyDisclosureSpans(text)) {
    slices.push({
      start: span.start,
      end: span.end,
      score: 120,
      label: "Quarterly earnings measure",
    });
  }

  for (const section of sections) {
    const score = scoreSection(section);
    if (score <= 0) continue;
    if (section.end - section.start <= 12_000) {
      slices.push({
        start: section.start,
        end: section.end,
        score,
        label: section.title,
      });
      continue;
    }
    const header = headerSlice(section, score);
    if (header) slices.push(header);
    for (const cluster of numericClusters(section, score)) {
      slices.push(cluster);
    }
  }

  for (const keyword of SHARED_KEYWORDS) {
    for (const span of keywordSpans(text, keyword, 2, 2)) {
      slices.push({ ...span, score: 70, label: "Credit disclosure" });
    }
  }
  for (const keyword of TAIL_KEYWORDS) {
    for (const span of keywordSpans(text, keyword, 0, 2)) {
      slices.push({ ...span, score: 65, label: "Credit disclosure" });
    }
  }

  let chosen = packSlices(extendForScale(text, slices), maxChars);
  const rendered = renderSlices(text, chosen);
  while (rendered.text.length > maxChars && chosen.length > 1) {
    const lowest = [...chosen].sort((a, b) => a.score - b.score || b.start - a.start)[0];
    chosen = chosen.filter((slice) => slice !== lowest);
    const next = renderSlices(text, chosen);
    if (next.text.length >= rendered.text.length && next.text.length > maxChars) break;
    rendered.text = next.text;
  }
  const omitted = omittedLabels(sections, chosen, text);
  if (!rendered.text) {
    return {
      text: text.slice(Math.max(0, text.length - maxChars)),
      omitted: omitted.length > 0 ? omitted : ["Unlabeled portions of the document"],
    };
  }
  if (rendered.text.length > maxChars) {
    return {
      text: rendered.text.slice(0, maxChars),
      omitted: omitted.length > 0 ? omitted : ["Unlabeled portions of the document (partial)"],
    };
  }
  return { text: rendered.text, omitted };
}

function renderSlices(text: string, slices: Slice[]): { text: string } {
  const ordered = [...slices].sort((a, b) => a.start - b.start);
  const textBody = ordered
    .map((slice) => {
      const chunk = text.slice(slice.start, slice.end).trim();
      if (!chunk) return "";
      const date = latestReportingDate(chunk);
      const label = slice.label.trim();
      const prefix = label
        ? `[Section: ${label}${date ? ` | Reporting date: ${date.label}` : ""}]\n`
        : "";
      return `${prefix}${chunk}`;
    })
    .filter(Boolean)
    .join("\n\n---\n\n");
  return { text: textBody };
}

function splitSections(text: string): Section[] {
  const sections: Section[] = [];
  let start = 0;
  let title = "Document";
  const lines = text.split("\n");
  let cursor = 0;
  for (const line of lines) {
    const heading = headingTitle(line);
    if (heading && cursor === start) {
      title = heading;
    } else if (heading && cursor > start) {
      sections.push({
        title,
        start,
        end: cursor,
        text: text.slice(start, cursor),
      });
      title = heading;
      start = cursor;
    }
    cursor += line.length + 1;
  }
  sections.push({
    title,
    start,
    end: text.length,
    text: text.slice(start),
  });
  return sections.filter((section) => section.end > section.start);
}

function headingTitle(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length < 4 || trimmed.length > 140) return null;
  if (/^item\s+\d+[a-z]?([\.\)]|\s)/i.test(trimmed)) return trimmed;
  if (/^note\s+\d+([\.\)]|\s|-)/i.test(trimmed)) return trimmed;
  if (
    /^consolidated\s+(balance|statements?|statement)/i.test(trimmed) &&
    !trimmed.includes(",")
  ) {
    return trimmed;
  }
  if (
    /^(liquidity and capital resources|debt maturities|contractual obligations|credit facilities)$/i.test(
      trimmed,
    )
  ) {
    return trimmed;
  }
  return null;
}

function scoreSection(section: Section): number {
  const title = section.title.toLowerCase();
  const body = section.text.toLowerCase();
  let score = 0;
  if (/balance sheet/.test(title) || /consolidated balance sheet/.test(body.slice(0, 400))) {
    score += 100;
  }
  if (/cash flow/.test(title)) score += 85;
  if (/statements? of (?:operations|income|earnings|comprehensive income)/.test(title)) {
    score += 95;
  }
  if (/^note\b/.test(title) && /debt|borrow|credit|note/.test(title)) score += 110;
  if (/liquidity|capital resource/.test(title)) score += 90;
  if (/maturity|maturities/.test(title)) score += 90;
  if (/long-term debt|senior notes|credit facility|borrowings/.test(body)) score += 80;
  if (/cash and cash equivalents|total assets/.test(body)) score += 40;
  if (/interest paid|interest expense|capital expenditure|\bcapex\b/.test(body)) score += 35;
  if (/adjusted ebitda|ebitda reconciliation|trailing twelve/.test(body)) score += 75;
  if (/covenant|net leverage|leverage ratio/.test(body)) score += 45;
  if (/revolving|undrawn|available credit|unused commitment/.test(body)) score += 40;
  if (/^item\s+1a?\b/.test(title) && score < 90) return 0;
  return score;
}

function headerSlice(section: Section, score: number): Slice | null {
  const head = section.text.slice(0, 2_500);
  if (!/\$|million|thousand|debt|cash|interest|leverage|revolving/i.test(head)) {
    return null;
  }
  return {
    start: section.start,
    end: Math.min(section.end, section.start + head.length),
    score: score + 5,
    label: section.title,
  };
}

function numericClusters(section: Section, score: number): Slice[] {
  const lines = section.text.split("\n");
  const clusters: Slice[] = [];
  let clusterStart: number | null = null;
  let cursor = section.start;
  let lastNumeric = cursor;

  const flush = (end: number) => {
    if (clusterStart == null) return;
    const start = Math.max(section.start, clusterStart - 400);
    const cappedEnd = Math.min(section.end, end, start + 10_000);
    if (cappedEnd - start > 80) {
      clusters.push({
        start,
        end: cappedEnd,
        score: score + 8,
        label: section.title,
      });
    }
    clusterStart = null;
  };

  for (const line of lines) {
    const next = cursor + line.length + 1;
    if (isNumericLine(line)) {
      if (clusterStart == null) clusterStart = cursor;
      lastNumeric = next;
    } else if (clusterStart != null && cursor - lastNumeric > 180) {
      flush(lastNumeric);
    }
    cursor = next;
  }
  flush(lastNumeric);
  return clusters;
}

function isNumericLine(line: string): boolean {
  return /\$\s*\d|\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?\s*(?:million|billion|thousand)/i.test(
    line,
  );
}

function keywordSpans(
  text: string,
  keyword: string,
  keepFirst: number,
  keepLast: number,
): Array<{ start: number; end: number }> {
  const lower = text.toLowerCase();
  const indexes: number[] = [];
  let from = 0;
  while (from < lower.length) {
    const index = lower.indexOf(keyword, from);
    if (index === -1) break;
    indexes.push(index);
    from = index + keyword.length;
  }
  const selected = new Set<number>();
  for (const index of indexes.slice(0, keepFirst)) selected.add(index);
  for (const index of indexes.slice(-keepLast)) selected.add(index);
  return [...selected].sort((a, b) => a - b).map((index) => ({
    start: Math.max(0, index - KEYWORD_RADIUS),
    end: Math.min(text.length, index + keyword.length + KEYWORD_RADIUS),
  }));
}

function extendForScale(text: string, slices: Slice[]): Slice[] {
  return slices.map((slice) => {
    const before = text.slice(Math.max(0, slice.start - 500), slice.start);
    const match = before.match(
      /(?:\$\s*in\s+(?:thousands|millions|billions)|in\s+(?:000s|thousands|millions|billions)[^\n]*)/i,
    );
    if (!match || match.index == null) return slice;
    const start = Math.max(0, slice.start - 500) + match.index;
    return { ...slice, start: Math.min(slice.start, start) };
  });
}

function packSlices(slices: Slice[], maxChars: number): Slice[] {
  const ordered = [...slices].sort((a, b) => b.score - a.score || a.start - b.start);
  const chosen: Slice[] = [];
  let used = 0;
  for (const slice of ordered) {
    if (used >= maxChars) break;
    for (const part of subtractOverlap(slice, chosen)) {
      const length = part.end - part.start;
      if (length < 80) continue;
      if (used + length > maxChars) {
        if (part.score >= 80 && maxChars - used > 400) {
          chosen.push({ ...part, end: part.start + (maxChars - used) });
          used = maxChars;
        }
        continue;
      }
      chosen.push(part);
      used += length + 8;
    }
  }
  return chosen.sort((a, b) => a.start - b.start);
}

function subtractOverlap(slice: Slice, chosen: Slice[]): Slice[] {
  let parts = [slice];
  for (const taken of chosen) {
    const next: Slice[] = [];
    for (const part of parts) {
      if (part.end <= taken.start || part.start >= taken.end) {
        next.push(part);
        continue;
      }
      if (part.start < taken.start) next.push({ ...part, end: taken.start });
      if (part.end > taken.end) next.push({ ...part, start: taken.end });
    }
    parts = next;
  }
  return parts;
}

function omittedLabels(sections: Section[], chosen: Slice[], text: string): string[] {
  const labels: string[] = [];
  for (const section of sections) {
    const covered = chosen.reduce((sum, slice) => {
      const start = Math.max(section.start, slice.start);
      const end = Math.min(section.end, slice.end);
      return sum + Math.max(0, end - start);
    }, 0);
    const length = Math.max(1, section.end - section.start);
    if (covered === 0) {
      labels.push(section.title === "Document" ? "Unlabeled portions of the document" : section.title);
    } else if (covered / length < 0.6 && length > 4_000) {
      const title = section.title === "Document" ? "Unlabeled portions of the document" : section.title;
      labels.push(`${title} (partial)`);
    }
  }
  if (labels.length === 0 && chosen.length > 0) {
    const covered = chosen.reduce((sum, slice) => sum + (slice.end - slice.start), 0);
    if (covered + 1_000 < text.length) labels.push("Unlabeled portions of the document");
  }
  const unique: string[] = [];
  for (const label of labels) {
    if (!unique.includes(label)) unique.push(label);
  }
  return unique.slice(0, 12);
}
