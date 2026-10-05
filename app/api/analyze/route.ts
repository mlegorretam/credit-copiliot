import { NextResponse } from "next/server";
import {
  MAX_PDF_BYTES,
  MIN_EXTRACTED_TEXT_CHARS,
} from "@/lib/constants";
import { prepareFilingContext } from "@/lib/filing/prepare-context";
import { analyzeFilingWithLlm } from "@/lib/llm/analyze-filing";
import { extractPdfText } from "@/lib/pdf/extract-text";
import {
  logAnalyzeError,
  logAnalyzeInfo,
  logOpenAiEnvStatus,
} from "@/lib/server/analyze-logger";
import type { CreditAnalysisResult } from "@/lib/types/credit-analysis";

export const runtime = "nodejs";
export const maxDuration = 60;

function isPdfUpload(file: File): boolean {
  return (
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf")
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
    const fileRaw = formData.get("file");

    if (typeof companyNameRaw !== "string" || !companyNameRaw.trim()) {
      return NextResponse.json(
        { error: "Company name is required." },
        { status: 400 },
      );
    }

    if (!(fileRaw instanceof File)) {
      return NextResponse.json(
        { error: "A PDF filing is required." },
        { status: 400 },
      );
    }

    if (!isPdfUpload(fileRaw)) {
      return NextResponse.json(
        { error: "Only PDF files are supported." },
        { status: 400 },
      );
    }

    if (fileRaw.size > MAX_PDF_BYTES) {
      return NextResponse.json(
        { error: "PDF must be 10 MB or smaller." },
        { status: 413 },
      );
    }

    if (fileRaw.size === 0) {
      return NextResponse.json(
        { error: "The uploaded PDF is empty." },
        { status: 400 },
      );
    }

    const companyName = companyNameRaw.trim();
    const buffer = Buffer.from(await fileRaw.arrayBuffer());

    let extracted;
    try {
      extracted = await extractPdfText(buffer);
      logAnalyzeInfo("PDF extracted", {
        fileName: fileRaw.name,
        fileSizeBytes: fileRaw.size,
        totalPages: extracted.totalPages,
        extractedTextChars: extracted.text.length,
      });
    } catch (err) {
      logAnalyzeError("pdf-extract", err, {
        fileName: fileRaw.name,
        fileSizeBytes: fileRaw.size,
      });
      return NextResponse.json(
        {
          error:
            "Could not read this PDF. Ensure it is a text-based document (not a scanned image).",
        },
        { status: 422 },
      );
    }

    if (extracted.text.length < MIN_EXTRACTED_TEXT_CHARS) {
      return NextResponse.json(
        {
          error:
            "Too little text was extracted from this PDF. Text-based filings work best; scanned documents without OCR are not supported.",
        },
        { status: 422 },
      );
    }

    const prepared = prepareFilingContext(extracted.text);
    logAnalyzeInfo("Filing context prepared", {
      originalCharCount: prepared.originalCharCount,
      contextCharCount: prepared.text.length,
      truncated: prepared.truncated,
    });

    let result: CreditAnalysisResult;
    try {
      result = await analyzeFilingWithLlm({
        companyName,
        fileName: fileRaw.name,
        filingExcerpt: prepared.text,
        excerptTruncated: prepared.truncated,
      });
    } catch (err) {
      logAnalyzeError("analyze-filing", err, {
        companyName,
        fileName: fileRaw.name,
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
        fileName: fileRaw.name,
        totalPages: extracted.totalPages,
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
