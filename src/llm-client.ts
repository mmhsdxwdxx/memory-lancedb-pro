/**
 * LLM Client for memory extraction and dedup decisions.
 * Uses OpenAI-compatible API (reuses the embedding provider config).
 */

import OpenAI from "openai";

export interface LlmClientConfig {
  apiKey?: string | string[];
  model: string;
  baseURL?: string;
  timeoutMs?: number;
  log?: (msg: string) => void;
  /** Warn-level logger for user-visible failures (timeouts, retries, network errors). */
  warnLog?: (msg: string) => void;
}

export interface LlmClient {
  /** Send a prompt and parse the JSON response. Returns null on failure. */
  completeJson<T>(prompt: string, label?: string): Promise<T | null>;
  /** Best-effort diagnostics for the most recent failure, if any. */
  getLastError(): string | null;
}

/**
 * Extract JSON from an LLM response that may be wrapped in markdown fences
 * or contain surrounding text.
 */
function extractJsonFromResponse(text: string): string | null {
  // Try markdown code fence first (```json ... ``` or ``` ... ```)
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // Try balanced brace extraction
  const firstBrace = text.indexOf("{");
  if (firstBrace === -1) return null;

  let depth = 0;
  let lastBrace = -1;
  for (let i = firstBrace; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        lastBrace = i;
        break;
      }
    }
  }

  if (lastBrace === -1) return null;
  return text.substring(firstBrace, lastBrace + 1);
}

function previewText(value: string, maxLen = 200): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 3)}...`;
}

export function createLlmClient(config: LlmClientConfig): LlmClient {
  // Resolve apiKey: support array of keys, pick one at random
  let resolvedApiKey: string;
  if (Array.isArray(config.apiKey)) {
    if (config.apiKey.length === 0) {
      throw new Error("LLM apiKey array is empty — provide at least one key");
    }
    resolvedApiKey = config.apiKey[Math.floor(Math.random() * config.apiKey.length)];
  } else {
    resolvedApiKey = config.apiKey ?? "";
  }

  const client = new OpenAI({
    apiKey: resolvedApiKey,
    baseURL: config.baseURL,
    timeout: config.timeoutMs ?? 30000,
  });
  const log = config.log ?? (() => {});
  const warnLog = config.warnLog;
  let lastError: string | null = null;

  return {
    async completeJson<T>(prompt: string, label = "generic"): Promise<T | null> {
      lastError = null;
      try {
        const response = await client.chat.completions.create({
          model: config.model,
          messages: [
            {
              role: "system",
              content:
                "You are a memory extraction assistant. Always respond with valid JSON only.",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.1,
        });

        const raw = response.choices?.[0]?.message?.content;
        if (!raw) {
          lastError =
            `memory-lancedb-pro: llm-client [${label}] empty response content from model ${config.model}`;
          log(lastError);
          return null;
        }
        if (typeof raw !== "string") {
          lastError =
            `memory-lancedb-pro: llm-client [${label}] non-string response content type=${Array.isArray(raw) ? "array" : typeof raw} from model ${config.model}`;
          log(lastError);
          return null;
        }

        const jsonStr = extractJsonFromResponse(raw);
        if (!jsonStr) {
          lastError =
            `memory-lancedb-pro: llm-client [${label}] no JSON object found (chars=${raw.length}, preview=${JSON.stringify(previewText(raw))})`;
          log(lastError);
          return null;
        }

        try {
          return JSON.parse(jsonStr) as T;
        } catch (err) {
          lastError =
            `memory-lancedb-pro: llm-client [${label}] JSON.parse failed: ${err instanceof Error ? err.message : String(err)} (jsonChars=${jsonStr.length}, jsonPreview=${JSON.stringify(previewText(jsonStr))})`;
          log(lastError);
          return null;
        }
      } catch (err) {
        // Graceful degradation — return null so caller can fall back
        lastError =
          `memory-lancedb-pro: llm-client [${label}] request failed for model ${config.model}: ${err instanceof Error ? err.message : String(err)}`;
        // Upgrade LLM request failures to warn level for user visibility
        (warnLog ?? log)(lastError);
        return null;
      }
    },
    getLastError(): string | null {
      return lastError;
    },
  };
}

export { extractJsonFromResponse };
