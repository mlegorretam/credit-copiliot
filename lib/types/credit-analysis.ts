import { z } from "zod";

export const NOT_AVAILABLE = "Not available.";

const riskLevelSchema = z.enum(["Low", "Moderate", "High"]);

export const creditAnalysisSchema = z.object({
  overallCreditRisk: riskLevelSchema,
  riskSummary: z.string().min(1),
  keyMetrics: z.object({
    totalDebt: z.string().min(1),
    cash: z.string().min(1),
    netDebt: z.string().min(1),
    ebitda: z.string().min(1),
    netLeverage: z.string().min(1),
    interestCoverage: z.string().min(1),
    liquidity: z.string().min(1),
  }),
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
  diligenceQuestions: z.array(z.string().min(1)).min(3).max(5),
});

export type CreditAnalysisResult = z.infer<typeof creditAnalysisSchema>;

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
        interestCoverage: { type: "string" },
        liquidity: { type: "string" },
      },
      required: [
        "totalDebt",
        "cash",
        "netDebt",
        "ebitda",
        "netLeverage",
        "interestCoverage",
        "liquidity",
      ],
      additionalProperties: false,
    },
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
    diligenceQuestions: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: [
    "overallCreditRisk",
    "riskSummary",
    "keyMetrics",
    "keyCreditRisks",
    "liquidityAndMaturities",
    "diligenceQuestions",
  ],
  additionalProperties: false,
} as const;
