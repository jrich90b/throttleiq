import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBookingIntentWithLLM } from "../services/api/src/domain/llmDraft.ts";

type BookingIntent = "schedule" | "reschedule" | "cancel" | "availability" | "question" | "none";
type TimeWindow = "exact" | "range" | "unknown";
type Reference = "last_suggested" | "last_appointment" | "none";

type Example = {
  id: string;
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lastSuggestedSlots?: { startLocal?: string | null }[];
  appointment?: any;
  expected: {
    intent: BookingIntent;
    intent_any?: BookingIntent[];
    explicit_request: boolean;
    requested?: {
      day?: string;
      time_text?: string;
      time_window?: TimeWindow;
    };
    reference?: Reference;
    normalized_contains?: string;
  };
};

function normalizeStr(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function requestedMatches(expected: Example["expected"]["requested"], actual: any): boolean {
  if (!expected) return true;
  if (!actual || typeof actual !== "object") return false;

  if (expected.day) {
    const exp = normalizeStr(expected.day);
    const act = normalizeStr(actual.day);
    if (!act || !act.includes(exp)) return false;
  }

  if (expected.time_text) {
    const exp = normalizeStr(expected.time_text);
    const act = normalizeStr(actual.timeText ?? actual.time_text);
    if (!act || !act.includes(exp)) return false;
  }

  if (expected.time_window) {
    const act = normalizeStr(actual.timeWindow ?? actual.time_window);
    if (act !== normalizeStr(expected.time_window)) return false;
  }

  return true;
}

function referenceMatches(expected: Reference | undefined, actual: string | null | undefined): boolean {
  if (!expected) return true;
  return normalizeStr(expected) === normalizeStr(actual);
}

function normalizedContainsMatches(expected: string | undefined, actual: string | null | undefined): boolean {
  if (!expected) return true;
  const exp = normalizeStr(expected);
  const act = normalizeStr(actual);
  return !!act && act.includes(exp);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = process.argv[2] ?? path.join(__dirname, "booking_parser_examples.json");

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim() === "..." || apiKey.trim().length < 20) {
  console.error("OPENAI_API_KEY is missing or looks like a placeholder. Set a real key and re-run.");
  process.exit(1);
}

if (process.env.LLM_ENABLED !== "1" || process.env.LLM_BOOKING_PARSER_ENABLED !== "1") {
  console.error("LLM_ENABLED=1 and LLM_BOOKING_PARSER_ENABLED=1 are required for this eval.");
  process.exit(1);
}

const raw = await fs.readFile(dataPath, "utf8");
const examples = JSON.parse(raw) as Example[];

let intentOk = 0;
let explicitOk = 0;
let requestedOk = 0;
let referenceOk = 0;
let normalizedOk = 0;
let total = 0;
let nullCount = 0;

const mismatches: string[] = [];

for (const ex of examples) {
  total += 1;
  const result = await parseBookingIntentWithLLM({
    text: ex.text,
    history: ex.history,
    lastSuggestedSlots: ex.lastSuggestedSlots,
    appointment: ex.appointment
  });

  if (!result) {
    nullCount += 1;
    mismatches.push(
      `[${ex.id}] parser returned null | expected intent=${ex.expected.intent} explicit=${ex.expected.explicit_request}`
    );
    continue;
  }

  const expectedIntents = ex.expected.intent_any?.length ? ex.expected.intent_any : [ex.expected.intent];
  const intentMatch = expectedIntents.includes(result.intent);
  const explicitMatch = result.explicitRequest === ex.expected.explicit_request;
  const requestedMatch = requestedMatches(ex.expected.requested, result.requested);
  const referenceMatch = referenceMatches(ex.expected.reference, result.reference);
  const normalizedMatch = normalizedContainsMatches(
    ex.expected.normalized_contains,
    result.normalizedText ?? null
  );

  if (intentMatch) intentOk += 1;
  if (explicitMatch) explicitOk += 1;
  if (requestedMatch) requestedOk += 1;
  if (referenceMatch) referenceOk += 1;
  if (normalizedMatch) normalizedOk += 1;

  if (!intentMatch || !explicitMatch || !requestedMatch || !referenceMatch || !normalizedMatch) {
    mismatches.push(
      [
        `[${ex.id}]`,
        `text="${ex.text}"`,
        `expected intent=${ex.expected.intent}${ex.expected.intent_any ? " (any)" : ""}`,
        `expected explicit=${ex.expected.explicit_request}`,
        `expected requested=${JSON.stringify(ex.expected.requested ?? null)}`,
        `expected reference=${String(ex.expected.reference ?? "(not asserted)")}`,
        `expected normalized_contains=${String(ex.expected.normalized_contains ?? "(not asserted)")}`,
        `got intent=${result.intent}`,
        `got explicit=${result.explicitRequest}`,
        `got requested=${JSON.stringify(result.requested ?? null)}`,
        `got reference=${String(result.reference ?? null)}`,
        `got normalized=${JSON.stringify(result.normalizedText ?? null)}`
      ].join(" | ")
    );
  }
}

const pct = (n: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);

console.log(`Intent accuracy: ${intentOk}/${total} (${pct(intentOk)}%)`);
console.log(`Explicit accuracy: ${explicitOk}/${total} (${pct(explicitOk)}%)`);
console.log(`Requested field match: ${requestedOk}/${total} (${pct(requestedOk)}%)`);
console.log(`Reference match: ${referenceOk}/${total} (${pct(referenceOk)}%)`);
console.log(`Normalized text match: ${normalizedOk}/${total} (${pct(normalizedOk)}%)`);
console.log(`Null parses: ${nullCount}/${total}`);
console.log("");

if (mismatches.length) {
  console.log("Mismatches:");
  for (const line of mismatches) console.log(`- ${line}`);
} else {
  console.log("All checks passed.");
}
