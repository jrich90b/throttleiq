import "dotenv/config";
import { parseAccessoryRequestWithLLM } from "../services/api/src/domain/llmDraft.ts";

type ExpectedAction = "can_install" | "status_check" | "demo_request" | "pricing_request" | "none";

type Fixture = {
  id: string;
  text: string;
  expectedAction: ExpectedAction;
  expectedExplicit: boolean;
  expectedItemContains?: string;
  expectedHumor?: boolean;
};

const fixtures: Fixture[] = [
  {
    id: "change_handlebars_1",
    text: "Are you able to change handbars not a fan of the ones on there",
    expectedAction: "can_install",
    expectedExplicit: true,
    expectedItemContains: "handlebar"
  },
  {
    id: "heated_grips_seat_1",
    text: "Can heated grips and seat be added?",
    expectedAction: "can_install",
    expectedExplicit: true,
    expectedItemContains: "heated grips"
  },
  {
    id: "stereo_status_1",
    text: "Did you get a stereo for me to hear yet ?",
    expectedAction: "status_check",
    expectedExplicit: true,
    expectedItemContains: "stereo"
  },
  {
    id: "pipes_demo_1",
    text: "Do you have pipes I can hear before I pick?",
    expectedAction: "demo_request",
    expectedExplicit: true,
    expectedItemContains: "pipes"
  },
  {
    id: "seat_pricing_1",
    text: "How much to add a better seat?",
    expectedAction: "pricing_request",
    expectedExplicit: true,
    expectedItemContains: "seat"
  },
  {
    id: "humor_not_accessory_1",
    text: "\"Off of work, and off my meds\" lol just kidding. I am off tomorrow",
    expectedAction: "none",
    expectedExplicit: false,
    expectedHumor: true
  },
  {
    id: "inventory_not_accessory_1",
    text: "Do you have any Street Bob coming in?",
    expectedAction: "none",
    expectedExplicit: false
  },
  {
    id: "schedule_not_accessory_1",
    text: "Tuesday around 11am would work great",
    expectedAction: "none",
    expectedExplicit: false
  }
];

function normalize(input: unknown): string {
  return String(input ?? "").trim().toLowerCase();
}

async function main() {
  let actionMatches = 0;
  let explicitMatches = 0;
  let itemMatches = 0;
  let itemAsserted = 0;
  let humorMatches = 0;
  let humorAsserted = 0;
  let nullParses = 0;
  const mismatches: string[] = [];

  for (const fixture of fixtures) {
    const parsed = await parseAccessoryRequestWithLLM({ text: fixture.text });
    if (!parsed) {
      nullParses += 1;
      mismatches.push(`- [${fixture.id}] parser returned null | expected action=${fixture.expectedAction}`);
      continue;
    }

    const actionOk = parsed.action === fixture.expectedAction;
    const explicitOk = parsed.explicitRequest === fixture.expectedExplicit;
    if (actionOk) actionMatches += 1;
    if (explicitOk) explicitMatches += 1;

    let itemOk = true;
    if (fixture.expectedItemContains) {
      itemAsserted += 1;
      itemOk = normalize(parsed.item).includes(normalize(fixture.expectedItemContains));
      if (itemOk) itemMatches += 1;
    }

    let humorOk = true;
    if (typeof fixture.expectedHumor === "boolean") {
      humorAsserted += 1;
      humorOk = !!parsed.hasHumor === fixture.expectedHumor;
      if (humorOk) humorMatches += 1;
    }

    if (!actionOk || !explicitOk || !itemOk || !humorOk) {
      mismatches.push(
        [
          `- [${fixture.id}] text=${JSON.stringify(fixture.text)}`,
          `expected action=${fixture.expectedAction}`,
          `expected explicit=${fixture.expectedExplicit}`,
          fixture.expectedItemContains ? `expected item contains=${fixture.expectedItemContains}` : null,
          typeof fixture.expectedHumor === "boolean" ? `expected humor=${fixture.expectedHumor}` : null,
          `got action=${parsed.action}`,
          `got explicit=${parsed.explicitRequest}`,
          `got item=${JSON.stringify(parsed.item ?? null)}`,
          `got humor=${!!parsed.hasHumor}`,
          `confidence=${parsed.confidence ?? null}`
        ]
          .filter(Boolean)
          .join(" | ")
      );
    }
  }

  console.log(`Action accuracy: ${actionMatches}/${fixtures.length} (${((actionMatches / fixtures.length) * 100).toFixed(1)}%)`);
  console.log(`Explicit accuracy: ${explicitMatches}/${fixtures.length} (${((explicitMatches / fixtures.length) * 100).toFixed(1)}%)`);
  console.log(`Item match: ${itemMatches}/${itemAsserted} (${itemAsserted ? ((itemMatches / itemAsserted) * 100).toFixed(1) : "100"}%)`);
  console.log(`Humor match: ${humorMatches}/${humorAsserted} (${humorAsserted ? ((humorMatches / humorAsserted) * 100).toFixed(1) : "100"}%)`);
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
