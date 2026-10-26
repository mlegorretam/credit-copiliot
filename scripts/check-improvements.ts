import { z } from "zod";
import { buildHistoricalSource } from "../lib/filing/historical-source";
import { prepareDocumentsContext } from "../lib/filing/prepare-context";
import { selectFinancialExcerpt } from "../lib/filing/select-financial-context";
import { layoutItemsToText } from "../lib/pdf/extract-text";
import {
  extractCash,
  extractLiquidity,
  extractReportedLeverage,
  extractUndrawn,
} from "../lib/credit/excerpt-stocks";
import { applyFinancialValidation } from "../lib/credit/validate-metrics";
import { formatCompactAbsolute } from "../lib/credit/format-money";
import {
  creditAnalysisJsonSchema,
  creditAnalysisSchema,
  NOT_AVAILABLE,
  type CalculationBasis,
  type CreditAnalysisModelResult,
  type DebtInstrumentInput,
  type SourcedAmount,
} from "../lib/types/credit-analysis";
import {
  addPdfSelections,
  disambiguateFileNames,
  validatePdfUploads,
} from "../lib/uploads/pdf-files";
import { MAX_PDF_BYTES, MAX_PDF_FILES } from "../lib/constants";

const failures: string[] = [];

function check(condition: unknown, message: string) {
  if (!condition) failures.push(message);
}

function includes(text: string, needle: string, label: string) {
  if (!text.includes(needle)) {
    failures.push(`${label} should include ${JSON.stringify(needle)}\n${text}`);
  }
}

function excludes(text: string, needle: string, label: string) {
  if (text.includes(needle)) {
    failures.push(`${label} should exclude ${JSON.stringify(needle)}\n${text}`);
  }
}

function blankAmount(): SourcedAmount {
  return {
    amount: "",
    scale: "not_available",
    period: "not_available",
    sourceDocument: "",
    asOf: "",
    description: NOT_AVAILABLE,
  };
}

function money(
  amount: string,
  period: SourcedAmount["period"],
  description: string,
  source = "10k.pdf",
): SourcedAmount {
  return {
    amount,
    scale: "millions",
    period,
    sourceDocument: source,
    asOf: "December 31, 2024",
    description,
  };
}

const sampleQuestions: CreditAnalysisModelResult["diligenceQuestions"] = [
  { category: "leverage", question: "Question one?" },
  { category: "cash_flow", question: "Question two?" },
  { category: "refinancing", question: "Question three?" },
  { category: "capital_allocation", question: "Question four?" },
  { category: "downside_protection", question: "Question five?" },
];

function modelResult(
  basis: Partial<CalculationBasis> = {},
  metrics: Partial<CreditAnalysisModelResult["keyMetrics"]> = {},
  instruments: DebtInstrumentInput[] = [],
): CreditAnalysisModelResult {
  return {
    overallCreditRisk: "Moderate",
    riskSummary: "Interpretation based only on the filings.",
    keyMetrics: {
      totalDebt: NOT_AVAILABLE,
      cash: NOT_AVAILABLE,
      netDebt: "8.0x",
      ebitda: NOT_AVAILABLE,
      netLeverage: "8.0x",
      reportedLeverage: NOT_AVAILABLE,
      interestCoverage: "16.0x",
      liquidity: NOT_AVAILABLE,
      affo: NOT_AVAILABLE,
      reitMetrics: NOT_AVAILABLE,
      ...metrics,
    },
    calculationBasis: {
      totalDebt: blankAmount(),
      cash: blankAmount(),
      statedNetDebt: blankAmount(),
      ebitda: blankAmount(),
      cashInterest: blankAmount(),
      affo: blankAmount(),
      liquidity: blankAmount(),
      undrawnAvailability: blankAmount(),
      capitalExpenditures: blankAmount(),
      statedLeverageMultiple: "",
      statedLeverageDefinition: "",
      statedLeverageSource: "",
      statedLeverageAsOf: "",
      statedInterestCoverageMultiple: "",
      statedInterestCoverageDefinition: "",
      statedInterestCoverageSource: "",
      ...basis,
    },
    calculationNotes: "See server validation.",
    documentConflicts:
      "No material conflicts identified in the provided documents.",
    keyCreditRisks: [
      {
        title: "Refinancing",
        severity: "Moderate",
        explanation: "Interpretation.",
        supportingEvidence: "Filing language.",
      },
      {
        title: "Liquidity",
        severity: "Low",
        explanation: "Interpretation.",
        supportingEvidence: "Filing language.",
      },
      {
        title: "Leverage",
        severity: "High",
        explanation: "Interpretation.",
        supportingEvidence: "Filing language.",
      },
    ],
    liquidityAndMaturities: "Revolver maturity is described in the filing.",
    capitalExpenditures: NOT_AVAILABLE,
    debtInstruments: instruments,
    diligenceQuestions: sampleQuestions,
  };
}

const baseExcerpt = [
  "Total debt $850 million.",
  "Cash $50 million.",
  "TTM Adjusted EBITDA $400 million.",
  "Quarterly EBITDA $100 million.",
  "Six-month EBITDA $200 million.",
  "Nine-month EBITDA $300 million.",
  "Annual EBITDA $360 million.",
  "Cash interest $100 million.",
  "Quarterly cash interest $25 million.",
  "Company-reported net leverage 3.5x.",
  "Company-reported net debt $700 million.",
  "Company-reported net debt $800 million.",
  "AFFO $80 million.",
].join(" ");

function runValidation(
  basis: Partial<CalculationBasis>,
  metrics?: Partial<CreditAnalysisModelResult["keyMetrics"]>,
  excerpt = baseExcerpt,
  fileNames = ["10k.pdf"],
  instruments: DebtInstrumentInput[] = [],
  historicalSource?: string,
) {
  return applyFinancialValidation(modelResult(basis, metrics, instruments), {
    fileNames,
    excerpt,
    excerptTruncated: false,
    historicalSource,
  });
}

function trendText(
  result: ReturnType<typeof runValidation>,
  id: string,
  year: string,
): string {
  const row = result.financialTrends.rows.find((item) => item.id === id);
  const index = result.financialTrends.years.indexOf(year);
  if (!row || index < 0) return "";
  return `${row.cells[index]?.display ?? ""} ${row.cells[index]?.detail ?? ""}`;
}

const standardDebt = {
  totalDebt: money("850", "point_in_time", "Total debt"),
  cash: money("50", "point_in_time", "Cash"),
};

const ttm = runValidation({
  ...standardDebt,
  ebitda: money("400", "ttm", "Adjusted EBITDA"),
  cashInterest: money("100", "ttm", "Cash interest"),
  affo: money("80", "ttm", "AFFO"),
  statedLeverageMultiple: "3.5",
  statedLeverageDefinition: "net debt / Adjusted EBITDA per the credit agreement",
  statedLeverageSource: "10k.pdf",
  statedLeverageAsOf: "December 31, 2024",
});

includes(ttm.keyMetrics.netLeverage, "2x", "TTM leverage");
includes(ttm.keyMetrics.netLeverage, "10k.pdf", "TTM leverage source");
includes(ttm.keyMetrics.netLeverage, "TTM Adjusted EBITDA", "TTM EBITDA label");
excludes(ttm.keyMetrics.netLeverage, "annualized approximation", "TTM leverage");
excludes(ttm.keyMetrics.netLeverage, "8.0x", "TTM leverage invented draft");
includes(ttm.keyMetrics.netDebt, "800", "TTM net debt");
includes(ttm.keyMetrics.netDebt, "10k.pdf", "net debt source");
includes(ttm.keyMetrics.interestCoverage, "4x", "TTM coverage");
excludes(
  ttm.keyMetrics.interestCoverage,
  "annualized approximation",
  "TTM coverage",
);
includes(ttm.keyMetrics.reportedLeverage, "3.5x", "reported leverage");
includes(ttm.keyMetrics.reportedLeverage, "credit agreement", "reported definition");
includes(ttm.calculationNotes, "differ", "reported vs independent note");
includes(ttm.keyMetrics.affo, "80", "AFFO");
excludes(ttm.keyMetrics.netLeverage, "10x", "AFFO must not be the leverage denominator");
check(
  ttm.analyzedDocuments.join(",") === "10k.pdf",
  "analyzed documents should be the uploaded filenames",
);

const quarterlyExcerpt =
  "Total debt $850 million. Cash $50 million. Quarterly EBITDA $100 million.";
const quarterly = runValidation(
  {
    ...standardDebt,
    ebitda: money("100", "quarterly", "EBITDA"),
  },
  undefined,
  quarterlyExcerpt,
);
includes(quarterly.keyMetrics.netLeverage, "2x", "quarterly annualized leverage");
includes(
  quarterly.keyMetrics.netLeverage,
  "annualized approximation",
  "quarterly label",
);
includes(
  quarterly.keyMetrics.netLeverage,
  "not trailing-twelve-month",
  "quarterly not TTM",
);
includes(quarterly.keyMetrics.netLeverage, "quarterly figure × 4", "quarterly factor");
excludes(quarterly.keyMetrics.netLeverage, "8x", "unadjusted quarterly leverage");
excludes(quarterly.keyMetrics.netLeverage, "8.0x", "unadjusted quarterly draft");

const sixMonth = runValidation(
  {
    ...standardDebt,
    ebitda: money("200", "six_month", "EBITDA"),
  },
  undefined,
  "Total debt $850 million. Cash $50 million. Six-month EBITDA $200 million.",
);
includes(sixMonth.keyMetrics.netLeverage, "2x", "six-month annualized leverage");
includes(sixMonth.keyMetrics.netLeverage, "six-month figure × 2", "six-month factor");
includes(
  sixMonth.keyMetrics.netLeverage,
  "annualized approximation",
  "six-month label",
);
excludes(sixMonth.keyMetrics.netLeverage, "4x", "unadjusted six-month leverage");

const nineMonth = runValidation(
  {
    ...standardDebt,
    ebitda: money("300", "nine_month", "EBITDA"),
  },
  undefined,
  "Total debt $850 million. Cash $50 million. Nine-month EBITDA $300 million.",
);
includes(nineMonth.keyMetrics.netLeverage, "2x", "nine-month annualized leverage");
includes(nineMonth.keyMetrics.netLeverage, "nine-month figure × 4/3", "nine-month factor");
excludes(nineMonth.keyMetrics.netLeverage, "2.67x", "unadjusted nine-month leverage");

const annual = runValidation(
  {
    ...standardDebt,
    ebitda: money("400", "annual", "Adjusted EBITDA"),
  },
  undefined,
  "Total debt $850 million. Cash $50 million. Annual EBITDA $400 million for the year ended December 31, 2024.",
);
includes(annual.keyMetrics.netLeverage, "2x", "annual leverage");
includes(
  annual.keyMetrics.netLeverage,
  "not explicitly trailing-twelve-month",
  "annual label",
);
excludes(annual.keyMetrics.netLeverage, "annualized approximation", "annual is not a partial-period approximation");

const matchedNetDebt = runValidation({
  ...standardDebt,
  statedNetDebt: money("800", "point_in_time", "Net debt"),
  ebitda: money("400", "ttm", "Adjusted EBITDA"),
});
includes(matchedNetDebt.calculationNotes, "matches company-reported net debt", "net debt match");

const conflictingNetDebt = runValidation({
  ...standardDebt,
  statedNetDebt: money("700", "point_in_time", "Net debt"),
  ebitda: money("400", "ttm", "Adjusted EBITDA"),
});
includes(conflictingNetDebt.keyMetrics.netDebt, "700", "stated net debt kept");
includes(conflictingNetDebt.keyMetrics.netDebt, "800", "independent net debt kept");
includes(conflictingNetDebt.calculationNotes, "differs", "net debt conflict");
includes(conflictingNetDebt.keyMetrics.netLeverage, "2x", "leverage on independent net debt");
includes(conflictingNetDebt.keyMetrics.netLeverage, "1.75x", "leverage on stated net debt");

const missingEbitda = runValidation(
  { ...standardDebt },
  undefined,
  "Total debt $850 million. Cash $50 million.",
);
const ebitdaFromText = runValidation(
  { ...standardDebt },
  undefined,
  "Total debt $850 million. Cash $50 million. TTM Adjusted EBITDA $400 million.",
);
includes(ebitdaFromText.keyMetrics.netLeverage, "2x", "TTM read from the excerpt");
includes(ebitdaFromText.keyMetrics.netLeverage, "TTM Adjusted EBITDA", "excerpt TTM label");
excludes(ebitdaFromText.keyMetrics.netLeverage, "8.0x", "excerpt TTM replaces the draft multiple");
includes(missingEbitda.keyMetrics.netLeverage, NOT_AVAILABLE, "missing EBITDA");
excludes(missingEbitda.keyMetrics.netLeverage, "8.0x", "do not keep invented leverage");
excludes(missingEbitda.keyMetrics.netLeverage, "8x", "do not invent a multiple");

