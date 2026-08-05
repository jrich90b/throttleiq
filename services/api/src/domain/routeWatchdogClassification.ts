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
  | "reaction_only"
  | "judged_no_response"
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

/**
 * Route outcomes that mean "the no-response judge looked at this turn and chose
 * silence" — the agent DECIDED not to reply, it did not fail to.
 *
 * An explicit allowlist, deliberately NOT a substring match on "no_response":
 * `routing_parser_no_response_overridden` contains that substring and means the
 * OPPOSITE — the parser proposed silence and we overrode it and replied. Matching
 * it would suppress a turn on the strength of a verdict that was thrown away.
 *
 * Add to this set only for outcomes whose meaning is a recorded decision to stay
 * silent on the customer's last message.
 */
export const DELIBERATE_SILENCE_ROUTE_OUTCOMES: ReadonlySet<string> = new Set([
  "customer_ack_no_response",
  "short_ack_no_reply"
]);

export type RouteOutcomeRowLike = {
  ts?: unknown;
  scope?: unknown;
  outcome?: unknown;
  detail?: { convId?: unknown; leadKey?: unknown } | null;
};

/**
 * Did the no-response judge rule silence on THIS inbound? Pure; reads only
 * structured audit rows (no message text ever reaches it).
 *
 * Three bindings, each of which independently keeps a stale or unrelated verdict
 * from silencing a live stall:
 *   - CONVERSATION: the row must name this conversation (id or lead key).
 *   - TIME: the verdict must be recorded at or after the inbound it supposedly
 *     judged. An older verdict is about an older turn.
 *   - SCOPE: `live` only. A `regen` or `manual` row is a replay or a staff action,
 *     not the serving path's decision about this customer's message.
 */
export function judgedNoResponseOnInbound(
  rows: ReadonlyArray<RouteOutcomeRowLike>,
  opts: { convId: string; leadKey?: string; inboundAtMs: number }
): boolean {
  if (!Array.isArray(rows) || !rows.length) return false;
  if (!Number.isFinite(opts.inboundAtMs)) return false;
  const convId = String(opts.convId ?? "").trim();
  const leadKey = String(opts.leadKey ?? "").trim();
  if (!convId && !leadKey) return false;

  return rows.some(row => {
    if (String(row?.scope ?? "") !== "live") return false;
    if (!DELIBERATE_SILENCE_ROUTE_OUTCOMES.has(String(row?.outcome ?? ""))) return false;
    const rowConv = String(row?.detail?.convId ?? "").trim();
    const rowLead = String(row?.detail?.leadKey ?? "").trim();
    const sameThread =
      (convId !== "" && (rowConv === convId || rowLead === convId)) ||
      (leadKey !== "" && (rowConv === leadKey || rowLead === leadKey));
    if (!sameThread) return false;
    const tsMs = Date.parse(String(row?.ts ?? ""));
    return Number.isFinite(tsMs) && tsMs >= opts.inboundAtMs;
  });
}

export function classifyStuckTurn(
  conv: StuckConvLike,
  opts: {
    ageSec: number;
    maxAgeSec?: number;
    hasOpenCallTask?: boolean;
    lastInboundIsReactionOnly?: boolean;
    lastInboundJudgedNoResponse?: boolean;
  }
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

  // The customer pressed a button, they did not write a word — a 👍👍, an ASCII
  // emoticon, or an iOS tapback echo. Silence is correct (Joe ruling, 2026-07-22;
  // AGENTS.md "Twilio Reaction No-Reply Guardrail"), so it is not a routing stall.
  //
  // The caller decides this, not us: the module's no-comprehension rule stands, so
  // the text matcher stays in the shared, eval-pinned scoringExclusions module
  // (`isBareReactionOnlyInbound`) and reaches this pure decision as a boolean.
  if (opts.lastInboundIsReactionOnly === true) {
    return { actionable: false, suppressionReason: "reaction_only" };
  }

  // The no-response judge ALREADY ruled on this exact inbound and chose silence
  // (2026-08-05, Mark Walsh +17736151296: a cadence touch drew a bare "No, thanks",
  // the live route outcome recorded `customer_ack_no_response` five seconds later,
  // and the watchdog still counted the correct silence as a routing stall — one
  // phantom row holding the readiness bar's "open P0/P1 = 0" shut indefinitely).
  //
  // The header rule above says judging an ack is the no-response judge's job, not
  // this module's. That was always right; what was missing is that the watchdog
  // never READ the judge's verdict. This closes that loop without moving an inch
  // of comprehension in here: the caller binds a recorded, live, per-turn outcome
  // to this inbound and hands it over as a boolean, exactly like `reaction_only`.
  //
  // FAIL DIRECTION: absence of a verdict is NOT a verdict. Silence with nothing
  // recorded — the genuine stall this watchdog exists to catch — stays ACTIONABLE.
  if (opts.lastInboundJudgedNoResponse === true) {
    return { actionable: false, suppressionReason: "judged_no_response" };
  }

  const maxAgeSec = Number.isFinite(opts.maxAgeSec) ? (opts.maxAgeSec as number) : STUCK_MAX_AGE_SEC_DEFAULT;
  if (Number.isFinite(opts.ageSec) && opts.ageSec > maxAgeSec) {
    return { actionable: false, suppressionReason: "aged_out" };
  }

  return { actionable: true, suppressionReason: null };
}
