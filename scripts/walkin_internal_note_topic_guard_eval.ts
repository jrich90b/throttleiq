/**
 * Walk-in internal-note follow-up topic guard eval.
 *
 * Pins the fail-safe guard that stops a Traffic Log Pro walk-in ack from parroting an INTERNAL
 * staff-log "Inquiry" back to the customer (+17168638237, 2026-07-22: a generated first-touch draft
 * read "…I'll follow up about his 2018 Heritage that was here for inspection ($8000)"). The guard
 * rejects an extracted follow-up topic that reads like an internal note; the tail then falls back to
 * the generic "Thanks for stopping in today" line (fail-safe).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  isInternalNoteFollowUpTopic,
  buildWalkInSpecRecapClause
} from "../services/api/src/domain/walkInFollowUpTopic.ts";
import { hasAdfFinanceApplicationContext } from "../services/api/src/domain/workflowRegressionGuards.ts";

// The exact production failure topic, and each internal-note tell in isolation → rejected.
assert.equal(
  isInternalNoteFollowUpTopic("his 2018 Heritage that was here for inspection ($8000)"),
  true,
  "the +17168638237 internal appraisal note must be rejected"
);
assert.equal(isInternalNoteFollowUpTopic("his 2018 Heritage"), true, "third-person 'his' about the customer");
assert.equal(isInternalNoteFollowUpTopic("her trade"), true, "third-person 'her' about the customer");
assert.equal(isInternalNoteFollowUpTopic("trade in value of $8000"), true, "a dollar appraisal figure");
assert.equal(isInternalNoteFollowUpTopic("$12,500 offer"), true, "any specific dollar figure");
assert.equal(isInternalNoteFollowUpTopic("gave him the trade-in value"), true, "internal 'gave him' phrasing");
assert.equal(isInternalNoteFollowUpTopic("the bike that was here for inspection"), true, "internal 'here for inspection'");
assert.equal(isInternalNoteFollowUpTopic("the appraisal on the trade"), true, "internal 'appraisal'");

// Legit customer-stated follow-up topics are KEPT — the guard must not over-suppress.
for (const ok of [
  "pricing on the Street Glide",
  "the Road Glide",
  "financing options",
  "a test ride this weekend",
  "the new models",
  "colors and availability"
]) {
  assert.equal(isInternalNoteFollowUpTopic(ok), false, `legit topic kept: ${ok}`);
}
assert.equal(isInternalNoteFollowUpTopic(""), false, "empty → no topic to reject");
assert.equal(isInternalNoteFollowUpTopic(null), false, "null → false");

// Wiring: the Traffic Log Pro topic extractor must actually call the guard (both are in the intake
// path; there is no regen twin — buildTrafficLogProWalkInTail has a single caller).
const sendgrid = fs.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");
assert.ok(
  /isInternalNoteFollowUpTopic\(/.test(sendgrid),
  "extractTrafficLogProFollowUpTopic must call isInternalNoteFollowUpTopic so an internal note can't become the topic"
);

// --- Spec recap: say back what the salesperson wrote down (Joe ruling 2026-07-28) ----------
// Larry Godzich +17164327329, 2026-07-27. Scott's note: "…asking about pre-owned trikes… Is
// looking for 2017-2020 Tri Glide in the $25,000 range (Step 2)". The whole first text back was
// "Thanks for stopping in today - I'll follow up about pre-owned trikes." — the day's only tone
// failure (65, intent_mismatch), fluent and blind to the specifics.
assert.equal(
  buildWalkInSpecRecapClause({ modelLabel: "Tri Glide", yearLabel: "2017-2020", condition: "used" }),
  "Just so I've got it right — you're looking for a pre-owned 2017-2020 Tri Glide.",
  "Larry's logged spec is repeated back to him"
);
assert.equal(
  buildWalkInSpecRecapClause({ modelLabel: "Street Glide", yearLabel: "", condition: "new" }),
  "Just so I've got it right — you're looking for a new Street Glide.",
  "condition alone is enough to be worth confirming"
);
assert.equal(
  buildWalkInSpecRecapClause({ modelLabel: "Road Glide", yearLabel: "2024", condition: null }),
  "Just so I've got it right — you're looking for a 2024 Road Glide.",
  "a single year reads as a year, not a range (formatWatchYearLabel feeds this)"
);
// Nothing to confirm beyond the model the tail already names → stay silent rather than pad.
assert.equal(buildWalkInSpecRecapClause({ modelLabel: "Road Glide" }), "", "model alone adds nothing");
assert.equal(buildWalkInSpecRecapClause({ modelLabel: "", yearLabel: "2017-2020", condition: "used" }), "", "no model => no recap");
assert.equal(buildWalkInSpecRecapClause({}), "", "no slots => no recap");

// THE POINT OF THIS MODULE: the recap is built from parsed SLOTS, never note prose. A budget
// figure is deliberately not a slot it accepts — a dollar amount in a walk-in note is as likely
// to be a trade appraisal as a budget, which is the leak the guard above exists to stop.
for (const clause of [
  buildWalkInSpecRecapClause({ modelLabel: "Heritage", yearLabel: "2018", condition: "used" }),
  buildWalkInSpecRecapClause({ modelLabel: "Tri Glide", yearLabel: "2017-2020", condition: "used" })
]) {
  assert.doesNotMatch(clause, /\$\s?\d/, "a recap never carries a dollar figure");
  assert.doesNotMatch(clause, /\b(?:his|him|her|hers)\b/i, "a recap never carries third-person staff phrasing");
  assert.equal(isInternalNoteFollowUpTopic(clause), false, "a recap must pass the internal-note guard it sits beside");
}

// Wiring: the Traffic Log Pro step tail must actually append the recap.
assert.ok(
  /buildWalkInSpecRecapClause\(\{/.test(sendgrid),
  "the TLP walk-in tail must append the spec recap (Larry Godzich)"
);

// --- A staff note that MENTIONS credit is not a credit-app lead (Brent Marshall, 7/29) --------
// Same principle as everything above: on a Traffic Log Pro payload the Inquiry field is our own
// staff log, so routing may not be read out of its prose. +17169941544 was classified
// finance_prequal/hdfs_coa — payments_handoff, an approval todo, a manual handoff, a stopped
// cadence, and a first draft claiming "Thanks — I received your credit application" — because the
// salesperson's note happened to say "…we would need to redo credit application".
const BRENT_TLP_NOTE =
  "Looking for a 2026 Road Glide in Dark Billiard gray with black motor. Told him we have one " +
  "coming in but not till late August and we would need to redo credit application.";
assert.equal(
  hasAdfFinanceApplicationContext({
    leadSource: "Traffic Log Pro",
    proseTexts: ["Traffic Log Pro", BRENT_TLP_NOTE, BRENT_TLP_NOTE],
    appIdTexts: [BRENT_TLP_NOTE],
    trafficLogPayloadHint: true,
    walkInSignalHint: false
  }),
  false,
  "+17169941544: a TLP staff note that merely mentions a credit application is NOT a credit-app lead"
);
// The other staff-log shapes we see in TLP Inquiry fields must stay clean too.
for (const note of [
  "Customer called asking about FLHD Deadwood availability. I gave him book values and said we would run a credit app if he wants numbers.",
  "Robert came in asking about pre-owned trikes. Told him to prequalify online. (Step 2)",
  "Told her the finance application can wait until she picks a bike."
]) {
  assert.equal(
    hasAdfFinanceApplicationContext({
      leadSource: "Traffic Log Pro",
      proseTexts: ["Traffic Log Pro", note],
      appIdTexts: [note],
      trafficLogPayloadHint: true,
      walkInSignalHint: false
    }),
    false,
    `TLP staff log stays a sales lead: ${note.slice(0, 48)}…`
  );
}

// POSITIVE CONTROLS — every path a REAL application arrives on must still route. These are the
// live shapes: the Source names the credit product, or the TLP payload carries an `App ID:`.
assert.equal(
  hasAdfFinanceApplicationContext({
    leadSource: "HDFS COA Online",
    proseTexts: ["HDFS COA Online", "App ID: 1013958809, Model Year: 2016, Model: Roadster"],
    appIdTexts: ["App ID: 1013958809, Model Year: 2016, Model: Roadster"],
    trafficLogPayloadHint: false,
    walkInSignalHint: false
  }),
  true,
  "+12707344947: an HDFS COA Online lead is still a credit-app lead"
);
assert.equal(
  hasAdfFinanceApplicationContext({
    leadSource: "Marketplace - Rider to Rider Credit App",
    proseTexts: ["Marketplace - Rider to Rider Credit App", "App ID: 101393"],
    appIdTexts: ["App ID: 101393"],
    trafficLogPayloadHint: false,
    walkInSignalHint: false
  }),
  true,
  "+17162658201: a Rider to Rider Credit App lead is still a credit-app lead"
);
assert.equal(
  hasAdfFinanceApplicationContext({
    leadSource: "Traffic Log Pro",
    proseTexts: ["Traffic Log Pro", "App ID: 1013958809"],
    appIdTexts: ["App ID: 1013958809"],
    trafficLogPayloadHint: true,
    walkInSignalHint: false
  }),
  true,
  "a TLP payload with a structured App ID: really did post an application"
);
// A recognized WALK-IN still vetoes the App ID arm — unchanged from the prior contract.
assert.equal(
  hasAdfFinanceApplicationContext({
    leadSource: "Traffic Log Pro",
    proseTexts: ["Traffic Log Pro", "Customer stopped in. App ID: 1013958809"],
    appIdTexts: ["Customer stopped in. App ID: 1013958809"],
    trafficLogPayloadHint: true,
    walkInSignalHint: true
  }),
  false,
  "walkInSignalHint still vetoes the App ID arm"
);
// NON-TLP ADFs are unchanged: there the inquiry text really is the customer talking.
assert.equal(
  hasAdfFinanceApplicationContext({
    leadSource: "Room58 - Request details",
    proseTexts: ["Room58 - Request details", "I filled out a credit application last week, any word?"],
    appIdTexts: ["I filled out a credit application last week, any word?"],
    trafficLogPayloadHint: false,
    walkInSignalHint: false
  }),
  true,
  "a customer's OWN words on a web form still signal finance context"
);
assert.equal(
  hasAdfFinanceApplicationContext({
    leadSource: "Room58 - Request details",
    proseTexts: ["Room58 - Request details", "Do you have any Road Glides in stock?"],
    appIdTexts: ["Do you have any Road Glides in stock?"],
    trafficLogPayloadHint: false,
    walkInSignalHint: false
  }),
  false,
  "an ordinary web inquiry is not a finance lead"
);
assert.equal(hasAdfFinanceApplicationContext({}), false, "no fields → no finance context");

// Wiring: intake must go through the helper, and the old inline prose regex must be gone (that
// regex reading lead.inquiry on a TLP payload IS the defect).
assert.ok(
  /hasAdfFinanceApplicationContext\(\{/.test(sendgrid),
  "adfFinanceContextSignal must be computed by hasAdfFinanceApplicationContext"
);
assert.doesNotMatch(
  sendgrid,
  /credit\\s\*app\(\?:lication\)\?[\s\S]{0,200}\.test\(\s*\[leadSource, lead\.comment/,
  "the inline finance regex over lead.inquiry/comment must not come back"
);

console.log("PASS walk-in internal-note follow-up topic guard eval (+ slot-only spec recap, TLP finance-context guard)");
