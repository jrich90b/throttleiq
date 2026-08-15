/**
 * Draft-quality judge — LEAD RECORD block (2026-08-14).
 *
 * THE BUG. On a web-lead form there is no question to answer, and the judge prompt says so in as
 * many words ("a form's fields are NOT requests" — added, correctly, to stop it inventing an ask
 * out of `Payment Status: Failed`). So `intent_ok` had nothing to grade on those turns and passed
 * by construction. David Ventry `+17164233848`, 2026-08-13: his HDFS COA form landed on a thread we
 * were already mid-deal on, the agent drafted a generic "thanks for the credit application, are you
 * looking at…", the judge passed it, and Scott deleted it and typed the real reply by hand.
 *
 * Measured over 30 days on the live store: web-lead forms are 15% of customer turns but 33% of the
 * wrong-intent corrections staff made by hand.
 *
 * THE FIX this pins: when — and only when — the inbound is a lead-intake form, the prompt carries a
 * LEAD RECORD block and `intent_ok` asks a different question: does the reply FIT this record and
 * this thread? Two arms, because they fail in opposite directions: an ENGAGED thread must not be
 * greeted as a new inquiry, and a genuine FIRST TOUCH must still be allowed its introduction.
 *
 * Layers:
 *   1. No-op guard — an ordinary typed message produces a BYTE-IDENTICAL prompt.
 *   2. Shape table — the two arms, and the record-usability predicate.
 *   3. Form detection — a form is a form; a human writing about a form is not.
 *   4. Wiring guard — index.ts builds the block and hands it to ALL judge call sites (including the
 *      confirm-on-block resample, which must ask the identical question or the vote is rigged).
 *   5. LLM arm (needs a key) — the real David Ventry draft fails, the reply Scott sent passes.
 *
 * Run: npx tsx scripts/draft_judge_lead_record_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  buildDraftQualityJudgePrompt,
  hasUsableLeadIntakeRecord,
  type DraftQualityLeadIntake
} from "../services/api/src/domain/draftQualityJudgePrompt.ts";
import { isLeadIntakeFormInbound } from "../services/api/src/domain/scoringExclusions.ts";

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}\n        ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------- fixtures --
const VENTRY_ADF = [
  "WEB LEAD (ADF)",
  "Source: HDFS COA Online",
  "Ref: 11785",
  "Name: David Ventry",
  "Email: Davyventry@outlook.com",
  "Phone: 7164233848",
  "Year: 2005",
  "Vehicle: Harley-Davidson Fat Boy",
  "",
  "Inquiry:",
  "App ID: 1014107855, Model Year: 2005, Model: Fat Boy"
].join("\n");

/** The record as it actually stood: mid-deal, we had already replied twice. */
const VENTRY_RECORD: DraftQualityLeadIntake = {
  source: "HDFS COA Online",
  vehicle: "2005 Harley-Davidson Fat Boy",
  inquiry: "App ID: 1014107855, Model Year: 2005, Model: Fat Boy",
  priorReplyCount: 2,
  threadStage: "credit_app"
};

/** The same form arriving on a lead we have never replied to. */
const FIRST_TOUCH_RECORD: DraftQualityLeadIntake = { ...VENTRY_RECORD, priorReplyCount: 0, threadStage: null };

const VENTRY_HISTORY = [
  "out: Join us Sat, July 18, 12–5PM at American Harley-Davidson for our 250 Years of Freedom party.",
  "in: 👍👍",
  "out: https://creditapplication.harley-davidson.com/us/en/?dealerid=3436"
];

/** What the agent actually drafted — fluent, on-topic, and treats a live deal as a new inquiry. */
const VENTRY_BAD_DRAFT =
  "Thanks for getting your credit application in! Are you looking at a specific bike, or would you " +
  "like me to send over some options that fit what you're after?";

/**
 * The CONTROL: a reply grounded in what the agent can actually see — the record's Fat Boy and
 * credit-app stage — and moving the deal forward.
 *
 * NOT Scott's literal text. His was "…I received your credit approval for the Fat Boy. Did you sell
 * the Super Glide" — and the Super Glide (Dave's trade, waiting on a brake kit) appears NOWHERE in
 * this thread or the record; he knew it out of band. Asserting the judge must bless a reply whose
 * key fact is invisible to it would be testing the wrong thing, and it is how the first cut of this
 * eval failed. What the block must prove is that it DISCRIMINATES: the generic draft fails, a
 * record-grounded one passes.
 */
const VENTRY_GOOD_DRAFT =
  "Hey Dave, it's Scott at American H-D — good news, your credit application on the 2005 Fat Boy " +
  "came through. Want me to grab a time this week to get the paperwork wrapped up?";

const base = {
  draft: VENTRY_BAD_DRAFT,
  inbound: VENTRY_ADF,
  historyLines: VENTRY_HISTORY,
  leadModel: "Fat Boy",
  leadSource: "HDFS COA Online",
  channel: "sms" as const
};