const invented = runValidation({
  totalDebt: money("9999", "point_in_time", "Total debt"),
  cash: money("50", "point_in_time", "Cash"),
  ebitda: money("400", "ttm", "Adjusted EBITDA"),
});
includes(invented.calculationNotes, "not found in the extracted text", "invented total debt");
excludes(invented.keyMetrics.netLeverage, "8.0x", "invented inputs cannot produce leverage");

const negativeEbitda = runValidation(
  {
    ...standardDebt,
    ebitda: money("-20", "ttm", "Adjusted EBITDA"),
  },
  undefined,
  `${baseExcerpt} TTM Adjusted EBITDA ($20 million).`,
);
includes(negativeEbitda.keyMetrics.netLeverage, "zero or negative", "negative EBITDA");
excludes(negativeEbitda.keyMetrics.netLeverage, "8.0x", "negative EBITDA multiple");

const quarterlyInterest = runValidation({
  ...standardDebt,
  ebitda: money("400", "ttm", "Adjusted EBITDA"),
  cashInterest: money("25", "quarterly", "Cash interest"),
});
includes(quarterlyInterest.keyMetrics.interestCoverage, "4x", "annualized coverage");
includes(
  quarterlyInterest.keyMetrics.interestCoverage,
  "annualized approximation",
  "coverage approximation label",
);
excludes(quarterlyInterest.keyMetrics.interestCoverage, "16x", "unadjusted quarterly interest");
excludes(quarterlyInterest.keyMetrics.interestCoverage, "16.0x", "draft coverage");

const proseQuarterly = runValidation(
  { ...standardDebt },
  { ebitda: "Quarterly EBITDA $100 million" },
  quarterlyExcerpt,
);
const ttmOverridesQuarterly = runValidation(
  {
    ...standardDebt,
    ebitda: money("50", "quarterly", "EBITDA"),
  },
  undefined,
  "Total debt $850 million. Cash $50 million. Quarterly EBITDA $50 million. TTM Adjusted EBITDA $400 million.",
);
includes(ttmOverridesQuarterly.keyMetrics.netLeverage, "2x", "TTM override leverage");
includes(ttmOverridesQuarterly.keyMetrics.netLeverage, "TTM Adjusted EBITDA", "TTM override label");
excludes(
  ttmOverridesQuarterly.keyMetrics.netLeverage,
  "annualized approximation",
  "TTM override should not annualize",
);
excludes(ttmOverridesQuarterly.keyMetrics.netLeverage, "16x", "TTM override unadjusted quarterly");
excludes(ttmOverridesQuarterly.keyMetrics.netLeverage, "4x", "TTM override annualized quarterly");
includes(proseQuarterly.keyMetrics.netLeverage, "2x", "prose quarterly leverage");
includes(
  proseQuarterly.keyMetrics.netLeverage,
  "annualized approximation",
  "prose quarterly label",
);
excludes(proseQuarterly.keyMetrics.netLeverage, "8x", "prose unadjusted leverage");
includes(
  proseQuarterly.calculationNotes,
  "read from the metric text",
  "prose fallback note",
);

const withExclusion = applyFinancialValidation(
  modelResult({
    ...standardDebt,
    ebitda: money("400", "ttm", "Adjusted EBITDA"),
  }),
  {
    fileNames: ["10k.pdf"],
    excerpt: baseExcerpt,
    excerptTruncated: false,
    extractionNotes: [
      "supplement.pdf could not be read as a text-based PDF and was excluded.",
    ],
  },
);
includes(
  withExclusion.documentConflicts,
  "supplement.pdf could not be read",
  "excluded document note",
);
includes(
  withExclusion.documentConflicts,
  "No material conflicts identified",
  "model conflict text preserved",
);

const single = validatePdfUploads([
  { name: "annual.pdf", size: 1024, type: "application/pdf" },
]);
check(single.ok, "a single PDF should remain valid");

const multi = validatePdfUploads([
  { name: "10k.pdf", size: 1024, type: "application/pdf" },
  { name: "10q.pdf", size: 2048, type: "application/pdf" },
  { name: "earnings.pdf", size: 512, type: "" },
]);
check(multi.ok, "several PDFs should be valid");

const missing = validatePdfUploads([]);
check(!missing.ok && missing.status === 400, "missing upload should be rejected");

const tooMany = validatePdfUploads(
  Array.from({ length: MAX_PDF_FILES + 1 }, (_, index) => ({
    name: `file-${index}.pdf`,
    size: 100,
    type: "application/pdf",
  })),
);
check(!tooMany.ok && tooMany.status === 400, "too many PDFs should be rejected");

const tooBig = validatePdfUploads([
  { name: "huge.pdf", size: MAX_PDF_BYTES + 1, type: "application/pdf" },
]);
check(!tooBig.ok && tooBig.status === 413, "an oversized PDF should be rejected");

const totalTooBig = validatePdfUploads([
  ...Array.from({ length: 4 }, (_, index) => ({
    name: `part-${index}.pdf`,
    size: MAX_PDF_BYTES,
    type: "application/pdf",
  })),
  { name: "extra.pdf", size: 1, type: "application/pdf" },
]);
check(!totalTooBig.ok && totalTooBig.status === 413, "combined size should be rejected");

const added = addPdfSelections(
  [{ name: "10k.pdf", size: 100, type: "application/pdf", lastModified: 1 }],
  [
    { name: "10k.pdf", size: 100, type: "application/pdf", lastModified: 1 },
    { name: "photo.png", size: 100, type: "image/png", lastModified: 2 },
    { name: "earnings.pdf", size: 200, type: "application/pdf", lastModified: 3 },
  ],
);
check(added.files.length === 2, "valid new PDFs should be appended");
check(added.files[1]?.name === "earnings.pdf", "earnings PDF should be kept");
check(added.error?.includes("photo.png") === true, "non-PDF should be reported");

check(
  disambiguateFileNames(["same.pdf", "other.pdf", "same.pdf"]).join("|") ===
    "same.pdf (1)|other.pdf|same.pdf (2)",
  "duplicate filenames should be disambiguated",
);

const shortDocs = prepareDocumentsContext([
  { fileName: "10k.pdf", text: "Total debt $10 million in the annual report.", totalPages: 2 },
  { fileName: "earnings.pdf", text: "TTM Adjusted EBITDA $4 million.", totalPages: 1 },
]);
check(shortDocs.truncated === false, "short documents should not be truncated");
includes(shortDocs.text, "10k.pdf", "first document name");
includes(shortDocs.text, "earnings.pdf", "second document name");
includes(shortDocs.text, "Total debt $10 million", "first document body");
includes(shortDocs.text, "TTM Adjusted EBITDA $4 million", "second document body");

const longTail = `${"A".repeat(130_000)} senior notes ebitda maturity`;
const longSingle = prepareDocumentsContext([
  { fileName: "annual.pdf", text: longTail, totalPages: 80 },
]);
check(longSingle.truncated, "a long single PDF should be truncated");
includes(longSingle.text, "annual.pdf", "truncated document name");
includes(longSingle.text, "ebitda", "credit keyword retained from the tail");

const combined = prepareDocumentsContext([
  { fileName: "short.pdf", text: "UNIQUE_SMALL_TOKEN total debt $10 million" },
  {
    fileName: "long.pdf",
    text: `${"B".repeat(250_000)} affo supplemental capex`,
  },
]);
check(combined.truncated, "a large second PDF should truncate the combined excerpt");
includes(combined.text, "short.pdf", "small document header");
includes(combined.text, "UNIQUE_SMALL_TOKEN", "small document body");
includes(combined.text, "long.pdf", "large document header");
includes(combined.text, "affo", "keyword retained from the large document");

const ironMountainExcerpt = [
  "===== DOCUMENT 1 of 2: 10-K.pdf =====",
  "Total debt $18,000 million. Cash $200 million.",
  "===== DOCUMENT 2 of 2: supplement.pdf =====",
  "All figures except per share and facility counts in 000s unless noted.",
  "($ in millions, except per share data)",
  "Adjusted EBITDA $727 $628 16% 15% $1,435 $1,208",
  "Financial Highlights",
  "Q2 2026 Q1 2026 Q4 2025 Q3 2025 Q2 2025 Storage Rental Revenue $1,134,611 $1,094,765 $1,061,248 $1,032,897 $1,009,989",
  "Service Revenue $894,451 $841,384 $781,919 $721,196 $701,959",
  "Total Revenues $2,029,062 $1,936,149 $1,843,167 $1,754,093 $1,711,948",
  "Adjusted EBITDA $727,018 $707,939 $705,277 $660,379 $628,388",
  "Adjusted EBITDA Margin 35.8% 36.6% 38.3% 37.6% 36.7%",
  "Year to date Adjusted EBITDA $1,434,957",
].join("\n");

const ironMountain = applyFinancialValidation(
  modelResult({
    totalDebt: money("18000", "point_in_time", "Total debt", "10-K.pdf"),
    cash: money("200", "point_in_time", "Cash", "10-K.pdf"),
    ebitda: {
      amount: "1434957",
      scale: "thousands",
      period: "six_month",
      sourceDocument: "supplement.pdf",
      asOf: "June 30, 2026",
      description: "Adjusted EBITDA",
    },
  }),
  {
    fileNames: ["10-K.pdf", "supplement.pdf"],
    excerpt: ironMountainExcerpt,
    excerptTruncated: false,
  },
);
includes(ironMountain.keyMetrics.ebitda, "2,800.613", "TTM sum");
includes(ironMountain.keyMetrics.ebitda, "660,379", "Q3 component");
includes(ironMountain.keyMetrics.ebitda, "727,018", "Q2 component");
includes(ironMountain.keyMetrics.ebitda, "Q3 2025", "oldest TTM quarter");
includes(ironMountain.keyMetrics.ebitda, "Q2 2026", "newest TTM quarter");
includes(ironMountain.keyMetrics.ebitda, "supplement.pdf", "TTM source document");
includes(ironMountain.keyMetrics.ebitda, "four consecutive quarters", "TTM method");
excludes(ironMountain.keyMetrics.ebitda, "Q2 2025", "prior-year quarter excluded from TTM");
excludes(ironMountain.keyMetrics.ebitda, "628,388", "prior-year amount excluded from TTM");
includes(ironMountain.keyMetrics.netLeverage, "6.36x", "leverage on summed TTM EBITDA");
includes(
  ironMountain.keyMetrics.netLeverage,
  "four consecutive quarterly figures",
  "leverage explains the quarterly sum",
);
includes(ironMountain.keyMetrics.netLeverage, "TTM Adjusted EBITDA", "sum is labeled TTM");
excludes(
  ironMountain.keyMetrics.netLeverage,
  "annualized approximation",
  "four quarters are not annualized",
);
excludes(ironMountain.keyMetrics.netLeverage, "six-month figure × 2", "six-month EBITDA is not doubled");
excludes(ironMountain.keyMetrics.netLeverage, "6.2x", "annualized six-month leverage");
excludes(ironMountain.keyMetrics.netLeverage, "12.4x", "unannualized six-month leverage");
includes(ironMountain.calculationNotes, "2,800.613", "calculation note shows the sum");
includes(ironMountain.calculationNotes, "No annualization was applied.", "calculation note");

const mislabeledTtm = applyFinancialValidation(
  modelResult({
    totalDebt: money("18000", "point_in_time", "Total debt", "10-K.pdf"),
    cash: money("200", "point_in_time", "Cash", "10-K.pdf"),
    ebitda: {
      amount: "1434957",
      scale: "thousands",
      period: "ttm",
      sourceDocument: "supplement.pdf",
      asOf: "June 30, 2026",
      description: "Adjusted EBITDA",
    },
  }),
  {
    fileNames: ["10-K.pdf", "supplement.pdf"],
    excerpt: ironMountainExcerpt,
    excerptTruncated: false,
  },
);
includes(mislabeledTtm.keyMetrics.ebitda, "2,800.613", "mislabeled TTM is replaced by the quarterly sum");
includes(mislabeledTtm.keyMetrics.netLeverage, "6.36x", "mislabeled TTM leverage");
excludes(mislabeledTtm.keyMetrics.netLeverage, "12.4x", "year-to-date figure is not treated as TTM");

const statedStillWins = applyFinancialValidation(
  modelResult({
    ...standardDebt,
    ebitda: money("200", "six_month", "EBITDA"),
  }),
  {
    fileNames: ["10k.pdf"],
    excerpt: `${ironMountainExcerpt}\nTTM Adjusted EBITDA $400 million.\nTotal debt $850 million. Cash $50 million.`,
    excerptTruncated: false,
  },
);
includes(statedStillWins.keyMetrics.netLeverage, "2x", "stated TTM still wins over the quarterly sum");
includes(statedStillWins.keyMetrics.ebitda, "400", "stated TTM amount");
excludes(statedStillWins.keyMetrics.ebitda, "2,800.613", "stated TTM is not replaced");
excludes(
  statedStillWins.keyMetrics.netLeverage,
  "annualized approximation",
  "stated TTM is not annualized",
);

