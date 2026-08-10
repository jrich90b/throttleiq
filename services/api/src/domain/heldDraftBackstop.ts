/**
 * Stale held-draft backstop (2026-07-13) — the actuation half of the draft-quality hold.
 *
 * The quality gate HOLDS a draft it can't auto-heal (conv.draftHeld set) and the console shows a
 * read-only "being fixed" panel with NO send box. Every existing clear path needs either a PASSING
 * AI re-draft (a code fix deploys, then a regenerate lands a good draft) or a real human/twilio/
 * sendgrid reply. So a hold where the customer never writes back AND no fix redeploys hits NONE of
 * them — it sits on "being fixed" forever and the customer gets nothing (James Browne +12543831187,
 * a Service quote request held 2026-07-12, silent ~14h). This gap widened when self-heal's
 * DRAFT_QUALITY_HOLD_CLASS_ONLY was flipped to 0 (unhealable needs_regenerate now HOLDS instead of
 * publishing), so an unrecoverable weak draft parks instead of landing in the box for staff to fix.
 *
 * This module is the PURE decision for a periodic sweep: which held drafts are stale enough that a
 * human must take over. The sweep (index.ts [state-reconcile]) turns a true here into a staff task +
 * clears the held limbo so staff can reply.
 *
 * FAIL DIRECTION: unsure => do NOT escalate (return false). The stale window itself guards against
 * escalating a hold that self-heal or a fresh inbound would still resolve; garbage timestamps / no
 * draftHeld / a real reply already out all skip. Context-fidelity holds already raise their OWN staff
 * todo at hold-time (upsertContextFidelityHeldTodo) — this backstop is only for the draft-quality
 * holds, which today get no task.
 */

export type HeldDraftBackstopConversation = {
  id?: string;
  draftHeld?: {
    at?: string | null;
    reason?: string | null;
    heldKind?: string | null;
    channel?: string | null;
  } | null;
  messages?: { direction?: string; provider?: string; at?: string }[] | null;
  closedAt?: string | null;
  closedReason?: string | null;
  sale?: unknown;
  heldDraftEscalatedAt?: string | null;
};

export type HeldDraftBackstopOptions = {
  /** How long a hold must persist unresolved before a human is pulled in. Long enough that self-heal
   *  and a same-day customer reply get their shot; short enough a real ask isn't left overnight.
   *  Default 6 (hours). */
  staleHours?: number;
  /** If a prior escalation was surfaced but the draft is STILL held (a human dismissed the task
   *  without resolving), re-surface after this window rather than never again. Default 24 (hours). */
  reNudgeHours?: number;
  /** Epoch ms at which the dealership CLOSES on the business day the hold landed in, when the hold
   *  landed while the store was open. Omit (or null) when unknown, or when the hold landed outside
   *  opening hours — then the plain stale window applies, exactly as before.
   *
   *  MEASURED, 2026-08-09: all four escalations this backstop has ever raised. Two landed while
   *  someone was there (held 9:12am -> flagged 3:12pm; held 1:21am -> flagged 7:21am, waiting at
   *  the door). The other two were held in the EARLY AFTERNOON with four hours of business day left
   *  and surfaced at 7:52pm and 7:42pm — both after a 6pm close, to an empty store. Maya's (8/07)
   *  was still unresolved two days later. A flag nobody can act on is a flag that did not fire. */
  closesAtMs?: number | null;
  /** Never escalate sooner than this after the hold, even to beat closing — self-heal and a quick
   *  customer reply still get a shot. Default 1 (hour). */
  minSoakHours?: number;
  /** Land the flag this long BEFORE closing, so it is actionable rather than technically on time.
   *  Default 45 (minutes). */
  beforeCloseMinutes?: number;
};

/** Summary marker so the sweep can find an already-open escalation todo for a conv (dedup) and so
 *  the console/audits can recognize the class. Mirrors CONTEXT_FIDELITY_HELD_TODO_MARKER. */
export const HELD_DRAFT_BACKSTOP_TODO_MARKER = "[held-draft-needs-human]";

/** Providers that mean a message actually REACHED the customer (a real reply resolves the hold).
 *  draft_ai rows are console drafts, never sent. */
const REAL_OUTBOUND_PROVIDERS = new Set(["twilio", "sendgrid", "human"]);

