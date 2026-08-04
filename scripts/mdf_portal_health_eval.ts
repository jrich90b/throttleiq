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

const { findMdfPortalFailures, mdfPortalTaskClaimId } = await import("../services/api/src/domain/mdfPortalHealth.ts");
const { mdfPortalClaimMarker } = await import("../services/api/src/domain/agentTaskStore.ts");
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

// ── RECOVERED CLAIMS: a failed attempt that a later retry of the SAME claim finished is history.
// Production pin — American Harley, 2026-08-03: portal task agent_msdk4gaz_d274td BLOCKED at 18:23 on
// claim mdf_b8b283a374546_1785780872299 ("Ansira changed the form"), and agent_msdkjd8g_6pfp3i saved the
// draft for that same claim 15 minutes later. Before this guard it re-surfaced as a P1 every day for the
// whole 7-day window; on 8/4 all four P1 MDF items in the work order were recovered claims like this.
{
  const NOW_AH = Date.parse("2026-08-04T04:40:00.000Z");
  const CLAIM = "mdf_b8b283a374546_1785780872299";
  const OTHER = "mdf_65220e89c062a_1784305311745";
  const instr = (claim: string) => `${mdfPortalClaimMarker(claim)} Use browser-use ... MDF claim ID: ${claim}`;
  const blocked = {
    id: "agent_msdk4gaz_d274td",
    kind: "mdf_portal",
    status: "blocked",
    instructions: instr(CLAIM),
    updatedAt: "2026-08-03T18:23:20.138Z",
    output: { summary: "MDF portal runner blocked before completion. MDF preflight failed — the Ansira Create MDF Recap form changed (likely an Ansira update). No draft was created (nothing was saved)." }
  };
  const saved = {
    id: "agent_msdkjd8g_6pfp3i",
    kind: "mdf_portal",
    status: "needs_approval",
    instructions: instr(CLAIM),
    updatedAt: "2026-08-03T18:38:44.638Z",
    output: { summary: "MDF portal draft run completed. Review the portal before any final submit. Ansira MDF draft saved successfully. Claim ID: RB26080001152813. Status: Incomplete." }
  };
  const ah = (tasks: any[]) =>
    findMdfPortalFailures({ tasks, now: NOW_AH, windowDays: 7, stuckMinutes: 30 }).map(a => a.dimension).sort();

  eq(mdfPortalTaskClaimId(blocked), CLAIM, "claim id comes from the [mdf-portal:<id>] instruction marker");
  eq(mdfPortalTaskClaimId({ kind: "mdf_portal", status: "completed", instructions: "[mdf-login] Open H-DNet" }), "", "a login task carries no claim id");

  eq(ah([blocked]), ["mdf_assistant_failure"], "blocked with no retry => still surfaced");
  eq(ah([blocked, saved]), [], "blocked then the SAME claim saved a draft later => not surfaced");
  eq(ah([blocked, { ...saved, instructions: instr(OTHER) }]), ["mdf_assistant_failure"], "a later success for a DIFFERENT claim cures nothing");
  eq(ah([{ ...blocked, updatedAt: "2026-08-03T19:00:00.000Z" }, saved]), ["mdf_assistant_failure"], "a success BEFORE the failure cures nothing (order matters)");
  eq(ah([{ ...blocked, instructions: "no marker" }, saved]), ["mdf_assistant_failure"], "a failure with no claim marker is never suppressed (fail toward flagging)");
  eq(ah([blocked, { ...saved, output: { summary: "" } }]), ["mdf_assistant_failure"], "a queued retry that has not run yet (no summary) is not a recovery");
  eq(ah([blocked, { ...saved, output: { summary: "Ansira MDF draft run finished, but save confirmation was not detected." } }]),
    ["mdf_assistant_failure", "mdf_assistant_failure"], "a later run that did not confirm the save is not a recovery");
  eq(ah([blocked, { ...saved, output: { summary: "MDF preflight failed — a control the runner depends on was missing." } }]),
    ["mdf_assistant_failure"], "recovery needs the POSITIVE saved-draft signal, not just the absence of a known failure phrase");
  eq(ah([{ ...blocked, status: "needs_approval", output: { summary: "the browser is not reachable, so the guided fallback opened" } }, saved]),
    [], "the guided-fallback branch is cured by a later saved draft too");
  // A hung runner is a PROCESS problem, not a claim outcome — finishing the claim elsewhere doesn't fix it.
  eq(ah([{ ...blocked, status: "running", output: { summary: "" } }, saved]), ["mdf_assistant_stuck"], "stuck-in-running is NOT silenced by a later success");
}

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
