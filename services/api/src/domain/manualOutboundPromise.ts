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
  // Watch-promise phrasing is a promise with no deliverable VERB from the list below —
  // "ok we will keep an eye out. thanks for your inquiry" (kunwarsahilnaseem@gmail.com,
  // Joe's report 2026-08-12) never reached the parser because "keep an eye out" matches
  // nothing in it. The parser owns the verdict; this hint only decides whether to pay for it.
  const watchPromise =
    /\b(keep (?:an|any) eye out|watch for|let you know (?:if|when)|text you (?:if|when|as soon as)|notify you (?:if|when))\b/.test(
      t
    );
  if (watchPromise) return true;
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
  /**
   * Same shape as the voice referee's staff_task, except the cadence hold may be NULL: on a
   * held-mode thread (manual_handoff / paused_indefinite) the automated cadence is already
   * standing down, so there is nothing to hold — the dated task is the whole outcome.
   */
  | (Omit<Extract<VoiceNextStepDecision, { kind: "staff_task" }>, "holdUntilIso"> & {
      holdUntilIso: string | null;
    })
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
  | { kind: "agent_promise_owner_task"; reason: string; taskSummary: string }
  /**
   * The rep promised to WATCH for a bike ("we'll keep an eye out"). The follow-through is the
   * inventory-watch machinery, not addTodo — resolveInventoryNotifyPromisePlan (domain/
   * inventoryNotifyPromise.ts) decides watch-vs-task from the slot parser's spec.
   */
  | { kind: "inventory_notify_promise"; reason: string };

export function decideManualOutboundPromise(input: ManualOutboundPromiseInput): ManualOutboundPromiseDecision {
  const parse = input.parse;
  if (!parse || !parse.promisePresent) return { kind: "none", reason: "no_promise" };
  // "We'll keep an eye out" (kind inventory_notify) was EXCLUDED here on the premise that the
  // watch arm handles it — and the watch arm's semantic parse reads CUSTOMER intent, so it
  // returns watchAction "none" for a rep's promise (measured 3/3) and handed it right back.
  // Nothing minted anything since April on Kunwar's Forty-Eight (Joe's report 2026-08-12).
  // The promise parser IS the authority on this shape (3/3 at 0.80-0.86); route it to the
  // inventory-notify plan (a watch when the thread names the bike, a dated task when not) —
  // the caller owns the side effects via resolveInventoryNotifyPromisePlan. Closed threads
  // still bail; low confidence still bails (fail direction: silence only when uncertain).
  if (parse.kind === "inventory_notify") {
    const status = String(input.conversationStatus ?? "").trim().toLowerCase();
    if (status === "closed") return { kind: "none", reason: "conversation_closed" };
    const confidence = Number(parse.confidence ?? 0);
    const confidenceMin = input.confidenceMin ?? 0.7;
    if (!(confidence >= confidenceMin)) return { kind: "none", reason: "inventory_notify_low_confidence" };
    return { kind: "inventory_notify_promise", reason: "staff_watch_promise" };
  }
  if (!isActionablePromiseKind(parse.kind)) return { kind: "none", reason: `kind_${parse.kind || "none"}` };
  // A HELD-MODE thread is not a reason to drop the promise — it is the main population.
  //
  // The voice referee bails on manual_handoff / paused_indefinite ("held_mode_*") because ITS
  // outcomes are cadence holds, and a held thread has no cadence to hold. This referee
  // delegated to it wholesale, so a staff promise typed into a human-owned thread died on that
  // gate: Beverly Hennig +17169839279 (operator report 2026-08-11) was told "I'll have one of
  // the guys check the numbers out tomorrow", the parser read it at 0.90-0.93 (4/4), and the
  // held_mode bail dropped it — zero todos on her thread, nobody ever checked the numbers.
  // Measured 2026-08-14: 75 staff promise-shaped texts on held-mode threads since 6/1, and not
  // ONE minted a task. Staff type into human-owned threads BY DESIGN — that is what a manual
  // handoff is — so the suppression excluded exactly the population this arm was built for
  // (the same declared-reason trap as the ladder sweep's walk-in lanes, PR #663).
  //
  // So: on a held-mode thread the referee still decides the TASK, and only the cadence hold is
  // dropped (there is no cadence to hold). Closed conversations still bail inside the voice
  // referee. Fail direction unchanged: this only ever ADDS a dismissible staff task.
  const mode = String(input.followUpMode ?? "").trim().toLowerCase();
  const heldMode = mode === "manual_handoff" || mode === "paused_indefinite";
  const decision = decideVoiceNextStep({
    isVoicemail: false,
    nowMs: input.nowMs,
    timeZone: input.timeZone,
    cadenceKind: input.cadenceKind ?? null,
    followUpMode: heldMode ? null : input.followUpMode ?? null,
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
    if (input.humanAuthored) return heldMode ? { ...decision, holdUntilIso: null } : decision;
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
