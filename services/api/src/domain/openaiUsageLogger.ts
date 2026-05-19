import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "./dataDir.js";

type UsageLike = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
  };
};

type OpenAIUsageContext = {
  feature: string;
  operation: string;
  model?: string | null;
  requestKind?: "responses.create" | "responses.parse" | "audio.transcriptions.create" | "images.generate";
  dealerId?: string | null;
  conversationId?: string | null;
  leadRef?: string | null;
  metadata?: Record<string, unknown>;
};

type Pricing = {
  inputPerMillion: number;
  cachedInputPerMillion?: number;
  outputPerMillion: number;
};

const DEFAULT_PRICING: Record<string, Pricing> = {
  "gpt-5-mini": { inputPerMillion: 0.75, cachedInputPerMillion: 0.075, outputPerMillion: 4.5 },
  "gpt-5.4-mini": { inputPerMillion: 0.75, cachedInputPerMillion: 0.075, outputPerMillion: 4.5 },
  "gpt-4o-mini": { inputPerMillion: 0.15, cachedInputPerMillion: 0.075, outputPerMillion: 0.6 },
  "gpt-4o": { inputPerMillion: 2.5, cachedInputPerMillion: 1.25, outputPerMillion: 10 }
};

function normalizeModel(model: unknown): string {
  return String(model ?? "").trim();
}

function monthKey(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function usageLogPath(date = new Date()): string {
  const configured = String(process.env.OPENAI_USAGE_LOG_PATH ?? "").trim();
  if (configured) return configured;
  return path.join(getDataDir(), "openai_usage", `${monthKey(date)}.jsonl`);
}

function pricingForModel(model: string): Pricing | null {
  const overrideRaw = String(process.env.OPENAI_USAGE_PRICING_JSON ?? "").trim();
  if (overrideRaw) {
    try {
      const parsed = JSON.parse(overrideRaw) as Record<string, Pricing>;
      const exact = parsed[model];
      if (exact?.inputPerMillion != null && exact?.outputPerMillion != null) return exact;
    } catch {
      // Ignore malformed pricing overrides; usage logging must never break production.
    }
  }
  const normalized = model.toLowerCase();
  return DEFAULT_PRICING[normalized] ?? null;
}

function estimateCostUsd(model: string, usage: UsageLike): number | null {
  const pricing = pricingForModel(model);
  if (!pricing) return null;
  const input = Number(usage.input_tokens ?? 0);
  const output = Number(usage.output_tokens ?? 0);
  const cached = Number(usage.input_tokens_details?.cached_tokens ?? 0);
  const uncachedInput = Math.max(0, input - cached);
  const cachedRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;
  const cost =
    (uncachedInput / 1_000_000) * pricing.inputPerMillion +
    (cached / 1_000_000) * cachedRate +
    (output / 1_000_000) * pricing.outputPerMillion;
  return Number.isFinite(cost) ? Number(cost.toFixed(8)) : null;
}

function extractUsage(response: any): UsageLike | null {
  const usage = response?.usage;
  if (!usage || typeof usage !== "object") return null;
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  const total = Number(usage.total_tokens ?? input + output);
  if (!input && !output && !total) return null;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    input_tokens_details: usage.input_tokens_details
  };
}

export function recordOpenAIUsage(response: any, context: OpenAIUsageContext): void {
  if (process.env.OPENAI_USAGE_LOGGING_ENABLED === "0") return;
  const usage = extractUsage(response);
  if (!usage) return;
  const model = normalizeModel(context.model ?? response?.model);
  const row = {
    at: new Date().toISOString(),
    provider: "openai",
    feature: context.feature,
    operation: context.operation,
    requestKind: context.requestKind ?? "responses.create",
    model: model || null,
    dealerId: context.dealerId ?? process.env.DEALER_ID ?? process.env.DEALER_SLUG ?? null,
    conversationId: context.conversationId ?? null,
    leadRef: context.leadRef ?? null,
    inputTokens: usage.input_tokens ?? 0,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    estimatedCostUsd: model ? estimateCostUsd(model, usage) : null,
    metadata: context.metadata ?? {}
  };

  try {
    const filePath = usageLogPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
  } catch {
    // Usage logging is accounting support only; never block customer workflows.
  }
}