/**
 * Pure. True when a draft-quality hold has sat unresolved long enough that a human should take over.
 * Mirrors the shouldNudge* family (conversationStore.ts). `hasOpenEscalationTodo` = an open todo
 * carrying HELD_DRAFT_BACKSTOP_TODO_MARKER already exists for this conv (computed by the sweep).
 */
export function shouldEscalateStaleHeldDraft(
  conv: HeldDraftBackstopConversation,
  hasOpenEscalationTodo: boolean,
  nowMs: number,
  opts: HeldDraftBackstopOptions = {}
): boolean {
  const held = conv?.draftHeld;
  if (!held) return false;
  const heldAt = Date.parse(String(held.at ?? ""));
  if (!Number.isFinite(heldAt)) return false; // unparseable stamp => skip (never escalate on uncertainty)
  // Context-fidelity holds raise their own staff todo at hold-time — don't double-surface them.
  if (String(held.heldKind ?? "") === "context_fidelity") return false;
  // A closed/sold lead doesn't need a reply chased.
  if (conv.closedAt || conv.closedReason || conv.sale) return false;
  // Give self-heal + a same-window customer reply time to resolve it on their own first.
  const staleMs = Math.max(1, opts.staleHours ?? 6) * 60 * 60 * 1000;
  let dueAtMs = heldAt + staleMs;
  // ...but never let the wait cross closing time. When the plain window would surface this after the
  // store shuts, pull it forward to just before close so a human can still act TODAY, subject to a
  // minimum soak so a hold at 5:55pm doesn't escalate the instant it lands. This can only ever move
  // the flag EARLIER and only within the hold's own business day — it never delays one, and with no
  // closesAtMs it is a no-op.
  const closesAt = typeof opts.closesAtMs === "number" && Number.isFinite(opts.closesAtMs) ? opts.closesAtMs : null;
  if (closesAt !== null) {
    const beforeCloseMs = Math.max(0, opts.beforeCloseMinutes ?? 45) * 60 * 1000;
    const minSoakMs = Math.max(0, opts.minSoakHours ?? 1) * 60 * 60 * 1000;
    const actionableBy = closesAt - beforeCloseMs;
    if (actionableBy < dueAtMs && actionableBy >= heldAt + minSoakMs) dueAtMs = actionableBy;
  }
  if (nowMs < dueAtMs) return false;
  // Already answered by a real reply after the hold => resolved (defensive; the send path normally
  // nulls draftHeld itself, but never escalate a conversation a human already replied to).
  for (const m of conv.messages ?? []) {
    if ((m?.direction ?? "") !== "out") continue;
    if (!REAL_OUTBOUND_PROVIDERS.has(String(m?.provider ?? "").toLowerCase())) continue;
    const t = Date.parse(String(m?.at ?? ""));
    if (Number.isFinite(t) && t > heldAt) return false;
  }
  // Already surfaced to a human and still open => wait, don't stack duplicates.
  if (hasOpenEscalationTodo) return false;
  // Surfaced once already: only re-surface after the re-nudge window (a dismissed-but-still-held draft
  // shouldn't be forgotten, but shouldn't re-fire every tick either).
  const escalatedAt = Date.parse(String(conv.heldDraftEscalatedAt ?? ""));
  if (Number.isFinite(escalatedAt)) {
    const reNudgeMs = Math.max(1, opts.reNudgeHours ?? 24) * 60 * 60 * 1000;
    if (nowMs - escalatedAt < reNudgeMs) return false;
  }
  return true;
}

/**
 * The staff-task summary for an escalated hold. Pure, and here rather than inline in the sweep so the
 * marker, the customer's ask and the wording live with the rule that raises them — an eval can then
 * assert the text a rep actually reads instead of pinning the sweep's source.
 */
export function buildHeldDraftEscalationSummary(args: {
  who: string;
  inboundPreview?: string | null;
}): string {
  const who = String(args.who ?? "").trim() || "this lead";
  const ask = String(args.inboundPreview ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
  const askLine = ask ? ` They asked: "${ask}".` : "";
  return (
    `${HELD_DRAFT_BACKSTOP_TODO_MARKER} Reply to ${who} needs a human — the AI's draft was held ` +
    `for review and couldn't auto-fix, so it never sent.${askLine} Please review and reply.`
  );
}
