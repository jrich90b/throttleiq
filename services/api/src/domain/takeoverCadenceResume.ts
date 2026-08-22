/**
 * Human-takeover cadence resume — the state-reconcile heal for Joe's 2026-08-21 rulings:
 * a manual takeover must not permanently kill the follow-up schedule when the deal shows
 * no progress ("after the two nudges it should pick back up on the cadence where it left
 * off"). The DECISION lives in routeStateReducer (decideHumanTakeoverCadenceResume — quiet
 * bar, progress signals, one-way); this module applies it: gather the structured inputs
 * from the conversation, and on a resume verdict call resumeFollowUpCadence, which picks
 * the cadence back up AT ITS CURRENT STEP (Joe: where it left off, not a restart, not a
 * long_term demotion).
 *
 * CAPPED PER TICK: on first deploy ~60+ threads are eligible at once (the census's
 * takeover-seam backlog); an uncapped pass would flood the approval box in one morning —
 * the same "won't overwhelm" requirement as the ride-challenge stagger. The cap drains the
 * backlog across ticks; steady-state is a trickle.
 *
 * Pinned by takeover_cadence_resume:eval (decision table + one-way/convergence + this
 * wiring body + the mode-endpoint toggle-back resume).
 */
import {
  type Conversation,
  getLatestPendingDraft,
  resumeFollowUpCadence,
  saveConversation
} from "./conversationStore.js";
import { decideHumanTakeoverCadenceResume } from "./routeStateReducer.js";

type RecordRouteOutcome = (scope: "manual", outcome: string, detail?: Record<string, unknown>) => void;

export const TAKEOVER_RESUME_MAX_PER_TICK = 10;

const DELIVERED_PROVIDERS = ["twilio", "human", "sendgrid", "web_widget", "sendgrid_adf"];

/** Newest delivered message in either direction — drafts and stale ghosts never count. */
export function lastDeliveredAtMs(conv: Conversation): number | null {
  let latest: number | null = null;
  for (const m of conv.messages ?? []) {
    const msg: any = m;
    if (!DELIVERED_PROVIDERS.includes(String(msg?.provider ?? ""))) continue;
    if (msg?.draftStatus) continue;
    if (!String(msg?.body ?? "").trim()) continue;
    const at = Date.parse(String(msg?.at ?? ""));
    if (!Number.isFinite(at)) continue;
    if (latest === null || at > latest) latest = at;
  }
  return latest;
}

/**
 * Toggle-back resume (Joe 8/21): flipping a thread back to AI mode must also restart the
 * follow-up schedule the takeover stopped — before this, the toggle only re-enabled reply
 * drafting and the cadence stayed secretly dead. manual_handoff ONLY: disposition stops
 * (wrong_number, no_longer_owns…) are judgements and stay stopped. Called from the
 * /conversations/:id/mode endpoint on the suggest direction of the toggle.
 */
export function resumeCadenceOnModeToggle(
  conv: Conversation,
  timeZone: string,
  recordRouteOutcome: RecordRouteOutcome
): boolean {
  if (conv.followUpCadence?.status !== "stopped") return false;
  if (conv.followUpCadence?.stopReason !== "manual_handoff") return false;
  resumeFollowUpCadence(conv, timeZone);
  saveConversation(conv);
  recordRouteOutcome("manual", "takeover_cadence_resumed_on_mode_toggle", {
    convId: conv.id,
    leadKey: conv.leadKey,
    stepIndex: conv.followUpCadence?.stepIndex ?? null
  });
  return true;
}

export function resumeTakeoverStoppedCadences(
  convs: Conversation[],
  opts: {
    nowMs: number;
    timeZone: string;
    isSuppressed: (leadKey: string) => boolean;
    openTodos: Array<{ convId?: string | null; dueAt?: string | null }>;
    recordRouteOutcome: RecordRouteOutcome;
  }
): number {
  let resumed = 0;
  for (const conv of convs) {
    if (resumed >= TAKEOVER_RESUME_MAX_PER_TICK) break;
    const cad: any = conv.followUpCadence;
    if (!cad) continue;
    const hasOpenFutureTodo = opts.openTodos.some(t => {
      if (t?.convId !== conv.id) return false;
      const dueMs = Date.parse(String(t?.dueAt ?? ""));
      return Number.isFinite(dueMs) && dueMs > opts.nowMs;
    });
    const decision = decideHumanTakeoverCadenceResume({
      cadenceStatus: cad.status,
      cadenceStopReason: cad.stopReason,
      cadenceStepIndex: cad.stepIndex,
      lastDeliveredAtMs: lastDeliveredAtMs(conv),
      nowMs: opts.nowMs,
      conversationClosed: conv.status === "closed" || !!conv.closedAt || !!conv.closedReason,
      sold: !!conv.sale?.soldAt || conv.closedReason === "sold",
      suppressed: opts.isSuppressed(conv.leadKey),
      contactPreference: (conv as any).contactPreference ?? null,
      appointmentBookedEventId: conv.appointment?.bookedEventId ?? null,
      hasHold: !!(conv as any).hold,
      hasOpenFutureDatedTodo: hasOpenFutureTodo,
      hasPendingDraft: !!getLatestPendingDraft(conv)
    });
    if (!decision) continue;
    resumeFollowUpCadence(conv, opts.timeZone);
    saveConversation(conv);
    resumed += 1;
    opts.recordRouteOutcome("manual", "takeover_cadence_resumed", {
      convId: conv.id,
      leadKey: conv.leadKey,
      quietDays: decision.quietDays,
      stepIndex: conv.followUpCadence?.stepIndex ?? null
    });
  }
  if (resumed > 0) {
    console.log(`[state-reconcile] resumed ${resumed} takeover-stopped cadence(s) after the quiet window (Joe 8/21)`);
  }
  return resumed;
}
