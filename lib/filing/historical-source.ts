import { MATURITY_CUE_RE } from "@/lib/credit/disclosed-maturities";

type StatementDocument = {
  fileName: string;
  text: string;
  totalPages?: number;
};

type Range = {
  start: number;
  end: number;
};

type LineSpan = {
  text: string;
  index: number;
};

/**
 * Keep complete financial statements from the full extracted text.
 * The model excerpt can drop these tables; historical metrics are read from this slice instead.
 */
/** Full extracted text, with the same document markers used by the statement slice. */
export function buildFilingText(documents: StatementDocument[]): string {
  return documents
    .map((document, index) => {
      const pages =
        document.totalPages && document.totalPages > 0
          ? `, ${document.totalPages} pages`
          : "";
      return `===== DOCUMENT ${index + 1} of ${documents.length}: ${document.fileName}${pages} =====\n${document.text}`;
    })
    .join("\n\n");
}

export function buildHistoricalSource(documents: StatementDocument[]): string {
  return documents
    .map((document, index) => {
      const pages =
        document.totalPages && document.totalPages > 0
          ? `, ${document.totalPages} pages`
          : "";
      const body = selectStatementText(document.text);
      return `===== DOCUMENT ${index + 1} of ${documents.length}: ${document.fileName}${pages} =====\n${body}`;
    })
    .join("\n\n");
}

export function selectStatementText(text: string): string {
  const lines = lineSpans(text);
  const ranges: Range[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const kind = statementKind(lines[index]?.text ?? "");
    if (kind) {
      ranges.push(statementRange(lines, index, kind));
      continue;
    }
    if (MATURITY_CUE_RE.test(lines[index]?.text ?? "")) {
      ranges.push(windowRange(lines, index, 50, 32));
    }
  }
  if (ranges.length === 0) return text;
  return mergeRanges(ranges)
    .map((range) => text.slice(range.start, range.end).trim())
    .filter(Boolean)
    .join("\n\n");
}

function statementKind(line: string): "statement" | "ebitda" | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 140) return null;
  if (isHeadingLine(trimmed, /^consolidated balance sheets?\b/i)) return "statement";
  if (
    isHeadingLine(
      trimmed,
      /^consolidated statements? of (?:operations(?: and comprehensive income)?|comprehensive income|income|earnings)\b/i,
    )
  ) {
    return "statement";
  }
  if (isHeadingLine(trimmed, /^consolidated statements? of cash flows\b/i)) return "statement";
  if (
    isHeadingLine(trimmed, /^reconciliation of net income(?: \(loss\))? to adjusted ebitda\b/i)
  ) {
    return "ebitda";
  }
  if (
    trimmed.length <= 200 &&
    /adjusted ebitda/i.test(trimmed) &&
    /calculated as follows/i.test(trimmed)
  ) {
    return "ebitda";
  }
  return null;
}

function isHeadingLine(line: string, pattern: RegExp): boolean {
  const match = line.match(pattern);
  if (!match) return false;
  const rest = line
    .slice(match[0].length)
    .replace(/^[.\s]+/, "")
    .trim();
  if (!rest) return true;
  return /^\([^)]*\)[:.]?$/.test(rest);
}

function statementRange(
  lines: LineSpan[],
  heading: number,
  kind: "statement" | "ebitda",
): Range {
  const before = kind === "statement" ? 8 : 2;
  const limit = kind === "statement" ? 170 : 28;
  const startLine = Math.max(0, heading - before);
  let endLine = Math.min(lines.length - 1, heading + limit);
  for (let index = heading + 1; index <= endLine; index += 1) {
    const text = lines[index]?.text ?? "";
    if (
      kind === "statement" &&
      /the accompanying notes are an integral part of these consolidated financial statements/i.test(
        text,
      )
    ) {
      endLine = index;
      break;
    }
    if (index > heading + 1 && statementKind(text)) {
      endLine = index - 1;
      break;
    }
    if (
      kind === "ebitda" &&
      /^reconciliation of\b/i.test(text.trim()) &&
      !/adjusted ebitda/i.test(text)
    ) {
      endLine = index - 1;
      break;
    }
  }
  return {
    start: lines[startLine]?.index ?? 0,
    end: lineEnd(lines[endLine], lines),
  };
}

function windowRange(lines: LineSpan[], center: number, before: number, after: number): Range {
  const startLine = Math.max(0, center - before);
  const endLine = Math.min(lines.length - 1, center + after);
  return {
    start: lines[startLine]?.index ?? 0,
    end: lineEnd(lines[endLine], lines),
  };
}

function lineEnd(line: LineSpan | undefined, lines: LineSpan[]): number {
  if (!line) return 0;
  const last = lines[lines.length - 1];
  if (line === last) return line.index + line.text.length;
  return line.index + line.text.length + 1;
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 2) {
      last.end = Math.max(last.end, range.end);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

function lineSpans(text: string): LineSpan[] {
  const lines: LineSpan[] = [];
  let index = 0;
  for (const line of text.split("\n")) {
    lines.push({ text: line, index });
    index += line.length + 1;
  }
  return lines;
}
