/**
 * "Awesome" is a courtesy word, and it must stay one WITHOUT widening the reply gate.
 *
 * Joe, 2026-08-13, on Christopher +17169400722: "Why did this create a task when the customer just
 * said awesome?" — the human-mode re-engagement backstop minted a `needs YOUR reply` task for the
 * owner off a bare "Awesome ", because ACK_TOKENS carries `great` and `perfect` but not `awesome`.
 *
 * This eval pins BOTH halves of the fix, because the second half is the one that can rot:
 *   1. a bare "Awesome" now reads as an acknowledgement (isBareAcknowledgementText), and
 *   2. `isShortAckText` — the WIDE gate read at eighteen decision points in index.ts, several of
 *      which decide whether we reply at all — is UNCHANGED by it. If somebody later "simplifies"
 *      this by moving `awesome` into ACK_TOKENS, check 2 goes red, and it should: that would
 *      silence "Awesome I'll be there at 3".
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import {
  isBareAcknowledgementText,
  isEmojiOnlyText,
  isShortAckText
} from "../services/api/src/domain/bareAcknowledgement.ts";

let checks = 0;
function check(id: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} ${id} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  assert.equal(ok, true, `${id} failed`);
  checks += 1;
}

// ---------------------------------------------------------------------------
// 1. The reported turn, verbatim from the live store (+17169400722, 2026-08-13).
// ---------------------------------------------------------------------------
check("reported_turn_reads_as_bare", isBareAcknowledgementText("Awesome "), true);
check("awesome_alone_is_bare", isBareAcknowledgementText("Awesome"), true);
check("awesome_with_a_reaction_is_bare", isBareAcknowledgementText("Awesome \u{1F44D}"), true);

// The other two tokens, both measured on the live store as courtesy-only turns.
check("thank_u_spelling_is_bare", isBareAcknowledgementText("Awesome thank u"), true);
check("ur_welcome_is_bare", isBareAcknowledgementText("ur welcome"), true);

// ---------------------------------------------------------------------------
// 2. Content after the courtesy word still surfaces. These are the turns a token
//    added to ACK_TOKENS would have silenced — "Awesome let's do it" is real, it is
//    in the corpus (2026-07-14), and it is a customer committing.
// ---------------------------------------------------------------------------
check("awesome_plus_commitment_is_not_bare", isBareAcknowledgementText("Awesome let's do it"), false);
check("awesome_plus_a_time_is_not_bare", isBareAcknowledgementText("Awesome I'll be there at 3"), false);
check("awesome_as_a_compliment_is_not_bare", isBareAcknowledgementText("This bike is awesome"), false);
check("awesome_with_a_question_is_not_bare", isBareAcknowledgementText("Awesome, when can I pick it up?"), false);

// ---------------------------------------------------------------------------
// 3. THE INVARIANT THAT MATTERS: the wide gate did not move. isShortAckText feeds
//    eighteen sites in index.ts, several of which decide whether we reply at all.
// ---------------------------------------------------------------------------
check("wide_gate_unchanged_for_awesome", isShortAckText("Awesome"), false);
check("wide_gate_unchanged_for_awesome_commitment", isShortAckText("Awesome let's do it"), false);
check("wide_gate_unchanged_for_thank_u", isShortAckText("thank u"), false);

// The pre-existing behaviour of both predicates is untouched.
check("great_still_short_ack", isShortAckText("Great"), true);
check("ok_thanks_still_bare", isBareAcknowledgementText("Ok thanks"), true);
check("stepping_back_is_not_bare", isBareAcknowledgementText("Found a better offer. Thanks"), false);
check("day_and_daypart_is_not_bare", isBareAcknowledgementText("Ok. Friday. Afternoon"), false);
check("emoji_only_is_bare", isEmojiOnlyText("\u{1F44D}"), true);

// ---------------------------------------------------------------------------
// 4. WIRING. The human-mode backstop must read the narrow predicate — the fix is
//    inert if index.ts still gates that task on the wide one alone.
// ---------------------------------------------------------------------------
const indexSrc = fs.readFileSync(path.join(process.cwd(), "services/api/src/index.ts"), "utf8");
check(
  "human_mode_gate_reads_the_narrow_predicate",
  indexSrc.includes(
    "const humanModeShortAck = isShortAckText(humanModeText) || isEmojiOnlyText(humanModeText) || humanModeDispositionShortAck;"
  ),
  true
);
// One bare-ack call site, reused — a second call is the inline-duplicate pattern
// bare_acknowledgement_disposition:eval forbids.
check("one_bare_ack_gate_site", indexSrc.split("isBareAcknowledgementText(").length - 1, 1);
check(
  "reply_needed_task_gated_on_the_bare_reading",
  indexSrc.includes("!humanModeDispositionShortAck &&") && indexSrc.includes("needs YOUR reply."),
  true
);

// ---------------------------------------------------------------------------
// 5. THE OWNER'S SIDE OF THE SAME PREDICATE (Joe ruled 2026-08-13, "build it").
//    On a thread a rep has taken over, the `needs YOUR reply` task is now skipped
//    for BARE turns only. These are the real turns the wide predicate used to
//    swallow — 39 of them in 44 days on the live store — and each one is a rep
//    being told nothing at all about a message that carried something.
// ---------------------------------------------------------------------------
const SURFACES = [
  "Ok. Friday. Afternoon", // a day + a day-part: a soft commitment
  "Found a better offer. Thanks", // a lost sale (+13105956498)
  "Oh okay I get out at 3 joe I should be able to stop today",
  "Joe, theirs 62,500 miles on it. Thanks", // an appraisal fact we asked for
  "Ok. I will stop by when it arrives. Thanks.",
  "Okay sounds good I will get that all together",
  "Thanks Scott. Ill try and sneak in"
];
for (const turn of SURFACES) {
  // Both halves matter: the wide predicate DOES swallow it (which is the bug), and the bare
  // predicate does not (which is why the owner now hears about it).
  check(`wide_predicate_would_have_hidden::${turn.slice(0, 28)}`, isShortAckText(turn), true);
  check(`owner_is_told::${turn.slice(0, 28)}`, isBareAcknowledgementText(turn), false);
}

// ...and the courtesy-only turns stay silent, which is the whole point of keeping a gate at all.
for (const turn of ["Ok thanks", "Awesome", "Thanks!", "\u{1F44D}", "sounds good", "Will do"]) {
  check(`owner_is_not_told::${turn}`, isBareAcknowledgementText(turn), true);
}

console.log(`\nAll ${checks} bare-ack courtesy checks passed.`);
