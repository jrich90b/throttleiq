/**
 * Stale-handoff nudge lifecycle — retire + rollup (Joe, 2026-08-12: "the inbox is overwhelming").
 *
 * Measured on the live store that day: 136 open tasks, 90 of them the ONE "Follow up with X —
 * handed off (...), no activity in N days" nudge class, 63 of those themselves older than 7 days,
 * and 17 open on threads where staff had ALREADY replied after the task was born. The nudge is a
 * safety net that never retired, so the inbox only ever grew.
 *
 * This eval EXECUTES the retire decision (staleHandoffNudgeRetireReason) against synthetic
 * fixtures built relative to a passed clock — no wall-clock reads, so it can never go red at
 * midnight — and pins the wiring: the reconcile sweep in index.ts, the shared summary builder
 * beside its recogniser, and the console rollup that collapses the class to one row.
 *
 * FAIL DIRECTION. Retiring a nudge closes a STAFF reminder — it never messages a customer and
 * never closes a lead; a still-quiet lead re-surfaces via shouldNudgeStaleHandoffLead's
 * reNudgeDays window. The dangerous direction is retiring a task that is NOT this nudge — so the
 * recogniser cases below are the load-bearing half.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const {
  buildStaleHandoffNudge,
  isStaleHandoffNudgeTodo,
  staleHandoffNudgeRetireReason,
  shouldNudgeStaleHandoffLead
} = await import("../services/api/src/domain/conversationStore.ts");

const NOW = new Date("2026-08-12T15:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

const conv = (msgs: Array<{ at: string; draftStatus?: string }>) =>
  ({ id: "+15550000001", messages: msgs.map(m => ({ direction: "out", body: "x", ...m })) }) as any;

const nudge = (over: Record<string, unknown> = {}) =>
  ({
    taskClass: "followup",
    summary: "Follow up with James — handed off (credit app), no activity in 9 days and no follow-up scheduled.",
    createdAt: iso(3 * DAY),
    ...over
  }) as any;

// ----------------------------------------------------------------- recogniser: what it must match
// The writer and the recogniser share one template — prove it end to end.
const built = buildStaleHandoffNudge(
  conv([{ at: iso(9 * DAY) }]),
  "James",
  NOW
);
assert.ok(built.summary.includes("no activity in 9 days"), "the builder reports the real idle days");
assert.ok(
  isStaleHandoffNudgeTodo({ taskClass: "followup", summary: built.summary }),
  "a freshly built nudge summary must be recognised by isStaleHandoffNudgeTodo"
);

// Real summaries from the live store (all generations present on 2026-08-12).
for (const summary of [
  "Follow up with James — handed off (credit app), no activity in 9 days and no follow-up scheduled.",
  "Follow up with richard — handed off (credit app approved), no activity in 4 days and no follow-up scheduled.",
  "Follow up with Aiden — handed off (jumpstart experience), no activity in 12 days and no follow-up scheduled."
]) {
  assert.ok(isStaleHandoffNudgeTodo({ taskClass: "followup", summary }), `must match: ${summary.slice(0, 50)}`);
}

// The tasks it must NEVER touch — real non-nudge summaries from the same store.
for (const t of [
  { taskClass: "followup", summary: "Customer texted a photo of a bike they like. Vision says it looks like Street Glide (74%)." },
  { taskClass: "followup", summary: "Deal in process — Brent replied: \"Ok that's interesting\" — needs your answer." },
  { taskClass: "todo", summary: "No reply after 4 texts - worth a quick call." },
  { taskClass: "reminder", summary: "Notify Mohamed Ahmed when the 2026 Deadwood (on order) arrives or is ready to show." },
  { taskClass: "appointment", summary: "Appointment scheduled for Sat, Aug 15, 12:00 PM." },
  // Same words in a DIFFERENT class: still not the nudge.
  { taskClass: "todo", summary: "Follow up with James — handed off (credit app), no activity in 9 days and no follow-up scheduled." }
]) {
  assert.equal(isStaleHandoffNudgeTodo(t as any), false, `must NOT match [${t.taskClass}]: ${t.summary.slice(0, 45)}`);
  assert.equal(
    staleHandoffNudgeRetireReason({ ...t, createdAt: iso(30 * DAY) } as any, conv([{ at: iso(1 * DAY) }]), NOW),
    null,
    "a non-nudge task can never be retired by this decision, no matter how old"
  );
}

// ------------------------------------------------------------------- the retire decision, executed
// activity_resumed: ANY delivered message after the task's birth ends it, at any age.
assert.equal(
  staleHandoffNudgeRetireReason(nudge(), conv([{ at: iso(1 * DAY) }]), NOW),
  "activity_resumed",
  "a message after the nudge was created retires it"
);
// The Paul Harrigan shape: staff replied the same day the task appeared.
assert.equal(
  staleHandoffNudgeRetireReason(nudge({ createdAt: iso(8 * DAY) }), conv([{ at: iso(7.5 * DAY) }]), NOW),
  "activity_resumed"
);
// A held/stale DRAFT is not activity — nobody ever received it.
assert.equal(
  staleHandoffNudgeRetireReason(nudge(), conv([{ at: iso(1 * DAY), draftStatus: "stale" }]), NOW),
  null,
  "an undelivered draft must not count as resumed activity"
);
// A message from BEFORE the task's birth proves nothing.
assert.equal(staleHandoffNudgeRetireReason(nudge(), conv([{ at: iso(5 * DAY) }]), NOW), null);

// expired: quiet for 7 days retires; 6.9 days does not.
assert.equal(
  staleHandoffNudgeRetireReason(nudge({ createdAt: iso(7 * DAY) }), conv([]), NOW),
  "expired",
  "an unread nudge expires at 7 days"
);
assert.equal(
  staleHandoffNudgeRetireReason(nudge({ createdAt: iso(6.9 * DAY) }), conv([]), NOW),
  null,
  "a 6.9-day-old nudge stays"
);
// A snooze into the future is STAFF intent — expiry leaves it alone…
assert.equal(
  staleHandoffNudgeRetireReason(
    nudge({ createdAt: iso(10 * DAY), dueAt: new Date(NOW.getTime() + DAY).toISOString() }),
    conv([]),
    NOW
  ),
  null,
  "a snoozed nudge must not expire"
);
// …but resumed activity still retires a snoozed nudge (the premise is gone either way).
assert.equal(
  staleHandoffNudgeRetireReason(
    nudge({ createdAt: iso(10 * DAY), dueAt: new Date(NOW.getTime() + DAY).toISOString() }),
    conv([{ at: iso(2 * DAY) }]),
    NOW
  ),
  "activity_resumed"
);
// A snooze that has already PASSED no longer protects.
assert.equal(
  staleHandoffNudgeRetireReason(nudge({ createdAt: iso(10 * DAY), dueAt: iso(1 * DAY) }), conv([]), NOW),
  "expired"
);
// Garbage createdAt: torn ⇒ keep (never retire on a record we cannot read).
assert.equal(staleHandoffNudgeRetireReason(nudge({ createdAt: "not-a-date" }), conv([]), NOW), null);

// -------------------------------------------------- the loop cannot strand a lead: expiry + re-nudge
// After an expiry, a STILL handed-off + quiet lead re-surfaces once the reNudge window passes.
const quietLead = {
  id: "+15550000002",
  followUp: { mode: "manual_handoff" },
  staleHandoffNudgedAt: iso(15 * DAY), // nudged 15d ago, re-nudge window is 14d
  messages: [{ direction: "in", body: "hi", at: iso(10 * DAY) }]
} as any;
assert.equal(
  shouldNudgeStaleHandoffLead(quietLead, false, NOW),
  true,
  "a still-quiet lead whose nudge expired must re-surface after the reNudge window"
);

// --------------------------------------------------------------------------------------- wiring
const indexSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
assert.ok(
  indexSource.includes("staleHandoffNudgeRetireReason(t, conv, now)"),
  "the reconcile sweep must ask the retire decision for open todos"
);
assert.ok(
  indexSource.includes('"stale_handoff_nudge_retired"'),
  "every retire must record WHY via a route outcome"
);
assert.ok(
  indexSource.includes("buildStaleHandoffNudge(conv, who, now)"),
  "the nudge writer must compose its summary through the shared builder"
);
assert.ok(
  !indexSource.includes("no activity in ${idleDays} days"),
  "the old inline summary template must not come back beside the shared builder"
);

const inboxSource = await fs.readFile(
  path.resolve("apps/web/src/app/components/TaskInboxSection.tsx"),
  "utf8"
);
assert.ok(
  inboxSource.includes("function isQuietHandoffTodo"),
  "the console must recognise the nudge class for the rollup"
);
assert.ok(
  inboxSource.includes('"quiet_handoff"'),
  "the console must file quiet-handoff cards under their own rollup section"
);
assert.ok(
  inboxSource.includes("React.useState(false)") && inboxSource.includes("quietHandoffOpen"),
  "the rollup must start collapsed — one row, not ninety"
);
assert.ok(
  inboxSource.includes("g.tasks.every((t: any) => isQuietHandoffTodo(t))"),
  "a card with ANY non-nudge task must stay in the main list — only all-nudge cards roll up"
);

console.log("stale_handoff_nudge_retire: all checks passed.");
