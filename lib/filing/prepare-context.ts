import {
  MAX_FILING_CONTEXT_CHARS,
  MAX_MULTI_FILING_CONTEXT_CHARS,
} from "@/lib/constants";
import { selectFinancialExcerpt } from "@/lib/filing/select-financial-context";

export type PreparedFilingContext = {
  text: string;
  truncated: boolean;
  originalCharCount: number;
  /** Section titles that were left out of the model context. */
  omittedSections: string[];
};

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
  const floor = Math.min(36_000, Math.floor(budget / count));
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

function reductionNote(omittedSections: string[]): string {
  if (omittedSections.length === 0) {
    return "[Context reduction: unlabeled text was shortened. Credit-related excerpts were retained. Omitted text is not represented and must not be inferred.]\n\n";
  }
  return `[Context reduction: some sections were omitted and must not be inferred. Omitted: ${omittedSections.join(" | ")}. Retained excerpts prioritize the income statement, balance sheet, debt footnotes, maturity schedules, liquidity, quarterly earnings measures, covenants, and cash flow statements.]\n\n`;
}

/**
 * Combine one or more extracted filings. A single document keeps the original
 * character budget. Several documents share a larger budget so each source
 * still contributes its credit-relevant sections.
 */
export function prepareDocumentsContext(
  documents: ContextDocument[],
): PreparedFilingContext {
  const originalCharCount = documents.reduce(
    (sum, document) => sum + document.text.length,
    0,
  );
  if (documents.length === 0) {
    return { text: "", truncated: false, originalCharCount: 0, omittedSections: [] };
  }

  if (documents.length === 1) {
    const only = documents[0];
    const prepared = prepareFilingContext(only.text);
    return {
      text: wrapDocument(only, prepared.text, 1, 1),
      truncated: prepared.truncated,
      originalCharCount,
      omittedSections: prepared.omittedSections.map((section) => `${only.fileName}: ${section}`),
    };
  }

  const maxChars = Math.min(
    MAX_MULTI_FILING_CONTEXT_CHARS,
    MAX_FILING_CONTEXT_CHARS * documents.length,
  );
  const overhead = documents.length * 280 + 800;
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
    return { text: body, truncated: false, originalCharCount, omittedSections: [] };
  }

  const shares = allocateBudgets(
    documents.map((document) => document.text.length),
    budget,
  );
  const omittedSections: string[] = [];
  const parts = documents.map((document, index) => {
    const share = shares[index] ?? 0;
    const fits = document.text.length <= share;
    if (fits) return wrapDocument(document, document.text, index + 1, documents.length);
    const selected = selectFinancialExcerpt(document.text, share);
    for (const section of selected.omitted) {
      omittedSections.push(`${document.fileName}: ${section}`);
    }
    return wrapDocument(document, selected.text, index + 1, documents.length);
  });

  return {
    text: reductionNote(omittedSections) + parts.join("\n\n"),
    truncated: true,
    originalCharCount,
    omittedSections,
  };
}

export function prepareFilingContext(rawText: string): PreparedFilingContext {
  const originalCharCount = rawText.length;
  if (rawText.length <= MAX_FILING_CONTEXT_CHARS) {
    return {
      text: rawText,
      truncated: false,
      originalCharCount,
      omittedSections: [],
    };
  }

  const selected = selectFinancialExcerpt(rawText, MAX_FILING_CONTEXT_CHARS);
  return {
    text: reductionNote(selected.omitted) + selected.text,
    truncated: true,
    originalCharCount,
    omittedSections: selected.omitted,
  };
}
