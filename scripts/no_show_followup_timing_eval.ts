/**
 * No-show follow-up timing eval (pure, no LLM).
 *
 * Pins the Joe-approved behavior (2026-07-02; Gary, +17167069902 — "I recorded the outcome of
 * did not show and needs follow up. And it went into a 7/7 cadence for some reason"): a
 * did-not-show + needs-follow-up outcome gets its FIRST touch the next business day (1-2
 * calendar days; Fri/Sat outcomes land Monday, never Sunday) — not a flat 72h pause and not a
 * week-out standard step.
 *
 * Layers:
 *   1. resolveNoShowFollowUpDueAt — next-business-day math across the week (TZ-aware).
 *   2. Wiring — the structured outcome path uses it for did_not_show; the attendance-question
 *      path derives pause_next_business_day for no_show (72h retired for no-shows).
 *
 * Run: npx tsx scripts/no_show_followup_timing_eval.ts
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import * as path from "node:path";

process.env.CONVERSATIONS_DB_PATH = path.join(os.tmpdir(), `no-show-timing-eval-${process.pid}.json`);
const { resolveNoShowFollowUpDueAt } = (await import(
  "../services/api/src/domain/conversationStore.ts"
)) as any;

const TZ = "America/New_York";
let n = 0;
const eq = (a: unknown, b: unknown, m: string) => {
  assert.deepEqual(a, b, m);
  n++;
};

const localDay = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

// Wednesday outcome → Thursday 10:30 local (1 day).
eq(localDay(resolveNoShowFollowUpDueAt("2026-07-01T18:00:00.000Z", TZ)), "Thu, 07/02/2026, 10:30", "Wed no-show → Thu 10:30");
// Thursday → Friday.
eq(localDay(resolveNoShowFollowUpDueAt("2026-07-02T18:00:00.000Z", TZ)), "Fri, 07/03/2026, 10:30", "Thu no-show → Fri 10:30");
// Friday → Monday (2-day window bound, never the weekend).
eq(localDay(resolveNoShowFollowUpDueAt("2026-07-03T18:00:00.000Z", TZ)), "Mon, 07/06/2026, 10:30", "Fri no-show → Mon 10:30");
// Saturday → Monday.
eq(localDay(resolveNoShowFollowUpDueAt("2026-07-04T18:00:00.000Z", TZ)), "Mon, 07/06/2026, 10:30", "Sat no-show → Mon 10:30");
// Sunday → Monday.
eq(localDay(resolveNoShowFollowUpDueAt("2026-07-05T18:00:00.000Z", TZ)), "Mon, 07/06/2026, 10:30", "Sun no-show → Mon 10:30");
// Late-evening local edge: 11pm ET Wednesday is already Thu 03:00 UTC — still "tomorrow" locally.
eq(localDay(resolveNoShowFollowUpDueAt("2026-07-02T03:00:00.000Z", TZ)), "Thu, 07/02/2026, 10:30", "Wed 11pm ET no-show → Thu 10:30 (local-day math, not UTC)");

// --- 2) Wiring guards. ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.ok(
  /args\.primaryStatus === "did_not_show"\s*\?\s*resolveNoShowFollowUpDueAt\(now, timezone\)/.test(index),
  "the structured outcome path must anchor a did_not_show fallback on the next business day"
);
assert.ok(
  /if \(outcome === "no_show"\) return "pause_next_business_day";/.test(index),
  "the attendance-question path must derive pause_next_business_day for a no-show (72h retired)"
);
assert.ok(
  /action === "pause_next_business_day"\s*\?\s*resolveNoShowFollowUpDueAt\(nowIso, tz\)/.test(index),
  "applyAction must implement pause_next_business_day via the shared helper"
);
n += 3;

console.log(`PASS no-show follow-up timing eval (${n} assertions)`);
