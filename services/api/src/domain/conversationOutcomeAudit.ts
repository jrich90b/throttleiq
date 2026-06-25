/**
 * Per-conversation OUTCOME auditor — Phase 2 of the autonomous self-healing loop
 * (docs/autonomous_coding_loop.md). Pure, read-only, DETERMINISTIC detection of STATE/side-effect
 * contradictions across every aspect of a turn's outcome. This is the detection feed that replaces a
 * human watching the agent: a healthy system produces ZERO anomalies, so any hit is either a net-new
 * bug or a regression of a reconcile heal that should have repaired it.
 *
 * Scope (this module): the deterministic STATE half — appointment/cadence/watch/held-flag/todo
 * consistency. The COMPREHENSION half (was the reply correct / in-context / on-tone) is already graded
 * by the nightly LLM audits (context_fidelity, answer_correctness, fabricated_frame, voice_charter);
 * those emit into the SAME OutcomeAnomaly feed downstream (the "one feed" consolidation) — this module
 * defines the schema and owns the deterministic dimensions.
 *
 * `healed: true` marks a dimension that a 60s reconcile heal already repairs — so a non-zero count there
 * is a REGRESSION signal (the heal missed it / a write path outran it), not a brand-new gap.
 *
 * Deterministic invariant detection (AGENTS.md allows deterministic for invariant guards); never reads
 * customer intent. No mutations.
 */
import { REAL_OUTBOUND_CONTACT_PROVIDERS } from "./conversationStore.js";

export type OutcomeSeverity = "P1" | "P2" | "P3";

// The "one feed": deterministic STATE contradictions + the COMPREHENSION/feedback verdicts the system
// already computed and persisted on the conversation (draftHeld, 👎). Category lets the loop route by
// kind (state → reconcile/invariant fix; comprehension → parser-first fix; feedback → redraft/diagnose).
export type OutcomeCategory = "state" | "comprehension" | "feedback";

export type OutcomeAnomaly = {
  convId: string;
  leadKey: string;
  dimension: string;
  category: OutcomeCategory;
  severity: OutcomeSeverity;
  healed: boolean; // a reconcile heal exists for this class → a hit means the heal lagged/missed (regression)
  detail: string;
};

const CATEGORY_BY_DIMENSION: Record<string, OutcomeCategory> = {
  appointment_confirmed_no_event: "state",
  watch_active_on_closed: "state",
  cadence_active_on_closed: "state",
  cadence_active_while_handoff: "state",
  stale_held_flag: "state",
  orphan_todo: "state",
  held_draft_unresolved: "comprehension",
  negative_feedback: "feedback"
};
const categoryFor = (dimension: string): OutcomeCategory => CATEGORY_BY_DIMENSION[dimension] ?? "state";

type RawAnomaly = Omit<OutcomeAnomaly, "category">;

type AuditableConv = {
  id?: string;
  leadKey?: string;
  closedAt?: string | null;
  closedReason?: string | null;
  sale?: { soldAt?: string | null } | null;
  appointment?: { status?: string | null; bookedEventId?: string | null; whenText?: string | null; whenIso?: string | null } | null;
  followUpCadence?: { status?: string | null; kind?: string | null } | null;
  followUp?: { mode?: string | null } | null;
  inventoryWatch?: { status?: string | null } | null;
  inventoryWatches?: Array<{ status?: string | null }> | null;
  draftHeld?: { at?: string | null; reason?: string | null; heldKind?: string | null; frame?: string | null } | null;
  messages?: Array<{ direction?: string | null; provider?: string | null; at?: string | null; body?: string | null; feedback?: { rating?: string | null } | null }> | null;
};

function isClosed(conv: AuditableConv): boolean {
  return !!(conv.closedAt || conv.closedReason || conv.sale?.soldAt);
}

function hasActiveWatch(conv: AuditableConv): boolean {
  if (String(conv.inventoryWatch?.status ?? "").toLowerCase() === "active") return true;
  return (conv.inventoryWatches ?? []).some(w => String(w?.status ?? "").toLowerCase() === "active");
}

