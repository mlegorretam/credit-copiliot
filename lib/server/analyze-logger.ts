import OpenAI from "openai";
import { DEFAULT_OPENAI_MODEL } from "@/lib/constants";

const LOG_PREFIX = "[credit-copilot/analyze]";

export function logAnalyzeInfo(message: string, data?: Record<string, unknown>) {
  if (data) {
    console.info(LOG_PREFIX, message, data);
  } else {
    console.info(LOG_PREFIX, message);
  }
}

export function logAnalyzeError(
  phase: string,
  err: unknown,
  data?: Record<string, unknown>,
) {
  const payload: Record<string, unknown> = { phase, ...data };

  if (err instanceof OpenAI.APIError) {
    payload.openaiStatus = err.status;
    payload.openaiCode = err.code;
    payload.openaiType = err.type;
    payload.message = err.message;
    if (err.error) {
      payload.openaiError = err.error;
    }
    console.error(LOG_PREFIX, "failure", payload);
    return;
  }

  if (err instanceof Error) {
    payload.message = err.message;
    payload.stack = err.stack;
    console.error(LOG_PREFIX, "failure", payload);
    return;
  }

  payload.raw = err;
  console.error(LOG_PREFIX, "failure", payload);
}

export function logOpenAiEnvStatus() {
  const key = process.env.OPENAI_API_KEY?.trim();
  logAnalyzeInfo("OpenAI environment", {
    openaiKeyConfigured: Boolean(key),
    openaiKeyLength: key?.length ?? 0,
    openaiModel: process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL,
  });
}
