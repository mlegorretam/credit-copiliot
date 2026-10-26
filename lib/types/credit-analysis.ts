import { z } from "zod";

export const NOT_AVAILABLE = "Not available.";

const riskLevelSchema = z.enum(["Low", "Moderate", "High"]);

export const amountScaleSchema = z.enum([
  "ones",
  "thousands",
  "millions",
  "billions",
  "not_available",
]);

export const amountPeriodSchema = z.enum([
  "ttm",
  "annual",
  "quarterly",
  "six_month",
  "nine_month",
  "ytd",
  "point_in_time",
  "not_available",
]);

export const sourcedAmountSchema = z.object({
  amount: z.string(),
  scale: amountScaleSchema,
  period: amountPeriodSchema,
  sourceDocument: z.string(),
  asOf: z.string(),
  description: z.string(),
});

export const calculationBasisSchema = z.object({
  totalDebt: sourcedAmountSchema,
  cash: sourcedAmountSchema,
  statedNetDebt: sourcedAmountSchema,
  ebitda: sourcedAmountSchema,
  cashInterest: sourcedAmountSchema,
  affo: sourcedAmountSchema,
  liquidity: sourcedAmountSchema,
  undrawnAvailability: sourcedAmountSchema,
  capitalExpenditures: sourcedAmountSchema,
  statedLeverageMultiple: z.string(),
  statedLeverageDefinition: z.string(),
  statedLeverageSource: z.string(),
  statedLeverageAsOf: z.string(),
  statedInterestCoverageMultiple: z.string(),
  statedInterestCoverageDefinition: z.string(),
  statedInterestCoverageSource: z.string(),
});

export const debtInstrumentSchema = z.object({
  name: z.string(),
  principalAmount: z.string(),
  principalScale: amountScaleSchema,
  carryingAmount: z.string(),
  carryingScale: amountScaleSchema,
  rateText: z.string(),
  rateType: z.enum(["fixed", "floating", "mixed", "not_disclosed"]),
  couponPercent: z.string(),
  maturityText: z.string(),
  maturityYear: z.string(),
  securedStatus: z.enum(["secured", "unsecured", "not_disclosed"]),
  amountBasis: z.enum(["principal", "carrying", "not_disclosed"]),
  sourceDocument: z.string(),
});

export const diligenceQuestionSchema = z.object({
  category: z.enum([
    "leverage",
    "cash_flow",
    "refinancing",
    "capital_allocation",
    "downside_protection",
    "other",
  ]),
  question: z.string().min(1),
});

export const creditAnalysisSchema = z.object({
  overallCreditRisk: riskLevelSchema,
  riskSummary: z.string().min(1),
  keyMetrics: z.object({
    totalDebt: z.string().min(1),
    cash: z.string().min(1),
    netDebt: z.string().min(1),
    ebitda: z.string().min(1),
    netLeverage: z.string().min(1),
    reportedLeverage: z.string().min(1),
    interestCoverage: z.string().min(1),
    liquidity: z.string().min(1),
    affo: z.string().min(1),
    reitMetrics: z.string().min(1),
  }),
  calculationBasis: calculationBasisSchema,
  calculationNotes: z.string().min(1),
  documentConflicts: z.string().min(1),
  keyCreditRisks: z
    .array(
      z.object({
        title: z.string().min(1),
        severity: riskLevelSchema,
        explanation: z.string().min(1),
        supportingEvidence: z.string().min(1),
      }),
    )
    .min(3)
    .max(5),
  liquidityAndMaturities: z.string().min(1),
  capitalExpenditures: z.string().min(1),
  debtInstruments: z.array(debtInstrumentSchema).max(30),
  diligenceQuestions: z.array(diligenceQuestionSchema).min(5).max(8),
});

export type SourcedAmount = z.infer<typeof sourcedAmountSchema>;
export type CalculationBasis = z.infer<typeof calculationBasisSchema>;
export type DebtInstrumentInput = z.infer<typeof debtInstrumentSchema>;
export type DiligenceQuestion = z.infer<typeof diligenceQuestionSchema>;
export type CreditAnalysisModelResult = z.infer<typeof creditAnalysisSchema>;

export type MetricBadge = "Reported" | "Calculated" | "Review Required";

export type DashboardMetric = {
  id:
    | "totalDebt"
    | "cash"
    | "netDebt"
    | "ebitda"
    | "netLeverage"
    | "reportedLeverage"
    | "interestCoverage"
    | "liquidity"
    | "affo"
    | "capitalExpenditures";
  label: string;
  value: string;
  period: string;
  asOf: string;
  badge: MetricBadge;
  review: boolean;
  source: string;
  calculation: string;
};