// Pure, read-only. Returns the state-contradiction anomalies for ONE conversation (empty when healthy).
export function auditConversationOutcome(conv: AuditableConv, opts: { now?: Date } = {}): OutcomeAnomaly[] {
  const out: RawAnomaly[] = [];
  if (!conv) return [];
  const base = { convId: String(conv.id ?? ""), leadKey: String(conv.leadKey ?? "") };
  const closed = isClosed(conv);
  const cad = conv.followUpCadence;
  const cadActive = String(cad?.status ?? "").toLowerCase() === "active";
  const appt = conv.appointment;

  // 1. A "confirmed" appointment with NO calendar event — silently skipped by the reminder + outcome
  //    sweeps (they gate on bookedEventId). Net-new (no heal yet). Audit P1.5.
  if (String(appt?.status ?? "").toLowerCase() === "confirmed" && !String(appt?.bookedEventId ?? "").trim()) {
    out.push({
      ...base,
      dimension: "appointment_confirmed_no_event",
      severity: "P1",
      healed: false,
      detail: `appointment.status=confirmed but bookedEventId is empty (whenText=${appt?.whenText ?? "?"})`
    });
  }

  // 2. Inventory watch still ACTIVE on a closed/sold conversation — a reopen can refire "it's available
  //    again!" to a customer who already bought/closed. Net-new (only the opt-out path pauses today).
  if (closed && hasActiveWatch(conv)) {
    out.push({ ...base, dimension: "watch_active_on_closed", severity: "P2", healed: false, detail: "inventoryWatch active on a closed/sold conversation" });
  }

  // 3. Follow-up cadence ACTIVE on a closed/sold conv (post_sale is legitimate). Should be 0
  //    (stopFollowUpCadence on close). A hit = a close path that didn't stop the cadence.
  if (closed && cadActive && cad?.kind !== "post_sale") {
    out.push({ ...base, dimension: "cadence_active_on_closed", severity: "P1", healed: false, detail: `followUpCadence active (kind=${cad?.kind ?? "?"}) on a closed/sold conversation` });
  }

  // 4. Cadence ACTIVE while handed off to a human — could auto-text mid-handoff. A reconcile heal pauses
  //    this, so a hit is a regression (a handoff path that bypassed setFollowUpMode's guard). CARVE-OUT:
  //    long_term / post_sale cadences are INTENTIONALLY kept through a handoff (matches the heal's own
  //    carve-out + stopFollowUpCadence) — flagging them is a false positive (model the hold conditions).
  if (
    !closed &&
    cadActive &&
    conv.followUp?.mode === "manual_handoff" &&
    cad?.kind !== "long_term" &&
    cad?.kind !== "post_sale"
  ) {
    out.push({ ...base, dimension: "cadence_active_while_handoff", severity: "P1", healed: true, detail: `followUpCadence active (kind=${cad?.kind ?? "?"}) while followUp.mode=manual_handoff` });
  }

  // 5. A held "needs reply" flag that a REAL reply already cleared — the inbox shows "needs reply"
  //    forever. A reconcile heal clears it, so a hit is a regression. (Same rule as healStaleHeldFlag,
  //    read-only: a real outbound exists AFTER the hold timestamp.)
  const heldAtMs = Date.parse(String(conv.draftHeld?.at ?? ""));
  if (conv.draftHeld && Number.isFinite(heldAtMs)) {
    const repliedAfter = (conv.messages ?? []).some(m => {
      if (m?.direction !== "out" || !REAL_OUTBOUND_CONTACT_PROVIDERS.has(String(m?.provider ?? ""))) return false;
      const t = Date.parse(String(m?.at ?? ""));
      return Number.isFinite(t) && t > heldAtMs;
    });
    if (repliedAfter) {
      // STATE cleanup: a real reply went out after the hold → the flag should have cleared (heal regression).
      out.push({ ...base, dimension: "stale_held_flag", severity: "P2", healed: true, detail: "draftHeld set but a real reply went out after the hold" });
    } else {
      // COMPREHENSION miss: the draft judge HELD this reply (out-of-context / fabrication / unsafe) and
      // no real reply has gone out — the agent couldn't answer this turn correctly. The system already
      // diagnosed it (frame + steering), which is exactly the loop's parser-first fix input.
      out.push({
        ...base,
        dimension: "held_draft_unresolved",
        severity: "P1",
        healed: false,
        detail: `held (${conv.draftHeld?.heldKind ?? conv.draftHeld?.reason ?? "?"}${conv.draftHeld?.frame ? `/${conv.draftHeld.frame}` : ""}) and unresolved — no reply sent`
      });
    }
  }

  // 6. Unaddressed 👎: the LAST outbound was thumbed-down by a rep and nothing better followed (the
  //    closed-loop redraft would append a newer outbound). The system's own "this reply was wrong" signal.
  const lastOut = [...(conv.messages ?? [])].reverse().find(m => m?.direction === "out");
  if (String(lastOut?.feedback?.rating ?? "").toLowerCase() === "down") {
    out.push({ ...base, dimension: "negative_feedback", severity: "P2", healed: false, detail: "the latest outbound was thumbed-down and not yet improved" });
  }

  return out.map(a => ({ ...a, category: categoryFor(a.dimension) }));
}

