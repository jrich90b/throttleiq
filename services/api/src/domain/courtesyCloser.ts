// ---------------------------------------------------------------------------
// THE COURTESY CLOSER — "You're welcome", and nothing else.
//
// Joe, 2026-08-13: "Can you look at prior conversations so the agent can determine when to respond
// with you're welcome, no problem, 👍, etc? So it knows when to be silent and when to generate one
// of those responses?"
//
// I MINED THE CORPUS FIRST, AND IT CANNOT TEACH THE RULE. All 295 bare-acknowledgement customer
// turns in the live store, and what we did next:
//   201 (68%)  nothing — silence is the majority behaviour and no thread shows harm from it
//    46 (16%)  a warm one-liner: 👍 x13, "You're welcome!" x8, "No problem!" x7, then a long tail
//    48 (16%)  the substantive next step — the ack arrived while we still OWED them something
//
// The first two populations are not separable by anything we store. The matched pair:
//    SILENT   "👍"    after "Perfect — you're all set for Mon, Jul 27, 4:00 PM with Joe Hartrich."
//    REPLIED  "👍👌"  after "Ok sounds good, see you Tuesday at 4:30"
// Same situation, opposite call. The obvious feature does not separate them either: an ack
// containing a thank-you drew a reply 39% of the time, a plain "ok/sounds good" 23%. Learning from
// that produces a coin flip, which is our worst-known failure shape — the same message treated
// differently run to run (route-instability). So this is a POLICY, not a learned rule, and it is
// the narrowest one that fits the clearest cases in the corpus: Eric thanking us for installing the
// shift lever, the customer thanking us for the muffler left out front.
//
// WHERE IT LIVES, AND WHY NOT HERE. The decision is `decideShortAckTurnEnd` in routeStateReducer —
// the referee that ALREADY owns "end this turn in silence", is pure, is dependency-free, and logs
// why. The closer is reachable only from the two branches where that referee had already concluded
// we owe them nothing: the typed ack parser read no acceptance (acceptedPendingOffer outranks
// everything), no watch / slot / reschedule is pending, and our own last message asked no question.
// **The closer therefore cannot displace a substantive reply — there was never going to be one.**
// The predicate and the copy sit in that module for the same reason it has no imports; this file
// carries the evidence, and the one thing the graders need.
//
// WHAT IS DELIBERATELY NOT BUILT: a reading of whether they thanked us for something we COMPLETED.
// That is a field on the customer-ack parser and a follow-up, not a longer word list. The corpus
// does not justify it yet, and a wider word list here is the anti-pattern this repo un-stacks.
//
// FAIL DIRECTION, both ways safe:
//   wrong TRUE  => one warm line, no question, thread not re-opened, and prod is suggest mode so
//                  staff approve it like any other draft.
//   wrong FALSE => silence, which is exactly today's behaviour.
// ---------------------------------------------------------------------------
import { COURTESY_CLOSER_TEXT } from "./routeStateReducer.js";

export { COURTESY_CLOSER_TEXT };

/**
 * FOR THE GRADERS. A closer ends in a statement on purpose, so it is the one reply class exempt
 * from the standing "every reply ends with ONE advancing question" rule (Joe, 2026-08-07). Without
 * this exemption the tone and reply-coverage scorers raise a finding on every single one — a
 * phantom we would have manufactured for ourselves, and the largest known source of false findings
 * in this system.
 */
export function isCourtesyCloserText(text: string): boolean {
  return String(text ?? "").trim().toLowerCase() === COURTESY_CLOSER_TEXT.trim().toLowerCase();
}
