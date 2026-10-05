/**
 * Local diagnostic: env + OpenAI structured-output schema (no filing upload).
 * Run: node --env-file=.env.local scripts/diagnose-analyze.mjs
 */
import OpenAI from "openai";
import { readFileSync, existsSync } from "node:fs";

/** Same schema as lib/types/credit-analysis.ts (for local diagnosis). */
const creditAnalysisJsonSchema = {
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
};

function loadEnvLocal() {
  if (process.env.OPENAI_API_KEY) return;
  const path = ".env.local";
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnvLocal();

const key = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini";

console.log("[diagnose] OPENAI_API_KEY set:", Boolean(key));
console.log("[diagnose] OPENAI_API_KEY length:", key?.length ?? 0);
console.log("[diagnose] OPENAI_MODEL:", model);

if (!key) {
  console.error("[diagnose] Missing OPENAI_API_KEY");
  process.exit(1);
}

const client = new OpenAI({ apiKey: key });

try {
  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      {
        role: "user",
        content:
          'Return minimal valid JSON for a fake company with one risk titled "Test".',
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "credit_analysis",
        strict: true,
        schema: creditAnalysisJsonSchema,
      },
    },
  });
  console.log("[diagnose] OpenAI call succeeded.");
  console.log(
    "[diagnose] finish_reason:",
    completion.choices[0]?.finish_reason,
  );
  console.log(
    "[diagnose] content length:",
    completion.choices[0]?.message?.content?.length ?? 0,
  );
} catch (err) {
  console.error("[diagnose] OpenAI call failed:");
  if (err instanceof OpenAI.APIError) {
    console.error("  status:", err.status);
    console.error("  message:", err.message);
    console.error("  code:", err.code);
    console.error("  type:", err.type);
    if (err.error) console.error("  error body:", JSON.stringify(err.error));
  } else if (err instanceof Error) {
    console.error("  ", err.message);
    console.error(err.stack);
  } else {
    console.error(err);
  }
  process.exit(1);
}
