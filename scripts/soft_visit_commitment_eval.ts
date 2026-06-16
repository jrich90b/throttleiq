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

const fails: Array<[any, string]> = [
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

console.log("PASS soft-visit-commitment eval (parser signal + warm ack + both-path parity)");
