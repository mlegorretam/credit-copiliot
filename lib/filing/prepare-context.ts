import { quarterlyDisclosureSpans } from "@/lib/credit/quarterly-ebitda";
import {
  MAX_FILING_CONTEXT_CHARS,
  MAX_MULTI_FILING_CONTEXT_CHARS,
} from "@/lib/constants";

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
  "adjusted ebitda",
  "trailing twelve",
  "ttm",
  "ltm",
  "interest expense",
  "cash interest",
  "leverage",
  "interest coverage",
  "debt schedule",
  "senior notes",
  "term loan",
  "indenture",
  "affo",
  "ffo",
  "funds from operations",
  "capital expenditure",
  "capex",
  "net operating income",
  "same-store",
  "same store",
  "occupancy",
  "supplemental",
] as const;

const WINDOW_RADIUS = 900;
const HEAD_CHARS = 12_000;

export type PreparedFilingContext = {
  text: string;
  truncated: boolean;
  originalCharCount: number;
};

function extractKeywordWindows(
  text: string,
  maxChars: number,
  options?: { capHead?: boolean },
): string {
  const reserved = protectedExcerpt(
    text,
    Math.min(6_000, Math.floor(maxChars * 0.4)),
  );
  const reservedLength = reserved ? reserved.length + 8 : 0;
  const body = collectKeywordWindows(
    text,
    Math.max(0, maxChars - reservedLength),
    options,
  );
  if (!reserved) return body;
  return `${reserved}\n\n---\n\n${body}`.slice(0, maxChars);
}

function protectedExcerpt(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  const parts: string[] = [];
  let used = 0;
  for (const span of quarterlyDisclosureSpans(text)) {
    const slice = text.slice(span.start, span.end).trim();
    if (!slice) continue;
    if (used + slice.length > maxChars) {
      if (parts.length === 0) parts.push(slice.slice(0, maxChars));
      break;
    }
    parts.push(slice);
    used += slice.length + 1;
  }
  return parts.join("\n");
}

function collectKeywordWindows(
  text: string,
  maxChars: number,
  options?: { capHead?: boolean },
): string {
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

  const headLimit = options?.capHead
    ? Math.min(HEAD_CHARS, Math.max(2_000, Math.floor(maxChars * 0.4)))
    : HEAD_CHARS;
  const head = text.slice(0, Math.min(headLimit, text.length, maxChars));
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

  return parts.join("\n\n---\n\n").slice(0, maxChars);
}

export type ContextDocument = {
  fileName: string;
  text: string;
  totalPages?: number;
};

function documentHeading(
  document: ContextDocument,
  index: number,
  total: number,
): string {
  const pages =
    document.totalPages && document.totalPages > 0
      ? `, ${document.totalPages} pages`
      : "";
  return `===== DOCUMENT ${index} of ${total}: ${document.fileName}${pages} =====`;
}

function wrapDocument(
  document: ContextDocument,
  body: string,
  index: number,
  total: number,
): string {
  return `${documentHeading(document, index, total)}\n${body}\n===== END DOCUMENT ${index}: ${document.fileName} =====`;
}

function allocateBudgets(lengths: number[], budget: number): number[] {
  const count = lengths.length;
  if (count === 0 || budget <= 0) return lengths.map(() => 0);
  const floor = Math.min(8_000, Math.floor(budget / count));
  const base = lengths.map((length) => Math.min(length, floor));
  const leftover = budget - base.reduce((sum, value) => sum + value, 0);
  const room = lengths.map((length, index) => Math.max(0, length - base[index]));
  const roomSum = room.reduce((sum, value) => sum + value, 0);
  const extra = room.map((value) => {
    if (roomSum === 0 || leftover <= 0) return 0;
    return Math.min(value, Math.floor((leftover * value) / roomSum));
  });
  const allocated = base.map((value, index) => value + extra[index]);
  let used = allocated.reduce((sum, value) => sum + value, 0);
  for (let index = 0; index < count && used < budget; index += 1) {
    const capacity = lengths[index] - allocated[index];
    if (capacity <= 0) continue;
    const add = Math.min(capacity, budget - used);
    allocated[index] += add;
    used += add;
  }
  return allocated;
}

/**
 * Combine one or more extracted filings. A single document keeps the original
 * 100k character budget. Several documents share a larger budget so each
 * source still contributes text.
 */
export function prepareDocumentsContext(
  documents: ContextDocument[],
): PreparedFilingContext {
  const originalCharCount = documents.reduce(
    (sum, document) => sum + document.text.length,
    0,
  );
  if (documents.length === 0) {
    return { text: "", truncated: false, originalCharCount: 0 };
  }

  if (documents.length === 1) {
    const only = documents[0];
    const prepared = prepareFilingContext(only.text);
    return {
      text: wrapDocument(only, prepared.text, 1, 1),
      truncated: prepared.truncated,
      originalCharCount,
    };
  }

  const maxChars = Math.min(
    MAX_MULTI_FILING_CONTEXT_CHARS,
    MAX_FILING_CONTEXT_CHARS * documents.length,
  );
  const overhead = documents.length * 280 + 500;
  const budget = Math.max(1_000, maxChars - overhead);
  const fullLength = documents.reduce(
    (sum, document) => sum + document.text.length,
    0,
  );

  if (fullLength <= budget) {
    const body = documents
      .map((document, index) =>
        wrapDocument(document, document.text, index + 1, documents.length),
      )
      .join("\n\n");
    return { text: body, truncated: false, originalCharCount };
  }

  const shares = allocateBudgets(
    documents.map((document) => document.text.length),
    budget,
  );
  const parts = documents.map((document, index) => {
    const share = shares[index] ?? 0;
    const fits = document.text.length <= share;
    const body = fits
      ? document.text
      : extractKeywordWindows(document.text, share, { capHead: true });
    return wrapDocument(document, body, index + 1, documents.length);
  });

  const preamble = `[Note: The combined filing text below is an excerpt. The uploaded documents totaled ${originalCharCount.toLocaleString()} characters; each document's opening and credit-relevant sections are prioritized. Do not infer figures from omitted sections. Documents: ${documents.map((document) => document.fileName).join("; ")}.]\n\n`;

  return {
    text: preamble + parts.join("\n\n"),
    truncated: true,
    originalCharCount,
  };
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
