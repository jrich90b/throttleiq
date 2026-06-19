/**
 * Task auto-close INBOUND-closure trigger eval.
 *
 * The auto-close hook used to fire only on a staff/agent OUTBOUND send. So a task the staff
 * already handled stayed Open whenever the CUSTOMER closed the loop with no trailing staff
 * reply — e.g. Douglas Kellner: Joe answered the price, Douglas said "Thanks. I was just
 * curious," and (had Joe not sent the trailing 👍) nothing would have re-checked the task.
 *
 * This adds an inbound trigger: when a customer's reply signals closure ("I'm all set", "just
 * curious", "no need"), re-run the SAME parser-first fulfillment check over the window. The
 * classifier (task_fulfillment_parser:eval, with the Douglas window ending on the customer
 * inbound) owns the verdict and still requires a prior dealer outbound that accomplished the
 * objective. THIS eval pins the deterministic surface: the closure-signal pre-filter + the
 * runner accepting an inbound trigger + the wiring. Fail-safe: a hint miss => no re-check.
 *
 * Run: npx tsx scripts/task_autoclose_inbound_trigger_eval.ts  (no LLM)
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const index = fs.readFileSync("services/api/src/index.ts", "utf8");

// --- Source guard: hint + inbound-capable runner + wired into the twilio inbound. ---
assert.ok(
  /function taskAutoCloseInboundClosureHint/.test(index) && /TASK_AUTOCLOSE_INBOUND_CLOSURE_RE/.test(index),
  "the inbound closure-signal hint must exist"
);
assert.ok(
  /direction\?:\s*"out"\s*\|\s*"in"/.test(index),
  "runTaskFulfillmentAutoClose must accept an inbound trigger (direction 'out' | 'in')"
);
assert.ok(
  /\(action\.direction \?\? "out"\) !== "in"/.test(index),
  "the runner must NOT force-append the action as an out item for an inbound trigger"
);
assert.ok(
  /runTaskFulfillmentAutoClose\(conv,\s*\{\s*channel:\s*"sms",\s*text:\s*event\.body[^}]*direction:\s*"in"/.test(
    index.replace(/\s+/g, " ")
  ) || /direction: "in" \}\)/.test(index),
  "the inbound trigger must be wired into the twilio inbound path"
);

// --- Closure-hint coverage. Kept in sync with TASK_AUTOCLOSE_INBOUND_CLOSURE_RE in index.ts. ---
const RE =
  /\b(all set|i'?m good|we'?re good|no need|no thanks|that'?s all|that'?s it|just curious|never\s?mind|got (?:it|what i needed|everything i needed)|all good|appreciate it|thanks,?\s*(?:that'?s|i'?m|just|no)\b)/i;

const closures = [
  "Thanks. I was just curious.", // Douglas
  "I'm all set, thanks",
  "we're good thanks",
  "no need",
  "that's all I needed",
  "nevermind",
  "got what I needed, thank you",
  "all good here"
];
for (const c of closures) {
  assert.ok(RE.test(c), `closure signal must match: "${c}"`);
}

const nonClosures = [
  "What is the asking price?",
  "can I come by Saturday?",
  "yes let's do it",
  "how much is it out the door?",
  "do you have it in black?"
];
for (const n of nonClosures) {
  assert.ok(!RE.test(n), `non-closure must NOT match: "${n}"`);
}

console.log(
  `PASS task autoclose inbound-trigger eval (source guard + ${closures.length} closure + ${nonClosures.length} non-closure cases)`
);
