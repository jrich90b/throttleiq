/**
 * TLP CRM-log catch-up eval (2026-07-06) — pins the crm_log_stale SELF-HEAL.
 *
 * Root cause (7/6 daily review): the serialized TLP queue is in-memory fire-and-forget — a
 * restart between "send" and "log" drops queued jobs with no failure recorded, so the CRM
 * gap is permanent (Kellen +17167995197's 7/3 Custom Coverage reminder, crm={}; Chuck
 * +17163197142's 7/1 second console send, 67s after a logged one). Prevention alone can't
 * close this class — the fix is a periodic catch-up sweep that re-queues conversations
 * whose latest REAL outbound is newer than their last CRM log.
 *
 * Pins:
 *   1. Decision table — findTlpLogCatchupCandidates (pure): candidate/skip per the
 *      fail-direction contract (unsure => skip; a missed catch-up self-heals next sweep).
 *   2. Source guards — the interval is registered behind TLP_LOG_CATCHUP_MINUTES (0 = kill
 *      switch) and re-queues through the SAME serialized logger (no second Chromium path).
 *
 * Run: npx tsx scripts/tlp_log_catchup_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { findTlpLogCatchupCandidates } from "../services/api/src/domain/tlpLogCatchup.ts";

const NOW = Date.parse("2026-07-06T12:00:00.000Z");
const min = (n: number) => n * 60 * 1000;
const day = (n: number) => n * 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

const conv = (over: any) => ({
  id: over.id ?? "+15550000001",
  lead: { leadRef: "12345" },
  crm: {},
  messages: [],
  ...over
});
const out = (atMs: number, provider = "twilio", extra: any = {}) => ({
  direction: "out",
  provider,
  at: iso(atMs),
  ...extra
});

// --- 1) Decision table ---

// The Kellen shape: leadRef present, real send 3 days ago, never logged => candidate.
assert.deepEqual(
  findTlpLogCatchupCandidates([conv({ id: "+17167995197", messages: [out(NOW - day(3))] })], NOW),
  ["+17167995197"],
  "a never-logged real outbound past the grace window is a catch-up candidate"
);

// The Chuck shape: logged at T, a SECOND real send after T never logged => candidate.
assert.deepEqual(
  findTlpLogCatchupCandidates(
    [conv({ id: "+17163197142", crm: { lastLoggedAt: iso(NOW - day(5) - min(1)) }, messages: [out(NOW - day(5) - min(1)), out(NOW - day(5))] })],
    NOW
  ),
  ["+17163197142"],
  "an outbound newer than the last CRM log is a catch-up candidate"
);

// Already logged up to (or past) the latest outbound => skip.
assert.deepEqual(
  findTlpLogCatchupCandidates(
    [conv({ crm: { lastLoggedAt: iso(NOW - day(1)) }, messages: [out(NOW - day(1))] })],
    NOW
  ),
  [],
  "a fully-logged conversation is not re-queued"
);

// Inside the grace window => skip (the normal send-path log may still be in flight).
assert.deepEqual(
  findTlpLogCatchupCandidates([conv({ messages: [out(NOW - min(5))] })], NOW),
  [],
  "a fresh outbound inside the grace window is left to the normal send-path log"
);

// No leadRef anywhere => skip (the logger would no-op; don't burn a queue slot).
assert.deepEqual(
  findTlpLogCatchupCandidates([conv({ lead: {}, messages: [out(NOW - day(2))] })], NOW),
  [],
  "no leadRef => nothing to log against => skip"
);
// latestLead.leadRef alone is enough.
assert.deepEqual(
  findTlpLogCatchupCandidates([conv({ lead: {}, latestLead: { leadRef: "9" }, messages: [out(NOW - day(2))] })], NOW),
  ["+15550000001"],
  "latestLead.leadRef also qualifies"
);

// draft_ai rows were never sent => not a real outbound => skip.
assert.deepEqual(
  findTlpLogCatchupCandidates([conv({ messages: [out(NOW - day(2), "draft_ai")] })], NOW),
  [],
  "an unsent draft_ai row must never trigger a CRM log"
);

// Ancient gaps beyond the lookback => skip (stale CRM value, first-rollout browser storm).
assert.deepEqual(
  findTlpLogCatchupCandidates([conv({ messages: [out(NOW - day(45))] })], NOW),
  [],
  "outbounds older than the lookback are not swept"
);

// Unparseable timestamps fail toward skip.
assert.deepEqual(
  findTlpLogCatchupCandidates([conv({ messages: [{ direction: "out", provider: "twilio", at: "garbage" }] })], NOW),
  [],
  "garbage timestamps => skip (never enqueue on uncertainty)"
);

// Batch cap + oldest-gap-first ordering.
const many = Array.from({ length: 8 }, (_, i) =>
  conv({ id: `+1555000000${i}`, messages: [out(NOW - day(1) - min(i))] })
);
const batch = findTlpLogCatchupCandidates(many, NOW);
assert.equal(batch.length, 5, "sweep batch is capped (backlog drains over multiple sweeps)");
assert.equal(batch[0], "+15550000007", "oldest gap drains first");

// --- 2) Source guards ---
const indexSrc = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
assert.match(
  indexSrc,
  /TLP_LOG_CATCHUP_MINUTES/,
  "the catch-up sweep must be registered behind the TLP_LOG_CATCHUP_MINUTES kill switch"
);
assert.match(
  indexSrc,
  /findTlpLogCatchupCandidates\(getAllConversations\(\)[\s\S]{0,400}queueTlpLogForConversation\(conv\)/,
  "the sweep must re-queue through the SAME serialized TLP logger (no second Chromium path)"
);

// ci:eval wiring.
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
assert.ok(
  String(pkg.scripts?.["ci:eval"] ?? "").includes("tlp_log_catchup:eval"),
  "tlp_log_catchup:eval is wired into ci:eval"
);

console.log("PASS tlp log catch-up eval (decision table 10 rows + serialized-queue + kill-switch source guards)");
