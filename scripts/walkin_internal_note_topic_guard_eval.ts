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

console.log("PASS walk-in internal-note follow-up topic guard eval (+ slot-only spec recap)");
