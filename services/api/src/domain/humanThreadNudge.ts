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

import { referencesPastDatedEvent } from "./pastEventGuard.js";

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

/**
 * The messages a bump is written FROM: real, delivered, non-empty traffic, newest last.
 *
 * The provider allowlist is the point — a `draft_ai` row is a draft staff may never approve, and the
 * voice/payment rows are internal log entries. Reading one as "our last message" would start the
 * quiet clock from something the customer never saw. Lives here rather than inline in the tick so
 * the thread the decision reads and the thread the composer is shown are the same list.
 */
const NUDGE_THREAD_PROVIDERS = new Set(["twilio", "human", "sendgrid", "web_widget", "sendgrid_adf"]);

export function selectHumanThreadNudgeThread(messages?: unknown): { thread: any[]; last: any | null } {
  const rows = Array.isArray(messages) ? (messages as any[]) : [];
  const thread = rows.filter(
    m => NUDGE_THREAD_PROVIDERS.has(String(m?.provider ?? "")) && String(m?.body ?? "").trim()
  );
  return { thread, last: thread[thread.length - 1] ?? null };
}

/**
 * Does this thread already have a staff task dated in the FUTURE? If so the bump stays quiet — a
 * dated promise ("I'll send numbers Monday") owns the follow-up, and "just checking in" over the top
 * of it reads as the left hand not knowing what the right is doing.
 */
export function hasOpenFutureDatedTodo(
  openTodos: unknown,
  convId: string | null | undefined,
  nowMs: number
): boolean {
  const rows = Array.isArray(openTodos) ? (openTodos as any[]) : [];
  return rows.some(t => {
    if (t?.convId !== convId) return false;
    const dueMs = Date.parse(String(t?.dueAt ?? ""));
    return Number.isFinite(dueMs) && dueMs > nowMs;
  });
}

/**
 * Is it worth PAYING to compose a bump for this thread?
 *
 * Everything here is cheap and certain, and it all used to run AFTER the LLM composition, which is
 * how the 2026-07-31 incident happened: enabling the feature took the one-minute follow-up tick from
 * ~13s to 150-220s. The per-tick cap counted only nudges that fully SUCCEEDED, so every rejected
 * composition was a free, uncounted LLM call and the loop could compose across all ~830
 * conversations. Only 16 threads were ever nudged while every tick burned three minutes.
 *
 * Two answers can be known for certain before spending anything:
 *
 * - **An unroutable phone.** No text can be sent to it, so a composed draft is pure waste.
 * - **A past-dated ANCHOR.** A bump continues the thread's last exchange, so if that exchange
 *   invited the customer to something already behind us, the bump re-issues it — Don Soto
 *   (+17167134185) got "circling back on the Taste of Country pre-party invite… still planning to
 *   come by Saturday?" five weeks after the June 20th party. The anchors are known before the bump
 *   exists, so this half of the guard costs nothing to run first.
 *
 * The COMPOSED TEXT still has to be checked against the same guard afterwards — it can name a date
 * the anchors never did — and `referencesPastDatedEvent` is a plain any-of over the texts it is
 * given, so checking anchors here and the composed text there is exactly the single combined call
 * it replaces. What it is NOT is the near-duplicate check: that genuinely needs the composed body,
 * so it stays downstream. Bounding it is the composition COUNTER's job, not this gate's.
 *
 * FAIL DIRECTION unchanged: anything uncertain returns compose:false ⇒ silence.
 */
export type HumanThreadNudgeComposeGate =
  | { compose: true }
  | { compose: false; reason: "unroutable_phone" | "past_dated_anchor" | "nothing_to_continue" };

/**
 * The compliance footer is on almost every outbound and says nothing about the deal, so it must not
 * count as substance. Matches the sentence `INITIAL_SMS_OPTOUT_FOOTER` adds and its common variants.
 */
const OPT_OUT_FOOTER_SENTENCE = /\b(?:reply\s+(?:stop|unsubscribe)|text\s+stop)\b[^.!?]*[.!?]?/gi;

/**
 * How much real text a thread must carry before a bump can "continue" it.
 *
 * 40 characters, and the number is picked from a GAP in the live data rather than taste. Measured
 * 2026-08-08 over all 363 eligible threads, longest footer-stripped message in the last 8:
 * **2 threads under 20 · 2 at 20-39 · ZERO at 40-59 · 7 at 60-99 · 352 at 100+** (p5 = 146).
 * Every thread below the line is a signature or an opt-out and nothing else — "Scott Hartrich
 * American H-D" (x2), a bare "STOP", and "stone from harley".
 *
 * That last one is why this exists. Dennis Kowalczyk (+17163459354): his entire thread was
 * *"stone from harley Reply STOP to opt out."* — a rep announcing himself. With nothing to continue,
 * the composer manufactured **"You still getting those messages or want me to stop them, Dennis?"**,
 * inviting a customer to unsubscribe from a conversation that never happened.
 *
 * FAIL DIRECTION: too thin ⇒ NO bump. A missed nudge on a threadbare thread costs nothing — there
 * was no thread to continue. Inventing one costs a customer.
 */
export const HUMAN_THREAD_NUDGE_MIN_ANCHOR_CHARS = 40;

/** Is there enough real text in these anchors to continue? Footer and whitespace do not count. */
export function anchorsHaveSomethingToContinue(anchors?: unknown): boolean {
  const rows = Array.isArray(anchors) ? (anchors as any[]) : [];
  return rows.some(
    m =>
      String(m?.body ?? "")
        .replace(OPT_OUT_FOOTER_SENTENCE, " ")
        .replace(/\s+/g, " ")
        .trim().length >= HUMAN_THREAD_NUDGE_MIN_ANCHOR_CHARS
  );
}

export function resolveHumanThreadNudgeComposeGate(input: {
  /** Already E.164-normalised by the caller; "" when the lead has no sendable number. */
  toE164?: string | null;
  /** The thread rows from selectHumanThreadNudgeThread — this module owns what "anchor text" means. */
  anchors?: unknown;
  nowMs: number;
}): HumanThreadNudgeComposeGate {
  if (!String(input.toE164 ?? "").startsWith("+")) return { compose: false, reason: "unroutable_phone" };
  const anchorBodies = (Array.isArray(input.anchors) ? (input.anchors as any[]) : []).map(m =>
    String(m?.body ?? "")
  );
  if (referencesPastDatedEvent(anchorBodies, { nowMs: input.nowMs })) {
    return { compose: false, reason: "past_dated_anchor" };
  }
  if (!anchorsHaveSomethingToContinue(input.anchors)) {
    return { compose: false, reason: "nothing_to_continue" };
  }
  return { compose: true };
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
  /** isThreadParkedOnInventoryPromise(conv) — the thread is quiet because WE said we'd call it. */
  parkedOnInventoryPromise?: boolean;
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
  // A thread parked on a promise we made (active watch / cadence stopped for one / a unit on order)
  // — see isThreadParkedOnInventoryPromise. Like the department stop this is a CLASS exclusion, so
  // it sits ABOVE the quiet clock: the answer must not change with how long the customer waits.
  if (input.parkedOnInventoryPromise) return { nudge: false, reason: "parked_on_inventory_promise" };
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
