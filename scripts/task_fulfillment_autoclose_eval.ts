/**
 * Task-fulfillment auto-close — deterministic gate eval.
 *
 * The "did this follow-up fulfill the task?" judgement is an LLM parser
 * (classifyTaskFulfillmentWithLLM, verified by the shadow backfill report). THIS
 * eval pins the pure, deterministic gate around that verdict: which tasks are
 * eligible (all open call + follow-up tasks, per Joe 2026-06-17) and whether a
 * verdict is strong enough — and ALLOWED by the dark flag — to actually close.
 *
 * Fail direction: a wrong CLOSE silently drops a customer follow-up, so the gate
 * must bias hard toward NOT closing — flag-off and any uncertainty => no close.
 */
import assert from "node:assert/strict";
import {
  isAutoCloseEligibleTask,
  decideTaskAutoClose,
  TASK_AUTO_CLOSE_MIN_CONFIDENCE,
  REPLY_OWED_TODO_MARKER,
  isReplyOwedTask,
  decideReplyOwedTaskClose,
  describeOutboundMedia,
  outboundActivityText
} from "../services/api/src/domain/taskFulfillmentAutoClose.ts";

// --- Eligibility: the 0.85 classifier decides for ANY customer-facing task. Only structurally
// non-fulfillable types are excluded: internal `note` + `appointment` taskClass (outcome flow).
// (Paul Foley 6/22: a parts AVAILABILITY question answered by text must be closeable.) ---
for (const reason of ["call", "pricing", "payments", "parts", "service", "apparel", "approval", "manager", "other"]) {
  assert.equal(
    isAutoCloseEligibleTask({ status: "open", reason, taskClass: "todo" }),
    true,
    `open ${reason} task is eligible — the classifier judges whether the objective was accomplished`
  );
}
assert.equal(
  isAutoCloseEligibleTask({ status: "open", reason: "other", taskClass: "followup" }),
  true,
  "open follow-up task eligible"
);
// Structural exclusions:
assert.equal(
  isAutoCloseEligibleTask({ status: "open", reason: "note", taskClass: "todo" }),
  false,
  "an internal note is not a customer task — not auto-closeable"
);
assert.equal(
  isAutoCloseEligibleTask({ status: "open", reason: "call", taskClass: "appointment" }),
  false,
  "an appointment task closes via its outcome flow, not fulfillment"
);
assert.equal(isAutoCloseEligibleTask({ status: "done", reason: "call" }), false, "a done task is never eligible");

// --- Gate: only enabled + eligible + fulfilled + confident closes ---
const fulfilledHigh = { taskId: "t1", fulfilled: true, confidence: 0.95, evidence: "x" };

assert.deepEqual(
  decideTaskAutoClose({ enabled: true, eligible: false, verdict: fulfilledHigh }),
  { close: false, reason: "ineligible_task" },
  "ineligible task never closes"
);
assert.deepEqual(
  decideTaskAutoClose({ enabled: true, eligible: true, verdict: null }),
  { close: false, reason: "no_verdict" },
  "no verdict => no close"
);
assert.deepEqual(
  decideTaskAutoClose({ enabled: true, eligible: true, verdict: { taskId: "t1", fulfilled: false, confidence: 0.99 } }),
  { close: false, reason: "not_fulfilled" },
  "not fulfilled => no close even at high confidence"
);
assert.deepEqual(
  decideTaskAutoClose({ enabled: true, eligible: true, verdict: { taskId: "t1", fulfilled: true, confidence: 0.5 } }),
  { close: false, reason: "below_confidence" },
  "fulfilled but low confidence => no close"
);

// Flag OFF (dark) — even a strong fulfilled verdict only SHADOWS.
assert.deepEqual(
  decideTaskAutoClose({ enabled: false, eligible: true, verdict: fulfilledHigh }),
  { close: false, reason: "shadow_would_close" },
  "dark: strong verdict reports shadow_would_close, never closes"
);

// Flag ON — strong verdict closes.
assert.deepEqual(
  decideTaskAutoClose({ enabled: true, eligible: true, verdict: fulfilledHigh }),
  { close: true, reason: "fulfilled_high_confidence" },
  "enabled + eligible + fulfilled + confident => close"
);

// Confidence floor is inclusive.
assert.equal(
  decideTaskAutoClose({
    enabled: true,
    eligible: true,
    verdict: { taskId: "t1", fulfilled: true, confidence: TASK_AUTO_CLOSE_MIN_CONFIDENCE }
  }).close,
  true,
  "confidence exactly at the floor closes"
);
assert.equal(
  decideTaskAutoClose({
    enabled: true,
    eligible: true,
    verdict: { taskId: "t1", fulfilled: true, confidence: TASK_AUTO_CLOSE_MIN_CONFIDENCE - 0.001 }
  }).close,
  false,
  "just below the floor does not close"
);

// Caller can raise (never silently lower) the floor.
assert.equal(
  decideTaskAutoClose({
    enabled: true,
    eligible: true,
    verdict: { taskId: "t1", fulfilled: true, confidence: 0.9 },
    minConfidence: 0.97
  }).close,
  false,
  "a stricter minConfidence is honored"
);

// ---------------------------------------------------------------------------
// REPLY-OWED deterministic closer (Joe ruling 2026-07-23, part 1).
// Curtis Samuel +17163812367: the "needs YOUR reply" task was created 17:46:46, Joe replied
// 17:47:41, and the LLM judge returned not_fulfilled because the reply was promise-shaped
// ("we will try to call and see if they can do a 2nd review"). For a reply-owed task the reply
// IS the accomplishment — close it deterministically, no verdict.
// ---------------------------------------------------------------------------
const CURTIS_SUMMARY = `Curtis replied while you have this thread: "No" — ${REPLY_OWED_TODO_MARKER}.`;
const STEP_BACK_SUMMARY = `Curtis replied to your thread (addressed you by name): "hey Joe" — ${REPLY_OWED_TODO_MARKER}, not the assistant's.`;
const TASK_CREATED = "2026-07-23T17:46:46.026Z";
const REPLY_SENT_MS = Date.parse("2026-07-23T17:47:41.832Z");