const labeledQuarters = applyFinancialValidation(
  modelResult({
    ...standardDebt,
    ebitda: money("1434.957", "six_month", "Adjusted EBITDA"),
  }),
  {
    fileNames: ["supplement.pdf"],
    excerpt: [
      "Total debt $850 million. Cash $50 million.",
      "Adjusted EBITDA",
      "Q3 2025: $660.379 million",
      "Q4 2025: $705.277 million",
      "Q1 2026: $707.939 million",
      "Q2 2026: $727.018 million",
      "Six-month Adjusted EBITDA $1,434.957 million.",
    ].join("\n"),
    excerptTruncated: false,
  },
);
includes(labeledQuarters.keyMetrics.ebitda, "2,800.613", "labeled quarterly sum");
includes(labeledQuarters.keyMetrics.ebitda, "660.379", "labeled Q3 amount");
includes(labeledQuarters.keyMetrics.netLeverage, "0.29x", "leverage on labeled TTM");
excludes(labeledQuarters.keyMetrics.netLeverage, "0.28x", "labeled quarters are not doubled from six months");
excludes(
  labeledQuarters.keyMetrics.netLeverage,
  "annualized approximation",
  "labeled quarters are true TTM",
);

const threeQuarters = applyFinancialValidation(
  modelResult({
    ...standardDebt,
    ebitda: money("200", "six_month", "EBITDA"),
  }),
  {
    fileNames: ["supplement.pdf"],
    excerpt: [
      "Total debt $850 million. Cash $50 million.",
      "All figures in 000s unless noted.",
      "Q2 2026 Q1 2026 Q2 2025",
      "Adjusted EBITDA $727,018 $707,939 $628,388",
      "Six-month EBITDA $200 million.",
    ].join(" "),
    excerptTruncated: false,
  },
);
includes(threeQuarters.keyMetrics.netLeverage, "2x", "three quarters still annualize the six-month figure");
includes(threeQuarters.keyMetrics.netLeverage, "six-month figure × 2", "three-quarter factor");
excludes(threeQuarters.keyMetrics.ebitda, "four consecutive quarters", "three quarters are not TTM");

const segmentOnly = applyFinancialValidation(
  modelResult({
    ...standardDebt,
    ebitda: money("200", "six_month", "EBITDA"),
  }),
  {
    fileNames: ["supplement.pdf"],
    excerpt: [
      "Total debt $850 million. Cash $50 million.",
      "All figures in 000s unless noted.",
      "Global RIM",
      "Q2 2026 Q1 2026 Q4 2025 Q3 2025",
      "Adjusted EBITDA $50,000 $50,000 $50,000 $50,000",
      "Six-month EBITDA $200 million.",
    ].join("\n"),
    excerptTruncated: false,
  },
);
includes(segmentOnly.keyMetrics.netLeverage, "2x", "segment EBITDA is not consolidated TTM");
includes(segmentOnly.keyMetrics.netLeverage, "annualized approximation", "segment series falls back");
excludes(segmentOnly.keyMetrics.netLeverage, "4x", "segment sum is not the leverage denominator");

const laidOut = layoutItemsToText([
  [
    { str: "Q2 2026", x: 100, y: 140, width: 40, fontSize: 10 },
    { str: "Q1 2026", x: 160, y: 141, width: 40, fontSize: 10 },
    { str: "Adjusted", x: 10, y: 120, width: 48, fontSize: 10 },
    { str: "EBITDA", x: 62, y: 120, width: 36, fontSize: 10 },
    { str: "$727,018", x: 100, y: 119, width: 48, fontSize: 10 },
    { str: "$707,939", x: 160, y: 120, width: 48, fontSize: 10 },
  ],
]);
includes(laidOut, "Q2 2026 Q1 2026", "quarter headers stay on one line");
includes(laidOut, "Adjusted EBITDA $727,018 $707,939", "EBITDA columns stay in row order");
check(
  laidOut.indexOf("Q2 2026") < laidOut.indexOf("Adjusted EBITDA"),
  "a higher table row is emitted first",
);

const buriedTable = [
  "All figures except per share in 000s unless noted.",
  "Q2 2026 Q1 2026 Q4 2025 Q3 2025 Q2 2025",
  "Adjusted EBITDA $727,018 $707,939 $705,277 $660,379 $628,388",
].join("\n");
const buried = prepareDocumentsContext([
  {
    fileName: "supplement.pdf",
    text: `${Array.from({ length: 60 }, (_, index) => `${"x".repeat(2200)} ebitda ${index}`).join("\n")}\n${"z".repeat(2_000)}\n${buriedTable}`,
  },
]);
check(buried.truncated, "a long supplemental should still truncate");
includes(buried.text, "$727,018", "buried quarterly EBITDA row is kept");
includes(buried.text, "in 000s", "buried scale note is kept");
const buriedValidation = applyFinancialValidation(
  modelResult({
    totalDebt: money("18000", "point_in_time", "Total debt", "supplement.pdf"),
    cash: money("200", "point_in_time", "Cash", "supplement.pdf"),
    ebitda: money("200", "six_month", "EBITDA", "supplement.pdf"),
  }),
  {
    fileNames: ["supplement.pdf"],
    excerpt: buried.text,
    excerptTruncated: buried.truncated,
  },
);
includes(buriedValidation.keyMetrics.ebitda, "2,800.613", "truncated excerpt still produces TTM EBITDA");
const buriedEbitda = buriedValidation.dashboard.find((metric) => metric.id === "ebitda");
check(buriedEbitda?.value === "$2.80B", "TTM EBITDA of 2,800.613 million displays as $2.80B");
check(buriedEbitda?.badge === "Calculated", "four-quarter EBITDA is marked calculated");
check(buriedEbitda?.period === "Trailing twelve months", "constructed EBITDA stays TTM");
includes(buriedEbitda?.calculation ?? "", "2,800.613", "dashboard detail keeps the million figure");
includes(buriedValidation.keyMetrics.ebitda, "million", "calculation sentence keeps millions");

check(formatCompactAbsolute(17_144_856_000) === "$17.14B", "thousands-scale debt displays in billions");
check(formatCompactAbsolute(2_800_613_000) === "$2.80B", "EBITDA millions display in billions");
check(formatCompactAbsolute(800_000_000) === "$800M", "sub-billion amounts stay in millions");

const thousandScale = runValidation(
  {
    totalDebt: {
      amount: "17144856",
      scale: "thousands",
      period: "point_in_time",
      sourceDocument: "10q.pdf",
      asOf: "June 30, 2026",
      description: "Total debt",
    },
    cash: {
      amount: "200000",
      scale: "thousands",
      period: "point_in_time",
      sourceDocument: "10q.pdf",
      asOf: "June 30, 2026",
      description: "Cash",
    },
    ebitda: {
      amount: "2800.613",
      scale: "millions",
      period: "ttm",
      sourceDocument: "supplement.pdf",
      asOf: "June 30, 2026",
      description: "Adjusted EBITDA",
    },
  },
  undefined,
  "Total debt $17,144,856 thousand. Cash $200,000 thousand. TTM Adjusted EBITDA $2,800.613 million.",
  ["10q.pdf", "supplement.pdf"],
);
check(
  thousandScale.dashboard.find((metric) => metric.id === "totalDebt")?.value === "$17.14B",
  "dashboard converts reported thousands without changing the stored scale",
);
includes(thousandScale.keyMetrics.totalDebt, "thousand", "original thousand unit remains in the source detail");
check(
  thousandScale.dashboard.find((metric) => metric.id === "ebitda")?.value === "$2.80B",
  "stated 2,800.613 million EBITDA displays as $2.80B",
);

const sixMonthAffo = runValidation(
  {
    ...standardDebt,
    ebitda: money("400", "ttm", "Adjusted EBITDA"),
    affo: money("300", "ttm", "Six-month AFFO"),
  },
  { affo: "TTM AFFO $300 million." },
  `${baseExcerpt} Six-month AFFO $300 million.`,
);
includes(sixMonthAffo.keyMetrics.affo, "Six-month AFFO", "six-month AFFO keeps its period");
excludes(sixMonthAffo.keyMetrics.affo, "TTM AFFO", "six-month AFFO is not titled TTM");
check(
  sixMonthAffo.dashboard.find((metric) => metric.id === "affo")?.period === "Six months",
  "dashboard AFFO period is six months",
);
check(
  sixMonthAffo.dashboard.find((metric) => metric.id === "affo")?.review === true,
  "mislabeled AFFO requires review",
);
check(
  sixMonthAffo.dataQuality.find((item) => item.id === "ttm-labels")?.status === "Review Required",
  "TTM label check flags the six-month AFFO",
);

const debtExcerpt = [
  "Total debt $1,000 million.",
  "Cash $50 million.",
  "TTM Adjusted EBITDA $400 million.",
  "Senior Notes due 2032 principal $600 million, carrying amount $590 million, at 5.25% unsecured.",
  "Term Loan due 2029 principal $400 million, carrying amount $390 million, SOFR + 2.25%, secured.",
  "Revolving credit facility due thereafter.",
].join(" ");
const reconciledDebt = runValidation(
  {
    totalDebt: money("1000", "point_in_time", "Total debt"),
    cash: money("50", "point_in_time", "Cash"),
    ebitda: money("400", "ttm", "Adjusted EBITDA"),
    statedLeverageMultiple: "2.38",
    statedLeverageDefinition: "net debt / Adjusted EBITDA",
    statedLeverageSource: "10k.pdf",
    statedLeverageAsOf: "December 31, 2024",
  },
  undefined,
  `${debtExcerpt} Company-reported net leverage 2.38x.`,
  ["10k.pdf"],
  [
    {
      name: "Senior Notes due 2032",
      principalAmount: "600",
      principalScale: "millions",
      carryingAmount: "590",
      carryingScale: "millions",
      rateText: "5.25%",
      rateType: "fixed",
      couponPercent: "5.25",
      maturityText: "Senior Notes due 2032",
      maturityYear: "2032",
      securedStatus: "unsecured",
      amountBasis: "principal",
      sourceDocument: "10k.pdf",
    },
    {
      name: "Term Loan due 2029",
      principalAmount: "400",
      principalScale: "millions",
      carryingAmount: "390",
      carryingScale: "millions",
      rateText: "SOFR + 2.25%",
      rateType: "floating",
      couponPercent: "2.25",
      maturityText: "Term Loan due 2029",
      maturityYear: "2029",
      securedStatus: "secured",
      amountBasis: "principal",
      sourceDocument: "10k.pdf",
    },
    {
      name: "Imaginary Bonds due 2040",
      principalAmount: "9999",
      principalScale: "millions",
      carryingAmount: "",
      carryingScale: "not_available",
      rateText: "9.99%",
      rateType: "fixed",
      couponPercent: "9.99",
      maturityText: "January 1, 2040",
      maturityYear: "2040",
      securedStatus: "unsecured",
      amountBasis: "principal",
      sourceDocument: "10k.pdf",
    },
  ],
);
check(reconciledDebt.capitalStructure.omittedCount === 1, "fabricated instrument is omitted");
check(
  reconciledDebt.capitalStructure.instruments.length === 2,
  "only grounded instruments remain",
);
check(
  reconciledDebt.capitalStructure.reconciliationStatus === "matched",
  "principal sum reconciles to reported total debt",
);
includes(
  reconciledDebt.capitalStructure.reconciliation,
  "Carrying amounts",
  "carrying amounts stay distinct from principal",
);
check(
  reconciledDebt.capitalStructure.maturityBars?.map((bar) => bar.year).join(",") === "2029,2032",
  "maturity chart uses disclosed years only",
);
check(
  reconciledDebt.capitalStructure.rateBreakdown != null,
  "fixed and floating principal is disclosed",
);
check(
  reconciledDebt.capitalStructure.weightedAverageCoupon == null,
  "floating spread is not converted into a weighted average coupon",
);
includes(
  reconciledDebt.capitalStructure.weightedAverageDetail,
  "Insufficient data",
  "incomplete coupons do not produce a cost of debt",
);
check(
  reconciledDebt.dataQuality.find((item) => item.id === "leverage-definitions")?.status ===
    "Calculated",
  "matching reported and calculated leverage is not a review failure",
);
check(
  reconciledDebt.dashboard.find((metric) => metric.id === "netLeverage")?.badge === "Calculated",
  "independent leverage stays labeled calculated",
);
check(
  reconciledDebt.dashboard.find((metric) => metric.id === "reportedLeverage")?.badge === "Reported",
  "company leverage stays labeled reported",
);

