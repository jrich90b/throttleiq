/**
 * Non-buyer / passenger survey acknowledgement eval (pure, no LLM).
 *
 * Pins the Elizabeth Klapa fix (2026-06-25): a Dealer Lead App "Passenger" survey whose
 * STRUCTURED purchase-timeframe field says the person is explicitly NOT a buyer ("I am not
 * interested in purchasing at this time") was answered as if it were a sales inquiry on the
 * first touch — "Thanks — I got your inquiry. Which bike are you asking about?" and "just
 * checking in on the 2026 Heritage Classic. Want me to send photos or price and payment
 * numbers?". They told us up front they don't want to buy; the only correct first touch is a
 * warm, no-pressure acknowledgement.
 *
 * This keys ONLY on a fixed ADF/lead-gen enum field (purchaseTimeframe), so it is structured
 * routing, NOT free-text comprehension — the same signal already drives
 * resolveInitialAdfCadencePlan -> "suppress" (no nagging follow-ups). This is its reply-side
 * twin, so the cadence AND the opener agree.
 *
 * Layers:
 *   1. Decision table — decideNonBuyerSurveyTurn maps an explicit non-buyer timeframe to the
 *      ack and leaves real/near-term/long-term/unparseable buyers alone.
 *   2. Cadence/reply parity — the EXACT timeframe that triggers the ack also makes
 *      resolveInitialAdfCadencePlan return "suppress" (one source of truth).
 *   3. Ack safety — buildNonBuyerSurveyAck identifies the agent and carries NO "which bike?"
 *      ask, photo/price offer, availability claim, model-fact assertion, or stop-in push.
 *   4. Source guard — the gate is wired at the initial-ADF draft in BOTH paths (live intake +
 *      regen), gated to the first touch (isInitialAdf / no customer SMS reply yet).
 *
 * Run: npx tsx scripts/non_buyer_survey_ack_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { decideNonBuyerSurveyTurn } from "../services/api/src/domain/routeStateReducer.ts";
import { buildNonBuyerSurveyAck } from "../services/api/src/domain/agentVoice.ts";
import { resolveInitialAdfCadencePlan } from "../services/api/src/domain/conversationStore.ts";

// --- 1) Decision table (pure). ---
type Row = { id: string; timeframe: string | null; ack: boolean };
const rows: Row[] = [
  // Elizabeth's exact field — the bug.
  { id: "not_interested_at_this_time", timeframe: "I am not interested in purchasing at this time", ack: true },
  { id: "not_interested_short", timeframe: "Not interested", ack: true },
  { id: "not_interested_mixed_case", timeframe: "NOT INTERESTED in buying right now", ack: true },
  // Real buyers — every horizon — must NOT be diverted.
  { id: "near_term_0_3", timeframe: "0-3 months", ack: false },
  { id: "mid_term_4_6", timeframe: "4-6 months", ack: false },
  { id: "long_term_year", timeframe: "1-2 years", ack: false },
  { id: "ready_now", timeframe: "Ready to buy now", ack: false },
  { id: "unsure", timeframe: "Just looking / not sure", ack: false },
  { id: "empty", timeframe: null, ack: false },
  { id: "blank", timeframe: "", ack: false }
];
for (const r of rows) {
  const kind = decideNonBuyerSurveyTurn({ purchaseTimeframe: r.timeframe }).kind;
  assert.equal(
    kind === "non_buyer_survey_ack",
    r.ack,
    `decideNonBuyerSurveyTurn[${r.id}] expected ack=${r.ack}, got kind=${kind}`
  );
}

// --- 2) Cadence/reply parity — the SAME signal must both suppress the cadence AND fire the ack
//        (and conversely, a buyer keeps a real cadence and gets no ack). One source of truth. ---
for (const r of rows) {
  const ack = decideNonBuyerSurveyTurn({ purchaseTimeframe: r.timeframe }).kind === "non_buyer_survey_ack";
  const suppressed = resolveInitialAdfCadencePlan({ purchaseTimeframe: r.timeframe }) === "suppress";
  assert.equal(
    ack,
    suppressed,
    `parity[${r.id}]: ack(${ack}) must match cadence-suppress(${suppressed}) for the same timeframe`
  );
}

// --- 3) Ack safety (pure). ---
const ack = buildNonBuyerSurveyAck("Elizabeth", "Alexandra", "American Harley-Davidson");
assert.ok(
  /Elizabeth/.test(ack) && /Alexandra/.test(ack) && /American Harley-Davidson/.test(ack),
  "ack must identify lead + agent + dealer"
);
// The exact failure modes this replaces must NOT appear in the approved ack.
const BANNED: { label: string; re: RegExp }[] = [
  { label: "which-bike ask", re: /\bwhich bike|what bike|bike preference|comparing models\b/i },
  { label: "photo/price offer", re: /\bsend (you )?(photos|pics|pictures)|price and payment|payment numbers|run (the )?numbers|monthly\b/i },
  { label: "availability claim", re: /\b(still available|in stock|available)\b/i },
  { label: "vehicle-fact assertion", re: /\bit'?s a (19|20)\d\d\b/i },
  { label: "stop-in / appointment push", re: /\bstop in|come in|swing by|check it out|what day|what time|set up a time|test ride|schedule\b/i }
];
for (const b of BANNED) {
  assert.ok(!b.re.test(ack), `non-buyer ack must not contain a ${b.label}: "${ack}"`);
}
// A nameless lead still produces a clean greeting (no "undefined"/"null").
const ackNoName = buildNonBuyerSurveyAck(null, "Alexandra", "American Harley-Davidson");
assert.ok(!/undefined|null/.test(ackNoName), "ack must handle a missing first name cleanly");

// --- 4) Source guard — the gate is wired at the initial-ADF draft in BOTH paths. ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const sendgrid = fs.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");

// Live intake: gated to the first touch (isInitialAdf) and overrides the sales draft.
assert.ok(
  /decideNonBuyerSurveyTurn/.test(sendgrid) && /buildNonBuyerSurveyAck/.test(sendgrid) && /isInitialAdf/.test(sendgrid),
  "the initial-ADF draft (live) must divert a self-declared non-buyer to the ack, gated to the first touch"
);
// Regen: gated to the first touch (no customer SMS reply) and overrides the sales draft.
assert.ok(
  /decideNonBuyerSurveyTurn/.test(index) && /buildNonBuyerSurveyAck/.test(index),
  "the regen path must divert a self-declared non-buyer first touch to the ack"
);
assert.ok(
  /regenIsAdfFirstTouchNonBuyer/.test(index) && /m\?\.provider \?\? ""\)\.toLowerCase\(\) === "twilio"/.test(index),
  "the regen gate must require an ADF first touch with no customer SMS reply yet"
);

const ackCount = rows.filter(r => r.ack).length;
console.log(
  `PASS non-buyer-survey ack eval — ${rows.length} decision cases (${ackCount} ack / ${rows.length - ackCount} not), cadence/reply parity, ack safety + both-path first-touch source guard`
);
