import { z } from "zod";
import { prepareDocumentsContext } from "../lib/filing/prepare-context";
import { layoutItemsToText } from "../lib/pdf/extract-text";
import { applyFinancialValidation } from "../lib/credit/validate-metrics";
import {
  creditAnalysisJsonSchema,
  creditAnalysisSchema,
  NOT_AVAILABLE,
  type CalculationBasis,
  type CreditAnalysisModelResult,
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

function modelResult(
  basis: Partial<CalculationBasis> = {},
  metrics: Partial<CreditAnalysisModelResult["keyMetrics"]> = {},
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
    diligenceQuestions: ["Question one?", "Question two?", "Question three?"],
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
) {
  return applyFinancialValidation(modelResult(basis, metrics), {
    fileNames: ["10k.pdf"],
    excerpt,
    excerptTruncated: false,
  });
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

if (failures.length > 0) {
  console.error(`Calculation and upload checks failed (${failures.length}):`);
  for (const failure of failures) {
    console.error(`\n- ${failure}`);
  }
  process.exit(1);
}

console.log("Calculation, upload, and schema checks passed.");
