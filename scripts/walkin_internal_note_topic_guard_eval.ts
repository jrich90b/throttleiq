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
import { isInternalNoteFollowUpTopic } from "../services/api/src/domain/walkInFollowUpTopic.ts";

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

console.log("PASS walk-in internal-note follow-up topic guard eval");
