import { strict as assert } from "node:assert";
import fs from "node:fs";

/**
 * Operator "Report issue" → self-healing-loop feed eval (2026-06-27).
 *
 * The existing dashboard "Report issue" button (opsAnomalyStore) is the explicit-human-flag net: a rep
 * flags something wrong on a conversation with a note — the strongest "this was wrong + here's why"
 * signal there is. This wires the AGENT-BEHAVIOR subset of those reports into the code loop (on top of
 * the support-ticket flow they already trigger).
 *
 * Pins: (1) decideOpsAnomalyReportedIssue — only agent-behavior types cross (routing/cadence/appointment/
 * task_inbox/handoff/other); tone + infra (inventory/integration/ui) are dropped; closed/info/no-note/
 * convId-less/stale are dropped; carries the note. (2) the classifier escalates reported_issue Tier 2
 * (notify, never auto-merge, even if graduated). (3) the sweep + the detect-merge wiring (source guards).
 */

const { decideOpsAnomalyReportedIssue } = await import("../services/api/src/domain/conversationOutcomeAudit.ts");
const { classifyOutcomeAnomaly } = await import("../services/api/src/domain/anomalyClassifier.ts");

const NOW = new Date("2026-06-27T12:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
const report = (over: any = {}) => ({
  id: "a1",
  type: "cadence",
  severity: "warning",
  title: "Conversation issue",
  note: "no follow-up cadence was scheduled after he asked us to check back",
  status: "open",
  createdAt: ago(1),
  context: { convId: "+1555", leadKey: "+1555" },
  ...over
});
const map = (over: any = {}) => decideOpsAnomalyReportedIssue(report(over), { now: NOW });

// 1. MAPPING — an open, recent, agent-behavior report with a note + convId crosses, carrying the note.
{
  const a = map();
  assert(a, "agent-behavior report => anomaly");
  assert.equal(a!.dimension, "reported_issue", "dimension");
  assert.equal(a!.category, "feedback", "reported_issue maps to feedback category");
  assert.equal(a!.severity, "P2", "P2");
  assert.equal(a!.convId, "+1555", "convId carried (loop needs it)");
  assert.ok(/cadence/.test(a!.detail) && /follow-up cadence/.test(a!.detail), "detail carries type + note");
}

// AGENT-BEHAVIOR types all cross.
for (const type of ["routing", "cadence", "appointment", "task_inbox", "handoff", "other"]) {
  assert(map({ type }), `${type} (agent behavior) => anomaly`);
}
// SUPPORT-only types are dropped (tone covered by 👎 + voice layer; infra can't be parser-fixed).
for (const type of ["tone", "inventory", "integration", "ui"]) {
  assert.equal(map({ type }), null, `${type} (support-only) => null`);
}

// NOISE FLOOR — closed / info / no-note / no-convId / stale all drop.
assert.equal(map({ status: "closed" }), null, "closed => null");
assert.equal(map({ severity: "info" }), null, "info severity => null");
assert.equal(map({ note: "", title: "" }), null, "no note/title => null");
assert.equal(map({ context: { convId: "" } }), null, "no convId => null (agent reports are conv-scoped)");
assert.equal(map({ createdAt: ago(40) }), null, "stale (>21d) => null");
// title is a fallback when note is blank.
assert.ok(map({ note: "", title: "Conversation issue: agent mis-routed" }), "title is used when note is blank");

// 2. CLASSIFICATION — always Tier 2 escalate, notify, never auto-merge (even if graduated).
const cls = classifyOutcomeAnomaly(map()!, {});
assert.equal(cls.tier, 2, "reported_issue => Tier 2");
assert.equal(cls.action, "escalate", "escalate (approve-first)");
assert.equal(cls.notify, true, "notify");
assert.equal(cls.autoMergeEligible, false, "never auto-merge");
assert.equal(
  classifyOutcomeAnomaly(map()!, { graduatedCategories: new Set(["reported_issue"]) }).autoMergeEligible,
  false,
  "stays approve-first even if the dimension graduates (human judgment)"
);

// 3. WIRING — the sweep emits the sibling feed and anomaly_loop_detect merges it.
const sweep = fs.readFileSync("scripts/ops_anomaly_loop_sweep.ts", "utf8");
assert.match(sweep, /decideOpsAnomalyReportedIssue/, "sweep uses the mapper");
assert.match(sweep, /ops_anomaly", "latest\.json"|ops_anomaly\/latest\.json/, "sweep writes the sibling feed");
const det = fs.readFileSync("scripts/anomaly_loop_detect.ts", "utf8");
assert.match(det, /"ops_anomaly", "latest\.json"/, "anomaly_loop_detect merges the ops-anomaly feed");

console.log("PASS reported_issue eval");
