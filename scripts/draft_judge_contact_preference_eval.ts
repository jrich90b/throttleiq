/**
 * draft_judge_contact_preference:eval — a form field is not a customer asking, and a concrete
 * appointment time is not pushiness.
 *
 * MEASURED 2026-08-07, agent loop, over 184 self-heal before->after pairs
 * (reports/draft_self_heal/heal_wins_*.jsonl, 07-07 -> 08-07): **41 heals DELETED a concrete clock
 * time the original draft had offered; only 5 added one.** 8:1 against the one number the business
 * is gated on (readiness section 1: "Offered a time (of engaged)" and "Offer -> book conversion").
 *
 * ONE mechanism produced every single one. The lead arrives as a "WEB LEAD (ADF)" form carrying an
 * Email: field; the whole form text is what the judge receives as the customer's message. The judge
 * reads the email address, concludes the customer "stated a contact preference (email)", and rates
 * an otherwise perfect reply defective for ignoring it. Its steering then tells the composer to
 * acknowledge the email preference and ask how they would like times sent — and the re-draft obeys,
 * throwing the times away:
 *
 *   before: "I can set up a test ride — are you available today at 9:30 AM or 11:30 AM?"
 *   after : "Got it, you prefer email — I can send test-ride options to <addr>. Is that the best
 *            email to confirm with?"
 *
 * Two things were wrong and this pins both. (1) The ADF block is a FORM the dealership received,
 * not the customer speaking; its Email/Phone/Source fields record how the lead ARRIVED. (2)
 * `disposition_ok`'s "if they just want info -> don't pivot to scheduling" was being applied to
 * customers whose entire request WAS a booking ("HD.com Online Test Ride Request").
 *
 * Joe ruled 2026-08-07: fix the CHECKER, not the reply. Fixing it here rather than vetoing the heal
 * is deliberate — a vetoed heal returns `still_failing`, which makes the publish gate HOLD the
 * draft, and staff would get nothing to approve instead of a weak draft.
 *
 * The deterministic arm runs everywhere. The LLM arm is the only thing that proves the judge ACTS
 * on the rules rather than merely being handed them; judge verdicts are not reproducible (memory
 * `judge-verdicts-are-not-reproducible`, 55-74% self-agreement), so it VOTES, same as
 * draft_price_fact_check:eval.
 */
import assert from "node:assert/strict";
import {
  buildDraftQualityJudgePrompt,
  type DraftQualityUnitFacts
} from "../services/api/src/domain/draftQualityJudgePrompt.js";

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

// The real case, straight off the heal log (leadKey chancewin@yahoo.com, 17 of the 41 events).
// Note Phone: also holds the email — that is the real form, not a typo here.
const ADF_INBOUND = [
  "WEB LEAD (ADF)",
  "Source: HD.com Online Test Ride Request",
  "Ref: 11117",
  "Name: Ch Wan",
  "Email: chancewin@yahoo.com",
  "Phone: chancewin@yahoo.com",
  "Year: 2026",
  "Vehicle: Harley-Davidson Nightster",
  "",
  "Inquiry:",
  "Customer Comments:"
].join("\n");

/** The draft the judge WRONGLY flagged — it offers two concrete slots. This is the good one. */
const CONCRETE_TIMES_DRAFT =
  "Hey Ch, it's Alexandra over at American Harley-Davidson. Glad you got in touch. Got it. I can set up a test ride — are you available today at 9:30 AM or 11:30 AM?";

/** What the heal turned it into. The times are gone, replaced by a question about channel. */
const CHANNEL_QUESTION_DRAFT =
  "Hey Ch, it's Alexandra over at American Harley-Davidson. Thanks for your message. Got it, you prefer email — I can send test-ride options to chancewin@yahoo.com. Is that the best email to confirm with?";

const base = {
  inbound: ADF_INBOUND,
  historyLines: [] as string[],
  leadModel: "Nightster",
  leadSource: "HD.com Online Test Ride Request",
  channel: "sms" as const
};

console.log("draft_judge_contact_preference:eval");

