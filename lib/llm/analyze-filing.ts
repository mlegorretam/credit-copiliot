import OpenAI from "openai";
import { DEFAULT_OPENAI_MODEL } from "@/lib/constants";
import {
  buildCreditAnalysisUserPrompt,
  CREDIT_ANALYSIS_SYSTEM_PROMPT,
} from "@/lib/llm/prompts";
import {
  logAnalyzeError,
  logAnalyzeInfo,
} from "@/lib/server/analyze-logger";
import { applyFinancialValidation } from "@/lib/credit/validate-metrics";
import {
  creditAnalysisJsonSchema,
  creditAnalysisSchema,
  type CreditAnalysisResult,
} from "@/lib/types/credit-analysis";

function getOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured on the server.");
  }
  return new OpenAI({ apiKey });
}

export async function analyzeFilingWithLlm(params: {
  companyName: string;
  fileNames: string[];
  filingExcerpt: string;
  excerptTruncated: boolean;
  extractionNotes?: string[];
}): Promise<CreditAnalysisResult> {
  const client = getOpenAIClient();
  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
  const userContent = buildCreditAnalysisUserPrompt(params);

  logAnalyzeInfo("OpenAI request", {
    model,
    userPromptChars: userContent.length,
    excerptTruncated: params.excerptTruncated,
    documentCount: params.fileNames.length,
  });

  let completion;
  try {
    completion = await client.chat.completions.create({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: CREDIT_ANALYSIS_SYSTEM_PROMPT },
        { role: "user", content: userContent },
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
  } catch (err) {
    logAnalyzeError("openai-chat-completions", err, { model });
    if (err instanceof OpenAI.APIError) {
      throw new Error(
        `OpenAI API error (${err.status ?? "unknown"}): ${err.message}`,
      );
    }
    throw err;
  }

  const message = completion.choices[0]?.message;

  if (message?.refusal) {
    throw new Error(`Analysis refused: ${message.refusal}`);
  }

  const raw = message?.content;
  if (!raw) {
    throw new Error("The model returned an empty response.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The model returned invalid JSON.");
  }

  const validated = creditAnalysisSchema.safeParse(parsed);
  if (!validated.success) {
    logAnalyzeError("zod-validation", validated.error, {
      zodIssues: validated.error.issues,
    });
    const summary = validated.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(
      `Analysis failed schema validation.${summary ? ` ${summary}` : ""}`,
    );
  }

  logAnalyzeInfo("OpenAI response validated", {
    finishReason: completion.choices[0]?.finish_reason,
    riskCount: validated.data.keyCreditRisks.length,
  });

  return applyFinancialValidation(validated.data, {
    fileNames: params.fileNames,
    excerpt: params.filingExcerpt,
    excerptTruncated: params.excerptTruncated,
    extractionNotes: params.extractionNotes,
  });
}