const undatedDebt = runValidation(
  {
    totalDebt: money("1000", "point_in_time", "Total debt"),
    cash: money("50", "point_in_time", "Cash"),
  },
  undefined,
  "Total debt $1,000 million. Cash $50 million. Senior Notes due 2032 principal $600 million. Other debt principal $400 million thereafter.",
  ["10k.pdf"],
  [
    {
      name: "Senior Notes due 2032",
      principalAmount: "600",
      principalScale: "millions",
      carryingAmount: "",
      carryingScale: "not_available",
      rateText: "",
      rateType: "not_disclosed",
      couponPercent: "",
      maturityText: "Senior Notes due 2032",
      maturityYear: "2032",
      securedStatus: "not_disclosed",
      amountBasis: "principal",
      sourceDocument: "10k.pdf",
    },
    {
      name: "Other debt",
      principalAmount: "400",
      principalScale: "millions",
      carryingAmount: "",
      carryingScale: "not_available",
      rateText: "",
      rateType: "not_disclosed",
      couponPercent: "",
      maturityText: "thereafter",
      maturityYear: "",
      securedStatus: "not_disclosed",
      amountBasis: "principal",
      sourceDocument: "10k.pdf",
    },
  ],
);
check(undatedDebt.capitalStructure.maturityBars == null, "thereafter does not create a maturity year");
includes(undatedDebt.capitalStructure.maturityMessage, "Insufficient data", "undated principal blocks the chart");
check(
  undatedDebt.dataQuality.find((item) => item.id === "maturity-schedule")?.status === "Review Required",
  "incomplete maturity schedule requires review",
);

const pricedDebt = runValidation(
  {
    totalDebt: money("1000", "point_in_time", "Total debt"),
    cash: money("50", "point_in_time", "Cash"),
  },
  undefined,
  "Total debt $1,000 million. Cash $50 million. Senior Notes due 2032 principal $600 million at 5.25% unsecured. Senior Notes due 2034 principal $400 million at 4.50% unsecured.",
  ["10k.pdf"],
  [
    {
      name: "Senior Notes due 2032",
      principalAmount: "600",
      principalScale: "millions",
      carryingAmount: "",
      carryingScale: "not_available",
      rateText: "5.25%",
      rateType: "fixed",
      couponPercent: "5.25",
      maturityText: "Senior Notes due 2032",
      maturityYear: "2032",
      securedStatus: "unsecured",
      amountBasis: "principal",
      sourceDocument: "10k.pdf",
    },
    {
      name: "Senior Notes due 2034",
      principalAmount: "400",
      principalScale: "millions",
      carryingAmount: "",
      carryingScale: "not_available",
      rateText: "4.50%",
      rateType: "fixed",
      couponPercent: "4.50",
      maturityText: "Senior Notes due 2034",
      maturityYear: "2034",
      securedStatus: "unsecured",
      amountBasis: "principal",
      sourceDocument: "10k.pdf",
    },
  ],
);
check(
  pricedDebt.capitalStructure.weightedAverageCoupon === "4.95%",
  "weighted average coupon is principal-weighted",
);

const carryingGap = runValidation(
  {
    totalDebt: money("980", "point_in_time", "Total debt"),
    cash: money("50", "point_in_time", "Cash"),
  },
  undefined,
  "Total debt $980 million. Cash $50 million. Senior Notes due 2032 principal $600 million, carrying amount $590 million. Term Loan due 2029 principal $400 million, carrying amount $390 million.",
  ["10k.pdf"],
  [
    {
      name: "Senior Notes due 2032",
      principalAmount: "600",
      principalScale: "millions",
      carryingAmount: "590",
      carryingScale: "millions",
      rateText: "",
      rateType: "not_disclosed",
      couponPercent: "",
      maturityText: "Senior Notes due 2032",
      maturityYear: "2032",
      securedStatus: "not_disclosed",
      amountBasis: "principal",
      sourceDocument: "10k.pdf",
    },
    {
      name: "Term Loan due 2029",
      principalAmount: "400",
      principalScale: "millions",
      carryingAmount: "390",
      carryingScale: "millions",
      rateText: "",
      rateType: "not_disclosed",
      couponPercent: "",
      maturityText: "Term Loan due 2029",
      maturityYear: "2029",
      securedStatus: "not_disclosed",
      amountBasis: "principal",
      sourceDocument: "10k.pdf",
    },
  ],
);
check(
  carryingGap.capitalStructure.reconciliationStatus === "difference",
  "principal that differs from reported debt stays unreconciled",
);
includes(carryingGap.capitalStructure.reconciliation, "Unreconciled difference", "difference is explicit");
check(
  carryingGap.maturitySchedule.buckets == null,
  "instrument rows do not become a maturity schedule",
);
check(
  carryingGap.dataQuality.find((item) => item.id === "maturity-schedule")?.status ===
    "Review Required",
  "a missing disclosed maturity schedule requires review",
);

const spam = Array.from({ length: 30 }, (_, index) => `${"m".repeat(4000)} ebitda ${index}`).join("\n");
const business = `Item 1. Business\n${"The company stores records and provides services. ".repeat(800)}\n`;
const risks = `Item 1A. Risk Factors\n${"Competition and regulation may affect results. ".repeat(600)}\n`;
const statements = [
  "Consolidated Balance Sheets",
  "As of June 30, 2026",
  "Cash and cash equivalents $200 million.",
  "Total debt $1,000 million.",
  "TTM Adjusted EBITDA $400 million.",
  "Note 8. Debt",
  "As of June 30, 2026",
  "4.875% Senior Notes due 2027 $300 million.",
  "6.125% Senior Notes due 2031 $700 million.",
  "Revolving credit facility availability $500 million undrawn.",
  "Consolidated Statements of Cash Flows",
  "Cash interest paid for the year ended December 31, 2025 was $80 million.",
  "Cash interest paid for the six months ended June 30, 2025 was $36 million.",
  "Cash interest paid for the six months ended June 30, 2026 was $44 million.",
  "Capital expenditures for the year ended December 31, 2025 were $20 million.",
  "Capital expenditures for the six months ended June 30, 2025 were $9 million.",
  "Capital expenditures for the six months ended June 30, 2026 were $11 million.",
  "Consolidated Statements of Operations",
  "(in millions)",
  "Year ended December 31,",
  "2025 2024 2023",
  "Total revenues 900 800 700",
].join("\n");
const reduced = prepareDocumentsContext([
  { fileName: "large-10q.pdf", text: `${business}${risks}${spam}\n${statements}`, totalPages: 120 },
]);
check(reduced.truncated, "a large filing with a late debt note is reduced");
includes(reduced.text, "Omitted:", "context reduction names what was dropped");
includes(reduced.text, "Item 1. Business", "omitted business section is reported");
includes(reduced.text, "4.875% Senior Notes due 2027", "debt row survives context reduction");
includes(reduced.text, "Total debt $1,000 million", "balance-sheet total survives context reduction");
includes(reduced.text, "Revolving credit facility availability", "revolver availability survives context reduction");
includes(reduced.text, "Cash interest paid for the year ended December 31, 2025", "prior-year cash interest survives");
excludes(reduced.text, "stores records and provides services", "low-value business prose is not kept");
includes(reduced.text, "Total revenues 900 800 700", "comparative revenue survives context reduction");

const reducedAnalysis = applyFinancialValidation(
  modelResult(
    {
      totalDebt: money("540", "point_in_time", "Total debt", "large-10q.pdf"),
      cash: money("200", "point_in_time", "Cash", "large-10q.pdf"),
      ebitda: money("400", "ttm", "Adjusted EBITDA", "large-10q.pdf"),
      cashInterest: money("44", "ttm", "Cash interest", "large-10q.pdf"),
      capitalExpenditures: money("11", "ttm", "Capital expenditures", "large-10q.pdf"),
    },
    { totalDebt: "Total debt is $540 million." },
    [
      {
        name: "4.875% Senior Notes due 2027",
        principalAmount: "300",
        principalScale: "millions",
        carryingAmount: "",
        carryingScale: "not_available",
        rateText: "4.875%",
        rateType: "fixed",
        couponPercent: "4.875",
        maturityText: "due 2031",
        maturityYear: "2031",
        securedStatus: "not_disclosed",
        amountBasis: "principal",
        sourceDocument: "large-10q.pdf",
      },
    ],
  ),
  {
    fileNames: ["large-10q.pdf"],
    excerpt: reduced.text,
    excerptTruncated: reduced.truncated,
    omissions: reduced.omittedSections,
  },
);
check(
  reducedAnalysis.dashboard.find((metric) => metric.id === "totalDebt")?.value === "$1B",
  "the most recent total debt in the excerpt replaces the partial $540 million figure",
);
includes(reducedAnalysis.keyMetrics.totalDebt, "1,000 million", "narrative total debt matches the validated balance");
excludes(reducedAnalysis.keyMetrics.totalDebt, "$540 million", "rejected partial debt is not presented as the balance");
const notes2027 = reducedAnalysis.capitalStructure.instruments.find((row) =>
  row.name.includes("4.875%"),
);
check(notes2027?.maturityYear === 2027, "a maturity from another row is not attached");
excludes(notes2027?.name ?? "", "Unsupported", "instrument names stay free of validation warnings");
check(
  reducedAnalysis.capitalStructure.instruments.some((row) => row.name.includes("6.125%")),
  "a debt row omitted by the model is recovered from the table",
);
check(
  reducedAnalysis.capitalStructure.reconciliationStatus === "matched",
  "recovered instrument balances reconcile to reported total debt",
);
includes(
  reducedAnalysis.capitalStructure.qualityNotes.join(" "),
  "Undrawn facility",
  "undrawn revolver is called out separately from outstanding debt",
);
check(
  reducedAnalysis.capitalStructure.instruments
    .filter((row) => row.kind === "outstanding")
    .every((row) => row.principalAbsolute !== 500_000_000),
  "undrawn availability is not counted as outstanding principal",
);
includes(reducedAnalysis.keyMetrics.interestCoverage, "88 million", "cash-interest bridge total");
includes(reducedAnalysis.keyMetrics.interestCoverage, "December 31, 2025", "bridge keeps the fiscal year");
includes(reducedAnalysis.keyMetrics.interestCoverage, "June 30, 2025", "bridge keeps the prior stub");
excludes(
  reducedAnalysis.keyMetrics.interestCoverage,
  "annualized approximation",
  "a fiscal-year bridge is not labeled as an annualized approximation",
);
check(
  reducedAnalysis.dashboard.find((metric) => metric.id === "interestCoverage")?.period ===
    "Trailing twelve months",
  "bridged cash interest coverage is actual TTM",
);
includes(reducedAnalysis.keyMetrics.interestCoverage, "TTM cash interest", "bridged interest keeps the cash-interest label");
check(
  reducedAnalysis.dashboard.find((metric) => metric.id === "capitalExpenditures")?.value === "$22M",
  "capex uses fiscal year plus current stub minus prior stub",
);
includes(reducedAnalysis.calculationNotes, "Omitted:", "calculation notes repeat omitted sections");
check(
  reducedAnalysis.dashboard.find((metric) => metric.id === "liquidity")?.value === "$700M",
  "liquidity adds cash and revolving availability",
);

const annualizedInterest = runValidation(
  {
    ...standardDebt,
    ebitda: money("400", "ttm", "Adjusted EBITDA"),
    cashInterest: money("44", "ttm", "Cash interest"),
  },
  undefined,
  "Total debt $850 million. Cash $50 million. TTM Adjusted EBITDA $400 million. Cash interest for the six months ended June 30, 2026 was $44 million.",
);
includes(
  annualizedInterest.keyMetrics.interestCoverage,
  "annualized approximation",
  "six-month cash interest is not called actual TTM coverage",
);
excludes(
  annualizedInterest.keyMetrics.interestCoverage,
  "TTM cash interest",
  "annualized six-month cash interest is not labeled TTM cash interest",
);
check(
  annualizedInterest.dashboard.find((metric) => metric.id === "interestCoverage")?.period ===
    "Annualized approximation",
  "coverage card period says annualized approximation",
);
includes(
  annualizedInterest.dataQuality.find((item) => item.id === "annualized-ttm")?.detail ?? "",
  "Annualized rather than actual TTM calculation",
  "data quality names the annualized coverage",
);

