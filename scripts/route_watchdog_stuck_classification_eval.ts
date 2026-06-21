/**
 * Route-watchdog stuck-turn classification eval (pure, no LLM).
 *
 * Pins the de-noising of the "routing-stuck-turns" signal (2026-06-20 prod
 * investigation: the watchdog flagged 44 stuck turns, 0 of them genuine misses
 * — all closed / handed-off / paused / rep-owned / months-old). The watchdog
 * now classifies every matched turn and surfaces only the ACTIONABLE subset as
 * its headline `count`, keeping the benign rows in a `suppressed` block.
 *
 * Layers:
 *   1. Source guard — the watchdog imports the pure classifier and assembles the
 *      segmented output shape (actionable `count`/`rows` + `suppressed` +
 *      `matchedTotal` + `maxAgeSec`).
 *   2. Decision table — each suppression reason + the actionable case, in the
 *      documented priority order (terminal state wins).
 *   3. Invariant — the default recency ceiling is a sane, positive horizon.
 *
 * Run: npx tsx scripts/route_watchdog_stuck_classification_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  classifyStuckTurn,
  STUCK_MAX_AGE_SEC_DEFAULT,
  type StuckConvLike,
  type StuckSuppressionReason
} from "../services/api/src/domain/routeWatchdogClassification.ts";

// --- 1) Source guard (no logic): the watchdog must consume the classifier and
//        emit the segmented shape so agent_manager reads an accurate count. ---
const watchdog = fs.readFileSync("scripts/route_audit_watchdog.ts", "utf8");
assert.ok(
  /classifyStuckTurn/.test(watchdog) && /routeWatchdogClassification/.test(watchdog),
  "the watchdog must import + use classifyStuckTurn from the pure module"
);
assert.ok(
  /actionable/.test(watchdog) && /suppressed:/.test(watchdog) && /matchedTotal/.test(watchdog),
  "the watchdog summary must segment actionable vs suppressed and report matchedTotal"
);
assert.ok(
  /reasonCounts/.test(watchdog),
  "the suppressed block must carry per-reason counts for triage"
);
assert.ok(
  /--stuck-max-age-sec/.test(watchdog) && /ROUTE_WATCHDOG_STUCK_MAX_AGE_SEC/.test(watchdog),
  "the recency ceiling must be tunable via flag + env"
);

// --- 2) Decision table (pure). Priority: terminal state wins. ---
const RECENT = 60 * 60; // 1h — inside the default ceiling
const OLD = STUCK_MAX_AGE_SEC_DEFAULT + 60 * 60; // past the ceiling

type Row = {
  id: string;
  conv: StuckConvLike;
  ageSec: number;
  actionable: boolean;
  reason: StuckSuppressionReason | null;
  maxAgeSec?: number;
};

const rows: Row[] = [
  // The one that matters: recent, open, suggest-mode, no suppression → actionable.
  { id: "actionable_recent_open", conv: { status: null, mode: "suggest", followUp: { mode: "active" } }, ageSec: RECENT, actionable: true, reason: null },
  // Terminal: a closed conversation can never be a live stall (wins even if recent).
  { id: "closed_recent", conv: { status: "closed", mode: "suggest", followUp: { mode: "active" } }, ageSec: RECENT, actionable: false, reason: "closed" },
  // closed wins over a handoff mode too (priority order).
  { id: "closed_beats_handoff", conv: { status: "closed", mode: "suggest", followUp: { mode: "manual_handoff" } }, ageSec: RECENT, actionable: false, reason: "closed" },
  // Staff took over.
  { id: "manual_handoff", conv: { status: null, mode: "suggest", followUp: { mode: "manual_handoff" } }, ageSec: RECENT, actionable: false, reason: "manual_handoff" },
  // Customer dispositioned out.
  { id: "paused_indefinite", conv: { status: "open", mode: "suggest", followUp: { mode: "paused_indefinite" } }, ageSec: RECENT, actionable: false, reason: "paused_indefinite" },
  // Inventory watch.
  { id: "holding_inventory", conv: { status: null, mode: "suggest", followUp: { mode: "holding_inventory" } }, ageSec: RECENT, actionable: false, reason: "holding_inventory" },
  // Rep owns the thread directly.
  { id: "human_mode", conv: { status: null, mode: "human", followUp: { mode: "active" } }, ageSec: RECENT, actionable: false, reason: "human_mode" },
  // Stale lead past the recency ceiling — owned by cadence/closeout, not a P0.
  { id: "aged_out", conv: { status: null, mode: "suggest", followUp: { mode: "active" } }, ageSec: OLD, actionable: false, reason: "aged_out" },
  // followUp mode wins over the age ceiling (handoff is reported even when old).
  { id: "handoff_beats_aged_out", conv: { status: null, mode: "suggest", followUp: { mode: "manual_handoff" } }, ageSec: OLD, actionable: false, reason: "manual_handoff" },
  // Missing followUp / mode are tolerated → recent unsuppressed stays actionable.
  { id: "actionable_sparse_conv", conv: { status: null, mode: "suggest", followUp: null }, ageSec: RECENT, actionable: true, reason: null },
  // A custom (smaller) ceiling still suppresses a turn beyond it.
  { id: "custom_ceiling_aged_out", conv: { status: null, mode: "suggest", followUp: { mode: "active" } }, ageSec: 2 * 60 * 60, actionable: false, reason: "aged_out", maxAgeSec: 60 * 60 }
];

for (const r of rows) {
  const got = classifyStuckTurn(r.conv, { ageSec: r.ageSec, maxAgeSec: r.maxAgeSec });
  assert.equal(got.actionable, r.actionable, `classify[${r.id}] actionable expected ${r.actionable}, got ${got.actionable}`);
  assert.equal(
    got.suppressionReason,
    r.reason,
    `classify[${r.id}] reason expected ${r.reason}, got ${got.suppressionReason}`
  );
}

// --- 3) Invariant: the default ceiling is a sane, positive horizon (7 days). ---
assert.ok(STUCK_MAX_AGE_SEC_DEFAULT > 0, "recency ceiling must be positive");
assert.equal(STUCK_MAX_AGE_SEC_DEFAULT, 7 * 24 * 60 * 60, "default ceiling should be 7 days");

const actionableCount = rows.filter(r => r.actionable).length;
console.log(
  `PASS route-watchdog stuck classification — ${rows.length} cases (${actionableCount} actionable, ${rows.length - actionableCount} suppressed), default ceiling ${STUCK_MAX_AGE_SEC_DEFAULT}s`
);