// ------------------------------------------------- 1) no-op / byte-identity --
// The overwhelming majority of turns are someone typing. Those prompts must not move at all.
check("NO-OP: omitting leadIntake leaves the prompt byte-identical", () => {
  const without = buildDraftQualityJudgePrompt(base);
  assert.equal(buildDraftQualityJudgePrompt({ ...base, leadIntake: null }), without);
  assert.equal(buildDraftQualityJudgePrompt({ ...base, leadIntake: {} }), without);
  assert.ok(!without.includes("LEAD RECORD"), "a prompt with no record must not carry the block");
});

check("NO-OP: an all-empty record is treated as no record", () => {
  const without = buildDraftQualityJudgePrompt(base);
  const empty: DraftQualityLeadIntake = {
    source: "",
    vehicle: null,
    inquiry: "   ",
    priorReplyCount: 0,
    threadStage: null
  };
  assert.equal(buildDraftQualityJudgePrompt({ ...base, leadIntake: empty }), without);
});

// --------------------------------------------------------- 2) shape / arms --
check("ENGAGED arm: the block appears and forbids greeting a known customer as new", () => {
  const p = buildDraftQualityJudgePrompt({ ...base, leadIntake: VENTRY_RECORD });
  assert.ok(p.includes("LEAD RECORD"), "block missing");
  assert.ok(/ALREADY ENGAGED/.test(p), "engaged arm missing");
  assert.ok(/brand-new inquiry/.test(p), "the known-customer failure must be named");
  assert.ok(/"repliesAlreadySentOnThisThread":2/.test(p.replace(/\s/g, "")), "reply count must reach the judge");
  assert.ok(/credit_app/.test(p), "thread stage must reach the judge");
  assert.ok(!/FIRST TOUCH/.test(p), "the first-touch arm must not also fire");
});

check("FIRST-TOUCH arm: an introduction is explicitly allowed", () => {
  const p = buildDraftQualityJudgePrompt({ ...base, leadIntake: FIRST_TOUCH_RECORD });
  assert.ok(/FIRST TOUCH/.test(p), "first-touch arm missing");
  assert.ok(/introduction is correct/.test(p), "an intro must be permitted on a first touch");
  assert.ok(!/ALREADY ENGAGED/.test(p), "the engaged arm must not fire with no prior reply");
});

check("the anti-phantom rule survives — a form field is still not an ask", () => {
  const p = buildDraftQualityJudgePrompt({ ...base, leadIntake: VENTRY_RECORD });
  assert.ok(/Payment Status: Failed/.test(p), "the phantom example must stay in the block");
  assert.ok(/Do NOT invent an ask out of a field/.test(p), "the anti-phantom instruction must stay");
  assert.ok(
    /are NOT requests|are not requests/i.test(p),
    "the original 'fields are not requests' rule must remain"
  );
});

check("record usability: any one real field is enough, nothing is not", () => {
  const rows: Array<[string, DraftQualityLeadIntake | null | undefined, boolean]> = [
    ["null", null, false],
    ["undefined", undefined, false],
    ["empty object", {}, false],
    ["blank strings", { source: "", vehicle: "  ", inquiry: "", threadStage: "" }, false],
    ["zero replies alone", { priorReplyCount: 0 }, false],
    ["source only", { source: "HDFS COA Online" }, true],
    ["vehicle only", { vehicle: "2005 Fat Boy" }, true],
    ["inquiry only", { inquiry: "App ID: 1014107855" }, true],
    ["stage only", { threadStage: "credit_app" }, true],
    ["engagement only", { priorReplyCount: 2 }, true]
  ];
  for (const [id, rec, want] of rows) {
    assert.equal(hasUsableLeadIntakeRecord(rec), want, `hasUsableLeadIntakeRecord[${id}]`);
  }
});

// ------------------------------------------------------ 3) form detection --
check("form detection: forms match, humans never do", () => {
  for (const form of [
    VENTRY_ADF,
    "WEB LEAD (ADF)\nSource: Traffic Log Pro\nRef: 11775\nInquiry: Mike was in on Saturday.",
    "PHONE LOG (ADF)\nSource: HDFS COA\nVehicle: Street Glide"
  ]) {
    assert.equal(isLeadIntakeFormInbound(form), true, `should be a form: ${form.slice(0, 40)}`);
  }
  for (const human of [
    "",
    "   ",
    "Ok. Friday. Afternoon",
    "What is the lowest interest rate you can get me on the flex financing?",
    // The two-signal requirement: a marker with no structured field, and a field-ish word with no
    // marker, both stay human. A customer mentioning "adf" must never be read as a form.
    "I filled out the ADF thing on your site",
    "Source: my buddy told me about you"
  ]) {
    assert.equal(isLeadIntakeFormInbound(human), false, `should NOT be a form: ${human}`);
  }
});

