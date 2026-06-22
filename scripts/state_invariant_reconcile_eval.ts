import { strict as assert } from "node:assert";
import os from "node:os";
import * as path from "node:path";
import fs from "node:fs";
import { promises as fsp } from "node:fs";

/**
 * State-invariant reconciler eval. Backtest of the americanharley store found conversations
 * whose state had silently gone inconsistent: handed-off leads still carrying an ACTIVE
 * cadence (could auto-text mid-handoff), and orphaned handoffs that were nudged once and then
 * never again. Pins the two write-time/maintenance invariants:
 *   1. setFollowUpMode(manual_handoff) pauses an active customer cadence (post_sale/long_term
 *      preserved).
 *   2. shouldNudgeStaleHandoffLead re-surfaces a persistent orphan after reNudgeDays.
 * Plus a source guard that the maintenance pass heals pre-existing contradictions.
 * Deterministic; no LLM.
 */

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "state-reconcile-eval-"));
process.env.CONVERSATIONS_DB_PATH = path.join(tmpDir, "conversations.json");

const { setFollowUpMode, shouldNudgeStaleHandoffLead } = await import(
  "../services/api/src/domain/conversationStore.ts"
);

// --- 1. Write-time invariant: handoff pauses an active customer cadence ---
const standard: any = { id: "+1", leadKey: "+1", followUpCadence: { status: "active", kind: "standard" } };
setFollowUpMode(standard, "manual_handoff", "non_motorcycle_trade");
assert.equal(standard.followUp.mode, "manual_handoff");
assert.equal(standard.followUpCadence.status, "stopped", "standard cadence must stop on handoff");

const postSale: any = { id: "+2", leadKey: "+2", followUpCadence: { status: "active", kind: "post_sale" } };
setFollowUpMode(postSale, "manual_handoff", "service_request");
assert.equal(postSale.followUpCadence.status, "active", "post_sale cadence must survive a handoff");

// active mode must NOT stop the cadence
const active: any = { id: "+3", leadKey: "+3", followUpCadence: { status: "active", kind: "standard" } };
setFollowUpMode(active, "active", "resume");
assert.equal(active.followUpCadence.status, "active", "non-handoff mode leaves cadence alone");

// --- 2. Orphan re-nudge: nudged once but still handed off + idle re-surfaces after reNudgeDays ---
const now = new Date("2026-06-22T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const mk = (over: any = {}): any => ({
  id: "+9",
  leadKey: "+9",
  followUp: { mode: "manual_handoff" },
  messages: [{ direction: "in", body: "hi", at: new Date(now.getTime() - 10 * DAY).toISOString() }],
  ...over
});
assert.equal(shouldNudgeStaleHandoffLead(mk(), false, now), true, "orphaned handoff, never nudged => nudge");
assert.equal(shouldNudgeStaleHandoffLead(mk(), true, now), false, "has open todo => no nudge");
assert.equal(
  shouldNudgeStaleHandoffLead(mk({ staleHandoffNudgedAt: new Date(now.getTime() - 2 * DAY).toISOString() }), false, now),
  false,
  "nudged 2d ago => still within dedup window"
);
assert.equal(
  shouldNudgeStaleHandoffLead(mk({ staleHandoffNudgedAt: new Date(now.getTime() - 20 * DAY).toISOString() }), false, now),
  true,
  "nudged 20d ago, still orphaned => re-nudge"
);
assert.equal(
  shouldNudgeStaleHandoffLead(mk({ followUpCadence: { status: "active" } }), false, now),
  false,
  "active cadence => the cadence is the coverage, no nudge"
);

// --- Source guards ---
const store = fs.readFileSync("services/api/src/domain/conversationStore.ts", "utf8");
assert.ok(
  /mode === "manual_handoff" && conv\.followUpCadence\?\.status === "active"/.test(store),
  "setFollowUpMode must enforce the handoff->pause-cadence invariant"
);
const idx = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.ok(
  /cadence_handoff_invariant_heal/.test(idx),
  "maintenance pass must heal pre-existing cadence-active-while-handoff contradictions"
);

await fsp.rm(tmpDir, { recursive: true, force: true });
console.log("state_invariant_reconcile:eval ok");