await check("the ADF-form rule is in the prompt: a form field is not a stated contact preference", () => {
  const prompt = buildDraftQualityJudgePrompt({ ...base, draft: CONCRETE_TIMES_DRAFT });
  assert.ok(prompt.includes("block is a FORM"), "the form rule names the ADF block");
  assert.ok(prompt.includes("WEB LEAD"), "and it names the block by the exact marker the ADF lane emits");
  assert.ok(/not the customer speaking/.test(prompt), "the form is distinguished from the customer's own words");
  assert.ok(/NOT a stated contact preference/.test(prompt), "an email in the form is explicitly not a preference");
  assert.ok(
    /asked, in their own words, to be reached a different way/.test(prompt),
    "the judge is told what a REAL channel request looks like, so the rule does not blanket-excuse channel misses"
  );
});

await check("the concrete-times rule is in the prompt, including the anti-steering clause", () => {
  const prompt = buildDraftQualityJudgePrompt({ ...base, draft: CONCRETE_TIMES_DRAFT });
  assert.ok(/OFFERING two concrete times is the/.test(prompt), "offering concrete times is named as correct");
  assert.ok(/never fail it as pushy/.test(prompt), "it may not be failed as pushiness");
  assert.ok(
    /never steer a re-draft to replace concrete\n?\s*times with a question about how or where to send times/.test(prompt),
    "the exact observed regression is forbidden IN THE STEERING — this is the clause that stops the 41"
  );
  assert.ok(/Dropping a real time slot is a\s+regression, not a fix/.test(prompt), "the fail-direction is stated");
  assert.ok(
    /don't pivot to scheduling.*only wanted information/s.test(prompt),
    "the disposition_ok rule is scoped to info-only customers rather than deleted"
  );
});

await check("the worked example is the real case and its verdict is GOOD", () => {
  const prompt = buildDraftQualityJudgePrompt({ ...base, draft: CONCRETE_TIMES_DRAFT });
  assert.ok(/HD.com Online Test Ride Request/.test(prompt), "the example carries a real booking-request source");
  assert.ok(/9:30 AM or 11:30 AM/.test(prompt), "the example shows two concrete slots");
  assert.ok(
    /how the lead arrived, not a stated contact preference","steering":""/.test(prompt),
    "the example verdict is good with EMPTY steering — no re-draft is invited"
  );
});

await check("both rules are RULES, not examples — they sit in the Rules block", () => {
  const prompt = buildDraftQualityJudgePrompt({ ...base, draft: CONCRETE_TIMES_DRAFT });
  const rulesAt = prompt.indexOf("\nRules:");
  const examplesAt = prompt.indexOf("\nExamples:");
  assert.ok(rulesAt > 0 && examplesAt > rulesAt, "prompt has a Rules block before Examples");
  const formRuleAt = prompt.indexOf("block is a FORM");
  const timesRuleAt = prompt.indexOf("OFFERING two concrete times");
  assert.ok(formRuleAt > rulesAt && formRuleAt < examplesAt, "the form rule is inside Rules");
  assert.ok(timesRuleAt > rulesAt && timesRuleAt < examplesAt, "the times rule is inside Rules");
});

await check("the rules are UNCONDITIONAL — every channel, with or without unit facts", () => {
  const facts: DraftQualityUnitFacts = { label: "2026 Nightster", listPrice: 12999, mileage: null, stockId: null, status: "available" };
  for (const channel of ["sms", "email"] as const) {
    for (const unitFacts of [null, undefined, facts]) {
      const prompt = buildDraftQualityJudgePrompt({ ...base, channel, draft: CONCRETE_TIMES_DRAFT, unitFacts: unitFacts as any });
      assert.ok(/NOT a stated contact preference/.test(prompt), `form rule missing for ${channel}/${!!unitFacts}`);
      assert.ok(/OFFERING two concrete times/.test(prompt), `times rule missing for ${channel}/${!!unitFacts}`);
    }
  }
});

await check("NO-OP GUARD: the price-fact section is untouched by this change", () => {
  const withoutFacts = buildDraftQualityJudgePrompt({ ...base, draft: CONCRETE_TIMES_DRAFT });
  assert.ok(!withoutFacts.includes("VERIFIED UNIT FACTS"), "still no fact section when no unit resolved");
  const withFacts = buildDraftQualityJudgePrompt({
    ...base,
    draft: CONCRETE_TIMES_DRAFT,
    unitFacts: { label: "2026 Nightster", listPrice: 12999 }
  });
  assert.ok(withFacts.includes("VERIFIED UNIT FACTS"), "the fact section still appears when a price resolves");
  assert.ok(/CONTRADICTS these facts fails safety_ok/.test(withFacts), "the price contradiction rule survives");
});