for (const [label, summary] of [
  ["human-mode re-engagement", CURTIS_SUMMARY],
  ["owner-thread step-back", STEP_BACK_SUMMARY]
] as const) {
  assert.equal(
    isReplyOwedTask({ status: "open", summary }),
    true,
    `${label} task carries the reply-owed marker`
  );
}
assert.equal(
  isReplyOwedTask({ status: "open", summary: "Call customer (follow-up): check on the Street Glide." }),
  false,
  "an ordinary cadence follow-up call task is NOT reply-owed"
);
assert.equal(
  isReplyOwedTask({ status: "done", summary: CURTIS_SUMMARY }),
  false,
  "a closed reply-owed task is not re-closed"
);

assert.deepEqual(
  decideReplyOwedTaskClose({
    task: { status: "open", summary: CURTIS_SUMMARY, createdAt: TASK_CREATED },
    isStaffOutbound: true,
    outboundAtMs: REPLY_SENT_MS
  }),
  { close: true, reason: "staff_reply_is_accomplishment" },
  "Curtis: a real staff reply one minute after the task closes it — no judge, promise-shaped or not"
);
assert.deepEqual(
  decideReplyOwedTaskClose({
    task: { status: "open", summary: CURTIS_SUMMARY, createdAt: TASK_CREATED },
    isStaffOutbound: false,
    outboundAtMs: REPLY_SENT_MS
  }),
  { close: false, reason: "not_staff_outbound" },
  "a customer INBOUND trigger never closes a reply-owed task — staff still owe the reply"
);
assert.deepEqual(
  decideReplyOwedTaskClose({
    task: { status: "open", summary: CURTIS_SUMMARY, createdAt: TASK_CREATED },
    isStaffOutbound: true,
    outboundAtMs: Date.parse("2026-07-23T17:40:00.000Z")
  }),
  { close: false, reason: "outbound_not_after_creation" },
  "an outbound that PREDATES the task cannot have answered it"
);
assert.equal(
  decideReplyOwedTaskClose({
    task: { status: "open", summary: "Call customer (follow-up): pricing", createdAt: TASK_CREATED },
    isStaffOutbound: true,
    outboundAtMs: REPLY_SENT_MS
  }).close,
  false,
  "a non-reply-owed task still goes to the fulfillment judge (this closer never widens)"
);
assert.equal(
  decideReplyOwedTaskClose({
    task: { status: "open", summary: CURTIS_SUMMARY, createdAt: TASK_CREATED },
    isStaffOutbound: true,
    outboundAtMs: Number.NaN
  }).close,
  false,
  "no usable outbound time => leave it open (fail-safe)"
);
// Missing createdAt (legacy task) still closes on a real staff send — the reply is the objective.
assert.equal(
  decideReplyOwedTaskClose({
    task: { status: "open", summary: CURTIS_SUMMARY, createdAt: null },
    isStaffOutbound: true,
    outboundAtMs: REPLY_SENT_MS
  }).close,
  true,
  "a reply-owed task with no createdAt closes on a real staff send"
);

// ---------------------------------------------------------------------------
// MEDIA-ONLY outbound visibility (Joe ruling 2026-07-23, part 2).
// Safvan +18728882220: the salesman sent 3 pictures against "send photos for the unlisted bike"
// and the verdict was "No photos/details were delivered." — a picture-only MMS has an empty body,
// so the closer never saw it. Render our own attachments so the classifier can judge them.
// ---------------------------------------------------------------------------
assert.equal(describeOutboundMedia(0), "", "no media => no synthetic line");
assert.equal(describeOutboundMedia(null), "", "missing media count => no synthetic line");
assert.equal(describeOutboundMedia(undefined), "", "undefined media count => no synthetic line");
assert.equal(describeOutboundMedia(-2), "", "a nonsense negative count => no synthetic line");
assert.equal(
  describeOutboundMedia(1),
  "[dealer sent 1 photo (picture-only message, no text)]",
  "one photo is singular"
);
assert.equal(
  describeOutboundMedia(3),
  "[dealer sent 3 photos (picture-only message, no text)]",
  "Safvan: three pictures render as a line the fulfillment classifier can read"
);

assert.equal(
  outboundActivityText("", 3),
  "[dealer sent 3 photos (picture-only message, no text)]",
  "a picture-only MMS is no longer empty to the auto-closer — this is the whole bug"
);
assert.equal(
  outboundActivityText("   ", 2),
  "[dealer sent 2 photos (picture-only message, no text)]",
  "whitespace-only body counts as picture-only"
);
assert.equal(
  outboundActivityText("here you go", 2),
  "here you go [dealer sent 2 photos (picture-only message, no text)]",
  "a captioned MMS keeps the words AND reports the attachments"
);
assert.equal(outboundActivityText("just text", 0), "just text", "a plain SMS is unchanged");
assert.equal(outboundActivityText("", 0), "", "an empty message with no media stays empty (still bails)");
assert.equal(
  outboundActivityText("  spaced   out  ", undefined),
  "spaced out",
  "body whitespace is normalized exactly as before"
);

console.log("PASS task fulfillment auto-close gate eval (+ reply-owed closer + media-only visibility)");
