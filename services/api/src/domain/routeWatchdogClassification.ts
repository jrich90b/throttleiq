/**
 * Stuck-turn classification for the route-audit watchdog (pure, no I/O).
 *
 * The watchdog flags any conversation whose last customer message has no
 * following outbound. On its own that signal is noisy: it counts conversations
 * the agent is CORRECTLY silent on — closed threads, staff hand-offs, customer
 * pauses, inventory watches, rep-owned (human-mode) threads — and it has no
 * recency ceiling, so a 90-day-old dead lead reads identically to a 2-hour-old
 * stall. That made the "routing-stuck-turns" P0 fire every hour while being
 * ~95% benign (2026-06-20 prod investigation: 44 matched, 0 genuine misses).
 *
 * This is a DETERMINISTIC pre-filter (a safety/segmentation gate), NOT a
 * comprehension layer. It must never try to read what a customer *means* from
 * message text — judging whether an ack/closeout ("Ok", "Thanks") warrants a
 * reply is the LLM no-response judge's job, not regex here. We only suppress on
 * structured conversation state (status / followUp.mode / mode) and age.
 *
 * `classifyStuckTurn` returns the single most-informative suppression reason
 * (terminal state first), or `actionable: true` when none applies. Callers keep
 * the benign rows for transparency but surface only the actionable count.
 */

export type StuckSuppressionReason =
  | "closed"
  | "manual_handoff"
  | "paused_indefinite"
  | "holding_inventory"
  | "human_mode"
  | "call_only"
  | "aged_out";

export type StuckClassification = {
  actionable: boolean;
  suppressionReason: StuckSuppressionReason | null;
};

export type StuckConvLike = {
  status?: unknown;
  mode?: unknown;
  followUp?: { mode?: unknown } | null;
  contactPreference?: unknown;
};

/**
 * Recency ceiling: beyond this, an unanswered turn is a cold lead owned by the
 * cadence/closeout machinery, not an acute routing stall worth a P0. Tunable on
 * the watchdog via `--stuck-max-age-sec` / `ROUTE_WATCHDOG_STUCK_MAX_AGE_SEC`.
 */
export const STUCK_MAX_AGE_SEC_DEFAULT = 7 * 24 * 60 * 60; // 7 days

export function classifyStuckTurn(
  conv: StuckConvLike,
  opts: { ageSec: number; maxAgeSec?: number; hasOpenCallTask?: boolean }
): StuckClassification {
  // A closed conversation can never be a live routing stall (sold / opt-out /
  // not-interested / wrong-number / archived). Most terminal — report first.
  if (String(conv?.status ?? "") === "closed") {
    return { actionable: false, suppressionReason: "closed" };
  }

  const fuMode = String(conv?.followUp?.mode ?? "");
  // Staff explicitly took the thread over — silence is the intended behavior.
  if (fuMode === "manual_handoff") {
    return { actionable: false, suppressionReason: "manual_handoff" };
  }
  // Customer dispositioned out (keep current bike / stepping back) — paused by intent.
  if (fuMode === "paused_indefinite") {
    return { actionable: false, suppressionReason: "paused_indefinite" };
  }
  // Inventory watch — awaiting stock, no reply owed this turn.
  if (fuMode === "holding_inventory") {
    return { actionable: false, suppressionReason: "holding_inventory" };
  }

  // Rep owns the thread directly; the agent is not the responder.
  if (String(conv?.mode ?? "") === "human") {
    return { actionable: false, suppressionReason: "human_mode" };
  }

  // Call-only lead (Joe ruling, 2026-07-09, +17163804680): a phone-preferred lead
  // gets a CALL TASK and never an auto SMS/email draft — in every mode. The agent's
  // silence is the intended behavior, so counting the turn as a routing stall is a
  // phantom (Kevin Burgess +17165414830, 2026-07-21: correct call-only silence with
  // an open, already-escalated call task, yet it alone failed the release gate).
  //
  // FAIL DIRECTION: we suppress ONLY when a human is demonstrably on the hook — an
  // OPEN call task exists. A call-only lead with no call task is the failure this
  // ruling was designed to prevent (silence with nobody told to dial), so it stays
  // ACTIONABLE and keeps failing the gate.
  if (String(conv?.contactPreference ?? "") === "call_only" && opts.hasOpenCallTask === true) {
    return { actionable: false, suppressionReason: "call_only" };
  }

  const maxAgeSec = Number.isFinite(opts.maxAgeSec) ? (opts.maxAgeSec as number) : STUCK_MAX_AGE_SEC_DEFAULT;
  if (Number.isFinite(opts.ageSec) && opts.ageSec > maxAgeSec) {
    return { actionable: false, suppressionReason: "aged_out" };
  }

  return { actionable: true, suppressionReason: null };
}