// ---------------------------------------------------------------------------------------------
// LLM arm — the only proof the judge ACTS on the rules. Votes, because verdicts are not
// reproducible.
//
// ⚠️ SAMPLE SIZE IS LOAD-BEARING, and 3 was too few. MEASURED 2026-08-07 with n=12 per draft on
// clean `origin/main`: the times draft scores good 9/12 (75%), the channel-question draft 8/12
// (67%). The judge does prefer the times draft — but by ~8 points, and at 3 samples a single vote
// flip inverts the comparison. This eval therefore red-lined main on ONE RUN IN THREE (measured:
// 3 consecutive runs of the unchanged file on 37fb69ff gave exit 0 / 1 / 0), blocking every
// routine and every human on an eval that was measuring nothing but noise. It runs with plain
// `tsx`, no retry wrapper, so a single unlucky sample was a red gate.
//
// The fix is sample size plus honest thresholds, NOT a weaker claim:
//   - n=12 per draft, so the 75%-vs-67% signal survives sampling.
//   - The times draft must clear a real majority (>= 7/12). A regression to a coin flip trips it;
//     the measured 9/12 clears it with room.
//   - It must NEVER be HELD. That is the DECISION the system branches on — a held draft is what
//     the self-heal then rewrites into the version with the times deleted, which is the whole bug
//     this file exists to guard. Measured 0 holds in 24 verdicts.
//   - The comparison survives with a noise band of 2 votes. A systematic inversion (the judge
//     genuinely preferring the stripped draft) still fails; a one-vote wobble no longer does.
// ---------------------------------------------------------------------------------------------
if (process.env.OPENAI_API_KEY && process.env.LLM_ENABLED === "1") {
  const { judgeDraftQualityWithLLM } = await import("../services/api/src/domain/llmDraft.js");
  const SAMPLES = 12;
  /** Measured jitter at n=12; a real preference inversion is far larger than this. */
  const NOISE_BAND = 2;

  const vote = async (draft: string) => {
    const verdicts = await Promise.all(
      Array.from({ length: SAMPLES }, () =>
        judgeDraftQualityWithLLM({
          draft,
          inbound: ADF_INBOUND,
          history: [],
          lead: { source: "HD.com Online Test Ride Request", vehicle: { model: "Nightster" } } as any,
          channel: "sms",
          unitFacts: null
        })
      )
    );
    return verdicts.map(v => (v ? v.overall : "null"));
  };

  // One sample set, both claims — the comparison must be drawn from the SAME run, and re-voting
  // the times draft a second time was pure cost and pure extra variance.
  const timesVotes = await vote(CONCRETE_TIMES_DRAFT);
  const channelVotes = await vote(CHANNEL_QUESTION_DRAFT);
  const goodTimes = timesVotes.filter(v => v === "good").length;
  const goodChannel = channelVotes.filter(v => v === "good").length;
  const heldTimes = timesVotes.filter(v => v === "hold").length;
  console.log(
    `      votes(concrete times) = ${JSON.stringify(timesVotes)}\n` +
      `      votes(channel question) = ${JSON.stringify(channelVotes)}`
  );

  await check("LLM: the two-concrete-times draft PASSES — the form email no longer reads as a preference", async () => {
    assert.ok(
      goodTimes >= 7,
      `a clear majority must pass the draft that offers real times; got ${goodTimes}/${SAMPLES}`
    );
  });

  await check("LLM: the draft that offers real times is NEVER held — a held draft is what the self-heal rewrites", async () => {
    assert.equal(heldTimes, 0, `the times draft was held ${heldTimes}/${SAMPLES} times: ${JSON.stringify(timesVotes)}`);
  });

  await check("LLM: the judge does NOT prefer the draft that deleted the times", async () => {
    assert.ok(
      goodTimes >= goodChannel - NOISE_BAND,
      `the reply with real appointment times scored materially below the one that removed them; ${goodTimes} vs ${goodChannel} of ${SAMPLES}`
    );
  });
} else {
  console.log("  --  LLM arm skipped (needs OPENAI_API_KEY + LLM_ENABLED=1)");
}

if (failures) {
  console.error(`\ndraft_judge_contact_preference:eval FAILED (${failures})`);
  process.exit(1);
}
console.log("draft_judge_contact_preference:eval passed");
