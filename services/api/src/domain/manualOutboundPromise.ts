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

/**
 * Did a PERSON write these words? (Scott Hartrich +17167130279, operator-reported
 * 2026-08-02: "Why did this create a call back".)
 *
 * The arm's premise is a STAFF-TYPED promise, but in suggest mode every agent draft
 * is released through the very same `/conversations/:id/send` endpoint a salesperson
 * types into, so the sent text alone cannot tell the two apart. The pending draft can:
 * a send whose text still matches the agent's own pending draft is that draft approved
 * as-is — the agent's boilerplate, not a person committing to something. The agent
 * writing "I'll follow up with the numbers we discussed" is describing what the agent
 * already does on its cadence; turning that into a dated task for the salesperson (and
 * holding the cadence past its due day) is noise, and it fired on 8 of the 20 promise
 * tasks on the box.
 *
 * This is the same comparison `shouldStampHumanOutboundActor` already uses to decide
 * whether to stamp a human actor on the outbound — one fact, asked twice.
 *
 * Two things we deliberately do NOT count as a human edit, because we appended them
 * ourselves on the way out: whitespace reflow (formatSmsLayout) and the compliance
 * opt-out footer (ensureInitialSmsOptOutFooter, which fires on exactly the first-touch
 * ADF sends this arm sees most).
 *
 * Fail direction: only the PROVABLE unedited-draft case is suppressed. No draft in
 * play, an edited draft, or an unreadable body all return true and leave today's
 * behaviour untouched, so an unrecognised shape can never swallow a real staff promise.
 *
 * Caller note: pass the draft body captured BEFORE the send — finalizeDraftAsSent
 * rewrites the pending draft message in place, so by reconcile time `draft.body`
 * already holds the sent text and would compare equal to everything.
 */
export function isHumanAuthoredOutbound(args: {
  pendingDraftBody?: string | null;
  sentBody: string;
}): boolean {
  const normalize = (value: unknown) =>
    String(value ?? "")
      .replace(/\s+/g, " ")
      .replace(/\s*Reply STOP to opt out\.?\s*$/i, "")
      .trim();
  const sent = normalize(args.sentBody);
  if (!sent) return true;
  const draft = normalize(args.pendingDraftBody);
  if (!draft) return true;
  return draft !== sent;
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
  /**
   * Did a PERSON type these words? `isHumanAuthoredOutbound` answers it by comparing the pending
   * draft against what was actually sent. Load-bearing in BOTH directions — see the decision.
   */
  humanAuthored: boolean;
}

export type ManualOutboundPromiseDecision =
  | { kind: "none"; reason: string }
  | Extract<VoiceNextStepDecision, { kind: "staff_task" }>
  /**
   * The AGENT promised it, and the agent cannot do it (Joe, 2026-08-07).
   *
   * PR #450 stopped an unedited agent draft from arming a staff task, and it was right to:
   * 8 of the 20 "Promised over text" tasks on the box were the agent's own boilerplate, not a
   * person's commitment. But dropping it entirely left the other half of the problem. On
   * 2026-08-07 the agent started answering "That would be great" with *"I'll pull the current
   * incentives that apply to the 2026 Street Glide Limited and text you the exact breakdown"* —
   * and the system has NO incentives data at all (domain/offers.ts resolves a URL to the
   * national-promotions page, nothing more). So it promised a person's work and nobody was told.
   *
   * This is the narrow middle: raise ONE task naming the promise, so it has an owner. No due-date
   * pressure and NO cadence hold — the agent's promise is not evidence about when a human will
   * get to it, and cadence timing is not this referee's business.
   */
  | { kind: "agent_promise_owner_task"; reason: string; taskSummary: string };

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
  if (decision.kind === "staff_task") {
    if (input.humanAuthored) return decision;
    // Same promise, different author: a person committed to nothing here, so there is no dated
    // plan to hold cadence against — but somebody still has to do the thing we said we would do.
    const promised = String(parse.action ?? "").trim();
    return {
      kind: "agent_promise_owner_task",
      reason: "agent_authored_promise",
      taskSummary: promised
        ? `The agent promised this and only a person can do it: ${promised}`
        : "The agent promised to send something only a person can put together"
    };
  }
  if (decision.kind === "none") return { kind: "none", reason: decision.reason };
  // breather_only / hold_for_customer never apply to a staff text: manual sends
  // already pause the cadence 24h, and customer commitments are owned by the
  // inbound-turn machinery.
  return { kind: "none", reason: `not_applicable_${decision.kind}` };
}

/**
 * WHAT THE SEND PATH ACTUALLY DOES with a promise decision — the whole author difference, in one
 * pure place the eval can EXECUTE.
 *
 * It lives here rather than inline in index.ts for a reason earned on 2026-08-09: the first cut of
 * this slice kept two apply branches in the handler and pinned them with SOURCE TEXT. Those pins
 * asserted `pauseFollowUpCadence(` did not appear near the agent arm — which is a claim about
 * formatting, not behaviour, and it broke the moment the two branches were merged even though the
 * agent branch still held no cadence. A plan object makes the real invariant checkable:
 *
 *   - a PERSON's promise  → dated task + cadence hold (unchanged since #450),
 *   - the AGENT's promise → a task with NO due date and NO hold, because the agent saying
 *     "shortly" tells us nothing about when a human will get to it,
 *   - anything else       → null, and the send path does nothing at all.
 *
 * FAIL DIRECTION: null is the quiet answer (no task, no hold), so an unrecognised decision kind can
 * never invent a due date or freeze someone's cadence.
 */
export interface ManualPromiseApplyPlan {
  taskSummary: string;
  taskDueIso: string | null;
  holdUntilIso: string | null;
  outcomeKey: "manual_outbound_promise_task" | "agent_promise_owner_task";
}

export function resolveManualPromiseApplyPlan(
  decision: ManualOutboundPromiseDecision
): ManualPromiseApplyPlan | null {
  if (decision.kind === "staff_task") {
    return {
      taskSummary: decision.taskSummary,
      taskDueIso: decision.taskDueIso,
      holdUntilIso: decision.holdUntilIso,
      outcomeKey: "manual_outbound_promise_task"
    };
  }
  if (decision.kind === "agent_promise_owner_task") {
    return {
      taskSummary: decision.taskSummary,
      taskDueIso: null,
      holdUntilIso: null,
      outcomeKey: "agent_promise_owner_task"
    };
  }
  return null;
}
