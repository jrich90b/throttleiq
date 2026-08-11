/**
 * Room58 asks them in instead of waiting (Joe, 2026-08-11: *"ask them in straight away"*).
 *
 * MEASURED on `Room58 - Request details` before building — 71 leads, our most engaged lane:
 *   **69% reply, 7% book.**
 *   **100% name a bike**; 33 of 71 also carry a stock# or VIN.
 *   **38 of 71 (54%) type NO message at all** — they clicked a button on a bike page. There is
 *     nothing to answer for over half the lane, which is why Joe's call was to spend the first touch
 *     on the visit rather than on a qualifying question.
 *   Of the 17 who asked about PRICE, **one got a number and eleven got "I'll confirm and send it
 *     over."** A ladder cannot fix that; it can only stop the deferral being the whole message.
 *
 * The old copy waited — *"if you'd like to stop in and check it out, just let me know"* — and the
 * Request-details variant then asked *"any specific questions I can answer?"*, a second question
 * aimed at more conversation rather than at a visit.
 *
 * This asserts the SHAPE of the first touch (asks, soft on timing, one question) and that the
 * answer-them-first rule reaches this lane, which is the other half of Joe's instruction: *"if the
 * customer responds with questions the agent needs to know how to handle this in the ladder."*
 *
 * Run: npx tsx scripts/room58_ask_them_in_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.resolve("services/api/src/routes/sendgridInbound.ts"), "utf8");

// --- the first touch ASKS -------------------------------------------------------------------
assert.ok(
  src.includes("Want to stop in and check it out?"),
  "the purchase-intent first touch asks them in"
);
// Joe was specific (2026-08-11): ask about the VISIT, not about arranging one. "Let me know if you
// want to stop in" is the shape he ruled out, and "want to set up a time to" is a step removed from
// the thing itself. Direct only works because the bike is KNOWN — the no-bike branch still asks which.
assert.ok(
  !src.includes("Want to set up a time to come see it?"),
  "the indirect 'set up a time to' phrasing is not used where the bike is known"
);
// The passive originals must not creep back.
assert.ok(
  !src.includes("If you’d like to stop in and check it out, just let me know."),
  "the passive 'just let me know' invitation is gone"
);
assert.ok(
  !src.includes("Any specific questions I can answer?"),
  "the competing second question is gone — one question per message"
);
assert.ok(
  !src.includes("Any specific questions about the bike?"),
  "…and so is its twin on the not-in-stock branch"
);

// --- SOFT on timing: no day, no clock time on the first touch --------------------------------
// Pull every line that carries the new ask and check each one.
const askLines = src.split("\n").filter(l => l.includes("Want to stop in and check it out?"));
assert.ok(askLines.length >= 2, "both purchase-intent branches ask (in-stock and learn-more)");
for (const line of askLines) {
  assert.ok(
    !/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|this week|weekend)\b/i.test(line),
    `no DAY on the first touch: ${line.trim().slice(0, 80)}`
  );
  assert.ok(!/\d\s*(am|pm)|\d:\d\d/i.test(line), `no clock TIME on the first touch: ${line.trim().slice(0, 80)}`);
}

// --- we never invite someone to see a bike we cannot name ------------------------------------
assert.ok(
  src.includes('"Thanks — I got your inquiry. Which bike are you asking about?"'),
  "with no identifiable bike, asking WHICH bike still outranks the invitation"
);

// --- the other half of Joe's instruction: they may answer with a QUESTION ---------------------
async function main(): Promise<void> {
  const { buildChannelRules } = await import("../services/api/src/domain/draftChannelRules.ts");
  process.env.DRAFT_ADVANCE_EVERY_REPLY = "1";
  // Room58 carries no lane goal — it is exactly the case that used to miss this rule.
  const rules = buildChannelRules({ channel: "sms", history: [] } as any);
  assert.ok(
    /ANSWER WHAT THEY ACTUALLY SAID FIRST/i.test(rules),
    "a Room58 follow-up answers the customer's question first"
  );
  assert.ok(
    /say so plainly/i.test(rules),
    "and when we do NOT have the answer — the common case on price — it says so plainly"
  );
  assert.ok(
    /NEVER ask a question you have already asked/i.test(rules),
    "and it does not re-ask them in using the same sentence"
  );
  console.log("PASS room58 ask-them-in — the first touch asks, stays loose on timing, and their questions still come first.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
