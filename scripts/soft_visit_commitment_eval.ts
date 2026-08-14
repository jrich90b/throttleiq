/**
 * soft_visit_commitment:eval — pins isParserSoftVisitCommitment (parser-driven soft-visit
 * detection) + both-path wiring. Origin: Todd Herian Ref 11438 ("Ok I will be there for the
 * taste of country pre party on Saturday 👍"). The legacy `detectSoftVisitIntent` regex
 * missed the weekday/event commitment, so the soft-visit cadence window never fired and the
 * lead was on a generic cadence. Now parser-driven (the appointment-timing parser already
 * reads it as intent:none + a committed day), applied in BOTH /webhooks/twilio + regenerate.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  hasConditionalVisitCommitmentHintText,
  isParserConditionalVisitCommitment,
  isParserSoftVisitCommitment,
  isParserTimedVisitCommitment
} from "../services/api/src/domain/softVisitSignal.ts";

// 1) Behavioral — the parser-derived signal.
const todd: any = {
  intent: "none",
  explicitRequest: false,
  requested: { day: "saturday", timeText: "", timeWindow: "unknown" },
  normalizedText: "committing to a saturday event visit",
  confidence: 0.92
};
assert.equal(isParserSoftVisitCommitment(todd), true, "Todd's soft visit commitment => true");
// a different committed-day phrasing (no ordinal date) still fires
assert.equal(
  isParserSoftVisitCommitment({ intent: "none", explicitRequest: false, requested: { day: "friday" }, normalizedText: "plans to stop by friday" }),
  true,
  "weekday stop-by commitment => true"
);

// Casual ride/drive/deal-framed day commitments the parser now tags intent:none + day but
// whose normalizedText the legacy verb list missed (Jessica Ornce / William Indelicato,
// 2026-07-11 confirm-committed-day cluster). Broadened verb list must fire on these.
const casualCommits: Array<[string, string]> = [
  ["riding up there in the morning tomorrow", "riding up (Jessica)"],
  ["coming in tomorrow to make the deal", "coming in to make the deal (William)"],
  ["swing in on saturday for lien release", "swing in (Jeff)"],
  ["heading up friday to sign the paperwork", "heading up to sign"],
  ["driving up saturday to pick it up", "driving up to pick up"],
  ["will make it in monday", "make it in"]
];
for (const [nt, label] of casualCommits) {
  assert.equal(
    isParserSoftVisitCommitment({ intent: "none", explicitRequest: false, requested: { day: "tomorrow" }, normalizedText: nt }),
    true,
    `casual day commitment => true: ${label}`
  );
}

// Day-only "see you {day}" commitments (Joe ruling 2026-07-19, Peter Meredith +17168303999:
// "Sounds good see you Monday" fell through every recognizer and drew the "I'll check that
// time and follow up" deflection). The parser's normalizedText is often VERBATIM for these,
// so the verb list must catch the literal phrasing, not just paraphrases.
const dayOnlyCommits: Array<[string, string]> = [
  ["sounds good see you monday", "Peter's exact turn (verbatim normalizedText)"],
  ["see you monday", "bare see-you"],
  ["see ya saturday", "casual see-ya"],
  ["be back friday to finish the paperwork", "be back"]
];
for (const [nt, label] of dayOnlyCommits) {
  assert.equal(
    isParserSoftVisitCommitment({ intent: "none", explicitRequest: false, requested: { day: "monday" }, normalizedText: nt }),
    true,
    `day-only commitment => true: ${label}`
  );
}

const fails: Array<[any, string]> = [
  // Broadened verb list must NOT match finance/off-topic phrasings that happen to share a verb.
  [{ intent: "none", explicitRequest: false, requested: { day: "friday" }, normalizedText: "worried about coming up short on the down payment friday" }, "come up short (finance, not a visit)"],
  [{ intent: "none", explicitRequest: false, requested: { day: "saturday" }, normalizedText: "running low on cash before saturday" }, "running low (not a visit)"],
  [{ intent: "none", explicitRequest: false, requested: { day: "saturday" }, normalizedText: "rode the bike hard on saturday" }, "rode on saturday (past ride, not a visit)"],
  [null, "null"],
  [undefined, "undefined"],
  [{ intent: "accept_proposed_time", explicitRequest: true, requested: { day: "saturday" }, normalizedText: "accepting saturday visit" }, "actionable booking intent"],
  [{ intent: "decline_time", explicitRequest: false, requested: { day: "saturday" }, normalizedText: "can't make the saturday visit" }, "decline has its own arm"],
  [{ intent: "tentative_time_window", explicitRequest: false, requested: { day: "saturday" }, normalizedText: "might visit saturday" }, "tentative has its own arm"],
  [{ intent: "none", explicitRequest: true, requested: { day: "saturday" }, normalizedText: "commit to visit saturday" }, "explicit request is actionable"],
  [{ intent: "none", explicitRequest: false, requested: { day: "" }, normalizedText: "i'll commit and visit" }, "no committed day"],
  [{ intent: "none", explicitRequest: false, requested: { day: "saturday" }, normalizedText: "asking whats open saturday" }, "day mention without commit/visit wording"]
];
for (const [p, label] of fails) {
  assert.equal(isParserSoftVisitCommitment(p), false, `must be false: ${label}`);
}

// 1b) CONDITIONAL (day-less) visit commitments (Michael Siejka +17169906333, 2026-06-25:
// "Beautiful thank you so much, currently cleaning the carbs on my bike but once she's back
// on the road i'll be in."). The appointment-timing parser reads intent:none + NO day +
// a commitment normalizedText; the day-anchored signal can't fire, so the turn used to fall
// through to the generic orchestrator (corpus replay judge: photo-appreciation improvisation
// instead of a visit ack). Both observed normalizedText shapes from the production parse are
// pinned (the parser paraphrases some runs and stays verbatim on others).
const conditionalCommits: Array<[string, string]> = [
  ["will come in once bike is back on the road", "Michael's turn (paraphrased parse)"],
  ["once she's back on the road i'll be in", "Michael's turn (verbatim parse)"],
  ["will stop by when the loan comes through", "loan-conditioned stop-by"],
  ["coming in as soon as work slows down", "work-conditioned come-in"]
];
for (const [nt, label] of conditionalCommits) {
  assert.equal(
    isParserConditionalVisitCommitment({
      intent: "none",
      explicitRequest: false,
      requested: { day: "", timeText: "", timeWindow: "unknown" },
      normalizedText: nt
    }),
    true,
    `conditional day-less commitment => true: ${label}`
  );
}
const conditionalFails: Array<[any, string]> = [
  // A day-anchored commitment belongs to isParserSoftVisitCommitment, never this signal.
  [{ intent: "none", explicitRequest: false, requested: { day: "saturday" }, normalizedText: "will come in once the check clears saturday" }, "day present => day-anchored signal owns it"],
  // A contact deferral is NOT a visit ("I'll be in touch when I decide").
  [{ intent: "none", explicitRequest: false, requested: { day: "" }, normalizedText: "will be in touch when they decide" }, "be-in-touch deferral is not a visit"],
  // No conditional marker => too vague to claim (today's behavior stands).
  [{ intent: "none", explicitRequest: false, requested: { day: "" }, normalizedText: "i'll commit and visit" }, "no conditional marker"],
  // No visit verb => a plain first-person deferral keeps its own handling.
  [{ intent: "none", explicitRequest: false, requested: { day: "" }, normalizedText: "will let us know when he is ready" }, "no visit verb"],
  [{ intent: "tentative_time_window", explicitRequest: false, requested: { day: "" }, normalizedText: "might come in when the rain stops" }, "tentative has its own arm"],
  [{ intent: "none", explicitRequest: true, requested: { day: "" }, normalizedText: "wants to come in once approved" }, "explicit request is actionable"],
  [null, "null"],
  [undefined, "undefined"]
];
for (const [p, label] of conditionalFails) {
  assert.equal(isParserConditionalVisitCommitment(p), false, `conditional must be false: ${label}`);
}
// 1c) The HINT gate must consult the parser on the raw production turn — the
// appointment-timing parser is hint-gated in both paths and Michael's turn matched NONE of
// the pre-existing hint tokens ("be in" is not "be there"), so without this the signal
// above is unreachable in production.
assert.equal(
  hasConditionalVisitCommitmentHintText(
    "Beautiful thank you so much,currently cleaning the carbs on my bike but once she's back on the road i'll be in."
  ),
  true,
  "hint gate must fire on Michael's raw production turn"
);
assert.equal(
  hasConditionalVisitCommitmentHintText("I'll come by as soon as the loan clears"),
  true,
  "hint gate fires on loan-conditioned come-by"
);
for (const [t, label] of [
  ["I'll be in touch when I decide", "be-in-touch deferral"],
  ["Thanks so much!", "plain thanks (no commitment shape)"],
  ["I'll be in tomorrow at 3", "day/time commitment (no conditional marker; the existing day/time hint tokens own it)"],
  ["when does the service department open?", "hours question with 'when' but no visit commitment"]
] as Array<[string, string]>) {
  assert.equal(hasConditionalVisitCommitmentHintText(t), false, `hint must be false: ${label}`);
}

// The be-in-touch exclusion must not have narrowed the day-anchored signal's "be in" verb.
assert.equal(
  isParserSoftVisitCommitment({ intent: "none", explicitRequest: false, requested: { day: "monday" }, normalizedText: "will be in monday" }),
  true,
  "day-anchored 'be in {day}' still fires after the be-in-touch exclusion"
);

// 2) Both-path wiring (route parity) + warm visit-ack — source guards.
const idx = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
// UPDATED 2026-08-14: both paths now reach the parser signal through the SHARED referee
// (resolveSoftVisitTurn -> resolveSoftVisitCommitment), not through two hand-mirrored inline
// expressions. These two guards used to pin the inline shapes and were RIGHT to fire when it
// changed; the INTENT is unchanged and now stated more strongly — each path must hand ITS OWN
// appointment-timing parse to the one referee. See soft_visit_precedence:eval for the table.
assert.ok(
  /resolveSoftVisitTurn\(\{[\s\S]{0,240}parse: appointmentTimingParse\b/.test(idx),
  "live path must hand its appointment-timing parse to the shared soft-visit referee"
);
assert.ok(
  /resolveSoftVisitTurn\(\{[\s\S]{0,240}parse: regenAppointmentTimingParse\b/.test(idx),
  "regen path must hand its appointment-timing parse to the SAME shared referee (parity)"
);
// warm visit-ack builder exists and BOTH paths build it.
assert.ok(/function buildSoftVisitCommitmentAck\(/.test(idx), "warm visit-ack builder must exist");
const ackUses = (idx.match(/buildSoftVisitCommitmentAck\(conv,/g) || []).length;
assert.ok(ackUses >= 2, `both live + regen must build the warm visit-ack (found ${ackUses})`);
// live short-circuit must be gated on a PURE soft visit so a compound (pricing/availability/
// callback/...) turn is never dropped.
assert.ok(
  /pureSoftVisit\b[\s\S]{0,400}!pricingOrPaymentsIntent[\s\S]{0,400}!callbackRequestedOverride/.test(idx),
  "live warm-ack must be gated on a pure soft visit (no competing intent dropped)"
);

// 2b) CONDITIONAL day-less commitment wiring (Michael Siejka +17169906333) — both paths.
// live: the conditional signal is consumed, watch-guarded (a "when one comes in I'll come
// by" turn keeps its inventory-watch routing), and OR'd into the soft-visit arm.
// UPDATED 2026-08-14 with the referee: the watch guard is now passed IN as `conditionalAllowed`
// and the referee is the single consumer of isParserConditionalVisitCommitment. Same intent —
// a watch-conditioned "when one comes in I'll come by" must keep its inventory-watch routing.
assert.ok(
  /resolveSoftVisitTurn\(\{[\s\S]{0,400}conditionalAllowed:[\s\S]{0,200}semanticWatchAction !== "set_watch"/.test(idx),
  "live path must pass the watch guard to the referee as conditionalAllowed"
);
const softVisitSignalSrc = fs.readFileSync(path.resolve("services/api/src/domain/softVisitSignal.ts"), "utf8");
// COUNT, do not merely match. The guarded expression appears TWICE by design — once in the
// referee (does it arm?) and once in needsVisitCommitmentTiebreak (is a round-trip worth buying?).
// A boolean `.test()` here was satisfied by EITHER copy, so a sabotage that gutted the referee
// passed because the tiebreak gate still carried the string.
const guardedConditional =
  softVisitSignalSrc.split(/conditionalAllowed !== false && isParserConditionalVisitCommitment\(/).length - 1;
assert.equal(
  guardedConditional,
  2,
  `the conditional signal must be consumed behind the watch guard in BOTH the referee and the ` +
    `tiebreak gate (found ${guardedConditional})`
);
assert.ok(
  /softVisitIntent = softVisitCommitment \|\| conditionalSoftVisitCommitment/.test(idx),
  "live soft-visit arm must include the conditional commitment"
);
// regen: the SAME watch guard, handed to the SAME referee (parity). The referee's own consumption
// of isParserConditionalVisitCommitment is asserted once, above, against softVisitSignal.ts.
assert.ok(
  /resolveSoftVisitTurn\(\{[\s\S]{0,400}conditionalAllowed:[\s\S]{0,200}regenSemanticWatchAction !== "set_watch"/.test(idx),
  "regen path must pass its watch guard to the referee as conditionalAllowed (parity)"
);
// BOTH hint gates must consult the parser on the conditional-commitment shape (without
// this the parser never runs on Michael's turn and the whole signal is unreachable).
const hintGateUses = (idx.match(/hasConditionalVisitCommitmentHintText\(event\.body \?\? ""\)/g) || []).length;
assert.ok(hintGateUses >= 2, `both live + regen appointment-timing hint gates must include the conditional hint (found ${hintGateUses})`);
// the no-rush patience ack builder exists and BOTH paths build it.
assert.ok(/function buildConditionalVisitCommitmentAck\(/.test(idx), "conditional visit-ack builder must exist");
const conditionalAckUses = (idx.match(/buildConditionalVisitCommitmentAck\(normalizeDisplayCase\(conv\.lead\?\.firstName\)\)/g) || []).length;
assert.ok(conditionalAckUses >= 2, `both live + regen must build the conditional no-rush ack (found ${conditionalAckUses})`);

// 3) Soft-appointment side effects (Joe ruling 2026-07-19) — source guards, both paths.
// The dated staff task + booked-same-day reflection live in shared helpers so the live and
// regen twins can't drift.
assert.ok(/function addSoftVisitStaffTask\(/.test(idx), "dated soft-visit staff-task helper must exist");
assert.ok(/function buildBookedSameDayAllSetReply\(/.test(idx), "booked-same-day all-set reply helper must exist");
assert.ok(
  /visitDate \? \{ dueAt: visitDate\.toISOString\(\) \} : undefined/.test(idx),
  "the soft-visit staff task must be DATED (dueAt on the visit day) when the day resolves"
);
const taskUses = (idx.match(/addSoftVisitStaffTask\(conv,/g) || []).length;
assert.ok(taskUses >= 6, `all soft-visit/visit-commitment/future-timeframe arms must add the dated staff task (found ${taskUses})`);
const allSetUses = (idx.match(/buildBookedSameDayAllSetReply\(conv,/g) || []).length;
assert.ok(allSetUses >= 4, `all soft-visit/visit-commitment arms must reflect a booked same-day slot (found ${allSetUses})`);
// The day-only signal must feed the centralized scheduling decision in BOTH paths, so a
// day-only commitment routes to visit_commitment instead of the arrival-window deflection.
const dayOnlyFeeds = (idx.match(/dayOnlyVisitCommitment:/g) || []).length;
assert.ok(dayOnlyFeeds >= 2, `both paths must feed dayOnlyVisitCommitment into decideSchedulingTurn (found ${dayOnlyFeeds})`);

// --- TIMED visit commitment: a named time is bookable, not "soft" (Joe ruling 2026-07-28) ---
// Terry Majchrzak +17166091289, 2026-07-27 13:33Z: "I could be there today between 4 and 5".
// He was filed as a loose "might stop by" — warm ack, cadence hold, outcome todo — and never
// reached the calendar. Staff reported it the same morning ("Never made it to the schedule").
const terry: any = {
  intent: "none",
  explicitRequest: false,
  requested: { day: "today", timeText: "between 4 and 5", timeWindow: "range" },
  normalizedText: "could be there today between 4 and 5",
  confidence: 0.9
};
assert.equal(isParserTimedVisitCommitment(terry), true, "Terry named a day AND a time => bookable commitment");
assert.equal(
  isParserSoftVisitCommitment(terry),
  false,
  "…and the DAY-ONLY signal must no longer claim him, or he keeps landing in the soft-visit hold"
);
// The two reads are mutually exclusive by construction — a commitment is day-only or timed.
assert.equal(isParserTimedVisitCommitment(todd), false, "Todd named no time => not the timed arm");
assert.equal(isParserSoftVisitCommitment(todd), true, "…and he stays with the soft-visit arm");
// Every gate the day-only read applies still applies to the timed read.
assert.equal(
  isParserTimedVisitCommitment({ intent: "ask_for_times", explicitRequest: false, requested: { day: "today", timeText: "4" }, normalizedText: "will be there today at 4" }),
  false,
  "an actionable timing intent keeps its own arm"
);
assert.equal(
  isParserTimedVisitCommitment({ intent: "none", explicitRequest: true, requested: { day: "today", timeText: "4" }, normalizedText: "will be there today at 4" }),
  false,
  "an explicit request keeps its own arm"
);
assert.equal(
  isParserTimedVisitCommitment({ intent: "none", explicitRequest: false, requested: { timeText: "4" }, normalizedText: "will be there at 4" }),
  false,
  "no committed day => not this arm"
);
assert.equal(
  isParserTimedVisitCommitment({ intent: "none", explicitRequest: false, requested: { day: "today", timeText: "4" }, normalizedText: "asked what time you close" }),
  false,
  "no visit verb in the parser's own normalizedText => not a commitment at all"
);
assert.equal(isParserTimedVisitCommitment(null), false, "no parse => false");

// Both paths must feed the timed signal into the centralized decision, or live/regen drift.
const timedFeeds = (idx.match(/timedVisitCommitment:/g) || []).length;
assert.ok(timedFeeds >= 2, `both paths must feed timedVisitCommitment into decideSchedulingTurn (found ${timedFeeds})`);

console.log("PASS soft-visit-commitment eval (parser signal + warm ack + both-path parity + dated-task/all-set guards + timed-commitment split)");
