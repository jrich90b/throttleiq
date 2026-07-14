import { strict as assert } from "node:assert";

/**
 * morning_digest:eval — pins the morning-digest popup's pure rules
 * (apps/web/src/app/lib/morningDigest.ts). Deterministic; no LLM.
 *
 *  1. shouldShowMorningDigest — once per local day, only during working hours,
 *     only when there are open tasks. A bug here is cosmetic (popup shows twice
 *     or not at all) but the once-a-day contract is the feature, so it's pinned.
 *  2. groupTasksForDigest — the digest must agree with the Task Inbox about
 *     urgency: overdue first, money tasks rise within a bucket, earliest due
 *     first, empty buckets omitted.
 *
 * Times are built with the LOCAL Date constructor so the eval is timezone-independent.
 */

const {
  morningDigestDayKey,
  shouldShowMorningDigest,
  groupTasksForDigest,
  digestAttentionCount
} = await import("../apps/web/src/app/lib/morningDigest.ts");

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`FAIL ${name}: ${err?.message ?? err}`);
  }
}

const at = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

// ── 1. show/don't-show ───────────────────────────────────────────────────────
const morning = at(2026, 7, 14, 8, 30);

check("shows on first login of the day with open tasks", () => {
  assert.equal(
    shouldShowMorningDigest({ nowMs: morning, lastShownDayKey: null, openTaskCount: 3 }),
    true
  );
});

check("does NOT show twice on the same day (day-key dedupe)", () => {
  const key = morningDigestDayKey(morning);
  assert.equal(
    shouldShowMorningDigest({ nowMs: at(2026, 7, 14, 15, 0), lastShownDayKey: key, openTaskCount: 3 }),
    false
  );
});

check("yesterday's key shows again today", () => {
  const yesterdayKey = morningDigestDayKey(at(2026, 7, 13, 9, 0));
  assert.equal(
    shouldShowMorningDigest({ nowMs: morning, lastShownDayKey: yesterdayKey, openTaskCount: 1 }),
    true
  );
});

check("a 2am login does NOT burn the day's showing (hour gate)", () => {
  assert.equal(
    shouldShowMorningDigest({ nowMs: at(2026, 7, 14, 2, 0), lastShownDayKey: null, openTaskCount: 5 }),
    false
  );
});

check("6am is the default opening hour (boundary)", () => {
  assert.equal(
    shouldShowMorningDigest({ nowMs: at(2026, 7, 14, 6, 0), lastShownDayKey: null, openTaskCount: 1 }),
    true
  );
  assert.equal(
    shouldShowMorningDigest({ nowMs: at(2026, 7, 14, 5, 59), lastShownDayKey: null, openTaskCount: 1 }),
    false
  );
});

check("zero open tasks → no popup", () => {
  assert.equal(
    shouldShowMorningDigest({ nowMs: morning, lastShownDayKey: null, openTaskCount: 0 }),
    false
  );
});

check("day key is a local calendar date", () => {
  assert.equal(morningDigestDayKey(morning), "2026-07-14");
  assert.equal(morningDigestDayKey(at(2026, 1, 3, 7, 0)), "2026-01-03");
});

// ── 2. digest grouping/ordering ──────────────────────────────────────────────
const now = at(2026, 7, 14, 8, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const overdueCall = { id: "a", reason: "call", dueAt: iso(at(2026, 7, 12, 9, 0)) };
const overduePricing = { id: "b", reason: "pricing", dueAt: iso(at(2026, 7, 13, 9, 0)) };
const todayNote = { id: "c", reason: "other", dueAt: iso(at(2026, 7, 14, 16, 0)) };
const laterTask = { id: "d", reason: "call", dueAt: iso(at(2026, 8, 1, 9, 0)) };
const noDate = { id: "e", reason: "note" };

check("buckets come out in urgency order and empty buckets are omitted", () => {
  const groups = groupTasksForDigest([laterTask, todayNote, overdueCall, noDate], now);
  assert.deepEqual(
    groups.map(g => g.bucket),
    ["overdue", "today", "later", "no_date"]
  );
});

check("a money task (pricing) rises above an earlier-due plain task within a bucket", () => {
  const groups = groupTasksForDigest([overdueCall, overduePricing], now);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].bucket, "overdue");
  // overdueCall is due EARLIER, but pricing is sales-critical → pricing first.
  assert.deepEqual(
    groups[0].tasks.map((t: any) => t.id),
    ["b", "a"]
  );
});

check("within a bucket, same criticality sorts by earliest due", () => {
  const early = { id: "x", reason: "call", dueAt: iso(at(2026, 7, 12, 8, 0)) };
  const late = { id: "y", reason: "call", dueAt: iso(at(2026, 7, 13, 8, 0)) };
  const groups = groupTasksForDigest([late, early], now);
  assert.deepEqual(
    groups[0].tasks.map((t: any) => t.id),
    ["x", "y"]
  );
});

check("attention count = overdue + today only", () => {
  assert.equal(digestAttentionCount([overdueCall, overduePricing, todayNote, laterTask, noDate], now), 3);
});

check("empty/absent input is safe", () => {
  assert.deepEqual(groupTasksForDigest([], now), []);
  assert.equal(digestAttentionCount([], now), 0);
});

if (failures > 0) {
  console.error(`morning_digest:eval FAILED (${failures} case(s))`);
  process.exit(1);
}
console.log("morning_digest:eval OK");
