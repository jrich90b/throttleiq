/**
 * Human-thread quiet nudge (Joe 2026-07-20: "this should be as hands off as possible").
 *
 * A HUMAN-owned thread (mode=human) deliberately gets no cadence and no auto-drafts — the agent
 * never talks over a rep mid-deal. But when the CUSTOMER goes quiet after the rep's last message,
 * the old fallback was a task for the owner (hands-ON). This module adds the hands-off lane: after
 * N quiet days the agent composes a short bump that CONTINUES the rep's own thread in the rep's own
 * voice (no persona intro — composeHumanThreadNudgeWithLLM), which lands as a suggest-mode DRAFT
 * (one tap to send). Full auto-send exists behind a second flag, DARK until Joe graduates it.
 *
 * This is the pure decision (no store, no clock, no LLM) — the cadenceHoldTtl.ts pattern. It
 * enumerates every stop-state so the nudge can never fire into: a non-human thread (those have
 * cadences), opt-out, closed, call-only, a booked appointment, an UNANSWERED customer message (that
 * stays the owner's "needs YOUR reply" task — the agent can't answer deal specifics), a pending
 * draft, or a pending dated staff promise ("I'll send numbers Monday" → the promise task owns the
 * follow-up, no "just checking in" over it). Capped per thread with spacing between nudges.
 *
 * FAIL DIRECTION: every uncertain state → no nudge (silence). A missed bump costs a little
 * momentum; a wrong bump talks over a human deal. Flags:
 *   HUMAN_THREAD_NUDGE_ENABLED   (default OFF) — the feature (drafts to the approval queue)
 *   HUMAN_THREAD_NUDGE_AUTOSEND  (default OFF) — the zero-touch carve-out (skips the queue)
 */

export const HUMAN_THREAD_NUDGE_QUIET_DAYS_DEFAULT = 3;
export const HUMAN_THREAD_NUDGE_MAX_COUNT_DEFAULT = 2;
export const HUMAN_THREAD_NUDGE_SPACING_DAYS_DEFAULT = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

function envFlag(name: string): boolean {
  const v = String(process.env[name] ?? "0").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function envNum(name: string, fallback: number): number {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return fallback; // Number("") is 0 — an unset env must fall to the default
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function isHumanThreadNudgeEnabled(): boolean {
  return envFlag("HUMAN_THREAD_NUDGE_ENABLED");
}

export function isHumanThreadNudgeAutosendEnabled(): boolean {
  return envFlag("HUMAN_THREAD_NUDGE_AUTOSEND");
}

export function humanThreadNudgeQuietDays(): number {
  return envNum("HUMAN_THREAD_NUDGE_QUIET_DAYS", HUMAN_THREAD_NUDGE_QUIET_DAYS_DEFAULT);
}

export function humanThreadNudgeMaxCount(): number {
  return envNum("HUMAN_THREAD_NUDGE_MAX_COUNT", HUMAN_THREAD_NUDGE_MAX_COUNT_DEFAULT);
}

export function humanThreadNudgeSpacingDays(): number {
  return envNum("HUMAN_THREAD_NUDGE_SPACING_DAYS", HUMAN_THREAD_NUDGE_SPACING_DAYS_DEFAULT);
}

export interface HumanThreadNudgeInput {
  conversationMode?: string | null; // must be "human"
  suppressed?: boolean; // STOP / opt-out / do-not-contact
  conversationStatus?: string | null;
  closedAt?: string | null;
  closedReason?: string | null;
  contactPreference?: string | null; // "call_only" never gets a text
  appointmentBookedEventId?: string | null;
  hasPendingDraft?: boolean; // never stack on an unreviewed draft
  /** Last DELIVERED message in the thread (twilio/human/sendgrid/web_widget — not draft_ai). */
  lastMessageDirection?: "in" | "out" | null;
  lastMessageAtMs?: number | null;
  /** The thread's last outbound was a real human send (actor user / provider human). */
  lastOutboundWasHuman?: boolean;
  /** An open todo with a FUTURE due date exists (a dated staff promise owns the follow-up). */
  hasOpenFutureDatedTodo?: boolean;
  nudgeCount?: number;
  lastNudgeAtMs?: number | null;
  nowMs: number;
  quietDays: number;
  maxCount: number;
  spacingDays: number;
}

export type HumanThreadNudgeDecision = { nudge: false; reason: string } | { nudge: true; quietDays: number };

export function decideHumanThreadNudge(input: HumanThreadNudgeInput): HumanThreadNudgeDecision {
  if (String(input.conversationMode ?? "").trim().toLowerCase() !== "human") {
    return { nudge: false, reason: "not_human_mode" };
  }
  if (input.suppressed) return { nudge: false, reason: "suppressed" };
  const closed =
    String(input.conversationStatus ?? "").trim().toLowerCase() === "closed" ||
    !!String(input.closedAt ?? "").trim() ||
    !!String(input.closedReason ?? "").trim();
  if (closed) return { nudge: false, reason: "closed" };
  if (String(input.contactPreference ?? "").trim().toLowerCase() === "call_only") {
    return { nudge: false, reason: "call_only" };
  }
  if (String(input.appointmentBookedEventId ?? "").trim()) {
    return { nudge: false, reason: "appointment_booked" };
  }
  if (input.hasPendingDraft) return { nudge: false, reason: "pending_draft" };
  // An unanswered CUSTOMER message stays the owner's job (the "needs YOUR reply" task, PR #223) —
  // the agent must not bump a customer who is waiting on the rep.
  if (input.lastMessageDirection !== "out") return { nudge: false, reason: "owner_reply_needed" };
  if (!input.lastOutboundWasHuman) return { nudge: false, reason: "no_human_outbound" };
  if (input.hasOpenFutureDatedTodo) return { nudge: false, reason: "staff_promise_pending" };
  const lastAtMs = Number(input.lastMessageAtMs);
  if (!Number.isFinite(lastAtMs)) return { nudge: false, reason: "no_message_anchor" };
  const quietMs = input.nowMs - lastAtMs;
  if (quietMs < input.quietDays * DAY_MS) return { nudge: false, reason: "not_quiet_long_enough" };
  const count = Number(input.nudgeCount ?? 0);
  if (count >= input.maxCount) return { nudge: false, reason: "cap_reached" };
  if (count > 0) {
    const lastNudgeMs = Number(input.lastNudgeAtMs);
    if (!Number.isFinite(lastNudgeMs) || input.nowMs - lastNudgeMs < input.spacingDays * DAY_MS) {
      return { nudge: false, reason: "spacing_not_elapsed" };
    }
  }
  return { nudge: true, quietDays: Math.floor(quietMs / DAY_MS) };
}
