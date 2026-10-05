import { MAX_FILING_CONTEXT_CHARS } from "@/lib/constants";

const KEYWORD_PATTERNS = [
  "total debt",
  "long-term debt",
  "borrowings",
  "credit facility",
  "revolver",
  "revolving",
  "liquidity",
  "cash and cash equivalents",
  "maturity",
  "maturities",
  "covenant",
  "ebitda",
  "interest expense",
  "leverage",
  "interest coverage",
  "debt schedule",
  "senior notes",
  "term loan",
  "indenture",
] as const;

const WINDOW_RADIUS = 900;
const HEAD_CHARS = 12_000;

export type PreparedFilingContext = {
  text: string;
  truncated: boolean;
  originalCharCount: number;
};

function extractKeywordWindows(text: string, maxChars: number): string {
  const lower = text.toLowerCase();
  const spans: Array<{ start: number; end: number }> = [];

  for (const keyword of KEYWORD_PATTERNS) {
    let searchFrom = 0;
    while (searchFrom < lower.length) {
      const idx = lower.indexOf(keyword, searchFrom);
      if (idx === -1) break;
      spans.push({
        start: Math.max(0, idx - WINDOW_RADIUS),
        end: Math.min(text.length, idx + keyword.length + WINDOW_RADIUS),
      });
      searchFrom = idx + keyword.length;
    }
  }

  spans.sort((a, b) => a.start - b.start);

  const merged: Array<{ start: number; end: number }> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (!last || span.start > last.end) {
      merged.push({ ...span });
    } else {
      last.end = Math.max(last.end, span.end);
    }
  }

  const parts: string[] = [];
  let used = 0;

  const head = text.slice(0, Math.min(HEAD_CHARS, text.length));
  parts.push(head);
  used += head.length;

  for (const span of merged) {
    if (used >= maxChars) break;
    const slice = text.slice(span.start, span.end);
    if (used + slice.length + 50 > maxChars) {
      parts.push(slice.slice(0, maxChars - used - 50));
      used = maxChars;
      break;
    }
    parts.push(slice);
    used += slice.length;
  }

  return parts.join("\n\n---\n\n");
}

export function prepareFilingContext(rawText: string): PreparedFilingContext {
  const originalCharCount = rawText.length;

  if (rawText.length <= MAX_FILING_CONTEXT_CHARS) {
    return {
      text: rawText,
      truncated: false,
      originalCharCount,
    };
  }

  const excerpt = extractKeywordWindows(rawText, MAX_FILING_CONTEXT_CHARS);
  const truncatedBody =
    excerpt.length > MAX_FILING_CONTEXT_CHARS
      ? excerpt.slice(0, MAX_FILING_CONTEXT_CHARS)
      : excerpt;

  const preamble = `[Note: The filing text below is an excerpt. The full document was ${originalCharCount.toLocaleString()} characters; credit-relevant sections and the document opening are prioritized. Do not infer figures from omitted sections.]\n\n`;

  return {
    text: preamble + truncatedBody,
    truncated: true,
    originalCharCount,
  };
}
