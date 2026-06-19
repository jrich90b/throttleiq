/**
 * Backfill harness — the safe, reusable scaffolding for retroactively correcting records a code fix
 * left wrong (close the tasks that should've closed, fire the watches that should've fired, redact a
 * leaked contact, set a missing cadence). A code patch fixes the NEXT occurrence; a backfill cleans
 * up the ones already affected so the UI reflects reality.
 *
 * The danger is mass state mutation, so this is DRY-RUN BY DEFAULT: planBackfill never mutates — it
 * collects the proposed changes + summaries. applyBackfill mutates only when the caller (a per-fix
 * backfill script) explicitly runs it, AFTER a human reviews the dry-run report. The agent-watch loop
 * ships the backfill SCRIPT + its dry-run report in the fix PR; the apply run stays approve-first.
 */

export type BackfillChange = {
  convId: string;
  leadKey: string;
  summary: string; // human-readable: what would change on this conversation
  mutate: () => void; // closes over the conv; applied only by applyBackfill
};

export type BackfillPlan = {
  changes: BackfillChange[];
  scanned: number;
  cap: number;
  capped: boolean;
};

/**
 * Pure planning pass — NO mutation. `correct(conv)` inspects a conversation and returns the proposed
 * change (a summary + a `mutate` closure) or null. Errors in `correct` are swallowed per-conv so one
 * bad record can't abort the plan. Capped so a runaway predicate can't propose unbounded changes.
 */
export function planBackfill(args: {
  conversations: any[];
  correct: (conv: any) => { summary: string; mutate: () => void } | null;
  cap?: number;
}): BackfillPlan {
  const cap = Number.isFinite(args.cap) && (args.cap as number) > 0 ? Math.floor(args.cap as number) : 500;
  const changes: BackfillChange[] = [];
  let scanned = 0;
  let capped = false;
  for (const conv of args.conversations ?? []) {
    if (changes.length >= cap) {
      capped = true;
      break;
    }
    scanned++;
    let c: { summary: string; mutate: () => void } | null = null;
    try {
      c = args.correct(conv);
    } catch {
      c = null;
    }
    if (c && c.summary && typeof c.mutate === "function") {
      changes.push({ convId: String(conv?.id ?? ""), leadKey: String(conv?.leadKey ?? ""), summary: String(c.summary), mutate: c.mutate });
    }
  }
  return { changes, scanned, cap, capped };
}

/** Applies a plan in place (calls each `mutate`). The caller is responsible for persisting the store. */
export function applyBackfill(plan: BackfillPlan): number {
  let applied = 0;
  for (const ch of plan.changes) {
    try {
      ch.mutate();
      applied++;
    } catch {
      // skip a single failed mutation; never abort the whole apply
    }
  }
  return applied;
}

/** Renders the dry-run (or applied) report that goes in the PR / the operator's review. */
export function renderBackfillReport(plan: BackfillPlan, opts?: { title?: string; applied?: boolean }): string {
  const head = opts?.applied ? "APPLIED" : "DRY-RUN (nothing written)";
  const lines: string[] = [];
  lines.push(
    `# Backfill${opts?.title ? " — " + opts.title : ""}: ${head} — ${plan.changes.length} of ${plan.scanned} scanned${plan.capped ? ` (CAPPED at ${plan.cap} — re-run to continue)` : ""}`
  );
  if (!plan.changes.length) {
    lines.push("(no records need correcting)");
  } else {
    for (const ch of plan.changes) lines.push(`  - ${ch.convId} (${ch.leadKey}): ${ch.summary}`);
  }
  return lines.join("\n");
}
