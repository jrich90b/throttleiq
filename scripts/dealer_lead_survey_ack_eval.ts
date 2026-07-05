/**
 * Dealer Lead App marketing-survey acknowledgement eval (pure, no LLM).
 *
 * Pins the Tim Williams fix (+17163741119, 2026-06-24): a "Marketing Questions: Dealer Lead App"
 * survey embedded in the ADF Customer Comments — ownership history + "Do you expect to make a
 * motorcycle purchase? Yes, in 3-12 months" + "Which model are you interested in? ...STREET GLIDE 3
 * LIMITED" + "Demo Bikes Ridden: ...STREET GLIDE 3 LIMITED" — fell through to the generic sales
 * generator, which read the survey's "Demo Bikes Ridden" field as a COMPLETED test ride at this
 * dealer and fabricated: "Thanks again for coming in for the test ride on the Street Glide 3
 * Limited. Congrats on the Street Glide 3 Limited." The context-fidelity gate HELD that draft
 * (stale_intent). The buyer-side twin of the non-buyer survey ack: comprehend the survey and answer
 * the FIRST touch with a warm, accurate acknowledgement of stated interest + an invite to ride/visit
 * — never a fabricated past action.
 *
 * Layers:
 *   1. Decision table — decideDealerLeadSurveyTurn maps {isDealerLeadSurvey, purchaseIntent,
 *      confidence} to buyer_survey_ack / non_buyer_survey_ack / none (confidence floor; non-survey
 *      and low-confidence => none so normal routing answers the lead).
 *   2. Buyer-ack safety — buildBuyerSurveyAck identifies agent + dealer + name, names the stated
 *      model when given, INVITES a ride/visit, and carries NONE of the fabricated-frame failure
 *      modes ("thanks again", "congrats", "coming in for the test ride") or a false stock claim.
 *   3. Hint pre-filter — hasDealerLeadSurveyHint matches the survey body and rejects a plain inquiry.
 *   4. Source guard — the gate is wired at the initial-ADF draft in BOTH paths (live intake + regen),
 *      gated to the first touch (isInitialAdf / no customer SMS reply yet) and behind the hint.
 *
 * Run: npx tsx scripts/dealer_lead_survey_ack_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { decideDealerLeadSurveyTurn } from "../services/api/src/domain/routeStateReducer.ts";
import { buildBuyerSurveyAck } from "../services/api/src/domain/agentVoice.ts";
import { hasDealerLeadSurveyHint } from "../services/api/src/domain/llmDraft.ts";

// --- 1) Decision table (pure). ---
type Row = {
  id: string;
  isSurvey: boolean;
  intent: "buyer" | "non_buyer" | "unknown";
  confidence: number;
  expect: "buyer_survey_ack" | "non_buyer_survey_ack" | "none";
};
const rows: Row[] = [
  // Tim's exact lead — a confident buyer survey.
  { id: "tim_buyer_3_12mo", isSurvey: true, intent: "buyer", confidence: 0.95, expect: "buyer_survey_ack" },
  { id: "buyer_low_conf", isSurvey: true, intent: "buyer", confidence: 0.5, expect: "none" },
  { id: "survey_unknown_horizon", isSurvey: true, intent: "unknown", confidence: 0.8, expect: "buyer_survey_ack" },
  { id: "explicit_non_buyer", isSurvey: true, intent: "non_buyer", confidence: 0.9, expect: "non_buyer_survey_ack" },
  // Not a survey at all (a direct inventory inquiry) — must never divert.
  { id: "direct_inquiry", isSurvey: false, intent: "buyer", confidence: 0.95, expect: "none" },
  { id: "non_survey_unknown", isSurvey: false, intent: "unknown", confidence: 0.4, expect: "none" }
];
for (const r of rows) {
  const kind = decideDealerLeadSurveyTurn({
    isDealerLeadSurvey: r.isSurvey,
    purchaseIntent: r.intent,
    confidence: r.confidence
  }).kind;
  assert.equal(kind, r.expect, `decideDealerLeadSurveyTurn[${r.id}] expected ${r.expect}, got ${kind}`);
}

// --- 2) Buyer-ack safety (pure). ---
const ackWithModel = buildBuyerSurveyAck("Tim", "Giovanni", "American Harley-Davidson", "Street Glide 3 Limited");
assert.ok(
  /Tim/.test(ackWithModel) && /Giovanni/.test(ackWithModel) && /American Harley-Davidson/.test(ackWithModel),
  "buyer ack must identify lead + agent + dealer"
);
assert.ok(/Street Glide 3 Limited/.test(ackWithModel), "buyer ack must name the stated interested model");
// It IS a buyer — it should warmly invite a ride/visit (the opposite of the non-buyer ack).
assert.ok(
  /\btest ride\b/i.test(ackWithModel) && /\bcome in\b/i.test(ackWithModel),
  "buyer ack must invite a test ride / visit"
);
// The EXACT fabrication this replaces must NOT appear.
const BANNED: { label: string; re: RegExp }[] = [
  { label: "past-visit 'thanks again'", re: /\bthanks again\b/i },
  { label: "congrats-on-purchase", re: /\bcongrats|congratulations\b/i },
  { label: "completed test ride frame", re: /coming in for (the|a|your) test ride|for the test ride|for your test ride/i },
  { label: "in-stock / availability claim", re: /\b(still available|in stock)\b/i },
  { label: "vehicle-fact assertion", re: /\bit'?s a (19|20)\d\d\b/i }
];
for (const b of BANNED) {
  assert.ok(!b.re.test(ackWithModel), `buyer ack must not contain a ${b.label}: "${ackWithModel}"`);
}
// A nameless / model-less lead still produces a clean greeting + invite (no "undefined"/"null").
const ackNoModel = buildBuyerSurveyAck(null, "Giovanni", "American Harley-Davidson", null);
assert.ok(!/undefined|null/.test(ackNoModel), "buyer ack must handle a missing name/model cleanly");
assert.ok(/\btest ride\b/i.test(ackNoModel), "model-less buyer ack must still invite a ride");
for (const b of BANNED) {
  assert.ok(!b.re.test(ackNoModel), `model-less buyer ack must not contain a ${b.label}: "${ackNoModel}"`);
}

// --- 3) Hint pre-filter — matches the survey body, rejects a plain inquiry. ---
const timBody =
  "WEB LEAD (ADF)\nSource: Dealer Lead App\nName: Tim Williams\nVehicle: Harley-Davidson Street Glide 3 Limited\n" +
  "Inquiry:\nCustomer Comments: Marketing Questions: Dealer Lead App - How many years have you owned your " +
  "Harley-Davidson motorcycle? More than 4 years - Do you expect to make a motorcycle purchase in the near " +
  "future? Yes, in 3-12 months - Which model of motorcycle are you interested in? 2026,TRIKE,STREET GLIDE 3 " +
  "LIMITED Demo Bikes Ridden: 2026,TRIKE,STREET GLIDE 3 LIMITED Email Opt-In:Yes-";
assert.ok(hasDealerLeadSurveyHint(timBody), "hint must fire on the Dealer Lead App marketing survey body");
assert.ok(
  !hasDealerLeadSurveyHint("Is the 2026 Road Glide still available? What's the out-the-door price?"),
  "hint must NOT fire on a plain inventory/pricing inquiry"
);
assert.ok(!hasDealerLeadSurveyHint(""), "hint must reject empty text");

// --- 4) Source guard — the gate is wired at the initial-ADF draft in BOTH paths. ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const sendgrid = fs.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");

// Live intake: gated to the first touch (isInitialAdf), behind the hint, overrides the sales draft.
assert.ok(
  /parseDealerLeadSurveyWithLLM/.test(sendgrid) &&
    /decideDealerLeadSurveyTurn/.test(sendgrid) &&
    /buildBuyerSurveyAck/.test(sendgrid) &&
    /hasDealerLeadSurveyHint/.test(sendgrid) &&
    /isInitialAdf/.test(sendgrid),
  "the initial-ADF draft (live) must comprehend a Dealer Lead App survey and divert to the survey ack, gated to the first touch + hint"
);
// Regen: gated to an ADF first touch (no customer SMS reply yet), behind the hint, overrides the draft.
assert.ok(
  /parseDealerLeadSurveyWithLLM/.test(index) &&
    /decideDealerLeadSurveyTurn/.test(index) &&
    /buildBuyerSurveyAck/.test(index) &&
    /regenIsAdfFirstTouchSurveyEligible/.test(index),
  "the regen path must comprehend a Dealer Lead App survey first touch and divert to the survey ack"
);

const ackCount = rows.filter(r => r.expect !== "none").length;
console.log(
  `PASS dealer-lead-survey ack eval — ${rows.length} decision cases (${ackCount} ack / ${rows.length - ackCount} none), buyer-ack safety (no fabricated frame), hint pre-filter + both-path first-touch source guard`
);
