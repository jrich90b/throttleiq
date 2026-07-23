import { localPartsToUtcDate } from "./schedulerEngine.js";

/**
 * Voice next-step plan — act on the plan agreed on a LIVE phone call, with zero
 * manual logging by the rep (Joe, 2026-07-19).
 *
 * The voice durable-facts parser already extracts quote facts from a call
 * summary; it now also extracts the NEXT STEP (owner / action / stated day).
 * This module is the PURE decision for what those fields do:
 *
 *  - customer-owed step ("I'll come in Saturday")  → hold the generic cadence
 *    until the day AFTER the committed day, so no touchpoint texts over the
 *    customer's own plan. The cadence RESUMES on its own — never silenced.
 *  - staff-owed promise ("I'll send you numbers Monday") → a dated task on the
 *    lead owner (the agent heard the promise; no one re-keys it), and the
 *    cadence holds past the due day so a generic text doesn't contradict the
 *    promise before staff deliver.
 *  - any live conversation → a short breather (default 48h) before the next
 *    generic cadence touch, so the robot doesn't pounce right after a human
 *    hangs up. Facts-informed cadence copy is unaffected (voiceCadenceFacts).
 *
 * Joe's baseline ruling stands: VOICEMAILS CHANGE NOTHING — the cadence keeps
 * running and the existing 2nd-attempt call task machinery handles retries.
 *
 * Fail direction (deterministic side-effect gate, AGENTS.md-allowed): every
 * branch only ever DELAYS a proactive touch or ADDS a staff task — never sends,
 * never silences indefinitely, never closes. When unsure (low confidence, no
 * parsable day, owner "none"), the cadence continues with at most the breather.
 * Holds are applied via pauseFollowUpCadence, which only ever pushes nextDueAt
 * LATER — it can never pull a send earlier. A committed day too far out (past
 * maxHoldDays) falls back to the breather so a misparse can never park a lead
 * for months (the cadence_far_future failure mode).
 *
 * Pinned by scripts/voice_next_step_eval.ts (ci:eval).
 */

export const VOICE_NEXT_STEP_CONFIDENCE_MIN_DEFAULT = 0.7;
export const VOICE_LIVE_CALL_BREATHER_HOURS_DEFAULT = 48;
export const VOICE_NEXT_STEP_MAX_HOLD_DAYS_DEFAULT = 30;
/** Local wall-clock time holds resume / tasks come due (mirrors the soft-visit reminder). */
export const VOICE_NEXT_STEP_LOCAL_HOUR = 10;
export const VOICE_NEXT_STEP_LOCAL_MINUTE = 30;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface VoiceNextStepInput {
  /** True when the call was a voicemail / not actually contacted. */
  isVoicemail: boolean;
  nowMs: number;
  timeZone: string;
  /** conv.followUpCadence?.kind — post_sale cadences are never touched. */
  cadenceKind?: string | null;
  /** conv.followUp?.mode — human-owned / explicitly-held threads are never touched. */
  followUpMode?: string | null;
  /** conv.status — closed conversations are never touched. */
  conversationStatus?: string | null;
  nextStepOwner?: "customer" | "staff" | "none" | null;
  nextStepAction?: string | null;
  nextStepConfidence?: number | null;
  /** Parser: the customer's next step is a physical VISIT to the store ("I'll come in Saturday"). */
  customerVisitPlanned?: boolean | null;
  /** next_step_due_text resolved by the caller via parseRequestedDateOnly; null when absent/unparsable. */
  dueDate?: { year: number; month: number; day: number; dayOfWeek?: string } | null;
  confidenceMin?: number;
  breatherHours?: number;
  maxHoldDays?: number;
  /** Task-summary lead-in; defaults to the call phrasing. The text-channel
   * sibling (manualOutboundPromise.ts) passes "Promised over text:". */
  summaryLeadIn?: string;
}

export type VoiceNextStepDecision =
  | { kind: "none"; reason: string }
  | { kind: "breather_only"; holdUntilIso: string }
  | { kind: "hold_for_customer"; holdUntilIso: string; dueLabel: string }
  | {
      kind: "staff_task";
      taskSummary: string;
      taskDueIso: string;
      holdUntilIso: string;
      dueLabel: string;
    }
  /** Customer committed to a dated VISIT on the call: hold the cadence like hold_for_customer
   *  AND surface a dated staff task so the store expects them (Zackary Hauff +17165985414,
   *  operator-reported: "agreed to come in Saturday between 1:30 and 2:00" on a live call —
   *  said over SMS that creates a soft-visit task; said on a call it created NOTHING). */
  | {
      kind: "customer_visit_task";
      taskSummary: string;
      taskDueIso: string;
      holdUntilIso: string;
      dueLabel: string;
    };

function localMorningIso(
  timeZone: string,
  parts: { year: number; month: number; day: number },
  addDays: number
): string {
  const base = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0));
  base.setUTCDate(base.getUTCDate() + addDays);
  return localPartsToUtcDate(timeZone, {
    year: base.getUTCFullYear(),
    month: base.getUTCMonth() + 1,
    day: base.getUTCDate(),
    hour24: VOICE_NEXT_STEP_LOCAL_HOUR,
    minute: VOICE_NEXT_STEP_LOCAL_MINUTE
  }).toISOString();
}

