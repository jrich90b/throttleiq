/**
 * Corpus-replay expected-silence eval.
 *
 * The shadow-replay classifier (`classifyDraft`) used to score DESIGNED silence
 * as verdict `no_response` (unexpected silence → a `corpus_replay_judge_fail`),
 * dirtying the anomaly work order with phantom misses. Its local ad-hoc matchers
 * had drifted behind the canonical, eval-pinned exclusion helpers in
 * services/api/src/domain/scoringExclusions.ts, and its `hasQuestion` veto fired
 * on NEGATED contractions ("can't wait" → "can") and auxiliaries inside fixed
 * phrases ("will do" → "do", "you are welcome" → "are").
 *
 * This pins every production turn from the 2026-07-23 sweep (root-cause key
 * replay-shadow-classifier-expected-silence-undercoverage) as a classifyDraft
 * self-test, plus fail-safe counter-cases proving real asks still get graded.
 * Harness-only: zero production behavior change.
 */
import assert from "node:assert/strict";

import { classifyDraft } from "./inbound_shadow_replay.ts";

const suggest = { mode: "suggest" } as any;

function expectSilence(provider: "twilio" | "sendgrid_adf", inbound: string, conv: any, label: string) {
  const { verdict, reasons } = classifyDraft(provider, inbound, null, conv);
  assert.equal(
    verdict,
    "expected_no_response",
    `${label}: silence on ${JSON.stringify(inbound.slice(0, 60))} must be expected_no_response, got ${verdict} (${reasons.join("; ")})`
  );
}

// --- Tapback / reaction echoes (customer pressed a button, wrote nothing) ---
expectSilence(
  "twilio",
  "Reacted 🫡 to “Hi Richard — this is Alexandra at American Harley-Davidson. Thanks for signing up for this year's ride challenge. Feel free to stop in and record your miles.”",
  suggest,
  "+17169308611 tapback echo"
);
expectSilence(
  "twilio",
  "Reacted ❤️ to “Hi Josh — this is Joe at American Harley-Davidson. Thanks again for coming to see us for your Road Glide Special. If you need anything, just let me know.”",
  suggest,
  "+17169570162 tapback echo"
);
// Zero-width-space-wrapped bare-emoji tapback ("👍 to “…”").
expectSilence(
  "twilio",
  " ​👍​ to “ Join us Sat, July 18, 12–5PM at American Harley‑Davidson (1149 Erie Ave, North Tonawanda) for our 250 Years of Freedom party”",
  suggest,
  "+17163828250 emoji tapback"
);
// Emoji-only turn.
expectSilence("twilio", "👍👍", suggest, "+17164233848 emoji-only");

// --- Emoji-tailed and phrase acks ---
expectSilence("twilio", "Awesome 👍", suggest, "+17164722478 emoji-tailed ack");
expectSilence("twilio", "Sounds great!", suggest, "+17164289392 sounds great");
expectSilence("twilio", "Thanks battle budy ", suggest, "+17165701338 vocative thanks");

// --- Enthusiasm closer (negated contraction must not veto) ---
expectSilence("twilio", "Can't wait ", suggest, "+15857657010 can't wait");

// --- Closer pleasantries ---
expectSilence("twilio", "You are welcome", suggest, "+17865569671 you are welcome");
expectSilence("twilio", "No problem at all.  ", suggest, "+17162667396 no problem at all");

// --- Gratitude signoff with "will do" (bare auxiliary must not veto) ---
expectSilence(
  "twilio",
  "Thank you, absolutely loving it. Took short day today at work to go out for a ride actually. And will do, thank you.",
  suggest,
  "+17164005844 will-do gratitude signoff"
);

// --- Dealer Lead App demo-ride ADF on an ALREADY-THANKED rider ---
// Ref 11182 / +17168078517: the thank-you went out 5/8, the DLA ADF re-fired 5/9.
// The live path dedupes (dealer_ride_initial_thank_you_exists), so silence is by
// design, not a missing thank-you.
const dlaDemoRideAdf = [
  "WEB LEAD (ADF)",
  "Source: Dealer Lead App",
  "Ref: 11182",
  "Name: Terrance Hailey",
  "Vehicle: Harley-Davidson Street Glide",
  "Event Name: Dealer Test Ride",
  "Comments: Customer completed a demo ride today."
].join("\n");
const alreadyThankedConv = {
  mode: "suggest",
  messages: [
    {
      direction: "out",
      body: "Hi Terry — This is Joe at American Harley-Davidson. Thanks again for coming in for the test ride. If any questions come up, just text me."
    }
  ]
} as any;
{
  const { verdict } = classifyDraft("sendgrid_adf", dlaDemoRideAdf, null, alreadyThankedConv);
  assert.equal(
    verdict,
    "expected_no_response",
    `already-thanked DLA demo-ride ADF must be expected_no_response, got ${verdict}`
  );
}
// Same ADF with NO prior thank-you keeps its original verdict: a missing thank-you
// draft is still surfaced (the Joe-approved 2026-07-02 policy stays enforced).
{
  const { verdict } = classifyDraft("sendgrid_adf", dlaDemoRideAdf, null, { mode: "suggest", messages: [] } as any);
  assert.notEqual(
    verdict,
    "expected_no_response",
    "un-thanked DLA demo-ride ADF silence must still be flagged, never expected_no_response"
  );
}

// --- Fail-safe counter-cases: real asks and cancellations still get graded ---
for (const [inbound, label] of [
  ["Can't make it Saturday, need to cancel", "cancellation must stay graded"],
  ["Thanks! What's the out the door price?", "gratitude + price ask must stay graded"],
  ["Awesome 👍 when can I come in?", "ack + scheduling ask must stay graded"],
  ["Sounds great, can you send payment numbers?", "ack + finance ask must stay graded"],
  ["Do you have the 2024 Street Glide in stock?", "inventory ask must stay graded"]
] as const) {
  const { verdict } = classifyDraft("twilio", inbound, null, suggest);
  assert.equal(verdict, "no_response", `${label}: ${JSON.stringify(inbound)} silence must stay no_response, got ${verdict}`);
}

console.log("PASS corpus replay expected-silence eval");
