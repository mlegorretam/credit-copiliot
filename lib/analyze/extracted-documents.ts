import {
  MAX_PDF_FILES,
  MIN_DOCUMENT_TEXT_CHARS,
} from "@/lib/constants";
import { disambiguateFileNames } from "@/lib/uploads/pdf-files";

export type IncludedDocument = {
  fileName: string;
  text: string;
  totalPages: number;
  extractedTextChars: number;
};

export type AnalyzeInput = {
  companyName: string;
  included: IncludedDocument[];
  extractionNotes: string[];
};

export type AnalyzeParseResult =
  | { ok: true; input: AnalyzeInput }
  | { ok: false; error: string; status: number };

export function parseAnalyzeJson(payload: unknown): AnalyzeParseResult {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Invalid JSON body.", status: 400 };
  }

  const body = payload as Record<string, unknown>;
  const companyName =
    typeof body.companyName === "string" ? body.companyName.trim() : "";
  if (!companyName) {
    return { ok: false, error: "Company name is required.", status: 400 };
  }

  if (!Array.isArray(body.documents)) {
    return { ok: false, error: "Extracted documents are required.", status: 400 };
  }
  if (body.documents.length > MAX_PDF_FILES) {
    return {
      ok: false,
      error: `Upload up to ${MAX_PDF_FILES} PDFs at a time.`,
      status: 400,
    };
  }

  const extractionNotes = Array.isArray(body.extractionNotes)
    ? body.extractionNotes.filter(
        (note): note is string =>
          typeof note === "string" && note.trim().length > 0,
      )
    : [];

  const included: IncludedDocument[] = [];
  for (const item of body.documents) {
    if (!item || typeof item !== "object") {
      return { ok: false, error: "Each document is invalid.", status: 400 };
    }
    const document = item as Record<string, unknown>;
    const fileName =
      typeof document.fileName === "string" ? document.fileName.trim() : "";
    const text = typeof document.text === "string" ? document.text : "";
    const totalPages =
      typeof document.totalPages === "number" &&
      Number.isFinite(document.totalPages)
        ? Math.max(0, Math.floor(document.totalPages))
        : 0;

    if (!fileName) {
      return {
        ok: false,
        error: "Each document needs a file name.",
        status: 400,
      };
    }
    if (text.length < MIN_DOCUMENT_TEXT_CHARS) {
      extractionNotes.push(
        `${fileName} contained too little extractable text and was excluded.`,
      );
      continue;
    }

    included.push({
      fileName,
      text,
      totalPages,
      extractedTextChars: text.length,
    });
  }

  const names = disambiguateFileNames(included.map((document) => document.fileName));
  return {
    ok: true,
    input: {
      companyName,
      included: included.map((document, index) => ({
        ...document,
        fileName: names[index] ?? document.fileName,
      })),
      extractionNotes,
    },
  };
}
