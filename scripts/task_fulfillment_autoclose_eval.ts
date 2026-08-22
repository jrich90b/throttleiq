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
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  isAutoCloseEligibleTask,
  decideTaskAutoClose,
  TASK_AUTO_CLOSE_MIN_CONFIDENCE,
  REPLY_OWED_TODO_MARKER,
  REPLY_OWED_TODO_MARKER_DEAL,
  isReplyOwedTask,
  isQuietTriggeredTask,
  decideReplyOwedTaskClose,
  describeOutboundMedia,
  outboundActivityText,
  buildTaskFulfillmentActivityWindow,
  activityChannelForProvider
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
// QUIET-TRIGGERED tasks may only close on NEW dealer activity (+19074412693, reported 7/19).
// Roger McCleskey's credit-app handoff task was minted at second 0 by the quiet sweep and closed
// at second 6 by the same tick's backfill, citing a 3-day-old "I received your credit application"
// text — the very silence that created the task. Live: 143 of 400 high-confidence closes fired
// within 120s of their task's creation. Fail direction: this only ever REFUSES a close.
// ---------------------------------------------------------------------------

const quietTaskSummaries = [
  "Follow up with Roger — handed off (credit app), no activity in 3 days and no follow-up scheduled.",
  "Nudge Roger? Deal in process (credit app), quiet since 2026-07-18 — your call whether/when to follow up.",
  "No reply after 4 texts - worth a quick call."
];
for (const summary of quietTaskSummaries) {
  assert.equal(isQuietTriggeredTask({ summary }), true, `quiet-triggered family recognized: ${summary.slice(0, 40)}`);
  assert.deepEqual(
    decideTaskAutoClose({
      enabled: true,
      eligible: true,
      verdict: fulfilledHigh,
      task: { summary },
      dealerOutboundTrigger: false
    }),
    { close: false, reason: "quiet_task_needs_new_outbound" },
    "a backfill / inbound re-check cannot close a task the quiet sweep just minted"
  );
  assert.deepEqual(
    decideTaskAutoClose({
      enabled: true,
      eligible: true,
      verdict: fulfilledHigh,
      task: { summary },
      dealerOutboundTrigger: true
    }),
    { close: true, reason: "fulfilled_high_confidence" },
    "a FRESH dealer outbound still closes the quiet task normally — staff's next send clears it"
  );
}

// Ordinary tasks are untouched by the guard, on either trigger.
for (const summary of [
  "Notify Don when the 2016 Freewheeler trade arrives or is ready to show.",
  "Promised over text: send pictures of the Deadwood when it arrives"
]) {
  assert.equal(isQuietTriggeredTask({ summary }), false, "an ordinary task is not quiet-triggered");
  assert.equal(
    decideTaskAutoClose({
      enabled: true,
      eligible: true,
      verdict: fulfilledHigh,
      task: { summary },
      dealerOutboundTrigger: false
    }).close,
    true,
    "an ordinary task still closes on a backfill / inbound re-check (Paul Foley 6/22 stays fixed)"
  );
}

