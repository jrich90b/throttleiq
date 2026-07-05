/**
 * MDF assistant health detector eval.
 *
 * Pins findMdfPortalFailures (domain/mdfPortalHealth.ts): an MDF portal run that BLOCKED, is STUCK in
 * "running", or fell back to the guided packet because the portal didn't load surfaces as an anomaly;
 * a clean draft / completed / out-of-window run does not. Plus the classifier (Tier-2 escalate) and the
 * sibling-feed registration in anomaly_loop_detect.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const { findMdfPortalFailures } = await import("../services/api/src/domain/mdfPortalHealth.ts");
const { classifyOutcomeAnomaly } = await import("../services/api/src/domain/anomalyClassifier.ts");

const NOW = Date.parse("2026-06-29T18:00:00.000Z");
const T = (iso: string, over: Record<string, unknown> = {}) => ({
  id: "agent_x",
  kind: "mdf_portal",
  updatedAt: iso,
  ...over
});
const dims = (tasks: any[]) =>
  findMdfPortalFailures({ tasks, now: NOW, windowDays: 7, stuckMinutes: 30 }).map(a => a.dimension).sort();
let n = 0;
const eq = (got: unknown, exp: unknown, m: string) => { assert.deepEqual(got, exp, m); n++; };

// ── blocked = a hard failure (portal/form didn't complete). P1 when stale (>4h), P2 when fresh.
{
  const a = findMdfPortalFailures({ tasks: [T("2026-06-29T17:00:00.000Z", { status: "blocked", output: { summary: "session has expired" } })], now: NOW, windowDays: 7 });
  eq(a.map(x => x.dimension), ["mdf_assistant_failure"], "recent blocked => mdf_assistant_failure");
  eq(a[0].severity, "P2", "blocked <4h => P2");
  eq(a[0].convId, "mdf:agent_x", "synthetic mdf:<taskId> id");
}
eq(findMdfPortalFailures({ tasks: [T("2026-06-27T18:00:00.000Z", { status: "blocked", output: { summary: "x" } })], now: NOW, windowDays: 7 })[0].severity, "P1", "blocked >4h (within window) => P1");
eq(dims([T("2026-06-15T18:00:00.000Z", { status: "blocked", output: { summary: "x" } })]), [], "blocked OUTSIDE the 7d window => not surfaced (stale/abandoned)");

// ── stuck: status "running" past the stuck threshold = the runner died/hung.
eq(dims([T("2026-06-29T17:00:00.000Z", { status: "running" })]), ["mdf_assistant_stuck"], "running >30m => mdf_assistant_stuck");
eq(dims([T("2026-06-29T17:50:00.000Z", { status: "running" })]), [], "running <30m => still in progress, not flagged");

// ── needs_approval: a clean draft is NOT a failure; a fallback-because-it-didn't-load IS.
eq(dims([T("2026-06-29T16:00:00.000Z", { status: "needs_approval", output: { summary: "the browser is not reachable, so the guided fallback opened the normal desktop browser." } })]),
  ["mdf_assistant_failure"], "needs_approval + load-failure/fallback summary => failure");
eq(dims([T("2026-06-29T16:00:00.000Z", { status: "needs_approval", output: { summary: "Ansira MDF draft saved successfully. Claim ID RB123. Status: Incomplete." } })]),
  [], "needs_approval + clean draft summary => NOT a failure (normal review-pending)");

// ── completed / non-mdf are ignored.
eq(dims([T("2026-06-29T17:00:00.000Z", { status: "completed", output: { summary: "saved successfully" } })]), [], "completed => not flagged");
eq(dims([T("2026-06-29T17:00:00.000Z", { kind: "other", status: "blocked", output: { summary: "x" } })]), [], "non-mdf_portal task => ignored");

// ── Classifier: both MDF dimensions are Tier-2 escalate, notify, never auto-merge (integration diagnosis).
for (const dimension of ["mdf_assistant_failure", "mdf_assistant_stuck"]) {
  const c = classifyOutcomeAnomaly({ category: "state", dimension, healed: false, severity: "P2" }, {});
  eq([c.tier, c.action, c.notify, c.autoMergeEligible], [2, "escalate", true, false], `${dimension} => Tier 2 escalate/notify/no-auto-merge`);
  const g = classifyOutcomeAnomaly({ category: "state", dimension, healed: false, severity: "P2" }, { graduatedCategories: new Set([dimension]) });
  eq(g.autoMergeEligible, false, `${dimension} never auto-merges even if graduated`);
}

// ── Source pin: the MDF health sibling feed is merged into the unified work order.
const detect = await fs.readFile(path.resolve("scripts/anomaly_loop_detect.ts"), "utf8");
assert.match(detect, /mdf_health", "latest\.json"/, "anomaly_loop_detect must merge the mdf_health sibling feed");

console.log(`PASS mdf portal health eval (${n} assertions)`);
