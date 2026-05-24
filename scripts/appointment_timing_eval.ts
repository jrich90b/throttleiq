import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Example = {
  id: string;
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  appointment?: any;
  expected: {
    intent: string;
    explicit_request: boolean;
    day_contains?: string | null;
    time_contains?: string | null;
    time_window?: "exact" | "range" | "unknown";
    reference?: "last_suggested" | "last_appointment" | "none";
  };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = process.argv[2] ?? path.join(__dirname, "appointment_timing_examples.json");

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim() === "..." || apiKey.trim().length < 20) {
  console.error("OPENAI_API_KEY is missing or looks like a placeholder. Set a real key and re-run.");
  process.exit(1);
}

if (process.env.LLM_ENABLED !== "1" || process.env.LLM_APPOINTMENT_TIMING_PARSER_ENABLED === "0") {
  console.error("LLM_ENABLED=1 and LLM_APPOINTMENT_TIMING_PARSER_ENABLED!=0 are required for this eval.");
  process.exit(1);
}

const raw = await fs.readFile(dataPath, "utf8");
const examples = JSON.parse(raw) as Example[];
const { parseAppointmentTimingWithLLM } = await import("../services/api/src/domain/llmDraft.ts");

let total = 0;
let intentOk = 0;
let explicitOk = 0;
let fieldOk = 0;
let nullCount = 0;
const mismatches: string[] = [];

const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();

for (const ex of examples) {
  total += 1;
  const result = await parseAppointmentTimingWithLLM({
    text: ex.text,
    history: ex.history,
    appointment: ex.appointment,
    lastSuggestedSlots: [
      { startLocal: "Fri, May 8, 11:00 AM" },
      { startLocal: "Sat, May 9, 9:30 AM" }
    ]
  });

  if (!result) {
    nullCount += 1;
    mismatches.push(`[${ex.id}] parser returned null`);
    continue;
  }

  const expected = ex.expected;
  const intentMatch = result.intent === expected.intent;
  const explicitMatch = result.explicitRequest === expected.explicit_request;
  const fieldChecks: boolean[] = [];

  if (Object.hasOwn(expected, "day_contains")) {
    fieldChecks.push(
      expected.day_contains == null
        ? !result.requested?.day
        : norm(result.requested?.day).includes(norm(expected.day_contains)) ||
            norm(result.normalizedText).includes(norm(expected.day_contains))
    );
  }
  if (Object.hasOwn(expected, "time_contains")) {
    fieldChecks.push(
      expected.time_contains == null
        ? !result.requested?.timeText
        : norm(result.requested?.timeText).includes(norm(expected.time_contains)) ||
            norm(result.normalizedText).includes(norm(expected.time_contains))
    );
  }
  if (Object.hasOwn(expected, "time_window")) {
    fieldChecks.push((result.requested?.timeWindow ?? "unknown") === expected.time_window);
  }
  if (Object.hasOwn(expected, "reference")) {
    fieldChecks.push((result.reference ?? "none") === expected.reference);
  }

  const fieldsMatch = fieldChecks.every(Boolean);
  if (intentMatch) intentOk += 1;
  if (explicitMatch) explicitOk += 1;
  if (fieldsMatch) fieldOk += 1;

  if (!intentMatch || !explicitMatch || !fieldsMatch) {
    mismatches.push(
      [
        `[${ex.id}]`,
        `text="${ex.text}"`,
        `expected=${JSON.stringify(expected)}`,
        `got=${JSON.stringify(result)}`
      ].join(" | ")
    );
  }
}

const pct = (n: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);

console.log(`Appointment timing intent accuracy: ${intentOk}/${total} (${pct(intentOk)}%)`);
console.log(`Explicit accuracy: ${explicitOk}/${total} (${pct(explicitOk)}%)`);
console.log(`Requested field match: ${fieldOk}/${total} (${pct(fieldOk)}%)`);
console.log(`Null parses: ${nullCount}/${total}`);
console.log("");

if (mismatches.length) {
  console.log("Mismatches:");
  for (const line of mismatches) console.log(`- ${line}`);
  process.exit(1);
}

console.log("All checks passed.");