const gaapBridge = runValidation(
  {
    ...standardDebt,
    ebitda: money("400", "ttm", "Adjusted EBITDA"),
  },
  undefined,
  [
    "Total debt $850 million. Cash $50 million. TTM Adjusted EBITDA $400 million.",
    "Interest expense for the year ended December 31, 2025 was $80 million.",
    "Interest expense for the six months ended June 30, 2025 was $36 million.",
    "Interest expense for the six months ended June 30, 2026 was $44 million.",
  ].join(" "),
);
includes(gaapBridge.keyMetrics.interestCoverage, "interest expense", "GAAP interest stays distinct from cash interest");
includes(gaapBridge.keyMetrics.interestCoverage, "88 million", "GAAP interest bridge");
excludes(gaapBridge.keyMetrics.interestCoverage, "TTM cash interest", "GAAP interest is not renamed cash interest");
includes(
  gaapBridge.calculationNotes,
  "GAAP interest expense",
  "coverage says cash interest was unavailable",
);

const quarterInterest = runValidation(
  {
    ...standardDebt,
    ebitda: money("400", "ttm", "Adjusted EBITDA"),
    cashInterest: money("20", "quarterly", "Cash interest"),
  },
  undefined,
  [
    "Total debt $850 million. Cash $50 million. TTM Adjusted EBITDA $400 million.",
    "Q3 2025 cash interest $20 million.",
    "Q4 2025 cash interest $21 million.",
    "Q1 2026 cash interest $22 million.",
    "Q2 2026 cash interest $23 million.",
  ].join(" "),
);
includes(quarterInterest.keyMetrics.interestCoverage, "four consecutive quarters", "four interest quarters become TTM");
excludes(quarterInterest.keyMetrics.interestCoverage, "annualized approximation", "four interest quarters are not annualized");
includes(quarterInterest.keyMetrics.interestCoverage, "86 million", "sum of the four interest quarters");

const missingDebtNarrative = runValidation(
  {},
  { totalDebt: "Total debt is $9,999 million." },
  "The filing discusses operations but does not state a debt balance.",
);
includes(missingDebtNarrative.keyMetrics.totalDebt, "Unverified draft", "rejected narrative debt is flagged");
includes(missingDebtNarrative.keyMetrics.totalDebt, NOT_AVAILABLE, "rejected narrative debt is not accepted");
check(
  missingDebtNarrative.dashboard.find((metric) => metric.id === "totalDebt")?.value === "n/a",
  "rejected total debt stays off the metric card",
);
includes(
  missingDebtNarrative.dataQuality.find((item) => item.id === "balance-sheet")?.detail ?? "",
  "Missing balance sheet metric",
  "missing debt is an actionable balance-sheet warning",
);

const reportedFromExcerpt = runValidation(
  {
    ...standardDebt,
    ebitda: money("400", "ttm", "Adjusted EBITDA"),
  },
  { reportedLeverage: "Leverage is attractive." },
  "Total debt $850 million. Cash $50 million. TTM Adjusted EBITDA $400 million. Net leverage 4.8x as of June 30, 2026.",
);
includes(reportedFromExcerpt.keyMetrics.reportedLeverage, "4.8x", "company-reported leverage is read from the excerpt");
check(
  reportedFromExcerpt.dashboard.find((metric) => metric.id === "reportedLeverage")?.value === "4.80x",
  "reported leverage card uses the excerpt multiple",
);

const staleBalance = applyFinancialValidation(
  modelResult({
    totalDebt: {
      amount: "900",
      scale: "millions",
      period: "point_in_time",
      sourceDocument: "annual.pdf",
      asOf: "December 31, 2025",
      description: "Total debt",
    },
    cash: {
      amount: "40",
      scale: "millions",
      period: "point_in_time",
      sourceDocument: "annual.pdf",
      asOf: "December 31, 2025",
      description: "Cash",
    },
    ebitda: money("400", "ttm", "Adjusted EBITDA", "quarterly.pdf"),
  }),
  {
    fileNames: ["annual.pdf", "quarterly.pdf"],
    excerpt: [
      "===== DOCUMENT 1 of 2: annual.pdf =====",
      "Total debt as of December 31, 2025 was $900 million.",
      "Cash as of December 31, 2025 was $40 million.",
      "===== DOCUMENT 2 of 2: quarterly.pdf =====",
      "Total debt as of June 30, 2026 was $1,000 million.",
      "Cash as of June 30, 2026 was $50 million.",
      "TTM Adjusted EBITDA $400 million.",
    ].join("\n"),
    excerptTruncated: false,
  },
);
includes(staleBalance.keyMetrics.totalDebt, "1,000 million", "newer balance-sheet debt replaces the older filing");
includes(staleBalance.keyMetrics.cash, "50 million", "newer cash replaces the older filing");
includes(staleBalance.keyMetrics.netDebt, "950", "net debt uses the latest shared date");
excludes(staleBalance.keyMetrics.netDebt, "860", "older debt and cash are not mixed into net debt");

const mixedDates = applyFinancialValidation(
  modelResult({
    totalDebt: {
      amount: "900",
      scale: "millions",
      period: "point_in_time",
      sourceDocument: "annual.pdf",
      asOf: "December 31, 2025",
      description: "Total debt",
    },
    cash: {
      amount: "50",
      scale: "millions",
      period: "point_in_time",
      sourceDocument: "quarterly.pdf",
      asOf: "June 30, 2026",
      description: "Cash",
    },
    ebitda: money("400", "ttm", "Adjusted EBITDA", "quarterly.pdf"),
  }),
  {
    fileNames: ["annual.pdf", "quarterly.pdf"],
    excerpt: [
      "===== DOCUMENT 1 of 2: annual.pdf =====",
      "Total debt as of December 31, 2025 was $900 million.",
      "===== DOCUMENT 2 of 2: quarterly.pdf =====",
      "Cash as of June 30, 2026 was $50 million.",
      "TTM Adjusted EBITDA $400 million.",
    ].join("\n"),
    excerptTruncated: false,
  },
);
includes(mixedDates.keyMetrics.netDebt, "Conflicting reporting dates", "different balance-sheet dates are not combined");
check(
  mixedDates.dashboard.find((metric) => metric.id === "netDebt")?.value === "n/a",
  "net debt card is withheld when the dates conflict",
);
check(
  mixedDates.dataQuality.find((item) => item.id === "reporting-dates")?.status === "Review Required",
  "conflicting reporting dates require review",
);

const historicalIssuance = runValidation(
  {
    totalDebt: money("1000", "point_in_time", "Total debt"),
    cash: money("50", "point_in_time", "Cash"),
  },
  undefined,
  "Total debt $1,000 million. Cash $50 million. In March 2026 the company issued $250 million of 5.000% Senior Notes due 2034. Senior Notes due 2032 principal $600 million. Term Loan due 2029 principal $400 million.",
  ["10k.pdf"],
  [
    {
      name: "Senior Notes due 2032",
      principalAmount: "600",
      principalScale: "millions",
      carryingAmount: "",
      carryingScale: "not_available",
      rateText: "",
      rateType: "not_disclosed",
      couponPercent: "",
      maturityText: "Senior Notes due 2032",
      maturityYear: "2032",
      securedStatus: "not_disclosed",
      amountBasis: "principal",
      sourceDocument: "10k.pdf",
    },
    {
      name: "Term Loan due 2029",
      principalAmount: "400",
      principalScale: "millions",
      carryingAmount: "",
      carryingScale: "not_available",
      rateText: "",
      rateType: "not_disclosed",
      couponPercent: "",
      maturityText: "Term Loan due 2029",
      maturityYear: "2029",
      securedStatus: "not_disclosed",
      amountBasis: "principal",
      sourceDocument: "10k.pdf",
    },
  ],
);
check(
  historicalIssuance.capitalStructure.reconciliationStatus === "matched",
  "a historical issuance is not added to outstanding principal",
);
includes(
  historicalIssuance.capitalStructure.qualityNotes.join(" "),
  "Historical issuance",
  "historical issuance is explained outside the instrument name",
);
check(
  !historicalIssuance.capitalStructure.instruments.some((row) => row.principalAbsolute === 250_000_000),
  "the issued amount is not an outstanding principal balance",
);

const conflictingInstrument = applyFinancialValidation(
  modelResult(
    {
      totalDebt: money("600", "point_in_time", "Total debt", "quarterly.pdf"),
      cash: money("50", "point_in_time", "Cash", "quarterly.pdf"),
    },
    undefined,
    [
      {
        name: "Senior Notes due 2032",
        principalAmount: "500",
        principalScale: "millions",
        carryingAmount: "",
        carryingScale: "not_available",
        rateText: "",
        rateType: "not_disclosed",
        couponPercent: "",
        maturityText: "Senior Notes due 2032",
        maturityYear: "2032",
        securedStatus: "not_disclosed",
        amountBasis: "principal",
        sourceDocument: "annual.pdf",
      },
    ],
  ),
  {
    fileNames: ["annual.pdf", "quarterly.pdf"],
    excerpt: [
      "===== DOCUMENT 1 of 2: annual.pdf =====",
      "As of December 31, 2025.",
      "Senior Notes due 2032 principal $500 million.",
      "===== DOCUMENT 2 of 2: quarterly.pdf =====",
      "As of June 30, 2026.",
      "Senior Notes due 2032 principal $600 million.",
      "Total debt $600 million. Cash $50 million.",
    ].join("\n"),
    excerptTruncated: false,
  },
);
const conflictingNotes = conflictingInstrument.capitalStructure.instruments.filter((row) =>
  row.name.toLowerCase().includes("senior notes due 2032"),
);
check(conflictingNotes.length === 1, "the same note is not listed twice");
check(
  conflictingNotes[0]?.principalAbsolute === 600_000_000,
  "the later instrument balance replaces the older one",
);
includes(
  conflictingInstrument.capitalStructure.qualityNotes.join(" "),
  "Conflicting instrument information",
  "the older instrument balance is explained",
);

const thousandsTable = runValidation(
  {
    totalDebt: {
      amount: "990",
      scale: "millions",
      period: "point_in_time",
      sourceDocument: "10k.pdf",
      asOf: "December 31, 2025",
      description: "Total debt",
    },
    cash: money("50", "point_in_time", "Cash"),
  },
  undefined,
  [
    "Total debt $980 million.",
    "Cash $50 million.",
    "($ in thousands)",
    "Principal Carrying value",
    "4.500% Senior Notes due 2027 600,000 590,000",
    "Term Loan due 2029 400,000 390,000",
  ].join("\n"),
  ["10k.pdf"],
);
const tableNotes = thousandsTable.capitalStructure.instruments.find((row) =>
  row.name.includes("4.500%"),
);
const tableLoan = thousandsTable.capitalStructure.instruments.find((row) =>
  row.name.toLowerCase().includes("term loan"),
);
check(tableNotes?.principalAbsolute === 600_000_000, "thousands table keeps principal on its own row");
check(tableNotes?.carryingAbsolute === 590_000_000, "thousands table keeps carrying value on its own row");
check(tableNotes?.maturityYear === 2027, "thousands table keeps the maturity on its own row");
check(tableLoan?.principalAbsolute === 400_000_000, "the next table row is not given the prior row's amount");
check(tableLoan?.maturityYear === 2029, "the next table row keeps its own maturity");
includes(
  thousandsTable.capitalStructure.reconciliation,
  "Unreconciled difference",
  "principal that differs from carrying-based total debt stays unreconciled",
);
includes(
  thousandsTable.capitalStructure.reconciliation,
  "carrying-value sum matches reported total debt",
  "the carrying column explains the gap to reported debt",
);

function requiredKeys(schema: z.ZodTypeAny): string[] {
  if (schema instanceof z.ZodObject) return Object.keys(schema.shape);
  throw new Error("Expected a Zod object schema.");
}

for (const key of requiredKeys(creditAnalysisSchema)) {
  check(
    creditAnalysisJsonSchema.required.includes(
      key as (typeof creditAnalysisJsonSchema.required)[number],
    ),
    `JSON schema is missing top-level field ${key}`,
  );
}
for (const key of requiredKeys(creditAnalysisSchema.shape.keyMetrics)) {
  check(
    creditAnalysisJsonSchema.properties.keyMetrics.required.includes(
      key as (typeof creditAnalysisJsonSchema.properties.keyMetrics.required)[number],
    ),
    `JSON schema is missing key metric ${key}`,
  );
}
check(
  creditAnalysisJsonSchema.properties.keyMetrics.required.includes("totalDebt"),
  "existing totalDebt metric should remain in the schema",
);
check(
  creditAnalysisJsonSchema.required.includes("liquidityAndMaturities"),
  "existing liquidity section should remain in the schema",
);
check(
  creditAnalysisJsonSchema.required.includes("keyCreditRisks"),
  "existing risk section should remain in the schema",
);
check(
  creditAnalysisJsonSchema.required.includes("debtInstruments"),
  "debt instruments should be part of the model schema",
);
for (const key of requiredKeys(creditAnalysisSchema.shape.calculationBasis)) {
  check(
    creditAnalysisJsonSchema.properties.calculationBasis.required.includes(
      key as (typeof creditAnalysisJsonSchema.properties.calculationBasis.required)[number],
    ),
    `JSON schema is missing calculation basis ${key}`,
  );
}
const debtSchema = creditAnalysisSchema.shape.debtInstruments;
if (debtSchema instanceof z.ZodArray && debtSchema.element instanceof z.ZodObject) {
  for (const key of Object.keys(debtSchema.element.shape)) {
    check(
      creditAnalysisJsonSchema.properties.debtInstruments.items.required.includes(
        key as (typeof creditAnalysisJsonSchema.properties.debtInstruments.items.required)[number],
      ),
      `JSON schema is missing debt instrument field ${key}`,
    );
  }
} else {
  failures.push("debt instrument schema should be an array of objects");
}

