const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

const MONTH_PATTERN =
  "January|February|March|April|May|June|July|August|September|October|November|December";

const REPORTING_DATE_RE = new RegExp(
  `\\b(?:as of|ended)\\s+((?:${MONTH_PATTERN})\\s+\\d{1,2},\\s+20\\d{2})`,
  "gi",
);

export type ReportingDate = {
  label: string;
  time: number;
};

/** Split extracted filing text into lines and sentences without breaking tables. */
export function splitFinancialSegments(text: string): string[] {
  const segments: string[] = [];
  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/(?<=\.)\s+(?=[A-Z\[\(])/);
    for (const part of parts) {
      const segment = part.trim();
      if (segment) segments.push(segment);
    }
  }
  return segments;
}

export function sourceDocumentAt(
  excerpt: string,
  index: number,
  fileNames: string[],
): string {
  const marker = /===== DOCUMENT \d+ of \d+: ([^\n=]+) =====/g;
  let found = "";
  for (const match of excerpt.matchAll(marker)) {
    if ((match.index ?? 0) > index) break;
    found = match[1].replace(/,\s*\d+\s+pages\s*$/i, "").trim();
  }
  if (found) return found;
  return fileNames.length === 1 ? fileNames[0] : "";
}

export function reportingDatesIn(text: string): ReportingDate[] {
  const found: ReportingDate[] = [];
  for (const match of text.matchAll(REPORTING_DATE_RE)) {
    const parsed = parseReportingDate(match[1] ?? "");
    if (parsed) found.push(parsed);
  }
  return found;
}

export function latestReportingDate(text: string): ReportingDate | null {
  let best: ReportingDate | null = null;
  for (const date of reportingDatesIn(text)) {
    if (!best || date.time > best.time) best = date;
  }
  return best;
}

export function parseReportingDate(raw: string): ReportingDate | null {
  const match = raw
    .trim()
    .match(
      new RegExp(`^(${MONTH_PATTERN})\\s+(\\d{1,2}),\\s+(20\\d{2})$`, "i"),
    );
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month == null || day < 1 || day > 31) return null;
  return {
    label: `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()} ${day}, ${year}`,
    time: Date.UTC(year, month, day),
  };
}

export function sameReportingDate(left: string, right: string): boolean {
  const a = parseReportingDate(left);
  const b = parseReportingDate(right);
  if (!a || !b) return left.trim().toLowerCase() === right.trim().toLowerCase();
  return a.time === b.time;
}
