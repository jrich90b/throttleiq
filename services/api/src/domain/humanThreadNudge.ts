/**
 * Quiet-thread nudge on human-owned AND handed-off threads (Joe 2026-07-20: "this should be as
 * hands off as possible"; Joe 2026-07-23 ruling: flip LIVE in draft mode + widen to manual-handoff
 * threads).
 *
 * A HUMAN-owned thread (mode=human) or a HANDED-OFF thread (followUp.mode=manual_handoff)
 * deliberately gets no cadence and no auto-drafts — the agent never talks over a rep mid-deal.
 * But when the CUSTOMER goes quiet after our last message, the old fallback was a task for the
 * owner (hands-ON) — and production showed those tasks getting closed with NO customer contact
 * (Zackary +17165985414: financing approved 7/16, 7 quiet days, 5 owner tasks closed, zero
 * outreach; Michael Spence +17169306602: web-widget price answered 7/06, silent since). This
 * module is the hands-off lane: after N quiet days the agent composes a short bump that CONTINUES
 * the thread in the rep's own voice (no persona intro, zero new facts —
 * composeHumanThreadNudgeWithLLM is the value gate), which lands as a suggest-mode DRAFT (one tap
 * to send). Full auto-send exists behind a second flag, DARK until Joe graduates it.
 *
 * This is the pure decision (no store, no clock, no LLM) — the cadenceHoldTtl.ts pattern. It
 * enumerates every stop-state so the nudge can never fire into: a thread that is neither
 * human-owned nor handed off (those have cadences), a NON-SALES department handoff (Motor
 * Clothes/Parts/Service own that thread — staff todo, never a customer bump), opt-out, closed,
 * call-only, a booked
 * appointment, an UNANSWERED customer message (that stays the owner's "needs YOUR reply" task —
 * the agent can't answer deal specifics), a pending draft, or a pending dated staff promise
 * ("I'll send numbers Monday" → the promise task owns the follow-up, no "just checking in" over
 * it), or a thread that has been quiet so long there is nothing left to continue (the ceiling
 * below). Capped per thread (max 2) with spacing between nudges.
 *
 * FAIL DIRECTION: every uncertain state → no nudge (silence). A missed bump costs a little
 * momentum; a wrong bump talks over a human deal. Flags:
 *   HUMAN_THREAD_NUDGE_ENABLED   (default ON since Joe's 7/23 ruling — drafts to the approval
 *                                 queue only; kill switch: set =0 + deploy)
 *   HUMAN_THREAD_NUDGE_AUTOSEND  (default OFF) — the zero-touch carve-out (skips the queue)
 */

export const HUMAN_THREAD_NUDGE_QUIET_DAYS_DEFAULT = 3;
export const HUMAN_THREAD_NUDGE_MAX_COUNT_DEFAULT = 2;
export const HUMAN_THREAD_NUDGE_SPACING_DAYS_DEFAULT = 5;

/**
 * The OTHER end of the quiet clock (Joe 2026-08-01, condition 3 of three before the feature is
 * re-enabled). A nudge is a ~3-day bump that continues a warm thread in the rep's voice with ZERO
 * new facts; past a month there is no thread left to continue, so the same message becomes a cold
 * re-open of a dead lead wearing a bump's label — and a cold re-open needs a reason to exist
 * (value-gated), which this composer is forbidden from inventing.
 *
 * 30 days is where the incident's own data separates cleanly. The 16 threads nudged on 2026-07-31
 * carried quiet days of 131, 130, 110, 87, 21, 13, 11, 10, 10, 8, 8, 7, 6, 6, 3, 3: twelve genuine
 * quiet threads at 21 days or less, then a gap to four dead ones at 87+. A 30-day ceiling keeps
 * every legitimate bump and blocks exactly those four (e.g. Amy Szyminski +17168615133, a March
 * JOB APPLICATION bumped 131 days later with "any other details you want me to pass along to the
 * hiring team?"). It also matches the store's own follow-up standard, which stops at day 30.
 *
 * Unlike the other knobs this one is NOT caller-supplied by default: a safety ceiling that has to
 * be wired at each call site is a ceiling that can be forgotten at one, so the decision applies it
 * whether or not the caller passes it. Overriding it is possible but never to "no ceiling" — a
 * missing, non-numeric, or non-positive value falls back to this default.
 */
export const HUMAN_THREAD_NUDGE_MAX_QUIET_DAYS_DEFAULT = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