const annualExcerpt = `
Consolidated Statements of Operations
(in millions)
Year ended December 31,
2025 2024 2023
Total revenues 900 800 700
Operating income 200 180 150
Interest expense 90 85 80
Storage revenue 90 80 70

Consolidated Statements of Cash Flows
(in millions)
Year ended December 31,
2025 2024 2023
Net cash provided by operating activities 250 220 200
Capital expenditures (40) (35) (30)

(in millions)
Year ended December 31,
2025 2024 2023
Adjusted EBITDA 400 360 300

Consolidated Balance Sheets
(in millions)
December 31, 2025 December 31, 2024
Cash and cash equivalents 50 40
Total debt 1,000 900

Scheduled maturities of long-term debt (in millions):
2026 100
2027 150
Thereafter 750
Total 1,000
`;
const historicalAnnual = runValidation({}, undefined, annualExcerpt, ["10k.pdf"]);
function trend(id: string, year: string): string {
  const row = historicalAnnual.financialTrends.rows.find((item) => item.id === id);
  const index = historicalAnnual.financialTrends.years.indexOf(year);
  if (!row || index < 0) return "";
  return `${row.cells[index]?.display ?? ""} ${row.cells[index]?.detail ?? ""}`;
}
check(
  historicalAnnual.financialTrends.years.join(",") === "2023,2024,2025",
  "trend columns use the disclosed fiscal years",
);
includes(trend("revenue", "2025"), "$900M", "2025 revenue is kept");
includes(trend("revenue", "2025"), "900 million", "revenue detail keeps reported units");
includes(trend("revenue", "2025"), "Total revenues", "revenue detail keeps the disclosed definition");
includes(trend("revenue", "2025"), "10k.pdf", "revenue detail keeps the source");
includes(trend("revenue", "2025"), "Year ended December 31, 2025", "revenue detail keeps the fiscal period");
includes(trend("revenueGrowth", "2025"), "12.50%", "revenue growth uses the prior disclosed year");
check(trend("revenueGrowth", "2023").trim() === "n/a", "the earliest year has no revenue growth");
includes(trend("operatingIncome", "2024"), "$180M", "operating income stays with its year");
includes(trend("ebitda", "2025"), "$400M", "stated adjusted EBITDA is shown");
check(
  historicalAnnual.financialTrends.rows.find((row) => row.id === "ebitda")?.label === "Adjusted EBITDA",
  "the EBITDA row uses the disclosed adjusted definition",
);
includes(trend("ebitdaMargin", "2025"), "44.44%", "EBITDA margin uses the same year");
includes(trend("operatingCashFlow", "2023"), "$200M", "operating cash flow is kept");
includes(trend("capitalExpenditures", "2025"), "-$40M", "capital expenditures keep the cash-flow sign");
includes(trend("freeCashFlow", "2025"), "$210M", "free cash flow subtracts capital expenditures");
includes(trend("interestExpense", "2025"), "$90M", "interest expense is kept");
includes(trend("totalDebt", "2025"), "$1B", "total debt uses the balance-sheet year");
check(trend("totalDebt", "2023").trim() === "n/a", "a year without a balance sheet stays blank");
includes(trend("netLeverage", "2025"), "2.38x", "net leverage uses debt, cash, and EBITDA for 2025");
check(trend("netLeverage", "2023").trim() === "n/a", "net leverage is blank when debt or EBITDA is missing");
check(
  historicalAnnual.maturitySchedule.buckets?.map((bucket) => bucket.label).join(",") === "2026,2027,Thereafter",
  "maturity buckets keep Thereafter",
);
check(
  historicalAnnual.maturitySchedule.buckets?.map((bucket) => bucket.display).join(",") === "$100M,$150M,$750M",
  "maturity amounts use the disclosed schedule",
);

const noEbitda = runValidation(
  {},
  undefined,
  `
Consolidated Statements of Operations
(in millions)
Year ended December 31,
2025 2024
Total revenues 900 800
Operating income 200 180
`,
  ["10k.pdf"],
);
check(
  noEbitda.financialTrends.rows.find((row) => row.id === "ebitda")?.cells.every((cell) => cell.display === "n/a"),
  "historical EBITDA is not invented from operating income",
);
check(
  noEbitda.financialTrends.rows.find((row) => row.id === "ebitdaMargin")?.cells.every((cell) => cell.display === "n/a"),
  "EBITDA margin is blank without disclosed EBITDA",
);

const instrumentOnly = runValidation(
  {},
  undefined,
  "Total debt $1,000 million. Senior Notes due 2032 principal $600 million. Term Loan due 2029 principal $400 million.",
  ["10k.pdf"],
);
check(instrumentOnly.maturitySchedule.buckets == null, "instrument maturities are not charted");
check(instrumentOnly.maturitySchedule.message === NOT_AVAILABLE, "an unreliable schedule says Not available");

const badTotal = runValidation(
  {},
  undefined,
  `
Scheduled maturities of long-term debt (in thousands):
2026 100,000
2027 200,000
Thereafter 300,000
Total 900,000
`,
  ["10k.pdf"],
);
check(badTotal.maturitySchedule.buckets == null, "a schedule that misses its disclosed total is rejected");

const laterColumn = runValidation(
  {},
  undefined,
  `
Scheduled maturities of long-term debt (in thousands):
December 31, 2024 December 31, 2025
2026 90,000 100,000
2027 80,000 200,000
Thereafter 400,000 1,000,000
Total 570,000 1,300,000
`,
  ["10k.pdf"],
);
check(
  laterColumn.maturitySchedule.buckets?.map((bucket) => bucket.display).join(",") === "$100M,$200M,$1B",
  "a two-column schedule uses the latest reporting date",
);

const inlineSchedule = runValidation(
  {},
  undefined,
  "Scheduled maturities of long-term debt were $100 million in 2026, $150 million in 2027, and $750 million thereafter.",
  ["10k.pdf"],
);
check(
  inlineSchedule.maturitySchedule.buckets?.map((bucket) => `${bucket.label}:${bucket.display}`).join(",") ===
    "2026:$100M,2027:$150M,thereafter:$750M",
  "a printed sentence schedule keeps its buckets",
);

const conflictingSchedules = runValidation(
  {},
  undefined,
  `
Scheduled maturities of long-term debt (in millions):
2026 100
2027 150
Thereafter 750
Total 1,000

Scheduled maturities of long-term debt (in millions):
2026 80
2027 150
Thereafter 750
Total 980
`,
  ["10k.pdf"],
);
check(
  conflictingSchedules.maturitySchedule.buckets == null,
  "conflicting maturity schedules are not averaged",
);

const lossCarryforward = runValidation(
  {},
  undefined,
  `
DECEMBER 31,
2025 2024
Deferred Tax Assets:
Net operating loss carryforwards 173,024 168,773
Valuation allowance (152,605) (132,714)
`,
);
excludes(
  JSON.stringify(lossCarryforward.financialTrends),
  "173,024",
  "a tax-loss carryforward is not operating income",
);
excludes(
  JSON.stringify(lossCarryforward.financialTrends),
  "168,773",
  "the prior-year tax-loss carryforward is not operating income",
);

const statementWithLossTable = runValidation(
  {},
  undefined,
  `
DECEMBER 31,
2025 2024
Net operating loss carryforwards 173,024 168,773

CONSOLIDATED STATEMENTS OF OPERATIONS
(in thousands, except per share data)
YEAR ENDED DECEMBER 31,
2025 2024 2023
Total Revenues 300,000 200,000 100,000
Operating Income (Loss) 50,000 40,000 30,000
Interest Expense, Net (includes Interest Income of $17,127, $14,672 and $12,471 in 2025,
2024 and 2023, respectively) 829,335 721,559 585,932

CONSOLIDATED STATEMENTS OF CASH FLOWS
(in thousands)
YEAR ENDED DECEMBER 31,
2025 2024 2023
Cash Flows from Operating Activities 400,000 350,000 300,000
Capital expenditures (40,000) (30,000) (20,000)

YEAR ENDED DECEMBER 31,
2025 2024 Change Change
Total Revenues 300,000 200,000 100,000 50
`,
);
includes(trendText(statementWithLossTable, "revenue", "2025"), "$300M", "2025 revenue stays in the 2025 column");
includes(trendText(statementWithLossTable, "revenue", "2023"), "$100M", "2023 revenue stays in the 2023 column");
includes(
  trendText(statementWithLossTable, "revenue", "2025"),
  "300,000 thousand",
  "revenue detail keeps the stated thousands",
);
includes(trendText(statementWithLossTable, "operatingIncome", "2025"), "$50M", "2025 operating income comes from the statement");
includes(trendText(statementWithLossTable, "operatingIncome", "2024"), "$40M", "2024 operating income comes from the statement");
includes(trendText(statementWithLossTable, "operatingIncome", "2023"), "$30M", "2023 operating income comes from the statement");
excludes(
  trendText(statementWithLossTable, "operatingIncome", "2025"),
  "173,024",
  "operating income ignores the tax-loss table",
);
includes(
  trendText(statementWithLossTable, "interestExpense", "2025"),
  "829,335 thousand",
  "wrapped interest expense uses the statement amount",
);
excludes(
  trendText(statementWithLossTable, "interestExpense", "2025"),
  "17,127",
  "interest income inside the label is not the expense",
);
includes(
  trendText(statementWithLossTable, "operatingCashFlow", "2025"),
  "$400M",
  "cash flows from operating activities is the operating cash flow line",
);
includes(trendText(statementWithLossTable, "operatingCashFlow", "2023"), "$300M", "2023 operating cash flow stays with 2023");
check(
  statementWithLossTable.financialTrends.years.join(",") === "2023,2024,2025",
  "statement years stay in chronological order",
);

const reusedAnnualEbitda = runValidation(
  {
    ebitda: {
      amount: "2779824",
      scale: "thousands",
      period: "annual",
      sourceDocument: "10k.pdf",
      asOf: "December 31, 2025",
      description: "Adjusted EBITDA",
    },
  },
  undefined,
  "Annual Adjusted EBITDA was $2,779,824 thousand for the year ended December 31, 2025.",
);
includes(
  trendText(reusedAnnualEbitda, "ebitda", "2025"),
  "2,779,824 thousand",
  "a verified annual EBITDA fills a blank 2025 trend cell",
);
includes(reusedAnnualEbitda.keyMetrics.ebitda, "2,779,824 thousand", "overview EBITDA is unchanged");
check(trendText(reusedAnnualEbitda, "ebitda", "2024") === "", "the overview figure is not copied into another year");

const statementEbitdaWins = runValidation(
  {
    ebitda: {
      amount: "999",
      scale: "millions",
      period: "annual",
      sourceDocument: "10k.pdf",
      asOf: "December 31, 2025",
      description: "Adjusted EBITDA",
    },
  },
  undefined,
  `
(in millions)
Year ended December 31,
2025 2024
Adjusted EBITDA 400 360
Annual Adjusted EBITDA was $999 million for the year ended December 31, 2025.
`,
);
includes(trendText(statementEbitdaWins, "ebitda", "2025"), "$400M", "the statement EBITDA is kept");
excludes(trendText(statementEbitdaWins, "ebitda", "2025"), "999", "a different overview amount does not replace it");
includes(statementEbitdaWins.keyMetrics.ebitda, "$999 million", "overview keeps its own EBITDA figure");

const ttmNotAnnual = runValidation(
  {
    ebitda: money("400", "ttm", "Adjusted EBITDA"),
  },
  undefined,
  "TTM Adjusted EBITDA $400 million.",
);
check(
  ttmNotAnnual.financialTrends.rows.find((row) => row.id === "ebitda") == null,
  "trailing-twelve-month EBITDA is not placed in an annual column",
);
includes(ttmNotAnnual.keyMetrics.ebitda, "$400 million", "overview still shows the trailing figure");

const segmentEbitda = runValidation(
  {
    ebitda: {
      amount: "2779824",
      scale: "thousands",
      period: "annual",
      sourceDocument: "10k.pdf",
      asOf: "December 31, 2025",
      description: "Total Adjusted EBITDA for Reportable Segments",
    },
  },
  undefined,
  `
YEAR ENDED DECEMBER 31,
2025 2024 2023
Total Adjusted EBITDA for Reportable Segments 2,779,824 2,505,630 2,242,982
`,
);
excludes(
  JSON.stringify(segmentEbitda.financialTrends),
  "2,779,824",
  "segment EBITDA is not used as company EBITDA",
);

