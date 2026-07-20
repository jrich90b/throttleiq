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

import { isParserSoftVisitCommitment } from "../services/api/src/domain/softVisitSignal.ts";

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

// 2) Both-path wiring (route parity) + warm visit-ack — source guards.
const idx = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
// live: parser signal OR'd into the soft-visit gate.
assert.ok(
  /softVisitCommitment\b[\s\S]{0,140}isParserSoftVisitCommitment\(appointmentTimingParse\)/.test(idx),
  "live path must OR the parser soft-visit signal into the soft-visit gate"
);
// regen: a REACHABLE soft-visit branch on the parser signal (NOT nested in the kind-gated
// tentative block, which intent:none never enters).
assert.ok(
  /event\.provider === "twilio" && isParserSoftVisitCommitment\(regenAppointmentTimingParse\)/.test(idx),
  "regen path must have a reachable soft-visit branch on the parser signal (parity)"
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

console.log("PASS soft-visit-commitment eval (parser signal + warm ack + both-path parity + dated-task/all-set guards)");
