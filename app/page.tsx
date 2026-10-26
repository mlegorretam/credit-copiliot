"use client";

import { useCallback, useRef, useState } from "react";
import { AnalysisResults } from "@/components/AnalysisResults";
import {
  MAX_HOSTED_UPLOAD_BYTES,
  MAX_PDF_BYTES,
  MAX_PDF_FILES,
  MAX_TOTAL_PDF_BYTES,
} from "@/lib/constants";
import { extractPdfUploads } from "@/lib/pdf/extract-uploads";
import { sampleAnalysis } from "@/lib/preview/sample-analysis";
import type { CreditAnalysisResult } from "@/lib/types/credit-analysis";
import { addPdfSelections } from "@/lib/uploads/pdf-files";

function formatMaxSizeMb(): string {
  return `${MAX_PDF_BYTES / (1024 * 1024)} MB`;
}

function formatTotalSizeMb(): string {
  return `${MAX_TOTAL_PDF_BYTES / (1024 * 1024)} MB`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function totalFileBytes(uploads: File[]): number {
  return uploads.reduce((sum, file) => sum + file.size, 0);
}

function analyzeErrorFromResponse(status: number, raw: string): string {
  try {
    const payload = JSON.parse(raw) as { error?: string; detail?: string };
    const parts = [payload.error, payload.detail].filter(Boolean);
    if (parts.length > 0) return parts.join(" ");
  } catch {
    // Vercel 413/504 responses are often HTML or plain text, not JSON.
  }
  if (status === 413) {
    return "This filing is too large for the hosted server. Try a smaller text-based PDF, or run the analysis locally.";
  }
  if (status === 504 || status === 408) {
    return "The analysis timed out. Try fewer or shorter filings.";
  }
  if (status >= 500) {
    return "The server could not complete this analysis. Please try again.";
  }
  return "Analysis failed. Please try again with a text-based PDF.";
}

function SampleResultsPreview() {
  return (
    <>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 id="results-heading" className="text-lg font-semibold text-slate-900">
          Analysis preview
        </h2>
        <span className="inline-flex w-fit items-center rounded border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-900">
          Sample results — for layout preview only
        </span>
      </div>
      <p className="mt-2 text-sm text-slate-600">
        Run an analysis to replace this preview with output from your uploaded
        filings. The sample figures below are checked against a short sample
        excerpt, not a live company filing.
      </p>
      <div className="mt-6">
        <AnalysisResults result={sampleAnalysis} heading="Analysis preview" />
      </div>
    </>
  );
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<File[]>([]);
  const [companyName, setCompanyName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [analysisResult, setAnalysisResult] =
    useState<CreditAnalysisResult | null>(null);

  const addIncomingFiles = useCallback((incoming: File[]) => {
    if (incoming.length === 0) return;
    const outcome = addPdfSelections(filesRef.current, incoming);
    filesRef.current = outcome.files;
    setFiles(outcome.files);
    setFileError(outcome.error);
  }, []);

  const removeFileAt = useCallback((index: number) => {
    const next = filesRef.current.filter((_, itemIndex) => itemIndex !== index);
    filesRef.current = next;
    setFiles(next);
    setFileError(null);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      addIncomingFiles(Array.from(e.dataTransfer.files));
    },
    [addIncomingFiles],
  );

  const onAnalyze = async (e: React.FormEvent) => {
    e.preventDefault();
    setAnalysisError(null);

    if (!companyName.trim()) {
      setAnalysisError("Enter a company name before analyzing.");
      return;
    }
    if (files.length === 0) {
      setAnalysisError("Upload at least one PDF filing before analyzing.");
      return;
    }

    setIsAnalyzing(true);
    setStatusMessage("Analyzing documents… This may take up to a minute.");

    try {
      let response: Response;
      if (totalFileBytes(files) > MAX_HOSTED_UPLOAD_BYTES) {
        setStatusMessage("Extracting text from large filings…");
        const extracted = await extractPdfUploads(files);
        if (extracted.documents.length === 0) {
          const detail = extracted.extractionNotes.join(" ");
          setAnalysisError(
            detail
              ? `Too little text was extracted. ${detail} Text-based filings work best; scanned documents without OCR are not supported.`
              : "Too little text was extracted from this PDF. Text-based filings work best; scanned documents without OCR are not supported.",
          );
          return;
        }

        const body = JSON.stringify({
          companyName: companyName.trim(),
          documents: extracted.documents,
          extractionNotes: extracted.extractionNotes,
        });
        if (new TextEncoder().encode(body).length > MAX_HOSTED_UPLOAD_BYTES) {
          setAnalysisError(
            "Extracted filing text is too large for the hosted server. Try fewer filings.",
          );
          return;
        }

        setStatusMessage(
          "Analyzing documents… This may take up to a minute, and longer when several filings are included.",
        );
        response = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
      } else {
        const formData = new FormData();
        formData.append("companyName", companyName.trim());
        for (const file of files) {
          formData.append("file", file);
        }
        response = await fetch("/api/analyze", {
          method: "POST",
          body: formData,
        });
      }

      const raw = await response.text();
      let payload: {
        error?: string;
        detail?: string;
        result?: CreditAnalysisResult;
      };
      try {
        payload = JSON.parse(raw) as {
          error?: string;
          detail?: string;
          result?: CreditAnalysisResult;
        };
      } catch {
        setAnalysisError(analyzeErrorFromResponse(response.status, raw));
        return;
      }

      if (!response.ok) {
        setAnalysisError(analyzeErrorFromResponse(response.status, raw));
        return;
      }

      if (!payload.result) {
        setAnalysisError("Analysis returned no results.");
        return;
      }

      setAnalysisResult(payload.result);
    } catch {
      setAnalysisError(
        "Could not reach the server. Check your connection and try again.",
      );
    } finally {
      setIsAnalyzing(false);
      setStatusMessage(null);
    }
  };

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
          <p className="text-xs font-medium uppercase tracking-widest text-slate-500">
            Institutional credit workflow
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
            Credit Copilot
          </h1>
          <p className="mt-2 text-base text-slate-600 sm:text-lg">
            AI-powered first-pass credit analysis
          </p>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        <p className="max-w-2xl text-sm leading-relaxed text-slate-600 sm:text-base">
          Upload one or more company filings to identify key credit risks,
          financial metrics, and areas for further diligence.
        </p>

        <form
          onSubmit={onAnalyze}
          className="mt-8 space-y-6 rounded-lg border border-slate-200 bg-white p-6 shadow-sm sm:p-8"
        >
          <div>
            <label
              htmlFor="company-name"
              className="block text-sm font-medium text-slate-800"
            >
              Company name
            </label>
            <input
              id="company-name"
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="e.g., Acme Holdings Inc."
              disabled={isAnalyzing}
              className="mt-2 w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200 disabled:bg-slate-50 disabled:text-slate-500"
            />
          </div>

          <div>
            <span className="block text-sm font-medium text-slate-800">
              Upload company filings
            </span>
            <p className="mt-1 text-xs text-slate-500">
              PDF only — 10-K, 10-Q, earnings release, or supplemental
              financials. Up to {MAX_PDF_FILES} files, {formatMaxSizeMb()} each
              ({formatTotalSizeMb()} combined).
            </p>
            <div
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (isAnalyzing) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  inputRef.current?.click();
                }
              }}
              onDragEnter={(e) => {
                e.preventDefault();
                if (!isAnalyzing) setDragActive(true);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (!isAnalyzing) setDragActive(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                setDragActive(false);
              }}
              onDrop={onDrop}
              onClick={() => {
                if (!isAnalyzing) inputRef.current?.click();
              }}
              className={`mt-3 flex flex-col items-center justify-center rounded-md border-2 border-dashed px-4 py-10 transition-colors ${
                isAnalyzing
                  ? "cursor-not-allowed border-slate-200 bg-slate-50 opacity-60"
                  : dragActive
                    ? "cursor-pointer border-slate-500 bg-slate-50"
                    : "cursor-pointer border-slate-200 bg-slate-50/50 hover:border-slate-300 hover:bg-slate-50"
              }`}
            >
              <svg
                className="h-10 w-10 text-slate-400"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.25}
                stroke="currentColor"
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m6.75 12-3-3m0 0-3 3m3-3V6.75m9 4.5a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
                />
              </svg>
              <p className="mt-3 text-sm font-medium text-slate-700">
                {files.length > 0
                  ? "Drag and drop more PDFs here, or click to browse"
                  : "Drag and drop PDFs here, or click to browse"}
              </p>
              <p className="mt-2 text-xs text-slate-500">
                Text-based PDFs only (no OCR). A single PDF still works.
              </p>
            </div>
            {files.length > 0 ? (
              <ul className="mt-3 divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
                {files.map((file, index) => (
                  <li
                    key={`${file.name}-${file.lastModified}-${index}`}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <span className="min-w-0 truncate text-xs text-slate-700">
                      <span className="font-medium text-slate-800">
                        {file.name}
                      </span>
                      <span className="text-slate-500">
                        {" "}
                        · {formatFileSize(file.size)}
                      </span>
                    </span>
                    <button
                      type="button"
                      disabled={isAnalyzing}
                      onClick={() => removeFileAt(index)}
                      className="shrink-0 text-xs font-medium text-slate-600 hover:text-slate-900 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
              multiple
              className="sr-only"
              disabled={isAnalyzing}
              onChange={(e) => {
                addIncomingFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            {fileError ? (
              <p className="mt-2 text-xs text-red-700" role="alert">
                {fileError}
              </p>
            ) : null}
          </div>

          {analysisError ? (
            <div
              className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
              role="alert"
            >
              {analysisError}
            </div>
          ) : null}

          {isAnalyzing ? (
            <div
              className="flex items-center gap-3 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700"
              role="status"
              aria-live="polite"
            >
              <span
                className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700"
                aria-hidden
              />
              {statusMessage ??
                "Analyzing documents… This may take up to a minute, and longer when several filings are included."}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={isAnalyzing}
            className="w-full rounded-md bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-400 sm:w-auto sm:min-w-[200px]"
          >
            {isAnalyzing ? "Analyzing…" : "Analyze Credit"}
          </button>
        </form>

        <section
          className="mt-10 border-t border-slate-200 pt-10"
          aria-labelledby="results-heading"
        >
          {analysisResult ? (
            <>
              <h2
                id="results-heading"
                className="text-lg font-semibold text-slate-900"
              >
                Analysis results
              </h2>
              <div className="mt-6">
                <AnalysisResults
                  result={analysisResult}
                  showLiveDisclaimer
                />
              </div>
            </>
          ) : (
            <SampleResultsPreview />
          )}
        </section>
      </main>

      <footer className="mt-auto border-t border-slate-200 bg-white py-6">
        <p className="text-center text-xs text-slate-500">
          Credit Copilot — first-pass credit screen. Not investment advice and not a recommendation to buy, sell, or hold.
        </p>
      </footer>
    </div>
  );
}