const distantMaturity = `
(In thousands, except share and per share data)
${Array.from({ length: 18 }, () => "The credit agreement contains financial covenants.").join("\n")}
Maturities of long-term debt are as follows:
YEAR AMOUNT
2026 $ 10,000
2027 20,000
Thereafter 30,000

Operating lease payments
2026 9,000
2027 8,000
Thereafter 7,000

Contractual interest payments are $5 million in 2026, $4 million in 2027, and $3 million thereafter.
Senior Notes due 2032 principal $600 million.
Purchase commitments
2026 $ 1,500
Thereafter 2,500
`;
const distantSchedule = runValidation({}, undefined, distantMaturity);
check(
  distantSchedule.maturitySchedule.buckets?.map((bucket) => `${bucket.label}:${bucket.display}`).join(",") ===
    "2026:$10M,2027:$20M,Thereafter:$30M",
  "a debt maturity table keeps its buckets when the scale heading is above it",
);
const unscaledSchedule = runValidation(
  {},
  undefined,
  `
Maturities of long-term debt
2026 10,000
2027 20,000
Thereafter 30,000
`,
);
check(unscaledSchedule.maturitySchedule.buckets == null, "a maturity table without a scale is not charted");

const filingLead = [
  "NOTE 6. DEBT",
  "Total debt $10 million.",
  "Cash $4 million.",
  "Annual Adjusted EBITDA was $2,779,824 thousand for the year ended December 31, 2025.",
  "DECEMBER 31,",
  "2025 2024",
  "Net operating loss carryforwards 173,024 168,773",
  ...Array.from({ length: 16 }, () => "The credit agreement contains a fixed charge coverage covenant."),
].join("\n");
const filingStatements = `
CONSOLIDATED BALANCE SHEETS
(in thousands)
DECEMBER 31,
2025 2024
Cash and cash equivalents $ 158,535 $ 155,716
Long-term Debt, net of current portion 16,000 15,000
The accompanying notes are an integral part of these consolidated financial statements.

CONSOLIDATED STATEMENTS OF OPERATIONS
(in thousands)
YEAR ENDED DECEMBER 31,
2025 2024 2023
Total Revenues 300,000 200,000 100,000
Operating Income (Loss) 50,000 40,000 30,000
The accompanying notes are an integral part of these consolidated financial statements.

CONSOLIDATED STATEMENTS OF CASH FLOWS
(in thousands)
YEAR ENDED DECEMBER 31,
2025 2024 2023
Cash Flows from Operating Activities 400,000 350,000 300,000
The accompanying notes are an integral part of these consolidated financial statements.

ITEM 7. MANAGEMENT'S DISCUSSION AND ANALYSIS

RECONCILIATION OF NET INCOME (LOSS) TO ADJUSTED EBITDA (IN THOUSANDS):
YEAR ENDED DECEMBER 31,
2025 2024
Adjusted EBITDA $ 2,573,950 $ 2,236,380
YEAR ENDED DECEMBER 31,
2025 2024 Change Change
Adjusted EBITDA $ 2,573,950 $ 2,236,380 $ 337,570 15.1 %
YEAR ENDED DECEMBER 31,
2025 2024 2023
Total Adjusted EBITDA for Reportable Segments 2,779,824 2,505,630 2,242,982

${Array.from({ length: 40 }, () => "The indenture limits additional borrowings.").join("\n")}
(In thousands, except share and per share data)
${Array.from({ length: 20 }, () => "Debt covenants are tested quarterly.").join("\n")}
J. MATURITIES OF LONG-TERM DEBT (GROSS OF DISCOUNTS) ARE AS FOLLOWS:
YEAR AMOUNT
2026 $ 10,000
2027 20,000
2028 30,000
2029 40,000
2030 50,000
Thereafter 60,000
210,000
Net Discounts (1,000)
Total Long-term Debt (including current portion) $ 209,000
Purchase commitments
2026 $ 80,208
Thereafter 6,185
`;
const fullFiling = `${filingLead}\n${filingStatements}`;
const packedFiling = selectFinancialExcerpt(fullFiling, 420);
const historicalFiling = buildHistoricalSource([
  { fileName: "annual-report.pdf", text: fullFiling },
]);
check(
  !packedFiling.text.includes("300,000"),
  "the shortened model excerpt drops the operations statement",
);
check(
  packedFiling.omitted.some((label) => /statements of operations/i.test(label)),
  "the omission note names the operations statement",
);
check(historicalFiling.includes("300,000"), "historical extraction keeps the operations statement");
check(
  !historicalFiling.includes("173,024"),
  "historical extraction does not keep the tax-loss carryforward table",
);
check(historicalFiling.includes("MATURITIES OF LONG-TERM DEBT"), "historical extraction keeps the maturity schedule");
const restored = applyFinancialValidation(
  modelResult({
    totalDebt: {
      amount: "10",
      scale: "millions",
      period: "point_in_time",
      sourceDocument: "annual-report.pdf",
      asOf: "December 31, 2025",
      description: "Total debt",
    },
    cash: {
      amount: "4",
      scale: "millions",
      period: "point_in_time",
      sourceDocument: "annual-report.pdf",
      asOf: "December 31, 2025",
      description: "Cash",
    },
    ebitda: {
      amount: "2779824",
      scale: "thousands",
      period: "annual",
      sourceDocument: "annual-report.pdf",
      asOf: "December 31, 2025",
      description: "Adjusted EBITDA",
    },
  }),
  {
    fileNames: ["annual-report.pdf"],
    excerpt: packedFiling.text,
    excerptTruncated: true,
    omissions: packedFiling.omitted,
    historicalSource: historicalFiling,
  },
);
includes(restored.keyMetrics.cash, "$4 million", "overview cash still comes from the model excerpt");
includes(
  restored.keyMetrics.ebitda,
  "2,573,950 thousand",
  "overview EBITDA uses consolidated Adjusted EBITDA",
);
excludes(
  restored.keyMetrics.ebitda,
  "2,779,824",
  "overview EBITDA is not the reportable-segment subtotal",
);
includes(trendText(restored, "revenue", "2025"), "300,000 thousand", "historical revenue is read from the statement");
includes(trendText(restored, "operatingIncome", "2024"), "40,000 thousand", "historical operating income is not the tax-loss amount");
includes(trendText(restored, "operatingIncome", "2023"), "30,000 thousand", "2023 operating income is kept when the tax table has no 2023 column");
includes(
  trendText(restored, "ebitda", "2025"),
  "2,573,950 thousand",
  "the consolidated Adjusted EBITDA reconciliation is used",
);
excludes(
  trendText(restored, "ebitda", "2025"),
  "2,779,824",
  "segment EBITDA does not replace the consolidated reconciliation",
);
check(trendText(restored, "ebitda", "2023").trim() === "n/a", "2023 EBITDA stays blank when it is not disclosed");
includes(
  trendText(restored, "netLeverage", "2025"),
  "$158.5M",
  "balance-sheet cash is used for that year's net leverage",
);
excludes(restored.keyMetrics.cash, "$158.5M", "overview cash is not replaced by the balance-sheet amount");
includes(trendText(restored, "totalDebt", "2025"), "$10M", "a verified total-debt figure fills only the matching year");
check(trendText(restored, "totalDebt", "2024").trim() === "n/a", "long-term debt net of current portion is not total debt");
includes(trendText(restored, "operatingCashFlow", "2025"), "$400M", "operating cash flow survives excerpt shortening");
check(
  restored.maturitySchedule.buckets?.map((bucket) => bucket.display).join(",") ===
    "$10M,$20M,$30M,$40M,$50M,$60M",
  "the disclosed maturity schedule is charted from the full filing",
);
check(
  restored.maturitySchedule.buckets?.some((bucket) => bucket.label === "Thereafter") === true,
  "the maturity chart keeps Thereafter",
);
excludes(
  restored.maturitySchedule.buckets?.map((bucket) => bucket.display).join(",") ?? "",
  "$80",
  "purchase commitments are not debt maturities",
);
includes(
  restored.maturitySchedule.reconciliation?.note ?? "",
  "Net Discounts",
  "a printed discount is included in the maturity reconciliation",
);
check(
  restored.maturitySchedule.reconciliation?.foots === true,
  "printed maturity adjustments foot to the carrying amount",
);
check(
  restored.maturitySchedule.reconciliation?.carryingAbsolute === 209_000_000,
  "the maturity reconciliation keeps the printed carrying amount",
);

const consolidatedExcerpt = `
(in thousands)
YEAR ENDED DECEMBER 31,
2025 2024
Adjusted EBITDA $ 2,573,950 $ 2,236,380
Interest Expense, Net 829,335 721,559
(in thousands)
Maturities of long-term debt (gross of discounts) are as follows:
2026 $ 216,074
2027 2,330,763
2028 1,663,693
2029 2,137,476
2030 3,035,690
Thereafter 7,173,071
16,556,767
Net Discounts (12,294)
Net Deferred Financing Costs (112,514)
Total Long-term Debt (including current portion) $ 16,431,959
`;
const segmentFiling = `
===== DOCUMENT 1 of 1: annual-report.pdf =====
(in thousands)
YEAR ENDED DECEMBER 31,
2025 2024 2023
Total Adjusted EBITDA for Reportable Segments 2,779,824 2,505,630 2,242,982
Cash Paid for Interest $ 824,591
The Credit Agreement uses EBITDAR-based calculations as the primary measure for calculating leverage ratios.
As of December 31, 2025, net total lease adjusted leverage ratio 4.9. Maximum allowable of 7.0.
`;
const separatedSources = applyFinancialValidation(
  modelResult({
    totalDebt: {
      amount: "16431959",
      scale: "thousands",
      period: "point_in_time",
      sourceDocument: "annual-report.pdf",
      asOf: "December 31, 2025",
      description: "Total debt",
    },
    cash: {
      amount: "158535",
      scale: "thousands",
      period: "point_in_time",
      sourceDocument: "annual-report.pdf",
      asOf: "December 31, 2025",
      description: "Cash",
    },
    ebitda: {
      amount: "2779824",
      scale: "thousands",
      period: "annual",
      sourceDocument: "annual-report.pdf",
      asOf: "December 31, 2025",
      description: "Adjusted EBITDA",
    },
    cashInterest: {
      amount: "824591",
      scale: "thousands",
      period: "annual",
      sourceDocument: "annual-report.pdf",
      asOf: "December 31, 2025",
      description: "Cash Paid for Interest",
    },
  }),
  {
    fileNames: ["annual-report.pdf"],
    excerpt:
      "Annual Adjusted EBITDA was $2,779,824 thousand for the year ended December 31, 2025. Total debt $16,431,959 thousand as of December 31, 2025. Cash $158,535 thousand as of December 31, 2025. Cash Paid for Interest $824,591 thousand.",
    excerptTruncated: true,
    omissions: ["annual-report.pdf: Consolidated Statements of Operations"],
    historicalSource: consolidatedExcerpt,
    filingText: segmentFiling,
  },
);
includes(
  separatedSources.keyMetrics.ebitda,
  "2,573,950 thousand",
  "a segment subtotal in the model excerpt is replaced by consolidated Adjusted EBITDA",
);
includes(separatedSources.keyMetrics.netLeverage, "6.32x", "net leverage uses consolidated Adjusted EBITDA");
excludes(
  separatedSources.keyMetrics.netLeverage,
  "5.85x",
  "segment EBITDA is not the leverage denominator",
);
includes(
  separatedSources.keyMetrics.reportedLeverage,
  "4.9x",
  "a covenant ratio printed without an x is kept",
);
includes(
  separatedSources.keyMetrics.reportedLeverage,
  "net total lease adjusted leverage ratio",
  "the covenant ratio keeps its filing name",
);
includes(
  separatedSources.keyMetrics.reportedLeverage,
  "Maximum allowable of 7.0",
  "the disclosed covenant maximum is kept",
);
includes(
  separatedSources.keyMetrics.reportedLeverage,
  "EBITDAR",
  "the covenant definition is the filing's own words",
);
const wrappedCovenant = extractReportedLeverage(
  [
    "The Credit Agreement uses EBITDAR-based calculations and the bond indentures use EBITDA based calculations as the primary",
    "measures of financial performance for purposes of calculating leverage and fixed charge coverage ratios. The EBITDAR- and",
    "EBITDA-based leverage calculations include our consolidated subsidiaries.",
    "Generally, the Credit Agreement and the bond indentures use a trailing four fiscal quarter basis for purposes of the relevant calculations and require certain adjustments, which make the calculation of financial performance under the Credit Agreement and bond indentures not directly comparable to Adjusted EBITDA as presented herein.",
    "Our leverage and fixed charge coverage ratios under the Credit Agreement as of December 31, 2025 are as follows:",
    "DECEMBER 31, 2025 MAXIMUM/MINIMUM ALLOWABLE",
    "Net total lease adjusted leverage ratio 4.9 Maximum allowable of 7.0",
  ].join("\n"),
  ["annual-report.pdf"],
);
includes(
  wrappedCovenant?.definition ?? "",
  "uses EBITDAR-based calculations",
  "a wrapped covenant paragraph keeps the EBITDAR definition",
);
includes(
  wrappedCovenant?.definition ?? "",
  "not directly comparable to Adjusted EBITDA",
  "a wrapped covenant paragraph keeps the comparability sentence",
);
excludes(
  wrappedCovenant?.definition ?? "",
  "as follows",
  "the covenant table caption is not the definition",
);
check(
  separatedSources.dashboard.find((metric) => metric.id === "reportedLeverage")?.label ===
    "net total lease adjusted leverage ratio",
  "the covenant card uses the filing's metric name",
);
check(
  separatedSources.dashboard.find((metric) => metric.id === "reportedLeverage")?.asOf ===
    "December 31, 2025",
  "the covenant card keeps the disclosed reporting date",
);
check(
  separatedSources.dashboard.find((metric) => metric.id === "reportedLeverage")?.badge === "Reported",
  "covenant leverage stays a reported figure",
);
check(
  separatedSources.dashboard.find((metric) => metric.id === "netLeverage")?.badge === "Calculated",
  "independent net leverage stays calculated",
);
check(
  separatedSources.dashboard.find((metric) => metric.id === "interestCoverage")?.label ===
    "Cash Interest Coverage",
  "cash paid for interest is labeled cash interest coverage",
);
includes(
  separatedSources.keyMetrics.interestCoverage,
  "cash paid for interest",
  "coverage names the cash-interest denominator",
);
includes(
  separatedSources.keyMetrics.interestCoverage,
  "2,573,950 thousand",
  "coverage uses consolidated Adjusted EBITDA as the numerator",
);
includes(
  trendText(separatedSources, "interestExpense", "2025"),
  "829,335 thousand",
  "financial trends keep GAAP interest expense, net",
);
excludes(
  trendText(separatedSources, "interestExpense", "2025"),
  "824,591",
  "cash paid for interest does not replace GAAP interest expense",
);
includes(
  trendText(separatedSources, "ebitda", "2025"),
  "2,573,950 thousand",
  "financial trends keep consolidated Adjusted EBITDA",
);
check(
  separatedSources.maturitySchedule.buckets?.map((bucket) => bucket.label).join(",") ===
    "2026,2027,2028,2029,2030,Thereafter",
  "the maturity chart keeps the contractual buckets",
);
check(
  separatedSources.maturitySchedule.reconciliation?.foots === true,
  "gross maturities reconcile to carrying value through printed adjustments",
);
includes(
  separatedSources.maturitySchedule.reconciliation?.carryingLabel ?? "",
  "including current portion",
  "the carrying label keeps the filing's parenthetical",
);
includes(
  separatedSources.maturitySchedule.reconciliation?.note ?? "",
  "12,294",
  "the reconciliation shows the printed discount",
);
includes(
  separatedSources.maturitySchedule.reconciliation?.note ?? "",
  "112,514",
  "the reconciliation shows deferred financing costs",
);
includes(
  separatedSources.maturitySchedule.reconciliation?.note ?? "",
  "16,431,959",
  "the reconciliation shows the carrying amount",
);
check(
  separatedSources.maturitySchedule.buckets?.reduce((sum, bucket) => sum + bucket.absolute, 0) ===
    16_556_767_000,
  "maturity buckets stay on contractual principal",
);
includes(
  separatedSources.calculationNotes,
  "Omitted:",
  "the shortened excerpt is still identified",
);
includes(
  separatedSources.calculationNotes,
  "Financial Trends and the debt maturity schedule use a separate extract of the full document",
  "the omission note distinguishes the full-document extract",
);

