/**
 * Source-size ratchet (Joe, 2026-08-01).
 *
 * `services/api/src/index.ts` is 71,520 lines and has grown ~2,000 lines/week
 * (46,167 on 5/15 → 64,952 on 7/1 → 71,520 on 8/1). Nothing has ever removed from it.
 *
 * That size is not itself a customer-facing defect, but it is what makes each new defect slower
 * to FIND — the 2026-08-01 finance-declined bug (PR #398) took a timestamp-by-timestamp trace to
 * spot, because several places in that one file write `followUpCadence` and nothing referees them.
 * The dealer-#2 north star ([[north-star-readiness-bar]]) makes engineering velocity a real
 * constraint, so the growth needs a floor under it before it compounds further.
 *
 * This is deliberately a CEILING, not a cleanup. It does not shrink anything and it does not
 * block any feature — it blocks a feature from being bolted onto the pile when a domain module
 * would do. Same mechanism as `twilio_comprehension_debt:eval`, which drove the regex debt to its
 * KEEP-floor: make the number visible, fail the build if it grows, and let it ratchet DOWN only.
 *
 * TO LOWER A CEILING: move code out into `services/api/src/domain/<name>.ts` (198 modules live
 * there today — that is the pattern that is already working), then lower the number here and say
 * what moved.
 *
 * TO RAISE ONE: don't. If a change genuinely cannot fit, that is the signal the code belongs in
 * its own module. Raising the ceiling to land a change defeats the entire guard.
 *
 * FAIL DIRECTION: a file that cannot be read fails CLOSED (the eval errors) rather than passing
 * silently — a ratchet that quietly stops measuring is worse than no ratchet.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

type Ceiling = {
  file: string;
  /** Max lines. RATCHET DOWN ONLY. */
  max: number;
  /** Why this file is watched. */
  note: string;
};

// Ceilings are set at the CURRENT size — this guard is about stopping growth, not forcing a
// cleanup sprint. Headroom is deliberately zero: the next change either fits or moves out.
//
// Re-baselined 2026-08-01 when the day's eight PRs landed together (71,526 -> 71,671 and
// 16,773 -> 16,827). Those were all written BEFORE this ratchet existed, so they could not have
// been asked to respect it; re-baselining to the merged reality is the honest one-time move.
// This is the ONLY legitimate reason to raise a ceiling, and it should never happen twice —
// from here the numbers go DOWN as the un-stack loop pulls code into domain modules.
const CEILINGS: Ceiling[] = [
  {
    file: "services/api/src/index.ts",
    // 71_671 -> 71_667. First ratchet DOWN: the followUpCadence quiet-window un-stacking replaced
    // four copies of the "hush the cadence after we just reached out" block with calls to
    // applyCadenceQuietWindow (conversationStore) / decideCadenceQuietWindow (routeStateReducer).
    // 71_667 -> 71_617. The appointment-teardown un-stacking: five hand-maintained copies of the
    // "un-book this appointment" field list replaced by applyAppointmentTeardown
    // (conversationStore) / decideAppointmentTeardown (routeStateReducer).
    // 71_604 -> 71_576. The manual-outbound cadence-restart un-stacking: two of the three
    // hand-built "does this lead keep its place in the follow-up sequence?" blocks replaced by
    // applyManualCadenceRestart (conversationStore) / decideManualCadenceRestart (routeStateReducer).
    // The cadence-quality judge's input assembly also moved out: the inline "days since the customer
    // last replied" walk is now daysSinceLastCustomerReply (cadenceQualityFacts.ts), alongside the
    // unit facts the judge is graded against.
    // 71_575 -> 71_467. The cadence repeat-similarity math (stop-word list, tokenizer, sentence
    // extraction, overlap score, near-duplicate test) moved to cadenceRepeatSimilarity.ts so the
    // eval could import the code that actually runs instead of a hand-copy that had already
    // drifted from it (ASCII-only apostrophe stripping: 0.8095 in the copy vs 0.7727 shipped).
    // 71_467 -> 71_461. The scheduling-conflict fix paid for its own wiring and then some:
    // buildFriendlyReachOutClose / buildCustomerDispositionReply / ensureUniqueDispositionReply
    // moved to domain/dispositionReply.ts, and the six inbound-reply-action acceptance helpers
    // moved to domain/inboundReplyActionPrompt.ts next to the parser prompt they gate.
    // NOTE: this PR was authored against a 71_576 ceiling and originally proposed 71_570, which
    // would have RAISED the ceiling by 103 lines and silently undone two reductions merged since.
    // Rebased to the real post-merge count instead (the #418 trap, ROUTINE_CONTRACT rule 3).
    // 71_461 -> 71_460. The appointment-confirm companion fields (status/confirmedBy/acknowledged/
    // reschedule latch) moved behind applyAppointmentConfirmRecord (conversationStore), which asks
    // decideAppointmentConfirmRecord — the two booked lanes here now write one call, not four fields.
    // 71_460 -> 71_456. The wrongful-silence judge's trace shaping (which stage, whether to record)
    // moved to domain/noResponseTrace.ts — so widening the judge's coverage to two more silence
    // terminals still came in NET SMALLER than before it.
    // 71_456 -> 71_455. The cadence-REVIVAL un-stacking: the three inline "is this chase dead
    // enough to throw away?" blocks (health-recovery delay, customer deferral, finance no-contact)
    // replaced by applyCadenceRevival (conversationStore) / decideCadenceRevival
    // (routeStateReducer). Small on paper because the fourth copy lived in sendgridInbound.ts,
    // which this ceiling does not cover — that file lost 5 lines of its own.
    // 71_455 -> 71_448. The SOLD-closeout un-stacking: the two hand-maintained copies of "the lead
    // bought — close the thread and settle the unit hold" (the appointment-outcome path and the
    // console's sold button) replaced by applySoldCloseout (conversationStore) / decideSoldCloseout
    // (routeStateReducer), including the five-line hold-match condition each carried inline.
    // Landed at 71_447 after rebasing onto #440/#442.
    max: 71_447,
    note: "the inbound handler + most wiring; the file the de-tangle program exists to shrink"
  },
  {
    file: "services/api/src/domain/llmDraft.ts",
    // 16_827 -> 16_825. The cadence-quality judge's inline "Known lead" prompt block became
    // formatCadenceQualityUnitFacts (cadenceQualityFacts.ts), which also carries the purchase.
    // 16_825 -> 16_723. Two extractions land together here: the conversation-state prompt
    // (conversationStateParserPrompt.ts, #436) and the inbound-reply-action JSON schema + its 23
    // few-shots (domain/inboundReplyActionPrompt.ts), so each prompt surface is editable on its own.
    // 16_723 -> 16_654. Every Anthropic request builder in the repo collapsed into ONE caller
    // (domain/anthropicRequest.ts): the open critic's `requestStructuredJsonAnthropic` wrapper and
    // the draft A/B arm's inline fetch both left this file. That is where the claude-opus-5
    // `temperature` 400 was hiding twice over.
    max: 16_654,
    note: "every parser prompt + JSON schema; second-largest and on the same trajectory"
  }
];