// --------------------------------------------------------- 4) wiring guard --
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
// The builder lives in a domain module, not index.ts — index.ts is at its size ceiling by design
// and `source_size_ratchet:eval` rejected the first cut of this change for growing it.
const builder = fs.readFileSync("services/api/src/domain/draftJudgeInputs.ts", "utf8");

check("the record is built from the form, not from every turn", () => {
  assert.ok(
    /export function buildDraftJudgeLeadRecord/.test(builder),
    "the record builder must live in services/api/src/domain/draftJudgeInputs.ts"
  );
  assert.ok(
    /buildDraftJudgeLeadRecord[\s\S]{0,300}?if \(!isLeadIntakeFormInbound\(inbound\)\) return null;/.test(builder),
    "the builder must return null unless the inbound IS a lead-intake form — otherwise every ordinary turn gets the block"
  );
  assert.ok(
    /keepCustomerReceivedOutbounds/.test(builder),
    "prior replies must be counted from what the customer RECEIVED (an unsent draft is not a reply)"
  );
});

check("every judge call site gets the record — including the confirm resample", () => {
  const sites = index.match(/leadIntake:\s*buildDraftJudgeLeadRecord\(conv, inbound\)/g) ?? [];
  assert.equal(
    sites.length,
    3,
    `all three judge call sites (shadow, live gate, confirm resample) must pass the record; found ${sites.length}`
  );
  // The resample is the one that silently rots: a confirm vote asking a DIFFERENT question is not a
  // second opinion, it is a second judge, and the hold/pass split stops meaning anything.
  assert.ok(
    /resample:[\s\S]{0,600}?leadIntake:\s*buildDraftJudgeLeadRecord/.test(index),
    "the confirm-on-block resample must ask the identical question as the first verdict"
  );
});

// -------------------------------------------------------------- 5) LLM arm --
const hasKey = process.env.LLM_ENABLED === "1" && !!process.env.OPENAI_API_KEY;
if (!hasKey) {
  console.log("  --  LLM arm skipped (needs OPENAI_API_KEY + LLM_ENABLED=1)");
} else {
  const { judgeDraftQualityWithLLM } = await import("../services/api/src/domain/llmDraft.ts");
  const judge = (draft: string, leadIntake: DraftQualityLeadIntake | null) =>
    judgeDraftQualityWithLLM({
      draft,
      inbound: VENTRY_ADF,
      history: VENTRY_HISTORY.map(l => ({
        direction: l.startsWith("out") ? ("out" as const) : ("in" as const),
        body: l.replace(/^(in|out):\s*/, "")
      })),
      lead: { source: "HDFS COA Online", vehicle: { model: "Fat Boy", year: "2005" } } as any,
      channel: "sms",
      leadIntake
    });

  // Judges are stochastic — vote, and require a majority, exactly like the price fact check.
  const vote = async (draft: string, rec: DraftQualityLeadIntake | null) =>
    (await Promise.all([judge(draft, rec), judge(draft, rec), judge(draft, rec)])).map(v =>
      v ? `${v.overall}/${v.intentOk ? "intent_ok" : "intent_bad"}` : "null"
    );

  const bad = await vote(VENTRY_BAD_DRAFT, VENTRY_RECORD);
  console.log(`      votes(generic draft, WITH record) = ${JSON.stringify(bad)}`);
  check("LLM: the draft Scott had to rewrite no longer passes with the record in hand", () => {
    const caught = bad.filter(v => v !== "null" && v !== "good/intent_ok").length;
    assert.ok(caught >= 2, `expected a majority to catch it; got ${JSON.stringify(bad)}`);
  });

  const good = await vote(VENTRY_GOOD_DRAFT, VENTRY_RECORD);
  console.log(`      votes(record-grounded reply)      = ${JSON.stringify(good)}`);
  check("LLM: a record-grounded reply passes — the block must discriminate, not fail everything", () => {
    const ok = good.filter(v => v.endsWith("/intent_ok")).length;
    assert.ok(ok >= 2, `the grounded reply must pass intent; got ${JSON.stringify(good)}`);
  });

  // THE A/B, and the reason to believe any of this. Same draft, same thread, record withheld: this
  // is the verdict production has been returning on these turns all along. If it also fails without
  // the block, the block is not what changed the answer and this whole change proves nothing.
  const withoutRecord = await vote(VENTRY_BAD_DRAFT, null);
  console.log(`      votes(generic draft, NO record)   = ${JSON.stringify(withoutRecord)}`);
  check("LLM: the SAME generic draft passes without the record — the block is what catches it", () => {
    const passed = withoutRecord.filter(v => v.endsWith("/intent_ok")).length;
    assert.ok(
      passed >= 2,
      `without the record the judge has no ask to grade and should pass it (that is the bug); got ${JSON.stringify(withoutRecord)}`
    );
  });
}

if (failures) {
  console.error(`\ndraft_judge_lead_record:eval FAILED (${failures})`);
  process.exit(1);
}
console.log("draft_judge_lead_record:eval passed");