const rclLiquiditySentence = [
  "As of December 31, 2025, we had liquidity of $7.2 billion, including cash and cash equivalents of $0.8 billion and $6.4 billion of undrawn revolving",
  "credit facility capacity.",
  "Cash $825 million as of December 31, 2025.",
  "Total debt $21,345 million as of December 31, 2025.",
].join("\n");
check(
  extractLiquidity(rclLiquiditySentence, ["10k.pdf"])?.absolute === 7_200_000_000,
  "disclosed liquidity is the stated total, not a component",
);
check(
  extractUndrawn(rclLiquiditySentence, ["10k.pdf"])?.absolute === 6_400_000_000,
  "undrawn availability is the unused revolver, not the liquidity total",
);
check(
  extractCash(rclLiquiditySentence, ["10k.pdf"])?.absolute === 825_000_000,
  "cash uses the standalone cash amount, not the rounded liquidity component",
);

const rclDoubleCount = runValidation(
  {
    cash: money("825", "point_in_time", "Cash"),
    undrawnAvailability: {
      amount: "7.2",
      scale: "billions",
      period: "point_in_time",
      sourceDocument: "10k.pdf",
      asOf: "December 31, 2025",
      description: "Undrawn availability",
    },
  },
  undefined,
  rclLiquiditySentence,
);
check(
  rclDoubleCount.dashboard.find((metric) => metric.id === "liquidity")?.value === "$7.20B",
  "overview liquidity uses the disclosed total instead of adding cash to it",
);
check(
  rclDoubleCount.dashboard.find((metric) => metric.id === "liquidity")?.badge === "Reported",
  "a disclosed liquidity total is labeled reported",
);
excludes(rclDoubleCount.keyMetrics.liquidity, "8.03", "cash is not added to a liquidity total");
excludes(rclDoubleCount.keyMetrics.liquidity, "$8.0", "cash is not added to a liquidity total");
includes(rclDoubleCount.keyMetrics.liquidity, "not added", "liquidity sentence says cash was not added again");
includes(rclDoubleCount.calculationNotes, "not treated as unused revolver", "mislabelled undrawn total is explained");

const rclStatements = `
CONSOLIDATED STATEMENTS OF COMPREHENSIVE INCOME (LOSS)
(in millions, except per share data)
Year Ended December 31,
2025 2024 2023
Passenger ticket revenues $ 12,515 $ 11,499 $ 9,568
Onboard and other revenues 5,419 4,986 4,332
Total revenues 17,935 16,484 13,900
Operating Income 4,910 4,106 2,878
Interest expense, net of interest capitalized (992) (1,590) (1,402)

CONSOLIDATED STATEMENTS OF CASH FLOWS
(in millions)
Year Ended December 31,
2025 2024 2023
Net cash provided by operating activities 6,465 5,265 4,477
Purchases of property and equipment (5,229) (3,268) (3,897)
Purchases of property and equipment included in accounts payable and accrued expenses and
other liabilities $ 72 $ 47 $ 50

CONSOLIDATED BALANCE SHEETS
(in millions)
As of December 31,
2025 2024
Cash and cash equivalents $ 825 $ 388

EBITDA, Adjusted EBITDA and Adjusted EBITDA Margin are calculated as follows (in millions, except APCD and per APCD data. Certain amounts
may not add or calculate due to the use of rounded numbers):
Year Ended December 31,
2025 2024 2023
Net Income attributable to Royal Caribbean Cruises Ltd. $ 4,268 $ 2,877 $ 1,697
EBITDA 7,036 6,097 4,524
Adjusted EBITDA $ 7,025 $ 5,971 $ 4,544

Annual maturities
The following is a schedule of annual maturities on our total debt including finance leases, as of December 31, 2025 for each of the next five years (in
millions):
As of December 31, 2025
Year (1)
2026 $ 3,187
2027 2,627
2028 3,218
2029 1,139
2030 1,089
Thereafter 10,642
$ 21,902
`;
const rclHistorical = buildHistoricalSource([{ fileName: "10k.pdf", text: rclStatements }]);
check(
  rclHistorical.includes("Total revenues 17,935"),
  "historical extraction keeps a comprehensive-income statement",
);
check(
  rclHistorical.includes("Interest expense, net of interest capitalized"),
  "historical extraction keeps interest expense net of capitalized interest",
);
const rclShared = applyFinancialValidation(
  modelResult({
    cash: money("825", "point_in_time", "Cash"),
    undrawnAvailability: {
      amount: "7.2",
      scale: "billions",
      period: "point_in_time",
      sourceDocument: "10k.pdf",
      asOf: "December 31, 2025",
      description: "Undrawn availability",
    },
  }),
  {
    fileNames: ["10k.pdf"],
    excerpt: rclLiquiditySentence,
    excerptTruncated: true,
    omissions: ["Item 7. Management's Discussion and Analysis"],
    historicalSource: rclHistorical,
  },
);
includes(trendText(rclShared, "revenue", "2025"), "17,935 million", "2025 revenue comes from comprehensive income");
includes(trendText(rclShared, "revenue", "2023"), "13,900 million", "2023 revenue stays with 2023");
includes(trendText(rclShared, "operatingIncome", "2025"), "$4.91B", "operating income is read from the income statement");
includes(
  trendText(rclShared, "interestExpense", "2025"),
  "992 million",
  "interest expense net of capitalized interest is kept",
);
includes(trendText(rclShared, "ebitda", "2025"), "7,025 million", "adjusted EBITDA from a calculated-as-follows reconciliation is kept");
check(
  rclShared.dashboard.find((metric) => metric.id === "ebitda")?.value === "$7.03B",
  "overview EBITDA uses the same consolidated Adjusted EBITDA as Financial Trends",
);
includes(trendText(rclShared, "capitalExpenditures", "2025"), "$5.23B", "cash-flow capex stays in financial trends");
check(
  rclShared.dashboard.find((metric) => metric.id === "capitalExpenditures")?.value === "$5.23B",
  "overview capex uses the verified historical purchases of property and equipment",
);
includes(
  rclShared.dashboard.find((metric) => metric.id === "capitalExpenditures")?.calculation ?? "",
  "Purchases of property and equipment",
  "overview capex keeps the cash-flow definition",
);
includes(
  rclShared.calculationNotes,
  "historical spend, not a projected commitment",
  "overview capex is labeled historical",
);
check(
  rclShared.dashboard.find((metric) => metric.id === "liquidity")?.value === "$7.20B",
  "shared liquidity stays at the disclosed total across the overview",
);
check(
  rclShared.maturitySchedule.buckets?.map((bucket) => `${bucket.label}:${bucket.display}`).join(",") ===
    "2026:$3.19B,2027:$2.63B,2028:$3.22B,2029:$1.14B,2030:$1.09B,Thereafter:$10.64B",
  "annual maturities on total debt are charted from the printed schedule",
);
check(
  rclShared.maturitySchedule.buckets?.some((bucket) => bucket.label === "2026" && bucket.absolute === 3_187_000_000) ===
    true,
  "2026 contractual maturities keep the printed 3,187 million",
);

const rclPartialMaturity = runValidation(
  {},
  undefined,
  "As of December 31, 2025, our obligations due through December 31, 2026 primarily consisted of $3.2 billion related to debt maturities, $1.0 billion related to interest on debt and $2.4 billion related to progress payments on our ship orders.",
);
check(rclPartialMaturity.maturitySchedule.buckets == null, "a single-year maturity mention is not charted");
includes(
  rclPartialMaturity.maturitySchedule.message,
  "complete contractual maturity schedule",
  "a partial maturity mention is distinguished from a complete schedule",
);
includes(rclPartialMaturity.maturitySchedule.message, "3.2 billion", "the partial disclosure keeps the printed amount");
excludes(rclPartialMaturity.maturitySchedule.message, "2027", "missing maturity years are not invented");

const projectedCapex = applyFinancialValidation(
  modelResult({
    capitalExpenditures: {
      amount: "2400",
      scale: "millions",
      period: "annual",
      sourceDocument: "10k.pdf",
      asOf: "December 31, 2026",
      description: "Remaining ship order commitments",
    },
  }),
  {
    fileNames: ["10k.pdf"],
    excerpt: `${rclLiquiditySentence}\nRemaining ship order commitments were $2,400 million.`,
    excerptTruncated: false,
    historicalSource: rclHistorical,
  },
);
check(
  projectedCapex.dashboard.find((metric) => metric.id === "capitalExpenditures")?.value === "$5.23B",
  "projected commitments are not used as historical capex",
);

if (failures.length > 0) {
  console.error(`Calculation and upload checks failed (${failures.length}):`);
  for (const failure of failures) {
    console.error(`\n- ${failure}`);
  }
  process.exit(1);
}

console.log("Calculation, upload, and schema checks passed.");
