import "dotenv/config";
import { parseVehicleFactQuestionWithLLM } from "../services/api/src/domain/llmDraft.ts";

type ExpectedType =
  | "year"
  | "price"
  | "otd_total"
  | "engine_feature"
  | "mileage"
  | "color"
  | "service_status"
  | "service_records"
  | "availability"
  | "none";

type Fixture = {
  id: string;
  text: string;
  expectedType: ExpectedType;
  expectedExplicit: boolean;
  expectedFieldContains?: string;
  history?: { direction: "in" | "out"; body: string }[];
};

const unitHistory: Fixture["history"] = [
  { direction: "out", body: "Hi Joe — thanks for stopping in today. I can send a quick recap on the 2002 FLHRCI." },
  { direction: "in", body: "Hello yes.. is that unit fuel injection" },
  { direction: "out", body: "Yes it is" }
];

const fixtures: Fixture[] = [
  {
    id: "short_year_question_1",
    text: "Year ?",
    expectedType: "year",
    expectedExplicit: true,
    expectedFieldContains: "year",
    history: unitHistory
  },
  {
    id: "short_total_price_question_1",
    text: "Total price ?",
    expectedType: "price",
    expectedExplicit: true,
    expectedFieldContains: "price",
    history: unitHistory
  },
  {
    id: "otd_total_question_1",
    text: "What is the out the door total?",
    expectedType: "otd_total",
    expectedExplicit: true,
    expectedFieldContains: "out"
  },
  {
    id: "fuel_injection_question_1",
    text: "Hello yes.. is that unit fuel injection",
    expectedType: "engine_feature",
    expectedExplicit: true,
    expectedFieldContains: "fuel"
  },
  {
    id: "mileage_question_1",
    text: "Mileage?",
    expectedType: "mileage",
    expectedExplicit: true,
    expectedFieldContains: "mileage"
  },
  {
    id: "color_question_1",
    text: "What color is it?",
    expectedType: "color",
    expectedExplicit: true,
    expectedFieldContains: "color"
  },
  {
    id: "service_status_question_1",
    text: "Has it been serviced yet?",
    expectedType: "service_status",
    expectedExplicit: true,
    expectedFieldContains: "service"
  },
  {
    id: "service_records_question_1",
    text: "Any service records?",
    expectedType: "service_records",
    expectedExplicit: true,
    expectedFieldContains: "records"
  },
  {
    id: "availability_question_1",
    text: "Is that still available?",
    expectedType: "availability",
    expectedExplicit: true,
    expectedFieldContains: "availability"
  },
  {
    id: "schedule_not_vehicle_fact_1",
    text: "Tuesday around 11am would work great",
    expectedType: "none",
    expectedExplicit: false
  },
  {
    id: "ack_not_vehicle_fact_1",
    text: "Thanks talk soon",
    expectedType: "none",
    expectedExplicit: false
  }
];

function normalize(input: unknown): string {
  return String(input ?? "").trim().toLowerCase();
}

async function main() {
  let typeMatches = 0;
  let explicitMatches = 0;
  let fieldMatches = 0;
  let fieldAsserted = 0;
  let nullParses = 0;
  const mismatches: string[] = [];

  for (const fixture of fixtures) {
    const parsed = await parseVehicleFactQuestionWithLLM({
      text: fixture.text,
      history: fixture.history
    });
    if (!parsed) {
      nullParses += 1;
      mismatches.push(`- [${fixture.id}] parser returned null | expected type=${fixture.expectedType}`);
      continue;
    }

    const typeOk = parsed.questionType === fixture.expectedType;
    const explicitOk = parsed.explicitRequest === fixture.expectedExplicit;
    if (typeOk) typeMatches += 1;
    if (explicitOk) explicitMatches += 1;

    let fieldOk = true;
    if (fixture.expectedFieldContains) {
      fieldAsserted += 1;
      fieldOk = (parsed.requestedFields ?? []).some(field =>
        normalize(field).includes(normalize(fixture.expectedFieldContains))
      );
      if (fieldOk) fieldMatches += 1;
    }

    if (!typeOk || !explicitOk || !fieldOk) {
      mismatches.push(
        [
          `- [${fixture.id}] text=${JSON.stringify(fixture.text)}`,
          `expected type=${fixture.expectedType}`,
          `expected explicit=${fixture.expectedExplicit}`,
          fixture.expectedFieldContains ? `expected field contains=${fixture.expectedFieldContains}` : null,
          `got type=${parsed.questionType}`,
          `got explicit=${parsed.explicitRequest}`,
          `got fields=${JSON.stringify(parsed.requestedFields ?? [])}`,
          `confidence=${parsed.confidence ?? null}`
        ]
          .filter(Boolean)
          .join(" | ")
      );
    }
  }

  console.log(`Type accuracy: ${typeMatches}/${fixtures.length} (${((typeMatches / fixtures.length) * 100).toFixed(1)}%)`);
  console.log(`Explicit accuracy: ${explicitMatches}/${fixtures.length} (${((explicitMatches / fixtures.length) * 100).toFixed(1)}%)`);
  console.log(`Field match: ${fieldMatches}/${fieldAsserted} (${fieldAsserted ? ((fieldMatches / fieldAsserted) * 100).toFixed(1) : "100"}%)`);
  console.log(`Null parses: ${nullParses}/${fixtures.length}`);

  if (mismatches.length) {
    console.log("\nMismatches:");
    for (const mismatch of mismatches) console.log(mismatch);
    process.exit(1);
  }

  console.log("\nAll checks passed.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
