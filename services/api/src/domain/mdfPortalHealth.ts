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
 */

export type MdfPortalTask = {
  id?: string | null;
  kind?: string | null;
  status?: string | null;
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

  for (const t of args.tasks ?? []) {
    if (String(t?.kind ?? "") !== "mdf_portal") continue;
    const status = String(t?.status ?? "").toLowerCase();
    const at = Date.parse(String(t?.updatedAt ?? ""));
    if (!Number.isFinite(at) || now - at > windowMs) continue; // recency: don't resurface old/abandoned runs
    const ageMin = (now - at) / (60 * 1000);
    const summary = String(t?.output?.summary ?? "").replace(/\s+/g, " ").trim();
    const id = String(t?.id ?? "").trim();
    const base = { convId: `mdf:${id}`, leadKey: `mdf:${id}`, category: "state" as const, healed: false as const };

    if (status === "blocked") {
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
