/**
 * Scheduling-leak reconcile eval (2026-06-25).
 *
 * Catches when a visit time was being arranged but no appointment ever got booked and it went idle —
 * the agent failed to offer times / confirm / book (Nicholas Braun: said he'd come ~10, Joe confirmed,
 * nothing scheduled). Pins the deterministic detector + that the cron reconcile surfaces it as a
 * deduped staff "book this" todo.
 *
 * Run: npx tsx scripts/scheduling_leak_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH || path.join(os.tmpdir(), `scheduling-leak-eval-${Date.now()}.json`);
const { isSchedulingLeakConversation } = await import("../services/api/src/domain/conversationStore.ts");

const NOW = new Date("2026-06-25T12:00:00.000Z");
const idleInbound = [{ direction: "in", body: "maybe around 10?", at: "2026-06-25T04:00:00.000Z" }]; // 8h idle
const mk = (state: string, o: any = {}) => ({
  dialogState: { name: state },
  appointment: o.appt ?? { status: "none" },
  messages: o.msgs ?? idleInbound,
  ...(o.extra ?? {})
});

// --- 1) Detector. ---
assert.equal(isSchedulingLeakConversation(mk("schedule_request"), NOW), true, "scheduling-pending + no appt + idle = leak");
assert.equal(isSchedulingLeakConversation(mk("schedule_offer_sent"), NOW), true, "offer sent but never booked + idle = leak");
assert.equal(
  isSchedulingLeakConversation(mk("schedule_offer_sent", { appt: { status: "confirmed" } }), NOW),
  false,
  "a confirmed appointment is not a leak"
);
assert.equal(isSchedulingLeakConversation(mk("schedule_booked"), NOW), false, "booked state is not a leak");
assert.equal(isSchedulingLeakConversation(mk("none"), NOW), false, "non-scheduling state is not a leak");
assert.equal(
  isSchedulingLeakConversation(mk("schedule_request", { msgs: [{ direction: "in", body: "10?", at: "2026-06-25T11:30:00.000Z" }] }), NOW),
  false,
  "a recent (in-progress) scheduling exchange is NOT flagged"
);
assert.equal(isSchedulingLeakConversation(mk("schedule_request", { extra: { closedReason: "sold" } }), NOW), false, "closed/sold excluded");
assert.equal(
  isSchedulingLeakConversation(mk("schedule_request", { msgs: [{ direction: "out", body: "hi", at: "2026-06-25T04:00:00.000Z" }] }), NOW),
  false,
  "no customer inbound => not a leak"
);
// Idle threshold is tunable.
assert.equal(isSchedulingLeakConversation(mk("schedule_request"), NOW, { minIdleHours: 24 }), false, "stricter idle window not yet met");

// Max-idle window: a scheduling thread idle for WEEKS is a cold/dead lead, NOT an actionable leak —
// don't flood the inbox with ancient convs (age-distribution sweep 6/25: 26 of 34 were 7+ days idle).
const ancientInbound = [{ direction: "in", body: "maybe around 10?", at: "2026-06-12T12:00:00.000Z" }]; // 13d idle
assert.equal(
  isSchedulingLeakConversation(mk("schedule_request", { msgs: ancientInbound }), NOW),
  false,
  "a scheduling thread idle for ~13 days is past the default 7-day window — NOT flagged"
);
assert.equal(
  isSchedulingLeakConversation(mk("schedule_request", { msgs: ancientInbound }), NOW, { maxIdleHours: 24 * 30 }),
  true,
  "a wider max-idle window can opt back in older threads"
);
// Boundary: the Nicholas-class recent-but-stalled leak (8h idle) stays inside the default window.
assert.equal(isSchedulingLeakConversation(mk("schedule_request"), NOW), true, "recently-stalled leak is in-window");

// --- 2) Source guard: the cron reconcile flags leaks (deduped, capped) AND self-cleans. ---
const api = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(api, /isSchedulingLeakConversation\(conv, now\)/, "the maintenance reconcile runs the detector");
assert.match(api, /scheduling_leak_flagged/, "route outcome recorded");
assert.match(api, /schedulingLeakFlaggedAt = now\.toISOString\(\)/, "deduped via the flag marker (no flood)");
assert.match(api, /SCHEDULING_LEAK_TODOS_PER_TICK/, "per-tick cap");
// Self-clean: scheduling-leak todos retire once the conv is no longer a live leak (booked/closed/aged out).
assert.match(api, /SCHEDULING_LEAK_TODO_MARKER/, "leak todos carry a stable marker for cleanup");
assert.match(api, /schedulingLeakTodosRetired/, "the reconcile retires stale leak todos");
assert.match(api, /if \(isSchedulingLeakConversation\(conv, now\)\) continue;[\s\S]*?markTodoDone\(conv\.id, t\.id\)/, "keeps live leaks, closes resolved/aged-out ones");

console.log("PASS scheduling leak eval (detector + max-idle window + cron reconcile surfacing + self-clean)");
