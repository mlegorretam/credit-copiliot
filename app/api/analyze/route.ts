import { NextResponse } from "next/server";
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

export async function POST(request: Request) {
  logOpenAiEnvStatus();

  try {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json(
        { error: "Invalid form submission." },
        { status: 400 },
      );
    }

    const companyNameRaw = formData.get("companyName");
    if (typeof companyNameRaw !== "string" || !companyNameRaw.trim()) {
      return NextResponse.json(
        { error: "Company name is required." },
        { status: 400 },
      );
    }

    const uploads = readUploadedFiles(formData);
    const validation = validatePdfUploads(uploads);
    if (!validation.ok) {
      return NextResponse.json(
        { error: validation.error },
        { status: validation.status },
      );
    }

    const displayNames = disambiguateFileNames(uploads.map((file) => file.name));
    const companyName = companyNameRaw.trim();
    const included: Array<{
      fileName: string;
      text: string;
      totalPages: number;
      extractedTextChars: number;
    }> = [];
    const extractionNotes: string[] = [];

    for (let index = 0; index < uploads.length; index += 1) {
      const file = uploads[index];
      const fileName = displayNames[index] ?? file.name;
      const buffer = Buffer.from(await file.arrayBuffer());

      try {
        const extracted = await extractPdfText(buffer);
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
            ? "Server is missing OpenAI configuration. Set OPENAI_API_KEY locally."
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
  } catch (err) {
    logAnalyzeError("unexpected", err);
    return NextResponse.json(
      { error: "An unexpected error occurred." },
      { status: 500 },
    );
  }
}
