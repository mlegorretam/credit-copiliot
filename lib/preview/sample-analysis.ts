import { applyFinancialValidation } from "@/lib/credit/validate-metrics";
import {
  NOT_AVAILABLE,
  type CalculationBasis,
  type CreditAnalysisModelResult,
  type DebtInstrumentInput,
  type SourcedAmount,
} from "@/lib/types/credit-analysis";

function blankAmount(): SourcedAmount {
  return {
    amount: "",
    scale: "not_available",
    period: "not_available",
    sourceDocument: "",
    asOf: "",
    description: "",
  };
}

function money(
  amount: string,
  period: SourcedAmount["period"],
  description: string,
): SourcedAmount {
  return {
    amount,
    scale: "millions",
    period,
    sourceDocument: "sample-10q.pdf",
    asOf: "June 30, 2026",
    description,
  };
}

const excerpt = [
  [
    "Total debt $1,000 million as of June 30, 2026.",
    "Cash $50 million.",
    "TTM Adjusted EBITDA $400 million.",
    "Cash interest $100 million.",
    "Company-reported net leverage 3.5x.",
    "Liquidity $420 million.",
    "Six-month AFFO $80 million.",
    "Six-month capital expenditures $40 million.",
    "Senior Notes due 2032 principal $600 million at 5.25% unsecured.",
    "Term Loan due 2029 principal $400 million, SOFR + 2.25%, secured.",
  ].join(" "),
  `
Consolidated Statements of Operations
(in millions)
Year ended December 31,
2025 2024 2023
Total revenues 900 800 700
Operating income 200 180 150
Interest expense 90 85 80

Consolidated Statements of Cash Flows
(in millions)
Year ended December 31,
2025 2024 2023
Net cash provided by operating activities 250 220 200
Capital expenditures (40) (35) (30)

Adjusted EBITDA
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
`,
].join("\n");

const instruments: DebtInstrumentInput[] = [
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
    sourceDocument: "sample-10q.pdf",
  },
  {
    name: "Term Loan due 2029",
    principalAmount: "400",
    principalScale: "millions",
    carryingAmount: "",
    carryingScale: "not_available",
    rateText: "SOFR + 2.25%",
    rateType: "floating",
    couponPercent: "",
    maturityText: "Term Loan due 2029",
    maturityYear: "2029",
    securedStatus: "secured",
    amountBasis: "principal",
    sourceDocument: "sample-10q.pdf",
  },
];

const basis: CalculationBasis = {
  totalDebt: money("1000", "point_in_time", "Total debt"),
  cash: money("50", "point_in_time", "Cash"),
  statedNetDebt: blankAmount(),
  ebitda: money("400", "ttm", "Adjusted EBITDA"),
  cashInterest: money("100", "ttm", "Cash interest"),
  affo: money("80", "six_month", "Six-month AFFO"),
  liquidity: money("420", "point_in_time", "Liquidity"),
  undrawnAvailability: blankAmount(),
  capitalExpenditures: money("40", "six_month", "Six-month capital expenditures"),
  statedLeverageMultiple: "3.5",
  statedLeverageDefinition: "net debt / Adjusted EBITDA per the credit agreement",
  statedLeverageSource: "sample-10q.pdf",
  statedLeverageAsOf: "June 30, 2026",
  statedInterestCoverageMultiple: "",
  statedInterestCoverageDefinition: "",
  statedInterestCoverageSource: "",
};

const model: CreditAnalysisModelResult = {
  overallCreditRisk: "Moderate",
  riskSummary:
    "Sample interpretation only. Leverage is moderate on the independent calculation and higher on the company-reported ratio.",
  keyMetrics: {
    totalDebt: NOT_AVAILABLE,
    cash: NOT_AVAILABLE,
    netDebt: NOT_AVAILABLE,
    ebitda: NOT_AVAILABLE,
    netLeverage: NOT_AVAILABLE,
    reportedLeverage: NOT_AVAILABLE,
    interestCoverage: NOT_AVAILABLE,
    liquidity: NOT_AVAILABLE,
    affo: "Six-month AFFO $80 million.",
    reitMetrics: NOT_AVAILABLE,
  },
  calculationBasis: basis,
  calculationNotes: "See server validation.",
  documentConflicts: "No material conflicts identified in the provided documents.",
  keyCreditRisks: [
    {
      title: "Refinancing",
      severity: "Moderate",
      explanation: "Sample interpretation of the 2029 maturity.",
      supportingEvidence: "Term Loan due 2029 principal $400 million.",
    },
    {
      title: "Leverage definition",
      severity: "Moderate",
      explanation:
        "Sample interpretation: the company ratio and the independent ratio use different definitions.",
      supportingEvidence: "Company-reported net leverage 3.5x.",
    },
    {
      title: "Cash flow",
      severity: "Low",
      explanation: "Sample interpretation of interim AFFO.",
      supportingEvidence: "Six-month AFFO $80 million.",
    },
  ],
  liquidityAndMaturities:
    "Sample disclosure: Liquidity $420 million. Senior Notes due 2032 principal $600 million. Term Loan due 2029 principal $400 million.",
  capitalExpenditures: "Six-month capital expenditures $40 million.",
  debtInstruments: instruments,
  diligenceQuestions: [
    {
      category: "leverage",
      question:
        "Which adjustments in the credit agreement explain the gap between reported and independently calculated leverage?",
    },
    {
      category: "cash_flow",
      question: "Is a trailing-twelve-month AFFO figure available, separate from the six-month amount?",
    },
    {
      category: "refinancing",
      question: "What is the plan for the 2029 term loan, and is any of it currently prepayable?",
    },
    {
      category: "capital_allocation",
      question: "How does six-month capital expenditure compare with the maintenance requirement?",
    },
    {
      category: "downside_protection",
      question: "How much of the capital structure is secured, and what is the undrawn revolver after the stated liquidity?",
    },
  ],
};

/** Layout preview. Every figure is checked against the sample excerpt above. */
export const sampleAnalysis = applyFinancialValidation(model, {
  fileNames: ["sample-10q.pdf"],
  excerpt,
  excerptTruncated: false,
});
