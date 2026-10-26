import { NextResponse } from "next/server";
import {
  parseAnalyzeJson,
  type AnalyzeInput,
  type IncludedDocument,
} from "@/lib/analyze/extracted-documents";
import {
  MIN_DOCUMENT_TEXT_CHARS,
  MIN_EXTRACTED_TEXT_CHARS,
} from "@/lib/constants";
import { buildFilingText, buildHistoricalSource } from "@/lib/filing/historical-source";
import { prepareDocumentsContext } from "@/lib/filing/prepare-context";
import { analyzeFilingWithLlm } from "@/lib/llm/analyze-filing";
import { extractPdfText } from "@/lib/pdf/extract-text";
import {
  logAnalyzeError,
  logAnalyzeInfo,
  logOpenAiEnvStatus,
} from "@/lib/server/analyze-logger";
import type { CreditAnalysisResult } from "@/lib/types/credit-analysis";
import {
  disambiguateFileNames,
  validatePdfUploads,
} from "@/lib/uploads/pdf-files";

export const runtime = "nodejs";
export const maxDuration = 120;

function readUploadedFiles(formData: FormData): File[] {
  const raw = [...formData.getAll("file"), ...formData.getAll("files")];
  return raw.filter(
    (item): item is File => item instanceof File && item.name.trim().length > 0,
  );
}

async function documentsFromUploads(
  uploads: File[],
): Promise<{
  included: IncludedDocument[];
  extractionNotes: string[];
}> {
  const displayNames = disambiguateFileNames(uploads.map((file) => file.name));
  const included: IncludedDocument[] = [];
  const extractionNotes: string[] = [];

  for (let index = 0; index < uploads.length; index += 1) {
    const file = uploads[index];
    const fileName = displayNames[index] ?? file.name;
    const bytes = new Uint8Array(await file.arrayBuffer());

    try {
      const extracted = await extractPdfText(bytes);
      logAnalyzeInfo("PDF extracted", {
        fileName,
        fileSizeBytes: file.size,
        totalPages: extracted.totalPages,
        extractedTextChars: extracted.text.length,
      });
      if (extracted.text.length < MIN_DOCUMENT_TEXT_CHARS) {
        extractionNotes.push(
          `${fileName} contained too little extractable text and was excluded.`,
        );
        continue;
      }
      included.push({
        fileName,
        text: extracted.text,
        totalPages: extracted.totalPages,
        extractedTextChars: extracted.text.length,
      });
    } catch (err) {
      logAnalyzeError("pdf-extract", err, {
        fileName,
        fileSizeBytes: file.size,
      });
      extractionNotes.push(
        `${fileName} could not be read as a text-based PDF and was excluded.`,
      );
    }
  }

  return { included, extractionNotes };
}

async function readAnalyzeInput(
  request: Request,
): Promise<{ ok: true; input: AnalyzeInput } | { ok: false; response: NextResponse }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Invalid JSON body." },
          { status: 400 },
        ),
      };
    }
    const parsed = parseAnalyzeJson(payload);
    if (!parsed.ok) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: parsed.error },
          { status: parsed.status },
        ),
      };
    }
    return { ok: true, input: parsed.input };
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Invalid form submission." },
        { status: 400 },
      ),
    };
  }

  const companyNameRaw = formData.get("companyName");
  if (typeof companyNameRaw !== "string" || !companyNameRaw.trim()) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Company name is required." },
        { status: 400 },
      ),
    };
  }

  const uploads = readUploadedFiles(formData);
  const validation = validatePdfUploads(uploads);
  if (!validation.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: validation.error },
        { status: validation.status },
      ),
    };
  }

  const extracted = await documentsFromUploads(uploads);
  return {
    ok: true,
    input: {
      companyName: companyNameRaw.trim(),
      included: extracted.included,
      extractionNotes: extracted.extractionNotes,
    },
  };
}

async function runCreditAnalysis(input: AnalyzeInput) {
  const { companyName, included, extractionNotes } = input;
  const combinedChars = included.reduce(
    (sum, document) => sum + document.text.length,
    0,
  );
  if (included.length === 0 || combinedChars < MIN_EXTRACTED_TEXT_CHARS) {
    const detail = extractionNotes.join(" ");
    return NextResponse.json(
      {
        error: detail
          ? `Too little text was extracted. ${detail} Text-based filings work best; scanned documents without OCR are not supported.`
          : "Too little text was extracted from this PDF. Text-based filings work best; scanned documents without OCR are not supported.",
      },
      { status: 422 },
    );
  }

  const prepared = prepareDocumentsContext(
    included.map((document) => ({
      fileName: document.fileName,
      text: document.text,
      totalPages: document.totalPages,
    })),
  );
  logAnalyzeInfo("Filing context prepared", {
    documentCount: included.length,
    excludedCount: extractionNotes.length,
    originalCharCount: prepared.originalCharCount,
    contextCharCount: prepared.text.length,
    truncated: prepared.truncated,
    omittedSections: prepared.omittedSections,
  });

  let result: CreditAnalysisResult;
  try {
    result = await analyzeFilingWithLlm({
      companyName,
      fileNames: included.map((document) => document.fileName),
      filingExcerpt: prepared.text,
      excerptTruncated: prepared.truncated,
      extractionNotes,
      omissions: prepared.omittedSections,
      historicalSource: buildHistoricalSource(
        included.map((document) => ({
          fileName: document.fileName,
          text: document.text,
          totalPages: document.totalPages,
        })),
      ),
      filingText: buildFilingText(
        included.map((document) => ({
          fileName: document.fileName,
          text: document.text,
          totalPages: document.totalPages,
        })),
      ),
    });
  } catch (err) {
    logAnalyzeError("analyze-filing", err, {
      companyName,
      fileNames: included.map((document) => document.fileName),
      contextCharCount: prepared.text.length,
      truncated: prepared.truncated,
    });
    const message =
      err instanceof Error ? err.message : "Analysis request failed.";
    const isConfig = message.includes("OPENAI_API_KEY");
    return NextResponse.json(
      {
        error: isConfig
          ? "Server is missing OpenAI configuration. Set OPENAI_API_KEY on the host (Vercel) and locally."
          : "Credit analysis failed. Please try again or use a shorter text-based filing.",
        detail: isConfig ? undefined : message,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    result,
    meta: {
      companyName,
      fileName: included.map((document) => document.fileName).join("; "),
      fileNames: included.map((document) => document.fileName),
      totalPages: included.reduce(
        (sum, document) => sum + document.totalPages,
        0,
      ),
      documents: included.map((document) => ({
        fileName: document.fileName,
        totalPages: document.totalPages,
        extractedTextChars: document.extractedTextChars,
      })),
      excluded: extractionNotes,
      excerptTruncated: prepared.truncated,
    },
  });
}

export async function POST(request: Request) {
  logOpenAiEnvStatus();

  try {
    const parsed = await readAnalyzeInput(request);
    if (!parsed.ok) return parsed.response;
    return await runCreditAnalysis(parsed.input);
  } catch (err) {
    logAnalyzeError("unexpected", err);
    return NextResponse.json(
      { error: "An unexpected error occurred." },
      { status: 500 },
    );
  }
}
