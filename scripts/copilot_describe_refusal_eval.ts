/**
 * copilot_describe_refusal:eval — the described-list builder must SAY when it cannot do something,
 * instead of quietly answering a different question.
 *
 * THE BUG THIS PINS (measured on the live parser, 2026-08-08). The marketing-list filters are a
 * fixed set: model, new/used, source, recency, open/closed. Asked for anything outside them, the
 * parser returned every filter null — and all-null filters build a list of EVERY reachable lead.
 * "anyone who is approved but hasn't bought yet" produced 449 people (the whole store), presented
 * as the answer, under whatever name the manager typed. The real answer was 11.
 *
 * That was survivable while a list only downloaded as a CSV. It is not survivable now that a
 * described list SAVES as a customer list a campaign can be sent to. So the parser declares what it
 * could not express (`unsupportedCriteria`) and the handler refuses.
 *
 * FAIL DIRECTION: toward refusing. This module's standing law is that every rule fails toward a
 * SMALLER list, and refusing is smaller than everyone. The prompt says so in those words.
 *
 * SAMPLE SIZE, justified (trap 8 — a sample size is a claim). Every case below was measured at
 * n=4 before this eval was written: all five were 4/4 stable, 20/20 overall, no case near a
 * boundary. So one sample per case is asserted here. If a case ever flakes, the honest fix is to
 * re-measure it at n=4+ and either widen the prompt or drop the case — never to loosen the
 * assertion until it passes.
 *
 * Run gated: LLM_ENABLED=1 npx tsx scripts/copilot_describe_refusal_eval.ts
 */
import assert from "node:assert/strict";

const { parseMarketingListRequestWithLLM } = await import("../services/api/src/domain/copilotLLM.ts");

if (process.env.LLM_ENABLED !== "1" || !process.env.OPENAI_API_KEY) {
  console.log("copilot_describe_refusal_eval: SKIPPED (LLM disabled) — the deterministic half lives in console_copilot_marketing_list:eval");
  process.exit(0);
}

/** true = the description asks for something the filters cannot express, so it MUST be refused. */
const CASES: { ask: string; mustRefuse: boolean; why: string }[] = [
  {
    ask: "anyone who is approved but hasn't bought yet",
    mustRefuse: true,
    why: "credit approval and purchase status are not filters — this is the case that returned all 449 people"
  },
  {
    ask: "customers in Lockport",
    mustRefuse: true,
    why: "location is not a filter, and a location list silently becoming everyone is a wasted campaign"
  },
  {
    ask: "all my leads",
    mustRefuse: false,
    why: "a deliberately broad request IS expressible — refusing it would break a legitimate list"
  },
  {
    ask: "everyone",
    mustRefuse: false,
    why: "same: breadth on purpose is not the same as breadth by accident"
  },
  {
    ask: "everyone interested in a used Street Glide in the last 90 days",
    mustRefuse: false,
    why: "the fully-supported shape must still build, or the guard has eaten the feature"
  }
];

let n = 0;
for (const c of CASES) {
  const parsed = await parseMarketingListRequestWithLLM({ request: c.ask });
  assert.ok(parsed, `the parser must answer at all for: ${c.ask}`);
  const refused = !!parsed!.unsupportedCriteria;
  assert.equal(refused, c.mustRefuse, `${c.ask} -> expected ${c.mustRefuse ? "REFUSE" : "BUILD"} (${c.why}); got ${refused ? `refusal "${parsed!.unsupportedCriteria}"` : "a built list"}`);
  n++;

  if (!c.mustRefuse) {
    // A "buildable" answer must still be a USABLE one — a parser that returned nulls for everything
    // AND null unsupportedCriteria would pass the line above while reintroducing the exact bug.
    if (c.ask.includes("Street Glide")) {
      assert.ok(
        String(parsed!.modelQuery ?? "").toLowerCase().includes("street glide"),
        `a supported description must still be understood, not just permitted: ${JSON.stringify(parsed)}`
      );
      assert.equal(parsed!.condition, "used", "…including the parts that were stated");
      assert.equal(parsed!.activeWithinDays, 90, "…and the recency window");
      n += 3;
    }
  } else {
    assert.ok(
      String(parsed!.unsupportedCriteria).trim().length > 3,
      "a refusal must name what it could not do, so the manager can rephrase"
    );
    n++;
  }
}

console.log(`copilot_describe_refusal_eval: PASS (${n} assertions over ${CASES.length} descriptions)`);
