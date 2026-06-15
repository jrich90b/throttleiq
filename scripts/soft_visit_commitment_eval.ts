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

// 2) Both-path wiring (route parity) — live + regen gates both route on the parser signal.
const idx = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
assert.ok(
  /softVisitCommitment\b[\s\S]{0,140}isParserSoftVisitCommitment\(appointmentTimingParse\)/.test(idx),
  "live path must OR the parser soft-visit signal into the soft-visit gate"
);
assert.ok(
  /regenAppointmentTimingIntent === "tentative_time_window"[\s\S]{0,90}isParserSoftVisitCommitment\(regenAppointmentTimingParse\)/.test(idx),
  "regen path must also route on the parser soft-visit signal (parity)"
);

console.log("PASS soft-visit-commitment eval (parser signal + both-path parity)");
