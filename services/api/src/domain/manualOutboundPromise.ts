import type { ManualOutboundPromiseParse } from "./llmDraft.js";
import { decideVoiceNextStep, type VoiceNextStepDecision } from "./voiceNextStep.js";

/**
 * Staff-text promise → dated task (Joe, 2026-07-19) — the TEXT-channel sibling
 * of the voice next-step plan. When a staff member types "I'll send you numbers
 * Monday" over SMS/email, the agent turns the promise into a dated task and
 * holds the generic cadence past the due day — nobody re-keys anything.
 *
 * Scope is deliberately narrower than the call version:
 *  - STAFF promises only. Customer commitments arrive on customer INBOUND turns
 *    and are already owned by the soft-visit / timeframe machinery.
 *  - No breather: manual sends already pause the cadence 24h
 *    (pauseCadenceAfterManualOutbound), so a breather-only outcome maps to none.
 *  - inventory_notify promises ("I'll text you when one comes in") and
 *    appointment talk are owned by the watch-set and appointment-parser arms of
 *    the manual-outbound reconciler — they are skipped here so one promise never
 *    produces two follow-throughs.
 *
 * Fail direction: this only ever ADDS a staff task and DELAYS a proactive touch.
 * Any uncertainty (no promise, low confidence, excluded kind) → nothing changes.
 * Pinned by scripts/manual_outbound_promise_eval.ts (ci:eval).
 */

/**
 * Cheap COST hint (not comprehension — the typed parser owns the verdict, this
 * only decides whether the parser is worth calling): first-person future intent
 * plus a deliverable-ish verb. Over-matching costs one parser call; the parser
 * returns kind none/appointment/inventory_notify and nothing happens.
 */
export function hasManualPromiseHint(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  const firstPersonFuture =
    /\b(i(?:'|’)?ll|i will|we(?:'|’)?ll|we will|let me|i(?:'|’)?m going to|gonna|i can get|i(?:'|’)?ll have)\b/.test(t);
  const deliverableVerb =
    /\b(send|get|check|pull|put together|find out|look into|work up|price|numbers?|quote|figure|confirm|ask|talk to|get back|follow up|have .{0,40}ready)\b/.test(
      t
    );
  return firstPersonFuture && deliverableVerb;
}

const ACTIONABLE_KINDS = new Set(["send_info", "check_and_get_back", "prepare_something", "other"]);

/** True for promise kinds this arm owns (others belong to the watch/appointment arms or are non-promises). */
export function isActionablePromiseKind(kind: string | null | undefined): boolean {
  return ACTIONABLE_KINDS.has(String(kind ?? "").trim().toLowerCase());
}

export interface ManualOutboundPromiseInput {
  parse: ManualOutboundPromiseParse | null;
  nowMs: number;
  timeZone: string;
  cadenceKind?: string | null;
  followUpMode?: string | null;
  conversationStatus?: string | null;
  /** dueText resolved by the caller via parseRequestedDateOnly; null when absent/unparsable. */
  dueDate?: { year: number; month: number; day: number; dayOfWeek?: string } | null;
  confidenceMin?: number;
  maxHoldDays?: number;
}

export type ManualOutboundPromiseDecision =
  | { kind: "none"; reason: string }
  | Extract<VoiceNextStepDecision, { kind: "staff_task" }>;

export function decideManualOutboundPromise(input: ManualOutboundPromiseInput): ManualOutboundPromiseDecision {
  const parse = input.parse;
  if (!parse || !parse.promisePresent) return { kind: "none", reason: "no_promise" };
  if (!isActionablePromiseKind(parse.kind)) return { kind: "none", reason: `kind_${parse.kind || "none"}` };
  const decision = decideVoiceNextStep({
    isVoicemail: false,
    nowMs: input.nowMs,
    timeZone: input.timeZone,
    cadenceKind: input.cadenceKind ?? null,
    followUpMode: input.followUpMode ?? null,
    conversationStatus: input.conversationStatus ?? null,
    nextStepOwner: "staff",
    nextStepAction: parse.action,
    nextStepConfidence: parse.confidence,
    dueDate: input.dueDate ?? null,
    confidenceMin: input.confidenceMin,
    maxHoldDays: input.maxHoldDays,
    summaryLeadIn: "Promised over text:"
  });
  if (decision.kind === "staff_task") return decision;
  if (decision.kind === "none") return { kind: "none", reason: decision.reason };
  // breather_only / hold_for_customer never apply to a staff text: manual sends
  // already pause the cadence 24h, and customer commitments are owned by the
  // inbound-turn machinery.
  return { kind: "none", reason: `not_applicable_${decision.kind}` };
}