function envFlag(name: string, fallback = "0"): boolean {
  const v = (String(process.env[name] ?? "").trim() || fallback).toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function envNum(name: string, fallback: number): number {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return fallback; // Number("") is 0 — an unset env must fall to the default
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function isHumanThreadNudgeEnabled(): boolean {
  // Default ON (Joe ruling 2026-07-23): draft-mode nudges are LIVE. Kill switch = set to 0.
  return envFlag("HUMAN_THREAD_NUDGE_ENABLED", "1");
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

/**
 * followUp.reason values we set ourselves when a NON-SALES department takes the thread
 * (index.ts web-text-widget lane + the service-handoff lane). These are our own structured state,
 * not comprehension — reading them is a deterministic invariant guard, not a regex over customer
 * text. A Motor Clothes / Parts / Service thread belongs to that department: the agent has no
 * facts it is allowed to add, so the composer's only moves are to re-ask what staff already asked
 * or to fabricate. The staff todo written alongside the handoff IS the follow-up.
 */
const NON_SALES_HANDOFF_REASONS = new Set(["apparel_request", "parts_request", "service_request"]);

export interface HumanThreadNudgeInput {
  conversationMode?: string | null; // "human" qualifies
  /** conv.followUp.mode — "manual_handoff" qualifies (Joe 7/23 widening). */
  followUpMode?: string | null;
  /** conv.followUp.reason — a NON-SALES department handoff is another team's thread, never bumped. */
  followUpReason?: string | null;
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
  /** An open todo with a FUTURE due date exists (a dated staff promise owns the follow-up). */
  hasOpenFutureDatedTodo?: boolean;
  nudgeCount?: number;
  lastNudgeAtMs?: number | null;
  nowMs: number;
  quietDays: number;
  maxCount: number;
  spacingDays: number;
  /**
   * Upper end of the quiet clock — omit it and HUMAN_THREAD_NUDGE_MAX_QUIET_DAYS_DEFAULT applies
   * anyway (the ceiling is a safety stop, not an opt-in). Junk falls back to the default.
   */
  maxQuietDays?: number | null;
}

export type HumanThreadNudgeDecision = { nudge: false; reason: string } | { nudge: true; quietDays: number };

/**
 * The eligible-class pre-filter, shared with the tick lane so it can skip the expensive
 * message/todo scans without restating (and drifting from) the first branch of the decision.
 */
export function isHumanThreadNudgeEligibleClass(conversationMode?: unknown, followUpMode?: unknown): boolean {
  return (
    String(conversationMode ?? "").trim().toLowerCase() === "human" ||
    String(followUpMode ?? "").trim().toLowerCase() === "manual_handoff"
  );
}

export function decideHumanThreadNudge(input: HumanThreadNudgeInput): HumanThreadNudgeDecision {
  // Eligible classes (Joe 7/23): a human-OWNED thread (mode=human) or a handed-off thread
  // (followUp.mode=manual_handoff). Everything else has a cadence/auto-draft lane of its own —
  // nudging there would double-message.
  const isHumanOwned = String(input.conversationMode ?? "").trim().toLowerCase() === "human";
  if (!isHumanThreadNudgeEligibleClass(input.conversationMode, input.followUpMode)) {
    return { nudge: false, reason: "not_human_or_handoff" };
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
  // A NON-SALES department handoff is another team's thread (Narendra +6282245353758, open-critic
  // 2026-08-01): a Motor Clothes web-widget lead got the apparel handoff ack, Joe then asked "are
  // you looking for factory racing t-shirts?", the customer never answered, and 12 quiet days later
  // the nudge re-asked Joe's own question back at him. "Continue the thread in the rep's voice"
  // over an unanswered staff question can only re-ask it, and the composer is forbidden new facts —
  // so on a department thread it has no legal move. Handed-off leads that go stale get staff todos,
  // not customer cadences, and that todo already exists (index.ts writes it on the handoff turn).
  // Deliberately ABOVE the quiet clock: this is a class exclusion, not a timing artifact.
  // mode=human wins — a rep who personally took the thread over is a stronger, fresher signal than
  // the department reason recorded when the lead first arrived.
  if (!isHumanOwned && NON_SALES_HANDOFF_REASONS.has(String(input.followUpReason ?? "").trim().toLowerCase())) {
    return { nudge: false, reason: "non_sales_department_handoff" };
  }
  // An unanswered CUSTOMER message stays the owner's job (the "needs YOUR reply" task, PR #223) —
  // the agent must not bump a customer who is waiting on the rep.
  if (input.lastMessageDirection !== "out") return { nudge: false, reason: "owner_reply_needed" };
  // NOTE (Joe 7/23): the old "last outbound must be a HUMAN send" gate is gone. Production showed
  // it blocking exactly the threads Joe wants bumped — Zackary's last delivered outbounds were an
  // agent credit-app ack and an event blast, so 7 quiet days produced nothing. On both eligible
  // classes every outbound was staff-approved (human send or suggest-queue approval), so the
  // rep-voice continuity the gate protected still holds.
  if (input.hasOpenFutureDatedTodo) return { nudge: false, reason: "staff_promise_pending" };
  const lastAtMs = Number(input.lastMessageAtMs);
  if (!Number.isFinite(lastAtMs)) return { nudge: false, reason: "no_message_anchor" };
  const quietMs = input.nowMs - lastAtMs;
  if (quietMs < input.quietDays * DAY_MS) return { nudge: false, reason: "not_quiet_long_enough" };
  // ...and the ceiling at the other end (Joe 2026-08-01). A thread this cold is not being
  // continued, it is being re-opened, and this composer has no facts to re-open it with.
  const maxQuiet = Number(input.maxQuietDays);
  const maxQuietDays =
    Number.isFinite(maxQuiet) && maxQuiet > 0 ? maxQuiet : HUMAN_THREAD_NUDGE_MAX_QUIET_DAYS_DEFAULT;
  if (quietMs > maxQuietDays * DAY_MS) return { nudge: false, reason: "quiet_too_long" };
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
