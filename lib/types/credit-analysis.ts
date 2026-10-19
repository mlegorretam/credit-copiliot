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
  statedLeverageMultiple: z.string(),
  statedLeverageDefinition: z.string(),
  statedLeverageSource: z.string(),
  statedLeverageAsOf: z.string(),
  statedInterestCoverageMultiple: z.string(),
  statedInterestCoverageDefinition: z.string(),
  statedInterestCoverageSource: z.string(),
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
  diligenceQuestions: z.array(z.string().min(1)).min(3).max(5),
});

export type SourcedAmount = z.infer<typeof sourcedAmountSchema>;
export type CalculationBasis = z.infer<typeof calculationBasisSchema>;
export type CreditAnalysisModelResult = z.infer<typeof creditAnalysisSchema>;

/** Model output plus the filenames actually uploaded, attached by the server. */
export type CreditAnalysisResult = CreditAnalysisModelResult & {
  analyzedDocuments: string[];
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
    diligenceQuestions: {
      type: "array",
      items: { type: "string" },
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
    "diligenceQuestions",
  ],
  additionalProperties: false,
} as const;
