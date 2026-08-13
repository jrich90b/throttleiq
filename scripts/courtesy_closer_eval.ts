/**
 * courtesy_closer:eval — the decision table for "say you're welcome, or say nothing".
 *
 * Joe, 2026-08-13, asked whether the agent could learn from past conversations when to answer a
 * thank-you with "You're welcome" / "No problem" / 👍 and when to stay quiet. The corpus was mined
 * first and it CANNOT teach that (295 bare acks: 68% silence, 16% a warm one-liner, 16% the reply we
 * still owed — and the two silent/warm populations are not separable by anything we store). So this
 * is a narrow POLICY, and this eval is what stops it widening.
 *
 * The load-bearing property, asserted below in four different ways: **the closer can only ever
 * replace SILENCE.** It is reachable from exactly the two branches where `decideShortAckTurnEnd`
 * had already concluded we owe the customer nothing — the typed ack parser read no acceptance, no
 * watch/slot/reschedule is pending, and our own last message asked no question. If a future edit
 * lets it fire before those checks, it starts eating real replies, and these cases go red.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  COURTESY_CLOSER_TEXT,
  decideShortAckTurnEnd,
  isExplicitThanksText,
  type ShortAckTurnEndInput
} from "../services/api/src/domain/routeStateReducer.ts";
import { isCourtesyCloserText } from "../services/api/src/domain/scoringExclusions.ts";

let checks = 0;
function check(id: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} ${id} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  assert.equal(ok, true, `${id} failed`);
  checks += 1;
}

/** A turn where every rule has already decided we owe nothing — the ONLY place a closer may live. */
function nothingOwed(over: Partial<ShortAckTurnEndInput> = {}): ShortAckTurnEndInput {
  return {
    provider: "twilio",
    shortAck: true,
    schedulingBlocked: false,
    ackOnlyCloseTurn: false,
    lastOutboundAskedQuestion: false,
    hasPendingWatch: false,
    hasPendingSlot: false,
    hasReschedulePending: false,
    acceptedPendingOffer: false,
    ackText: "Thanks!",
    ...over
  };
}

// --- 1. The class itself -----------------------------------------------------------------------
{
  const d = decideShortAckTurnEnd(nothingOwed());
  check("thanks_with_nothing_owed_ends_the_turn", d.end, true);
  check("thanks_with_nothing_owed_sends_the_closer", d.closerText, COURTESY_CLOSER_TEXT);
}
{
  // The 68% majority behaviour is unchanged: a plain ack still gets silence.
  const d = decideShortAckTurnEnd(nothingOwed({ ackText: "Ok" }));
  check("plain_ack_still_ends_the_turn", d.end, true);
  check("plain_ack_stays_silent", d.closerText, undefined);
}
for (const t of ["Sounds good", "👍", "Ok cool", "Will do", ""]) {
  check(`no_closer_for::${t || "(empty)"}`, decideShortAckTurnEnd(nothingOwed({ ackText: t })).closerText, undefined);
}
for (const t of ["Thanks!", "Thank you", "Ok thanks", "thank u", "Much appreciated", "Appreciate it"]) {
  check(`closer_for::${t}`, decideShortAckTurnEnd(nothingOwed({ ackText: t })).closerText, COURTESY_CLOSER_TEXT);
}

// --- 2. THE LOAD-BEARING PROPERTY: it can only replace silence ---------------------------------
// Each case below is a turn where we DO owe the customer something. Every one must continue to a
// real reply and carry no closer — a "You're welcome!" here is a lead being dropped politely.
const OWED: Array<[string, Partial<ShortAckTurnEndInput>]> = [
  ["our_last_message_asked_a_question", { lastOutboundAskedQuestion: true }],
  ["a_slot_is_pending", { hasPendingSlot: true }],
  ["a_watch_is_pending", { hasPendingWatch: true }],
  ["a_reschedule_is_pending", { hasReschedulePending: true }],
  ["the_parser_read_an_acceptance", { acceptedPendingOffer: true }]
];
for (const [name, over] of OWED) {
  const d = decideShortAckTurnEnd(nothingOwed({ ...over, ackText: "Thanks!" }));
  check(`turn_continues_when::${name}`, d.end, false);
  check(`no_closer_when::${name}`, d.closerText, undefined);
}

// --- 3. Deliberately narrow edges --------------------------------------------------------------
check("non_twilio_never_closes", decideShortAckTurnEnd(nothingOwed({ provider: "sendgrid" })).closerText, undefined);
// scheduling_blocked is a DIFFERENT quiet state (we could not offer a time); it keeps plain silence.
check(
  "scheduling_blocked_keeps_plain_silence",
  decideShortAckTurnEnd(nothingOwed({ schedulingBlocked: true })).closerText,
  undefined
);
// A question is never a sign-off, whatever courtesy it carries.
check("thanks_with_a_question_is_not_a_signoff", isExplicitThanksText("Thanks, what time do you close?"), false);
// An ack-only close turn is the other silent branch, and it earns a closer on the same terms.
check(
  "ack_only_close_turn_can_close_warmly",
  decideShortAckTurnEnd(nothingOwed({ ackOnlyCloseTurn: true, shortAck: false })).closerText,
  COURTESY_CLOSER_TEXT
);

// --- 4. The copy, and the grader exemption ------------------------------------------------------
check("closer_never_asks_anything", /\?/.test(COURTESY_CLOSER_TEXT), false);
check("closer_is_one_short_line", COURTESY_CLOSER_TEXT.length <= 40 && !COURTESY_CLOSER_TEXT.includes("\n"), true);
check("graders_can_recognise_it", isCourtesyCloserText(COURTESY_CLOSER_TEXT), true);
check("graders_do_not_exempt_an_ordinary_reply", isCourtesyCloserText("Want me to set a time for Saturday?"), false);

// --- 5. WIRING. The arm is inert unless the live path actually sends what the referee returned. --
const apiIndex = fs.readFileSync(path.join(process.cwd(), "services/api/src/index.ts"), "utf8");
check(
  "live_path_passes_the_customers_words_to_the_referee",
  apiIndex.includes("ackText: String(event.body ?? \"\")"),
  true
);
check(
  "live_path_sends_the_closer_instead_of_empty_twiml",
  apiIndex.includes("shortAckTurnEnd.closerText ? publishLiveTwilioReply(shortAckTurnEnd.closerText"),
  true
);
check("the_send_is_still_logged_with_a_reason", apiIndex.includes("closer: !!shortAckTurnEnd.closerText"), true);

console.log(`\nAll ${checks} courtesy-closer checks passed.`);