export type DebtInstrumentView = {
  name: string;
  principalDisplay: string;
  carryingDisplay: string;
  principalAbsolute: number | null;
  carryingAbsolute: number | null;
  /** Balance used to reconcile the schedule when principal is not labeled on every row. */
  reconAbsolute: number | null;
  reconBasis: "principal" | "carrying" | "unlabeled" | "none";
  rate: string;
  rateType: DebtInstrumentInput["rateType"];
  coupon: number | null;
  allIn: boolean;
  maturity: string;
  maturityYear: number | null;
  secured: string;
  source: string;
  reportingDate: string;
  kind: "outstanding" | "undrawn" | "historical";
  amountBasis: DebtInstrumentInput["amountBasis"];
  note: string;
};

export type MaturityBar = {
  year: string;
  absolute: number;
  display: string;
  share: number;
};

export type CapitalStructureView = {
  instruments: DebtInstrumentView[];
  omittedCount: number;
  reconciliationStatus: "matched" | "difference" | "insufficient";
  reconciliation: string;
  qualityNotes: string[];
  unsupportedMaturities: string[];
  maturityBars: MaturityBar[] | null;
  maturityMessage: string;
  rateBreakdown: {
    fixedAbsolute: number;
    floatingAbsolute: number;
    unclassifiedAbsolute: number;
    fixedDisplay: string;
    floatingDisplay: string;
    unclassifiedDisplay: string;
  } | null;
  rateMessage: string;
  weightedAverageCoupon: string | null;
  weightedAverageDetail: string;
};

export type QualityCheck = {
  id: string;
  label: string;
  status: MetricBadge;
  detail: string;
};

export type TrendCell = {
  display: string;
  detail: string;
};

export type FinancialTrendRow = {
  id:
    | "revenue"
    | "revenueGrowth"
    | "operatingIncome"
    | "ebitda"
    | "ebitdaMargin"
    | "operatingCashFlow"
    | "capitalExpenditures"
    | "freeCashFlow"
    | "interestExpense"
    | "totalDebt"
    | "netLeverage";
  label: string;
  cells: TrendCell[];
};

export type FinancialTrends = {
  years: string[];
  rows: FinancialTrendRow[];
  note: string;
};

export type MaturityBucket = {
  label: string;
  absolute: number;
  display: string;
  share: number;
};

export type MaturityBridgeLine = {
  label: string;
  absolute: number;
  display: string;
};

export type MaturityReconciliation = {
  grossAbsolute: number;
  grossDisplay: string;
  lines: MaturityBridgeLine[];
  carryingLabel: string;
  carryingAbsolute: number;
  carryingDisplay: string;
  foots: boolean;
  note: string;
};

export type DisclosedMaturitySchedule = {
  buckets: MaturityBucket[] | null;
  message: string;
  reconciliation: MaturityReconciliation | null;
};

/** Model output plus server-side checks. The model does not fill the view fields. */
export type CreditAnalysisResult = CreditAnalysisModelResult & {
  analyzedDocuments: string[];
  dashboard: DashboardMetric[];
  capitalStructure: CapitalStructureView;
  financialTrends: FinancialTrends;
  maturitySchedule: DisclosedMaturitySchedule;
  dataQuality: QualityCheck[];
};

const sourcedAmountJsonSchema = {
  type: "object",
  properties: {
    amount: { type: "string" },
    scale: {
      type: "string",
      enum: ["ones", "thousands", "millions", "billions", "not_available"],
    },
    period: {
      type: "string",
      enum: [
        "ttm",
        "annual",
        "quarterly",
        "six_month",
        "nine_month",
        "ytd",
        "point_in_time",
        "not_available",
      ],
    },
    sourceDocument: { type: "string" },
    asOf: { type: "string" },
    description: { type: "string" },
  },
  required: [
    "amount",
    "scale",
    "period",
    "sourceDocument",
    "asOf",
    "description",
  ],
  additionalProperties: false,
} as const;

const debtInstrumentJsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    principalAmount: { type: "string" },
    principalScale: sourcedAmountJsonSchema.properties.scale,
    carryingAmount: { type: "string" },
    carryingScale: sourcedAmountJsonSchema.properties.scale,
    rateText: { type: "string" },
    rateType: {
      type: "string",
      enum: ["fixed", "floating", "mixed", "not_disclosed"],
    },
    couponPercent: { type: "string" },
    maturityText: { type: "string" },
    maturityYear: { type: "string" },
    securedStatus: {
      type: "string",
      enum: ["secured", "unsecured", "not_disclosed"],
    },
    amountBasis: {
      type: "string",
      enum: ["principal", "carrying", "not_disclosed"],
    },
    sourceDocument: { type: "string" },
  },
  required: [
    "name",
    "principalAmount",
    "principalScale",
    "carryingAmount",
    "carryingScale",
    "rateText",
    "rateType",
    "couponPercent",
    "maturityText",
    "maturityYear",
    "securedStatus",
    "amountBasis",
    "sourceDocument",
  ],
  additionalProperties: false,
} as const;

/** JSON Schema for OpenAI Structured Outputs (strict mode). */
export const creditAnalysisJsonSchema = {
  type: "object",
  properties: {
    overallCreditRisk: {
      type: "string",
      enum: ["Low", "Moderate", "High"],
    },
    riskSummary: { type: "string" },
    keyMetrics: {
      type: "object",
      properties: {
        totalDebt: { type: "string" },
        cash: { type: "string" },
        netDebt: { type: "string" },
        ebitda: { type: "string" },
        netLeverage: { type: "string" },
        reportedLeverage: { type: "string" },
        interestCoverage: { type: "string" },
        liquidity: { type: "string" },
        affo: { type: "string" },
        reitMetrics: { type: "string" },
      },
      required: [
        "totalDebt",
        "cash",
        "netDebt",
        "ebitda",
        "netLeverage",
        "reportedLeverage",
        "interestCoverage",
        "liquidity",
        "affo",
        "reitMetrics",
      ],
      additionalProperties: false,
    },
    calculationBasis: {
      type: "object",
      properties: {
        totalDebt: sourcedAmountJsonSchema,
        cash: sourcedAmountJsonSchema,
        statedNetDebt: sourcedAmountJsonSchema,
        ebitda: sourcedAmountJsonSchema,
        cashInterest: sourcedAmountJsonSchema,
        affo: sourcedAmountJsonSchema,
        liquidity: sourcedAmountJsonSchema,
        undrawnAvailability: sourcedAmountJsonSchema,
        capitalExpenditures: sourcedAmountJsonSchema,
        statedLeverageMultiple: { type: "string" },
        statedLeverageDefinition: { type: "string" },
        statedLeverageSource: { type: "string" },
        statedLeverageAsOf: { type: "string" },
        statedInterestCoverageMultiple: { type: "string" },
        statedInterestCoverageDefinition: { type: "string" },
        statedInterestCoverageSource: { type: "string" },
      },
      required: [
        "totalDebt",
        "cash",
        "statedNetDebt",
        "ebitda",
        "cashInterest",
        "affo",
        "liquidity",
        "undrawnAvailability",
        "capitalExpenditures",
        "statedLeverageMultiple",
        "statedLeverageDefinition",
        "statedLeverageSource",
        "statedLeverageAsOf",
        "statedInterestCoverageMultiple",
        "statedInterestCoverageDefinition",
        "statedInterestCoverageSource",
      ],
      additionalProperties: false,
    },
    calculationNotes: { type: "string" },
    documentConflicts: { type: "string" },
    keyCreditRisks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          severity: {
            type: "string",
            enum: ["Low", "Moderate", "High"],
          },
          explanation: { type: "string" },
          supportingEvidence: { type: "string" },
        },
        required: ["title", "severity", "explanation", "supportingEvidence"],
        additionalProperties: false,
      },
    },
    liquidityAndMaturities: { type: "string" },
    capitalExpenditures: { type: "string" },
    debtInstruments: {
      type: "array",
      maxItems: 30,
      items: debtInstrumentJsonSchema,
    },
    diligenceQuestions: {
      type: "array",
      minItems: 5,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: [
              "leverage",
              "cash_flow",
              "refinancing",
              "capital_allocation",
              "downside_protection",
              "other",
            ],
          },
          question: { type: "string" },
        },
        required: ["category", "question"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "overallCreditRisk",
    "riskSummary",
    "keyMetrics",
    "calculationBasis",
    "calculationNotes",
    "documentConflicts",
    "keyCreditRisks",
    "liquidityAndMaturities",
    "capitalExpenditures",
    "debtInstruments",
    "diligenceQuestions",
  ],
  additionalProperties: false,
} as const;
