import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWalkInOutcomeWithLLM } from "../services/api/src/domain/llmDraft.ts";

type Expected = {
  state?: string;
  state_any?: string[];
  explicit_state?: boolean;
  test_ride_requested?: boolean;
  weather_sensitive?: boolean;
  follow_up_window_text_any?: string[];
  follow_up_window_text_any_contains?: string[];
};

type Example = {
  id: string;
  text: string;
  history?: { direction: "in" | "out"; body: string }[];
  lead?: any;
  expected: Expected;
};

function norm(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function boolMatch(expected: boolean | undefined, actual: boolean | undefined): boolean {
  if (typeof expected !== "boolean") return true;
  return expected === !!actual;
}

function stateMatch(expected: Expected, actualState: string | undefined): boolean {
  const got = norm(actualState);
  if (expected.state_any?.length) {
    return expected.state_any.map(v => norm(v)).includes(got);
  }
  if (expected.state) {
    return norm(expected.state) === got;
  }
  return true;
}

function windowTextMatch(expected: Expected, actualText: string | undefined): boolean {
  const got = norm(actualText);
  if (expected.follow_up_window_text_any?.length) {
    const allowed = expected.follow_up_window_text_any.map(v => norm(v));
    if (allowed.includes(got)) return true;
  }
  if (expected.follow_up_window_text_any_contains?.length) {
    return expected.follow_up_window_text_any_contains
      .map(v => norm(v))
      .some(fragment => !!fragment && got.includes(fragment));
  }
  if (expected.follow_up_window_text_any?.length) return false;
  return true;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = process.argv[2] ?? path.join(__dirname, "walkin_outcome_examples.json");

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim() === "..." || apiKey.trim().length < 20) {
  console.error("OPENAI_API_KEY is missing or looks like a placeholder. Set a real key and re-run.");
  process.exit(1);
}

if (process.env.LLM_ENABLED !== "1" || process.env.LLM_WALKIN_OUTCOME_PARSER_ENABLED === "0") {
  console.error("LLM_ENABLED=1 and LLM_WALKIN_OUTCOME_PARSER_ENABLED!=0 are required for this eval.");
  process.exit(1);
}

const raw = await fs.readFile(dataPath, "utf8");
const examples = JSON.parse(raw) as Example[];

let passed = 0;
const failures: string[] = [];

for (const ex of examples) {
  const result = await parseWalkInOutcomeWithLLM({
    text: ex.text,
    history: ex.history,
    lead: ex.lead
  });

  if (!result) {
    failures.push(`[${ex.id}] parser returned null`);
    continue;
  }

  const stateOk = stateMatch(ex.expected, result.state);
  const explicitOk = boolMatch(ex.expected.explicit_state, result.explicitState);
  const rideOk = boolMatch(ex.expected.test_ride_requested, result.testRideRequested);
  const weatherOk = boolMatch(ex.expected.weather_sensitive, result.weatherSensitive);
  const windowOk = windowTextMatch(ex.expected, result.followUpWindowText);

  const ok = stateOk && explicitOk && rideOk && weatherOk && windowOk;
  if (ok) {
    passed += 1;
    console.log(`PASS ${ex.id} state=${result.state} explicit=${result.explicitState} window="${result.followUpWindowText}"`);
  } else {
    failures.push(
      [
        `[${ex.id}]`,
        `expected=${JSON.stringify(ex.expected)}`,
        `actual=${JSON.stringify({
          state: result.state,
          explicit_state: result.explicitState,
          test_ride_requested: result.testRideRequested,
          weather_sensitive: result.weatherSensitive,
          follow_up_window_text: result.followUpWindowText,
          confidence: result.confidence
        })}`
      ].join(" | ")
    );
  }
}

console.log(`\nWalk-in outcome eval: ${passed}/${examples.length} passed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const line of failures) console.log(`- ${line}`);
  process.exit(1);
}
