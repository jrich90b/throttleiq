/**
 * draft_price_fact_check:eval — the draft-quality judge can check a NUMBER, not just the words.
 *
 * Joe, 2026-08-04, on Michael Lococo (+15853075478): the judge read a draft quoting
 * "$25,999–$44,999 ... around $560–$1,020/mo" for a 2026 Road Glide and rated it fine. It IS fine
 * as prose — fluent, on-topic, correctly formatted. It was just wrong by about fifteen thousand
 * dollars, because the price range had swept in sibling models (the CVO ST) and a payment quote was
 * built on top of it. Nothing in the judge's prompt said what the bike costs, so `safety_ok`'s
 * "no FABRICATED facts" rule had nothing to test against.
 *
 * Two properties this pins, and they pull in opposite directions:
 *   1. WITH verified feed facts, a contradicting number must be caught.
 *   2. WITHOUT them, the prompt is BYTE-IDENTICAL to its pre-2026-08-04 form — no new opinions on
 *      turns where we never resolved a single unit (most of them).
 *
 * The deterministic arm runs everywhere. The LLM arm runs when OPENAI_API_KEY is present and is the
 * only thing that proves the judge actually acts on the facts rather than merely being handed them.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDraftQualityJudgePrompt,
  hasCheckableUnitFacts,
  type DraftQualityUnitFacts
} from "../services/api/src/domain/draftQualityJudgePrompt.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
let failures = 0;

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok  ${name}`))
    .catch((err: any) => {
      failures += 1;
      console.error(`  FAIL ${name}: ${err?.message ?? err}`);
    });
}

// The real case, with the real numbers off the feed.
const LOCOCO_FACTS: DraftQualityUnitFacts = {
  label: "2026 Harley-Davidson Road Glide (Dark Billiard Gray Black Trim)",
  listPrice: 29399,
  mileage: null,
  stockId: null,
  status: "available"
};
const LOCOCO_INBOUND =
  "WEB LEAD (ADF)\nVehicle: Harley-Davidson Road Glide Glide 2026 FLTRX Dark Billiard Gray Black Trim\n\nInquiry:\nLooking into possibly purchasing this bike. Looking for current rates and estimated payments";
const LOCOCO_BAD_DRAFT =
  "Hey Michael, it's Alexandra over at American Harley-Davidson. Ballpark, on about $25,999–$44,999, you're around $560–$1,020/mo at 60 months before taxes and fees, based on your APR. What monthly payment feels comfortable for you?";
const LOCOCO_GOOD_DRAFT =
  "Hey Michael, it's Alexandra over at American Harley-Davidson. That 2026 Road Glide in Dark Billiard Gray with black trim is $29,399 before tax and fees. On the payment side, your rate comes out of the credit application, so anything I quote now would be a guess — tell me roughly what you'd put down and I'll get you a real number from our finance desk.";

const base = {
  inbound: LOCOCO_INBOUND,
  historyLines: [] as string[],
  leadModel: "Road Glide",
  leadSource: "Room58 - Request details",
  channel: "sms" as const
};

console.log("draft_price_fact_check:eval");

await check("hasCheckableUnitFacts: a real price or mileage makes facts checkable; nothing else does", () => {
  assert.equal(hasCheckableUnitFacts(LOCOCO_FACTS), true);
  assert.equal(hasCheckableUnitFacts({ listPrice: null, mileage: 12000 }), true);
  assert.equal(hasCheckableUnitFacts({ label: "2026 Road Glide", listPrice: null, mileage: null }), false, "a label alone checks nothing");
  assert.equal(hasCheckableUnitFacts({ listPrice: 0 }), false, "a zero price is 'unknown', not free");
  assert.equal(hasCheckableUnitFacts(null), false);
  assert.equal(hasCheckableUnitFacts(undefined), false);
});

await check("NO-OP GUARD: with no facts the prompt is byte-identical to the pre-fact prompt", () => {
  const withoutArg = buildDraftQualityJudgePrompt({ ...base, draft: LOCOCO_GOOD_DRAFT });
  for (const facts of [null, undefined, { label: "2026 Road Glide" }, { listPrice: 0, mileage: 0 }]) {
    const withUncheckable = buildDraftQualityJudgePrompt({ ...base, draft: LOCOCO_GOOD_DRAFT, unitFacts: facts as any });
    assert.equal(withUncheckable, withoutArg, `uncheckable facts must not change the prompt: ${JSON.stringify(facts)}`);
  }
  assert.ok(!withoutArg.includes("VERIFIED UNIT FACTS"), "no fact section without facts");
});

await check("with facts, the prompt carries the price, the contradiction rule, and the limits", () => {
  const prompt = buildDraftQualityJudgePrompt({ ...base, draft: LOCOCO_BAD_DRAFT, unitFacts: LOCOCO_FACTS });
  assert.ok(prompt.includes("VERIFIED UNIT FACTS"), "the fact section is present");
  assert.ok(prompt.includes("29399"), "the real price is in the prompt");
  assert.ok(/CONTRADICTS these facts fails safety_ok/.test(prompt), "the contradiction rule is stated");
  assert.ok(/PAYMENT estimate built on a wrong price/.test(prompt), "a payment built on a bad price is covered");
  assert.ok(/Absence of a fact is never evidence the draft is wrong/.test(prompt), "the judge is told not to over-reach");
  assert.ok(/Out-the-door totals, taxes, fees/.test(prompt), "deferring on out-the-door stays CORRECT");
});

await check("the worked example in the prompt is the real Lococo case", () => {
  const prompt = buildDraftQualityJudgePrompt({ ...base, draft: LOCOCO_BAD_DRAFT, unitFacts: LOCOCO_FACTS });
  assert.ok(prompt.includes("$560-$1,020/mo"), "the swept payment range is shown as the tell");
  assert.ok(/"safety_ok":false,"overall":"hold"/.test(prompt), "the example verdict is a hold on safety");
});

await check("WIRING: self-heal hands the judge the same feed facts the composer used", () => {
  const llm = fs.readFileSync(path.join(repoRoot, "services/api/src/domain/llmDraft.ts"), "utf8");
  assert.ok(/function buildJudgeUnitFacts\(ctx: DraftContext\)/.test(llm), "the ctx->facts adapter exists");
  assert.ok(/ctx\.inventoryListPrice/.test(llm) && /ctx\.inventoryMileage/.test(llm), "it reads the resolved feed facts");
  const heal = llm.slice(llm.indexOf("export async function selfHealDraftWithLLM"));
  const judgeCalls = heal.match(/judgeDraftQualityWithLLM\(\{[^}]*\}\)/g) ?? [];
  assert.equal(judgeCalls.length, 2, "self-heal judges twice (original + re-draft)");
  for (const call of judgeCalls) {
    assert.ok(/unitFacts/.test(call), `both judge calls must pass unitFacts: ${call.slice(0, 90)}`);
  }
});

// ---------------------------------------------------------------------------------------------
// LLM arm — the only proof the judge ACTS on the facts. Judge verdicts are not reproducible
// (55-74% self-agreement), so this VOTES rather than trusting one sample.
// ---------------------------------------------------------------------------------------------
if (process.env.OPENAI_API_KEY && process.env.LLM_ENABLED === "1") {
  const { judgeDraftQualityWithLLM } = await import("../services/api/src/domain/llmDraft.js");
  const SAMPLES = 3;

  const vote = async (draft: string, unitFacts: DraftQualityUnitFacts | null) => {
    const verdicts = await Promise.all(
      Array.from({ length: SAMPLES }, () =>
        judgeDraftQualityWithLLM({ draft, inbound: LOCOCO_INBOUND, history: [], lead: { source: "Room58" } as any, channel: "sms", unitFacts })
      )
    );
    return verdicts.map(v => (v ? v.overall : "null"));
  };

  await check("LLM: the swept price range is CAUGHT once the judge can see the real price", async () => {
    const votes = await vote(LOCOCO_BAD_DRAFT, LOCOCO_FACTS);
    const flagged = votes.filter(v => v === "hold" || v === "needs_regenerate").length;
    console.log(`      votes(bad draft, with facts) = ${JSON.stringify(votes)}`);
    assert.ok(flagged >= 2, `a majority must flag the wrong number; got ${JSON.stringify(votes)}`);
  });

  await check("LLM: the CORRECTED draft still passes — the fact check must not fail an honest reply", async () => {
    const votes = await vote(LOCOCO_GOOD_DRAFT, LOCOCO_FACTS);
    const good = votes.filter(v => v === "good").length;
    console.log(`      votes(good draft, with facts) = ${JSON.stringify(votes)}`);
    assert.ok(good >= 2, `the right price + an honest payment deferral must pass; got ${JSON.stringify(votes)}`);
  });
} else {
  console.log("  --  LLM arm skipped (needs OPENAI_API_KEY + LLM_ENABLED=1)");
}

if (failures) {
  console.error(`\ndraft_price_fact_check:eval FAILED (${failures})`);
  process.exit(1);
}
console.log("draft_price_fact_check:eval passed");