function formatDueLabel(parts: { year: number; month: number; day: number }, timeZone: string): string {
  const d = localPartsToUtcDate(timeZone, {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour24: 12,
    minute: 0
  });
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric"
  }).format(d);
}

export function resolveVoiceNextStepConfidenceMin(envValue?: string | null): number {
  const n = Number(envValue);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : VOICE_NEXT_STEP_CONFIDENCE_MIN_DEFAULT;
}

export function resolveVoiceLiveCallBreatherHours(envValue?: string | null): number {
  const n = Number(envValue);
  return Number.isFinite(n) && n > 0 ? n : VOICE_LIVE_CALL_BREATHER_HOURS_DEFAULT;
}

export function decideVoiceNextStep(input: VoiceNextStepInput): VoiceNextStepDecision {
  // Voicemail = not contacted: cadence keeps running, existing 2nd-attempt call
  // task machinery owns retries (Joe's baseline ruling). Nothing changes here.
  if (input.isVoicemail) return { kind: "none", reason: "voicemail_no_change" };
  const status = String(input.conversationStatus ?? "").trim().toLowerCase();
  if (status === "closed") return { kind: "none", reason: "conversation_closed" };
  const mode = String(input.followUpMode ?? "").trim().toLowerCase();
  if (mode === "manual_handoff" || mode === "paused_indefinite") {
    return { kind: "none", reason: `held_mode_${mode}` };
  }
  if (String(input.cadenceKind ?? "").trim().toLowerCase() === "post_sale") {
    return { kind: "none", reason: "post_sale_cadence" };
  }

  const breatherHours = input.breatherHours ?? VOICE_LIVE_CALL_BREATHER_HOURS_DEFAULT;
  const breatherIso = new Date(input.nowMs + breatherHours * HOUR_MS).toISOString();
  const confidenceMin = input.confidenceMin ?? VOICE_NEXT_STEP_CONFIDENCE_MIN_DEFAULT;
  const maxHoldDays = input.maxHoldDays ?? VOICE_NEXT_STEP_MAX_HOLD_DAYS_DEFAULT;
  const owner = input.nextStepOwner === "customer" || input.nextStepOwner === "staff" ? input.nextStepOwner : "none";
  const confidence = Number(input.nextStepConfidence ?? 0);
  const action = String(input.nextStepAction ?? "").trim();

  // No concrete plan (or not confident there is one) → just the breather.
  if (owner === "none" || !(confidence >= confidenceMin) || !action) {
    return { kind: "breather_only", holdUntilIso: breatherIso };
  }

  // Resolve + sanity-check the committed day. Past days and days beyond the
  // hold cap fall back to the breather (a misparse must never park the lead).
  let due: { year: number; month: number; day: number } | null = input.dueDate ?? null;
  let dueLabel = "";
  if (due) {
    const dueNoonMs = localPartsToUtcDate(input.timeZone, {
      year: due.year,
      month: due.month,
      day: due.day,
      hour24: 12,
      minute: 0
    }).getTime();
    const tooFar = dueNoonMs > input.nowMs + maxHoldDays * DAY_MS;
    const inPast = dueNoonMs < input.nowMs - DAY_MS;
    if (tooFar || inPast) due = null;
    else dueLabel = formatDueLabel(due, input.timeZone);
  }

  if (owner === "customer") {
    if (!due) return { kind: "breather_only", holdUntilIso: breatherIso };
    // Resume the morning AFTER the committed day: don't text over the plan, and
    // if they went quiet the next touch lands naturally ("how did it go?" timing).
    const holdIso = localMorningIso(input.timeZone, due, 1);
    const holdUntilIso = Date.parse(holdIso) > Date.parse(breatherIso) ? holdIso : breatherIso;
    if (input.customerVisitPlanned) {
      // A dated VISIT commitment gets the hold AND a dated staff task — a customer walking in
      // Saturday with nobody expecting them is the miss (Zackary). Task comes due the morning of
      // the visit day; the cadence hold is identical to hold_for_customer.
      const leadIn = String(input.summaryLeadIn ?? "").trim() || "Said on the call:";
      return {
        kind: "customer_visit_task",
        taskSummary: `${leadIn} customer plans to VISIT${dueLabel ? ` ${dueLabel}` : ""} — ${action}. Be ready for them.`,
        taskDueIso: localMorningIso(input.timeZone, due, 0),
        holdUntilIso,
        dueLabel
      };
    }
    return { kind: "hold_for_customer", holdUntilIso, dueLabel };
  }

  // Staff-owed promise: dated task from the call itself (nobody re-keys it).
  // No stated day → due tomorrow morning so the promise can't quietly age out.
  const taskDueIso = due
    ? localMorningIso(input.timeZone, due, 0)
    : new Date(input.nowMs + 24 * HOUR_MS).toISOString();
  const holdBase = due ? localMorningIso(input.timeZone, due, 1) : breatherIso;
  const holdUntilIso = Date.parse(holdBase) > Date.parse(breatherIso) ? holdBase : breatherIso;
  const leadIn = String(input.summaryLeadIn ?? "").trim() || "Promised on the call:";
  const summary = `${leadIn} ${action}${dueLabel ? ` — by ${dueLabel}` : ""}`;
  return { kind: "staff_task", taskSummary: summary, taskDueIso, holdUntilIso, dueLabel };
}