export type OutcomeAuditSummary = {
  conversationsScanned: number;
  totalAnomalies: number;
  byDimension: Record<string, number>;
  byCategory: Record<OutcomeCategory, number>;
  bySeverity: Record<OutcomeSeverity, number>;
  regressionAnomalies: number; // hits on a `healed` dimension — a reconcile heal lagged/missed
};

// Store-level audit: per-conv detectors over all conversations + the orphan-todo check (an open todo
// whose conversation no longer exists in the store). Pure, read-only.
export function auditConversationStore(input: {
  conversations: AuditableConv[];
  todos?: Array<{ convId?: string | null; status?: string | null; summary?: string | null }>;
  now?: Date;
}): { anomalies: OutcomeAnomaly[]; summary: OutcomeAuditSummary } {
  const convs = Array.isArray(input.conversations) ? input.conversations : [];
  const now = input.now ?? new Date();
  const anomalies: OutcomeAnomaly[] = [];
  for (const conv of convs) anomalies.push(...auditConversationOutcome(conv, { now }));

  // Orphan todos: an open todo pointing at a conversation that isn't in the store.
  const convIds = new Set(convs.map(c => String(c.id ?? "")));
  for (const t of input.todos ?? []) {
    if (String(t?.status ?? "") !== "open") continue;
    const cid = String(t?.convId ?? "");
    if (cid && !convIds.has(cid)) {
      anomalies.push({ convId: cid, leadKey: "", dimension: "orphan_todo", category: categoryFor("orphan_todo"), severity: "P2", healed: false, detail: `open todo on a conversation not in the store: ${String(t?.summary ?? "").slice(0, 60)}` });
    }
  }

  const byDimension: Record<string, number> = {};
  const byCategory: OutcomeAuditSummary["byCategory"] = { state: 0, comprehension: 0, feedback: 0 };
  const bySeverity: OutcomeAuditSummary["bySeverity"] = { P1: 0, P2: 0, P3: 0 };
  let regressionAnomalies = 0;
  for (const a of anomalies) {
    byDimension[a.dimension] = (byDimension[a.dimension] ?? 0) + 1;
    byCategory[a.category] += 1;
    bySeverity[a.severity] += 1;
    if (a.healed) regressionAnomalies += 1;
  }
  return {
    anomalies,
    summary: { conversationsScanned: convs.length, totalAnomalies: anomalies.length, byDimension, byCategory, bySeverity, regressionAnomalies }
  };
}
