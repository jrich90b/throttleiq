/**
 * MDF assistant (Ansira co-op recap portal runner) health detector. Pure + deterministic, read-only.
 *
 * The MDF portal runner drives a logged-in Chrome (CDP) to fill the Ansira "Create MDF Recap" form.
 * When something fails to load — the CDP Chrome is down, the H-DNet session expired, the form didn't
 * render, Ansira changed the layout, or browser-use timed out — the run records the outcome on its
 * AgentTask (kind "mdf_portal") via updateAgentTaskStatus: status "blocked" (a hard failure, no draft),
 * a stuck "running" (the runner died/hung), or "needs_approval" with a fallback summary (it fell back to
 * the guided packet because the portal didn't load). Until now nothing surfaced these, so a broken MDF
 * assistant was invisible.
 *
 * This folds the failure signal into the unified anomaly feed (a SIBLING sweep, like watch_fire_miss —
 * MDF runs aren't conversations, so they carry a synthetic `mdf:<taskId>` id). Recency-bounded so old,
 * abandoned runs don't resurface forever; the classifier routes it Tier-2 escalate (an integration
 * diagnosis — ansira-form-sync / restart the CDP Chrome / re-login — not a parser fix or auto-heal).
 *
 * RECOVERED CLAIMS (2026-08-04): a blocked run is a claim-level outcome, and the operator's normal
 * response is to press Start again. Judging each task in isolation meant a claim that FAILED and then
 * SUCCEEDED minutes later kept surfacing as P1 every day for the whole 7-day window — on 8/4 all four
 * P1s in the work order were two such claims (`mdf_65220e89c062a_...` recovered 7/31 22:33,
 * `mdf_b8b283a374546_...` recovered 8/3 18:38, 15 minutes after its block). So a failure is suppressed
 * when a LATER task for the SAME claim id saved a draft. Scope is deliberately narrow: only the two
 * claim-outcome branches (blocked / fell-back-to-guided) are curable this way. `mdf_assistant_stuck`
 * reports a hung runner process, not a claim outcome, so a later success never silences it.
 */

export type MdfPortalTask = {
  id?: string | null;
  kind?: string | null;
  status?: string | null;
  /** Carries the `[mdf-portal:<claimId>]` marker written by agentTaskStore.mdfPortalClaimMarker. */
  instructions?: string | null;
  updatedAt?: string | null;
  output?: { summary?: string | null } | null;
};

export type MdfHealthAnomaly = {
  convId: string;
  leadKey: string;
  dimension: "mdf_assistant_failure" | "mdf_assistant_stuck";
  category: "state";
  severity: "P1" | "P2";
  healed: false;
  detail: string;
};

// A "needs_approval" task is normally a clean draft awaiting review — flag it ONLY when the summary
// signals that the portal/asset failed to load and the runner fell back (the "fails to load" class).
const LOAD_FAILURE_RE =
  /not reachable|guided fallback|could not open|sign-?in|session has expired|save confirmation was not detected|form layout|changed the form|could not find the required|login page|timed out|failed to load|blocked before completion/i;

/** The MDF claim this portal task was launched for, or "" (login/legacy tasks carry no marker). */
export function mdfPortalTaskClaimId(task: MdfPortalTask): string {
  return (String(task?.instructions ?? "").match(/\[mdf-portal:([^\]]+)\]/)?.[1] ?? "").trim();
}

// The runner's own saved-draft wording (mdf_portal_runner.ts): "Ansira MDF draft saved successfully." /
// "MDF portal draft run completed." Its failure twin ("save confirmation was not detected") is a
// LOAD_FAILURE_RE hit. Recovery demands this POSITIVE signal rather than merely "no known failure
// phrase", so a novel failure wording can never silence a real block.
const DRAFT_SAVED_RE = /draft saved successfully|draft run completed/i;

/**
 * Did this task end with a draft saved in Ansira? Status "completed", or a "needs_approval" run that
 * reported a saved draft (a needs_approval task with NO summary has not run yet — same has-run-output
 * rule agentTaskStore.findActivePortalDraftTask uses to decide a task is still active).
 */
function isPortalSuccess(task: MdfPortalTask): boolean {
  const status = String(task?.status ?? "").toLowerCase();
  const summary = String(task?.output?.summary ?? "").trim();
  if (status === "completed") return true;
  return status === "needs_approval" && DRAFT_SAVED_RE.test(summary) && !LOAD_FAILURE_RE.test(summary);
}

/** claimId -> the newest timestamp at which that claim's draft was saved. */
function latestSuccessByClaim(tasks: MdfPortalTask[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tasks ?? []) {
    if (String(t?.kind ?? "") !== "mdf_portal") continue;
    const claimId = mdfPortalTaskClaimId(t);
    if (!claimId || !isPortalSuccess(t)) continue;
    const at = Date.parse(String(t?.updatedAt ?? ""));
    if (!Number.isFinite(at)) continue;
    out.set(claimId, Math.max(out.get(claimId) ?? -Infinity, at));
  }
  return out;
}

export function findMdfPortalFailures(args: {
  tasks: MdfPortalTask[];
  now?: number;
  windowDays?: number;
  stuckMinutes?: number;
}): MdfHealthAnomaly[] {
  const now = args.now ?? Date.now();
  const windowMs = (args.windowDays ?? 7) * 24 * 60 * 60 * 1000;
  const stuckMs = (args.stuckMinutes ?? 30) * 60 * 1000;
  const out: MdfHealthAnomaly[] = [];
  const recoveredAt = latestSuccessByClaim(args.tasks ?? []);

  for (const t of args.tasks ?? []) {
    if (String(t?.kind ?? "") !== "mdf_portal") continue;
    const status = String(t?.status ?? "").toLowerCase();
    const at = Date.parse(String(t?.updatedAt ?? ""));
    if (!Number.isFinite(at) || now - at > windowMs) continue; // recency: don't resurface old/abandoned runs
    const ageMin = (now - at) / (60 * 1000);
    const summary = String(t?.output?.summary ?? "").replace(/\s+/g, " ").trim();
    const id = String(t?.id ?? "").trim();
    const base = { convId: `mdf:${id}`, leadKey: `mdf:${id}`, category: "state" as const, healed: false as const };
    // A retry of the SAME claim saved the draft afterwards — the work got done, so this failed attempt
    // is history, not an open problem. A success BEFORE the failure cures nothing.
    const claimId = mdfPortalTaskClaimId(t);
    const claimRecovered = !!claimId && (recoveredAt.get(claimId) ?? -Infinity) > at;

    if (status === "blocked") {
      if (claimRecovered) continue;
      out.push({
        ...base,
        dimension: "mdf_assistant_failure",
        severity: ageMin > 240 ? "P1" : "P2",
        detail: `MDF assistant blocked (portal/form didn't complete): ${summary.slice(0, 160) || "(no summary)"}`
      });
    } else if (status === "running" && now - at > stuckMs) {
      out.push({
        ...base,
        dimension: "mdf_assistant_stuck",
        severity: "P1",
        detail: `MDF assistant stuck in "running" for ${Math.round(ageMin)}m (runner died/hung): ${summary.slice(0, 120) || "(no summary)"}`
      });
    } else if (status === "needs_approval" && LOAD_FAILURE_RE.test(summary)) {
      if (claimRecovered) continue;
      out.push({
        ...base,
        dimension: "mdf_assistant_failure",
        severity: "P2",
        detail: `MDF assistant fell back — something didn't load: ${summary.slice(0, 160)}`
      });
    }
  }
  return out;
}
