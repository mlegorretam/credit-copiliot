"use client";

import { useCallback, useRef, useState } from "react";
import { AnalysisResults } from "@/components/AnalysisResults";
import { MAX_PDF_BYTES } from "@/lib/constants";
import type { CreditAnalysisResult } from "@/lib/types/credit-analysis";

const SAMPLE_METRICS = [
  { label: "Net Leverage", value: "3.2x", note: "Total net debt / LTM EBITDA" },
  {
    label: "Interest Coverage",
    value: "4.1x",
    note: "LTM EBITDA / cash interest",
  },
  {
    label: "Liquidity",
    value: "$420M",
    note: "Cash + undrawn revolver availability",
  },
] as const;

const SAMPLE_RISKS = [
  "Elevated leverage following recent acquisition; integration execution risk.",
  "Customer concentration: top three customers represent ~42% of revenue.",
  "Covenant headroom narrowing if EBITDA declines more than 10% YoY.",
] as const;

const SAMPLE_MATURITIES = [
  "Revolver ($150M) matures Q2 2027; currently undrawn.",
  "$500M Term Loan B due 2029; SOFR + 225 bps, 1% floor.",
  "No near-term maturities before 2027; manageable amortization profile.",
] as const;

const SAMPLE_QUESTIONS = [
  "What is management's plan to de-lever over the next 12–18 months?",
  "Are there material off-balance-sheet obligations or pension underfunding?",
  "How sensitive is free cash flow to a 200 bps rise in reference rates?",
  "What drove the decline in gross margin in the most recent quarter?",
] as const;

function isPdfFile(file: File): boolean {
  return (
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf")
  );
}

function formatMaxSizeMb(): string {
  return `${MAX_PDF_BYTES / (1024 * 1024)} MB`;
}

function SampleResultsPreview() {
  return (
    <>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2
          id="results-heading"
          className="text-lg font-semibold text-slate-900"
        >
          Analysis preview
        </h2>
        <span className="inline-flex w-fit items-center rounded border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-900">
          Sample results — for layout preview only
        </span>
      </div>
      <p className="mt-2 text-sm text-slate-600">
        Run an analysis to replace this preview with live output from your
        uploaded filing.
      </p>

      <div className="mt-6 space-y-6">
        <div className="rounded-lg border border-slate-200 bg-white p-5 sm:p-6">
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Overall credit risk
          </h3>
          <p className="mt-2 text-2xl font-semibold text-slate-900">
            Moderate
          </p>
          <p className="mt-1 text-sm text-slate-600">
            Balanced leverage and coverage; monitor liquidity and covenant
            trends.
          </p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5 sm:p-6">
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Key metrics
          </h3>
          <dl className="mt-4 grid gap-4 sm:grid-cols-3">
            {SAMPLE_METRICS.map((m) => (
              <div
                key={m.label}
                className="rounded-md border border-slate-100 bg-slate-50/80 px-4 py-3"
              >
                <dt className="text-xs font-medium text-slate-500">
                  {m.label}
                </dt>
                <dd className="mt-1 text-xl font-semibold tabular-nums text-slate-900">
                  {m.value}
                </dd>
                <dd className="mt-1 text-xs text-slate-500">{m.note}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5 sm:p-6">
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Key credit risks
          </h3>
          <ul className="mt-4 list-disc space-y-2 pl-5 text-sm text-slate-700">
            {SAMPLE_RISKS.map((risk) => (
              <li key={risk}>{risk}</li>
            ))}
          </ul>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5 sm:p-6">
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Liquidity &amp; debt maturities
          </h3>
          <ul className="mt-4 list-disc space-y-2 pl-5 text-sm text-slate-700">
            {SAMPLE_MATURITIES.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5 sm:p-6">
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Questions for further diligence
          </h3>
          <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-slate-700">
            {SAMPLE_QUESTIONS.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ol>
        </div>
      </div>
    </>
  );
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [companyName, setCompanyName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] =
    useState<CreditAnalysisResult | null>(null);

  const setPdfFile = useCallback((next: File | null) => {
    if (next && !isPdfFile(next)) {
      setFileError("Please upload a PDF file only.");
      setFile(null);
      return;
    }
    if (next && next.size > MAX_PDF_BYTES) {
      setFileError(`PDF must be ${formatMaxSizeMb()} or smaller.`);
      setFile(null);
      return;
    }
    setFileError(null);
    setFile(next);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      const dropped = e.dataTransfer.files[0];
      if (dropped) setPdfFile(dropped);
    },
    [setPdfFile],
  );

  const onAnalyze = async (e: React.FormEvent) => {
    e.preventDefault();
    setAnalysisError(null);

    if (!companyName.trim()) {
      setAnalysisError("Enter a company name before analyzing.");
      return;
    }
    if (!file) {
      setAnalysisError("Upload a PDF filing before analyzing.");
      return;
    }

    setIsAnalyzing(true);

    try {
      const formData = new FormData();
      formData.append("companyName", companyName.trim());
      formData.append("file", file);

      const response = await fetch("/api/analyze", {
        method: "POST",
        body: formData,
      });

      const payload = (await response.json()) as {
        error?: string;
        detail?: string;
        result?: CreditAnalysisResult;
      };

      if (!response.ok) {
        const parts = [
          payload.error ??
            "Analysis failed. Please try again with a text-based PDF.",
          payload.detail,
        ].filter(Boolean);
        setAnalysisError(parts.join(" "));
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
    }
  };

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-10">
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

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        <p className="max-w-2xl text-sm leading-relaxed text-slate-600 sm:text-base">
          Upload a company filing to identify key credit risks, financial
          metrics, and areas for further diligence.
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
              Upload company filing
            </span>
            <p className="mt-1 text-xs text-slate-500">
              PDF only — e.g., 10-K, 10-Q, earnings release (max{" "}
              {formatMaxSizeMb()})
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
                Drag and drop a PDF here, or click to browse
              </p>
              {file ? (
                <p className="mt-2 text-xs text-slate-600">
                  Selected:{" "}
                  <span className="font-medium text-slate-800">{file.name}</span>
                </p>
              ) : (
                <p className="mt-2 text-xs text-slate-500">
                  Text-based PDFs only (no OCR)
                </p>
              )}
            </div>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="sr-only"
              disabled={isAnalyzing}
              onChange={(e) => {
                const selected = e.target.files?.[0] ?? null;
                setPdfFile(selected);
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
              Analyzing filing… This may take up to a minute for longer
              documents.
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
          Credit Copilot MVP — first-pass credit screen. Not investment advice.
        </p>
      </footer>
    </div>
  );
}