// A caller that passes no task keeps the pre-guard behavior exactly (the guard needs the summary).
assert.deepEqual(
  decideTaskAutoClose({ enabled: true, eligible: true, verdict: fulfilledHigh }),
  { close: true, reason: "fulfilled_high_confidence" },
  "no task supplied => unchanged decision"
);
// The guard is reported ahead of the dark-flag shadow so the trace names the real blocker.
assert.deepEqual(
  decideTaskAutoClose({
    enabled: false,
    eligible: true,
    verdict: fulfilledHigh,
    task: { summary: quietTaskSummaries[0] },
    dealerOutboundTrigger: false
  }),
  { close: false, reason: "quiet_task_needs_new_outbound" },
  "dark: the quiet guard, not shadow_would_close, is the reported reason"
);
// Guard order: a weak verdict is still rejected on confidence first.
assert.deepEqual(
  decideTaskAutoClose({
    enabled: true,
    eligible: true,
    verdict: { taskId: "t1", fulfilled: true, confidence: 0.5 },
    task: { summary: quietTaskSummaries[1] },
    dealerOutboundTrigger: false
  }),
  { close: false, reason: "below_confidence" },
  "confidence is still judged before the quiet guard"
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

// Tim Williams (+17163741119, 2026-07-29): the in-process-deal generators phrase the SAME
// "staff owes this customer a reply" task as "needs your answer", so the marker missed them and
// they fell through to the LLM judge — which kept the task nagging after Joe had already replied
// at 19:56:06Z ("i follow up but the task did not clear", filed 20:08). Live at fix time:
// `needs YOUR reply` 43 ever / 0 open; `needs your answer` 11 ever / 2 still open.
const DEAL_REPLY_SUMMARY = `Deal in process — Tim replied: "Sounds good" — ${REPLY_OWED_TODO_MARKER_DEAL}.`;
const DEAL_SIGNAL_SUMMARY = `Deal in process (paperwork) — Tim said: "See you Friday" — ${REPLY_OWED_TODO_MARKER_DEAL}.`;

for (const [label, summary] of [
  ["human-mode re-engagement", CURTIS_SUMMARY],
  ["owner-thread step-back", STEP_BACK_SUMMARY],
  ["in-process-deal reply", DEAL_REPLY_SUMMARY],
  ["in-process-deal signal", DEAL_SIGNAL_SUMMARY]
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
assert.equal(
  isReplyOwedTask({ status: "done", summary: DEAL_REPLY_SUMMARY }),
  false,
  "a closed in-process-deal reply-owed task is not re-closed"
);

// COVERAGE PIN: every generator of a "staff owes this customer a reply" task must be matched by
// one of the two markers. This is the drift surface that caused the bug — a third phrasing added
// in index.ts without a marker would silently fall back to the LLM judge again.
{
  const apiSrc = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
  const generatorLines = apiSrc
    .split("\n")
    // Code only — a comment mentioning the phrase is documentation, not a task generator.
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter((line) => /needs YOUR reply|needs your answer/i.test(line))
    // The context-fidelity held-draft task ("Needs your reply — the AI couldn't answer this in
    // context…") is deliberately OUT of this family: it carries its own marker and its own
    // clear-on-send closer in conversationStore.ts (three call sites keyed on
    // CONTEXT_FIDELITY_HELD_TODO_MARKER). It must not be routed through the reply-owed closer.
    .filter((line) => !line.includes("CONTEXT_FIDELITY_HELD_TODO_MARKER"));
  assert.ok(
    generatorLines.length >= 4,
    `expected at least 4 reply-owed task generators in index.ts, found ${generatorLines.length}`
  );
  for (const line of generatorLines) {
    assert.ok(
      line.includes(REPLY_OWED_TODO_MARKER) || line.includes(REPLY_OWED_TODO_MARKER_DEAL),
      `a reply-owed task summary in index.ts carries neither marker (would miss the deterministic closer): ${line.trim()}`
    );
  }
}

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

// --- A task may not be closed by evidence OLDER than itself (Robert Guarino +17163164302, 8/22).
// Joe brought Parts in at 15:55:29.783Z; the backfill re-check closed the task 54s later at 0.90,
// citing photos from 13:43Z and a reply at 14:04Z — two hours before the task existed. Nobody from
// Parts had touched it, and the thread never reached Brandon's inbox.
{
  const CREATED = Date.parse("2026-08-22T15:55:29.783Z");
  const NEWEST_MESSAGE = Date.parse("2026-08-22T14:30:58.562Z"); // the last real message on that thread
  const strongVerdict = { taskId: "todo_ffb1bc5d8c9df_1787414129783", fulfilled: true, confidence: 0.9 };
  const partsTask = { summary: "lights" };

  const robert = decideTaskAutoClose({
    enabled: true,
    eligible: true,
    verdict: strongVerdict,
    task: partsTask,
    dealerOutboundTrigger: false,
    taskCreatedAtMs: CREATED,
    latestActivityAtMs: NEWEST_MESSAGE
  });
  assert.equal(robert.close, false, "THE FIX: a 54-second-old task is not fulfilled by a two-hour-old photo exchange");
  assert.equal(robert.reason, "task_newer_than_its_evidence", "and the shadow log names the real blocker");

  // The same task, once something actually happens after it — a dealer reply an hour later.
  const afterRealActivity = decideTaskAutoClose({
    enabled: true,
    eligible: true,
    verdict: strongVerdict,
    task: partsTask,
    dealerOutboundTrigger: true,
    taskCreatedAtMs: CREATED,
    latestActivityAtMs: CREATED + 60 * 60 * 1000
  });
  assert.equal(afterRealActivity.close, true, "a task IS closable once the thread moves after it was filed");

  // Exactly equal timestamps are not "after": a window that ends where the task begins saw nothing new.
  assert.equal(
    decideTaskAutoClose({
      enabled: true, eligible: true, verdict: strongVerdict, task: partsTask,
      dealerOutboundTrigger: true, taskCreatedAtMs: CREATED, latestActivityAtMs: CREATED
    }).reason,
    "task_newer_than_its_evidence",
    "equal timestamps refuse — the boundary is strictly after"
  );

  // Missing either timestamp reproduces the pre-2026-08-22 behaviour rather than stranding the task.
  const partial: Array<[string, Record<string, number>]> = [
    ["no createdAt", { latestActivityAtMs: NEWEST_MESSAGE }],
    ["no activity time", { taskCreatedAtMs: CREATED }],
    ["neither", {}],
    ["unparseable createdAt", { taskCreatedAtMs: Number.NaN, latestActivityAtMs: NEWEST_MESSAGE }]
  ];
  for (const [label, extra] of partial) {
    const d = decideTaskAutoClose({
      enabled: true, eligible: true, verdict: strongVerdict, task: partsTask, dealerOutboundTrigger: true, ...extra
    });
    assert.equal(d.close, true, `${label}: the guard is finite-gated and never strands a task`);
  }

  // Ordering: the guard reports BEFORE the flag check, like the quiet and booking guards, so a dark
  // run's shadow log shows the real blocker instead of "shadow_would_close".
  assert.equal(
    decideTaskAutoClose({
      enabled: false, eligible: true, verdict: strongVerdict, task: partsTask,
      dealerOutboundTrigger: false, taskCreatedAtMs: CREATED, latestActivityAtMs: NEWEST_MESSAGE
    }).reason,
    "task_newer_than_its_evidence",
    "the shadow log names this blocker, not the flag"
  );

  // ...but a weak verdict is still reported as weak: the new guard must not mask the older reasons.
  assert.equal(
    decideTaskAutoClose({
      enabled: true, eligible: true, verdict: { ...strongVerdict, confidence: 0.4 }, task: partsTask,
      dealerOutboundTrigger: false, taskCreatedAtMs: CREATED, latestActivityAtMs: NEWEST_MESSAGE
    }).reason,
    "below_confidence",
    "confidence is still judged first"
  );
}

// --- The window builder and the guard are one invariant, so they are pinned together: the window's
// end is what `latestActivityAtMs` means.
{
  const messages = [
    { direction: "in", provider: "twilio", at: "2026-08-22T13:43:43.294Z", body: "Here is a picture of the lights." },
    { direction: "out", provider: "twilio", at: "2026-08-22T14:04:38.813Z", body: "Got both photos — thanks!" },
    { direction: "out", provider: "twilio", at: "2026-08-22T14:30:58.562Z", body: "Thanks again for coming to see us." }
  ];
  const built = buildTaskFulfillmentActivityWindow(messages, { channel: "sms", text: "", direction: "in" }, "");
  assert.equal(
    new Date(built.latestActivityAtMs).toISOString(),
    "2026-08-22T14:30:58.562Z",
    "the window reports the NEWEST message time — what the guard compares the task against"
  );
  assert.equal(built.activity.length, 3, "an inbound trigger appends no synthetic action");

  const withSend = buildTaskFulfillmentActivityWindow(messages, { channel: "sms", text: "on its way" }, "on its way");
  assert.equal(
    withSend.activity[withSend.activity.length - 1].text,
    "on its way",
    "an outbound trigger ends with the just-sent message"
  );

  assert.ok(
    Number.isNaN(
      buildTaskFulfillmentActivityWindow(
        [{ direction: "in", provider: "twilio", body: "hi" }],
        { channel: "sms", text: "", direction: "in" },
        ""
      ).latestActivityAtMs
    ),
    "no parseable timestamp => NaN, which switches the guard OFF rather than guessing"
  );
  assert.equal(activityChannelForProvider("sendgrid"), "email", "provider mapping moved verbatim");
  assert.equal(activityChannelForProvider("voice_summary"), "call", "provider mapping moved verbatim");
  assert.equal(activityChannelForProvider("twilio"), "sms", "provider mapping moved verbatim");
}

// The window builder now lives beside the guard; index.ts must not keep a second copy, and must pass
// BOTH halves of the comparison or the refusal can never fire in production.
{
  const indexSrc = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
  assert.ok(
    indexSrc.includes("buildTaskFulfillmentActivityWindow(conv.messages, action, actionText)"),
    "index.ts builds the classifier window through the domain helper"
  );
  assert.ok(
    indexSrc.includes("latestActivityAtMs") && indexSrc.includes("taskCreatedAtMs: Date.parse(String(task.createdAt"),
    "…and passes both taskCreatedAtMs and latestActivityAtMs into decideTaskAutoClose"
  );
}

console.log("PASS task fulfillment auto-close gate eval (+ reply-owed closer + media-only visibility + evidence-age guard)");
