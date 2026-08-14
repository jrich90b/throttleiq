/**
 * "Can you reach out?" is a request for CONTACT, not a request to be reminded later.
 *
 * THE MISS (+17164312108, Adam, 2026-08-08). Adam texted "Hey Scott it's Adam again can you
 * reach out when you get the chance". The live twilio arm gated on a direction-blind regex —
 * /\b(remind|reminder|follow up|follow-up|check back|reach out|touch base)\b/ — matched the
 * words "reach out", and answered:
 *
 *     "Sounds good — I'm here when you're ready. Just reach out when the time is right."
 *
 * ...while pausing follow-up for 90 days. He asked us to call HIM; we told him to call US and
 * then went quiet for three months. The nightly corpus replay still reproduces that draft on
 * current main (2026-08-14 run: pass=false, critical=true, judge severity "major").
 *
 * WHY IT IS NOT A PARSER MISS. Both typed parsers read the turn correctly and stably — measured
 * 2026-08-14, five samples each: parseIntentWithLLM => intent "callback", explicit_request true,
 * confidence 0.90-0.98 (5/5); parseInboundReplyActionWithLLM => "explicit_callback_request",
 * confidence 0.98-0.99 (5/5). Both feed the centralized route decision, which says callback.
 * A keyword gate sitting downstream simply claimed the turn first — the anti-pattern AGENTS.md
 * exists to stop, and the same class as the soft-visit referee (#701).
 *
 * WHAT THIS EVAL PINS. The DECISION — "does the reminder/pause arm own this turn?" — not any
 * label or copy. followUpReminderPauseClaimsTurn is the one gate; it must decline the turn when
 * the route decision carries a callback request, and must still claim a genuine defer.
 *
 * BLAST RADIUS, measured on the live store (562 conversations): 38 inbound turns have words
 * that match the reminder gate. Exactly ONE — Adam's — is a customer asking us to make contact.
 * The rest are ADF lead blobs, phone-call transcripts, tapbacks, and genuine defers
 * ("I'll reach out to you when I'm looking again"), none of which this change touches.
 *
 * FAIL DIRECTION: safe both ways. A MISSED callback parse leaves the old behaviour exactly as it
 * was; a FALSE callback parse means we reply and do NOT pause — never a silent 90-day park.
 */
import assert from "node:assert/strict";

import { followUpReminderPauseClaimsTurn } from "../services/api/src/domain/workflowRegressionGuards.js";

// Adam's exact inbound text (+17164312108, 2026-08-08T12:08:29.293Z).
const ADAM = "Hey Scott it's Adam again can you reach out when you get the chance";
// A genuine defer, also from the live store (+17164815673, 2026-05-23).
const DEFER = "Thanks Joe. I'm all set on the bike search for the time being. Appreciate your help. I'll reach out to you when I'm looking again";

// 1. THE MISS. The parsers read Adam's turn as an explicit callback request, so the
//    reminder/pause arm must not claim it — the callback arm owns the task and the reply.
assert.equal(
  followUpReminderPauseClaimsTurn(ADAM, true, false),
  false,
  "a parsed callback request must not be claimed by the reminder/pause arm (it paused Adam 90 days and told him to call us)"
);

// 2. FAIL DIRECTION. If the callback parse is missed or low-confidence, behaviour is unchanged —
//    this slice never makes a turn WORSE than it was before it.
assert.equal(
  followUpReminderPauseClaimsTurn(ADAM, false, false),
  true,
  "with no callback signal the arm must behave exactly as it did before this change"
);

// 3. THE ARM STILL WORKS. A customer deferring us is still a reminder/pause turn.
assert.equal(
  followUpReminderPauseClaimsTurn(DEFER, false, false),
  true,
  "a genuine defer must still pause follow-up — this change narrows the arm, it does not retire it"
);

// 4. The pre-existing location-question guard is preserved, not silently dropped.
assert.equal(
  followUpReminderPauseClaimsTurn("I cant not currently and remind me again what address is this at?", false, true),
  false,
  "a dealer-location question must still win over the reminder arm"
);

// 5. A turn with none of the reminder words was never this arm's, callback or not.
assert.equal(
  followUpReminderPauseClaimsTurn("do you have any black street glides in stock?", false, false),
  false,
  "the arm must not claim a turn whose words never matched it"
);
assert.equal(followUpReminderPauseClaimsTurn("", false, false), false, "empty text claims nothing");
assert.equal(followUpReminderPauseClaimsTurn(null, false, false), false, "absent text claims nothing");

// 6. The callback signal outranks the words regardless of WHICH reminder word matched — the
//    defect was the gate's blindness to direction, not the single phrase "reach out".
for (const text of [
  "give me a reminder",
  "can you follow up with me",
  "let's touch base",
  "check back with me",
  "can you reach out"
]) {
  assert.equal(
    followUpReminderPauseClaimsTurn(text, true, false),
    false,
    `callback route decision must outrank the reminder words in: ${text}`
  );
  assert.equal(
    followUpReminderPauseClaimsTurn(text, false, false),
    true,
    `without a callback signal the reminder words still claim the turn: ${text}`
  );
}

console.log("PASS callback request is not a reminder pause (7 decisions + 5 reminder-word pairs)");
