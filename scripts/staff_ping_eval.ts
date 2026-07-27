/**
 * Manager "Ping" eval (Joe, 2026-07-27) — decision table for the manual staff nudge:
 * who gets the text, when we refuse, and what the SMS says. Decision logic is pure in
 * domain/staffPing.ts; this exercises it directly and pins the endpoint wiring.
 *
 * Internal staff SMS only — the customer thread is never touched, so the guarded
 * behaviors here are target selection, the cooldown, and the no-phone/no-owner refusals.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const {
  appendStaffPingRecord,
  buildStaffPingMessage,
  collectPingableTasks,
  decideStaffPing,
  DEFAULT_STAFF_PING_COOLDOWN_MINUTES,
  evaluateStaffPingCooldown,
  lastStaffPingAt,
  resolveStaffPingOwnerRef,
  STAFF_PING_HISTORY_LIMIT
} = await import("../services/api/src/domain/staffPing.ts");

const nowMs = Date.parse("2026-07-27T18:00:00.000Z");
const iso = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString();

const mkTodo = (over: any = {}): any => ({
  id: over.id ?? "t1",
  convId: over.convId ?? "conv-1",
  leadKey: over.leadKey ?? "+15551230000",
  reason: over.reason ?? "call",
  summary: over.summary ?? "Get a trade number on the 2016 Freewheeler",
  createdAt: over.createdAt ?? iso(-3 * 60 * 60 * 1000),
  status: over.status ?? "open",
  ...over
});

// ---------------------------------------------------------------- task collection
const allTodos = [
  mkTodo({ id: "t1", ownerId: "u-mike", ownerName: "Mike" }),
  mkTodo({ id: "t2", convId: "conv-other", leadKey: "+15559990000", ownerId: "u-mike" }),
  mkTodo({ id: "t3", reason: "note", summary: "Internal note card", ownerId: "u-mike" }),
  mkTodo({ id: "t4", status: "done", ownerId: "u-mike" }),
  mkTodo({ id: "t5", leadKey: "+15551230000", convId: "legacy-key", ownerId: "u-dana", ownerName: "Dana" })
];
const tasks = collectPingableTasks(allTodos, ["conv-1", "+15551230000"]);
assert.deepEqual(
  tasks.map((t: any) => t.id),
  ["t1", "t5"],
  "only this conversation's OPEN, actionable tasks — notes, done cards, and other threads excluded"
);
assert.equal(collectPingableTasks(allTodos, []).length, 0, "no conversation keys -> no tasks");

// Ordering: soonest-due first, undated after, then oldest-created.
const ordered = collectPingableTasks(
  [
    mkTodo({ id: "undated", createdAt: iso(-5 * 60 * 60 * 1000) }),
    mkTodo({ id: "due-later", dueAt: iso(4 * 60 * 60 * 1000) }),
    mkTodo({ id: "overdue", dueAt: iso(-2 * 60 * 60 * 1000) })
  ],
  ["conv-1"]
);
assert.deepEqual(
  ordered.map((t: any) => t.id),
  ["overdue", "due-later", "undated"],
  "overdue card leads the ping body"
);

// ---------------------------------------------------------------- target selection
// Joe's ruling: the TASK owner gets the ping, not the lead owner, when they differ.
const conv = { leadOwner: { id: "u-lead", name: "Sam" } };
assert.deepEqual(
  resolveStaffPingOwnerRef(
    [mkTodo({ id: "a", ownerId: "u-mike", ownerName: "Mike" })],
    conv
  ),
  { id: "u-mike", name: "Mike", source: "task_owner" },
  "task owner beats lead owner"
);

// Most open cards wins among several task owners.
assert.equal(
  resolveStaffPingOwnerRef(
    [
      mkTodo({ id: "a", ownerId: "u-mike", ownerName: "Mike" }),
      mkTodo({ id: "b", ownerId: "u-dana", ownerName: "Dana" }),
      mkTodo({ id: "c", ownerId: "u-dana", ownerName: "Dana" })
    ],
    conv
  )?.id,
  "u-dana",
  "owner carrying the most open cards wins"
);

// Tie breaks to the earliest-created task, so the answer never flickers.
assert.equal(
  resolveStaffPingOwnerRef(
    [
      mkTodo({ id: "a", ownerId: "u-mike", ownerName: "Mike", createdAt: iso(-2 * 60 * 60 * 1000) }),
      mkTodo({ id: "b", ownerId: "u-dana", ownerName: "Dana", createdAt: iso(-9 * 60 * 60 * 1000) })
    ],
    conv
  )?.id,
  "u-dana",
  "tie breaks to the oldest task's owner"
);

// Unowned tasks fall back to the lead owner; nothing assigned at all -> no target.
assert.deepEqual(
  resolveStaffPingOwnerRef([mkTodo({ id: "a" })], conv),
  { id: "u-lead", name: "Sam", source: "lead_owner" },
  "unowned tasks fall back to the lead owner"
);
assert.equal(resolveStaffPingOwnerRef([], {}), null, "nobody assigned -> no target");
assert.equal(
  resolveStaffPingOwnerRef([], conv)?.source,
  "lead_owner",
  "no open task still pings the lead owner (Joe default #3: 'just look at this one')"
);

// ---------------------------------------------------------------- cooldown
assert.equal(DEFAULT_STAFF_PING_COOLDOWN_MINUTES, 120, "Joe default #4: 2-hour cooldown");
assert.deepEqual(
  evaluateStaffPingCooldown({ lastPingedAt: null, nowMs, cooldownMinutes: 120 }),
  { allowed: true, minutesRemaining: 0 },
  "never pinged -> allowed"
);
assert.equal(
  evaluateStaffPingCooldown({
    lastPingedAt: iso(-40 * 60 * 1000),
    nowMs,
    cooldownMinutes: 120
  }).minutesRemaining,
  80,
  "40 minutes in, 80 to go"
);
assert.equal(
  evaluateStaffPingCooldown({ lastPingedAt: iso(-3 * 60 * 60 * 1000), nowMs, cooldownMinutes: 120 })
    .allowed,
  true,
  "past the window -> allowed again"
);
assert.equal(
  evaluateStaffPingCooldown({ lastPingedAt: "not-a-date", nowMs, cooldownMinutes: 120 }).allowed,
  true,
  "unparseable timestamp never blocks a manager"
);

// ---------------------------------------------------------------- decision table
const baseArgs = {
  enabled: true,
  nowMs,
  cooldownMinutes: 120,
  ownerRef: { id: "u-mike", name: "Mike", source: "task_owner" as const },
  target: { id: "u-mike", name: "Mike", phone: "+15551112222" },
  lastPingedAt: null as string | null,
  managerName: "Joe",
  customerName: "Dante Turello",
  tasks: [mkTodo({ id: "t1" })],
  link: "https://console.example.com/?section=inbox&convId=conv-1"
};

assert.equal(decideStaffPing({ ...baseArgs, enabled: false }).kind, "disabled", "kill switch");
assert.equal(decideStaffPing({ ...baseArgs, ownerRef: null }).kind, "no_target", "nobody assigned");

const noPhone = decideStaffPing({ ...baseArgs, target: { id: "u-mike", name: "Mike", phone: "" } });
assert.equal(noPhone.kind, "no_phone", "a rep with no mobile is reported, not silently dropped");
assert.equal((noPhone as any).targetName, "Mike");

// A name that matches nobody in the user store still names who we meant.
const unknownUser = decideStaffPing({ ...baseArgs, target: null });
assert.equal(unknownUser.kind, "no_phone");
assert.equal((unknownUser as any).targetName, "Mike", "falls back to the task's owner name");

const cooled = decideStaffPing({ ...baseArgs, lastPingedAt: iso(-30 * 60 * 1000) });
assert.equal(cooled.kind, "cooldown", "a second ping inside the window is refused");
assert.equal((cooled as any).minutesRemaining, 90);

const send = decideStaffPing(baseArgs);
assert.equal(send.kind, "send");
assert.equal((send as any).targetPhone, "+15551112222");
assert.deepEqual((send as any).taskIds, ["t1"]);

// ---------------------------------------------------------------- message body
const message = buildStaffPingMessage({
  managerName: "Joe",
  customerName: "Dante Turello",
  tasks: [
    mkTodo({ id: "a", summary: "Get a trade number on the 2016 Freewheeler" }),
    mkTodo({ id: "b", summary: "Call back Tuesday at 2pm" }),
    mkTodo({ id: "c", summary: "Send the payoff quote" }),
    mkTodo({ id: "d", summary: "Fourth task" }),
    mkTodo({ id: "e", summary: "Fifth task" })
  ],
  link: "https://console.example.com/?section=inbox&convId=conv-1"
});
assert.match(message, /^LeadRider: Joe pinged you — Dante Turello\./, "says who pinged and about whom");
assert.match(message, /• Get a trade number on the 2016 Freewheeler/);
assert.match(message, /\+2 more/, "long task lists collapse");
assert.match(message, /Open: https:\/\/console\.example\.com/, "link back to the thread");
assert.ok(!/Fourth task/.test(message), "only the first 3 tasks are listed");

const noTaskMessage = buildStaffPingMessage({
  managerName: "Joe",
  customerName: "Dante Turello",
  tasks: [],
  link: null
});
assert.equal(
  noTaskMessage,
  "LeadRider: Joe asked you to take a look at Dante Turello.",
  "no open card -> a plain 'take a look' ping, no invented task"
);

// Long summaries are truncated so the SMS stays short.
const longSummary = buildStaffPingMessage({
  managerName: "Joe",
  customerName: "Dante",
  tasks: [mkTodo({ summary: "x".repeat(200) })],
  link: null
});
assert.ok(longSummary.length < 130, `summary truncated, got ${longSummary.length} chars`);

// ---------------------------------------------------------------- audit trail
let history: any[] = [];
for (let i = 0; i < STAFF_PING_HISTORY_LIMIT + 5; i++) {
  history = appendStaffPingRecord(history, {
    at: iso(i * 60_000),
    byUserName: "Joe",
    toUserName: "Mike",
    taskIds: ["t1"],
    delivered: true
  });
}
assert.equal(history.length, STAFF_PING_HISTORY_LIMIT, "history is capped so the store cannot grow forever");
assert.equal(lastStaffPingAt(history), iso((STAFF_PING_HISTORY_LIMIT + 4) * 60_000), "newest ping last");
assert.equal(
  lastStaffPingAt([{ at: iso(0), byUserName: "Joe", toUserName: "Mike", taskIds: [], delivered: false }]),
  null,
  "a failed send does not start the cooldown"
);
assert.equal(lastStaffPingAt(undefined), null);

// ---------------------------------------------------------------- wiring pins
const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
assert.match(
  apiSource,
  /app\.post\("\/conversations\/:id\/ping-owner", requirePermission\("canViewAllTasks"\)/,
  "endpoint exists and is manager-gated"
);
assert.match(apiSource, /STAFF_PING_ENABLED/, "kill switch exists");
assert.match(apiSource, /STAFF_PING_COOLDOWN_MIN/, "cooldown is configurable");
assert.match(apiSource, /sendInternalSms\(decision\.targetPhone, decision\.message\)/, "internal staff SMS only");
assert.match(apiSource, /appendStaffPingRecord\(conv\.staffPings/, "every ping is recorded on the conversation");

const proxy = await fs.readFile(
  path.resolve("apps/web/src/app/api/conversations/[id]/ping-owner/route.ts"),
  "utf8"
);
assert.match(proxy, /\/ping-owner/, "console proxy route wired");

const page = await fs.readFile(path.resolve("apps/web/src/app/page.tsx"), "utf8");
assert.match(page, /pingLeadOwner/, "header button handler exists");
assert.match(
  page,
  /authUser\?\.role === "manager" \|\| authUser\?\.permissions\?\.canViewAllTasks/,
  "button is manager-gated in the UI too"
);

console.log("PASS staff ping eval");
