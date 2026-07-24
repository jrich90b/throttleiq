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

// --- Broadened gate: also re-check on a substantive reply when an eligible open task + a
// prior dealer outbound exist (close-by-parsing-the-conversation), not only a closure phrase.
// The 0.85 classifier still owns the verdict, so this widens WHEN we look, not the bar. ---
assert.ok(
  /function hasEligibleAutoCloseInboundContext/.test(index) && /isAutoCloseEligibleTask\(/.test(index),
  "the broadened inbound context gate must exist and key on autoclose-eligible tasks"
);
assert.ok(
  /taskAutoCloseInboundClosureHint\(event\.body \?\? ""\) \|\| hasEligibleAutoCloseInboundContext\(conv\)/.test(
    index.replace(/\s+/g, " ")
  ),
  "the twilio inbound trigger must also fire on an eligible-task context, not only a closure phrase"
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
  "do you have it in black?",
  // Substantive resolutions that are NOT closure phrases: these rely on the broadened
  // context gate (eligible task + prior dealer answer) to re-check, not the closure regex.
  "sounds good, see you Saturday",
  "ok I'll take it",
  "perfect, thanks for the price"
];
for (const n of nonClosures) {
  assert.ok(!RE.test(n), `non-closure must NOT match: "${n}"`);
}

// ---------------------------------------------------------------------------
// Joe ruling 2026-07-23 — task follow-through trio, wiring guards.
//
// (1) REPLY-OWED: a "needs YOUR reply" task must close on the first real staff outbound after it
//     was created, deterministically and BEFORE/independent of the LLM fulfillment judge (Curtis
//     +17163812367: the judge said not_fulfilled on a promise-shaped reply and the task sat open).
// (2) MEDIA-ONLY: a picture-only MMS (empty body, numMedia > 0) must be visible to the closer —
//     both as a trigger and inside the activity window it hands the classifier (+18728882220).
// ---------------------------------------------------------------------------
const flat = index.replace(/\s+/g, " ");

assert.ok(
  /function closeReplyOwedTasksOnStaffOutbound/.test(index) && /decideReplyOwedTaskClose\(/.test(index),
  "the deterministic reply-owed closer must exist and use the pure decider"
);
assert.ok(
  /const replyOwedClosed = isOutboundTrigger && actionText \? closeReplyOwedTasksOnStaffOutbound\(conv, Date\.now\(\)\) : \[\];/.test(
    flat
  ),
  "the reply-owed closer must run on an OUTBOUND trigger only"
);
assert.ok(
  flat.indexOf("closeReplyOwedTasksOnStaffOutbound(conv, Date.now())") <
    flat.indexOf("if (!taskFulfillmentAutoCloseShadowEnabled() && !isTaskFulfillmentAutoCloseEnabled()) return;"),
  "the reply-owed closer must run BEFORE the fulfillment flag guard — the staff reply IS the accomplishment, no judge and no dark flag"
);
assert.ok(
  /!replyOwedClosed\.includes\(t\.id\)/.test(flat),
  "a task already closed as reply-owed must not be re-judged by the classifier"
);

assert.ok(
  /mediaCount\?: number/.test(index) && /outboundActivityText\(/.test(index),
  "the runner must accept a mediaCount and render outbound media through the shared helper"
);
assert.ok(
  /const actionText = isOutboundTrigger \? outboundActivityText\(action\?\.text, action\?\.mediaCount\) : String\(action\?\.text \?\? ""\)\.trim\(\);/.test(
    flat
  ),
  "a picture-only MMS must produce a non-empty action text so the run does not abort on an empty body"
);
assert.ok(
  /outboundActivityText\(m\?\.body, Array\.isArray\(m\?\.mediaUrls\) \? m\.mediaUrls\.length : 0\)/.test(flat),
  "the activity window must describe outbound media so media-only sends are not filtered out as empty"
);
assert.ok(
  /runTaskFulfillmentAutoClose\(conv, \{ channel: "sms", text: smsBody, mediaCount: Array\.isArray\(mediaUrls\) \? mediaUrls\.length : 0 \}\)/.test(
    flat
  ),
  "the SMS send site must pass the outbound media count"
);

// (3) FINANCE needs-more-info => an OPEN business-manager checklist task off the CALL lane.
assert.ok(
  /function openFinanceNeedsMoreInfoManagerTask/.test(index) &&
    /buildFinanceNeedsMoreInfoTaskSummary\(/.test(index),
  "the needs-more-info business-manager task must exist and use the pure summary builder"
);
assert.ok(
  /if \(opts\?\.openNeedsInfoManagerTask\) \{ await openFinanceNeedsMoreInfoManagerTask\(conv, \{/.test(flat),
  "the checklist task is opt-in so only the finance-CALL outcome lane opens it (ruling scope)"
);
assert.ok(
  /requiredItems: parsedFinanceOutcome\.requiredItems \?\? \[\], openNeedsInfoManagerTask: true/.test(flat),
  "the voice finance-outcome lane must pass the parsed lender items and opt in"
);

console.log(
  `PASS task autoclose inbound-trigger eval (source guard + reply-owed + media-only + finance-checklist wiring + ${closures.length} closure + ${nonClosures.length} non-closure cases)`
);