/**
 * Line count matching `wc -l` (newline-terminated lines), so the number here is the same number a
 * human gets from the shell. A naive `split("\n").length` counts the empty string after a trailing
 * newline and reads one HIGHER, which would silently shift every ceiling by one.
 */
function countLines(text: string): number {
  if (!text) return 0;
  const newlines = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

let failures = 0;

for (const ceiling of CEILINGS) {
  const full = path.resolve(ceiling.file);
  // Fail CLOSED: a missing/unreadable file must not silently pass the ratchet.
  assert.ok(fs.existsSync(full), `source-size ratchet: ${ceiling.file} not found (did it move? update the ratchet)`);
  const lines = countLines(fs.readFileSync(full, "utf8"));
  const delta = lines - ceiling.max;
  if (delta > 0) {
    failures += 1;
    console.error(
      `  FAIL ${ceiling.file}: ${lines} lines, ceiling ${ceiling.max} (+${delta}).\n` +
        `       ${ceiling.note}\n` +
        "       Move the new code into services/api/src/domain/<name>.ts and import it here.\n" +
        "       Do NOT raise the ceiling to land this change — that is the one thing this guard exists to stop."
    );
  } else {
    const slack = -delta;
    console.log(`  ok  ${ceiling.file}: ${lines} / ${ceiling.max} lines (${slack} under)`);
    // A file that has shrunk well below its ceiling should ratchet DOWN, or the guard goes slack
    // and stops constraining anything. Loud, not fatal — lowering the number is a human decision.
    if (slack >= 500) {
      console.log(
        `      NOTE: ${ceiling.file} is ${slack} lines under its ceiling — lower \`max\` to ${lines} ` +
          "so the ratchet keeps its grip."
      );
    }
  }
}

if (failures) {
  console.error(`source_size_ratchet:eval FAILED (${failures} file(s) over ceiling)`);
  process.exit(1);
}
console.log(`source_size_ratchet:eval OK (${CEILINGS.length} ceiling(s) held)`);
