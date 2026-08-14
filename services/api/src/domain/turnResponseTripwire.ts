/**
 * The per-message tripwire (Joe's ruling, 2026-08-14 evening): minutes after every customer
 * message, ask one dead-simple question — did ANYTHING respond? An outbound, a draft in the
 * approval box, a staff task, a watch: any artifact at all. A turn that produced NONE of them
 * has fallen through every arm, and silence is the one outcome that is never right.
 *
 * Built from the two misses that proved the class: Rick Williamson (+17168609581) asked a
 * flex-financing question at 21:48 and got 16 hours of nothing (a watch-arm flag had silenced
 * the backstop, #707), and Beverly Hennig (+17169839279) was promised numbers that no task
 * tracked (#705). Both were invisible for DAYS because the deep detectors run daily. This
 * tripwire is deterministic — no LLM, no judge, no phantom risk — and its heal is the safest
 * side effect the system has: ONE merged, dismissible staff task (addTodo merges by open task
 * class, so repeat fires refresh one row, never stack).
 *
 * WHAT IT DELIBERATELY SKIPS (the 2026-08-14 taxonomy: 11 of 12 silent threads were CORRECTLY
 * silent): closed threads, suppressed/opted-out numbers, human-owned threads (#707's per-inbound
 * backstop already owns those), bare courtesy acks, tapback reactions, non-SMS providers (ADF
 * form blobs and phone-log records are not customer turns awaiting a text), and anything outside
 * the 10-minute-to-24-hour window — younger turns are still being worked by the live pipeline,
 * older ones belong to the daily sweeps.
 *
 * FAIL DIRECTION: every uncertain input reads as "don't fire". A missed fire costs what today
 * costs (the daily sweeps catch it); a false fire costs one dismissible task.
 */
import { isBareAcknowledgementText } from "./bareAcknowledgement.js";
import { isQuotedReactionInboundText } from "./regenerateSelection.js";

export const TURN_TRIPWIRE_MIN_AGE_MS_DEFAULT = 10 * 60 * 1000;
export const TURN_TRIPWIRE_MAX_AGE_MS_DEFAULT = 24 * 60 * 60 * 1000;

export interface TurnResponseTripwireInput {
  nowMs: number;
  conversationStatus?: string | null;
  mode?: string | null;
  suppressed: boolean;
  /** The LAST message on the thread — the tripwire only ever examines a thread whose newest row is inbound. */
  lastMessage: {
    direction?: string | null;
    provider?: string | null;
    body?: string | null;
    at?: string | null;
    id?: string | null;
  } | null;
  /** Any response artifact minted at-or-after the inbound: outbound/draft row, todo, watch, appointment change. */
  hasResponseArtifact: boolean;
  /** The tripwire's own receipt for this message id — never fire twice for one message. */
  alreadyFiredForMessageId?: string | null;
  minAgeMs?: number;
  maxAgeMs?: number;
}

export type TurnResponseTripwireDecision =
  | { fire: false; reason: string }
  | { fire: true; messageId: string; excerpt: string; ageMinutes: number };

export function decideTurnResponseTripwire(input: TurnResponseTripwireInput): TurnResponseTripwireDecision {
  const m = input.lastMessage;
  if (!m || m.direction !== "in") return { fire: false, reason: "last_message_not_inbound" };
  const provider = String(m.provider ?? "");
  // SMS-shaped customer turns only: ADF form blobs, phone-log records and voice artifacts are
  // not a customer sitting on their phone waiting for a text back.
  if (provider !== "twilio" && provider !== "web_widget") return { fire: false, reason: `provider_${provider || "none"}` };
  const body = String(m.body ?? "");
  if (!body.trim()) return { fire: false, reason: "empty_body" };
  if (String(input.conversationStatus ?? "").toLowerCase() === "closed") return { fire: false, reason: "conversation_closed" };
  if (input.suppressed) return { fire: false, reason: "suppressed" };
  // Human-owned threads: the per-inbound reply-needed backstop (#707) already mints the task at
  // arrival time — a second one here would be the double-task the backstop's flag exists to stop.
  if (String(input.mode ?? "").toLowerCase() === "human") return { fire: false, reason: "human_mode_backstop_owns_it" };
  if (isBareAcknowledgementText(body)) return { fire: false, reason: "bare_acknowledgement" };
  if (isQuotedReactionInboundText(body)) return { fire: false, reason: "tapback_reaction" };
  const messageId = String(m.id ?? "").trim();
  if (!messageId) return { fire: false, reason: "no_message_id" };
  if (input.alreadyFiredForMessageId && input.alreadyFiredForMessageId === messageId) {
    return { fire: false, reason: "already_fired" };
  }
  const atMs = Date.parse(String(m.at ?? ""));
  if (!Number.isFinite(atMs)) return { fire: false, reason: "undatable_message" };
  const age = input.nowMs - atMs;
  const minAge = input.minAgeMs ?? TURN_TRIPWIRE_MIN_AGE_MS_DEFAULT;
  const maxAge = input.maxAgeMs ?? TURN_TRIPWIRE_MAX_AGE_MS_DEFAULT;
  if (age < minAge) return { fire: false, reason: "too_young" };
  if (age > maxAge) return { fire: false, reason: "too_old_daily_sweeps_own_it" };
  if (input.hasResponseArtifact) return { fire: false, reason: "response_artifact_exists" };
  return {
    fire: true,
    messageId,
    excerpt: body.replace(/\s+/g, " ").slice(0, 140),
    ageMinutes: Math.round(age / 60_000)
  };
}

/**
 * Did ANY response artifact appear at-or-after the inbound? Pure over plain rows so the eval can
 * execute it. Artifacts: any outbound message row (a delivered send OR a draft_ai row — a draft
 * in the approval box means the pipeline responded and staff have it), any todo created since,
 * any inventory watch created since. Undatable rows count as artifacts (fail toward NOT firing).
 */
export function hasResponseArtifactSince(args: {
  inboundAtMs: number;
  messagesAfter: Array<{ direction?: string | null; at?: string | null; body?: string | null }>;
  todos: Array<{ createdAt?: string | null }>;
  watches: Array<{ createdAt?: string | null }>;
}): boolean {
  for (const m of args.messagesAfter) {
    if (m?.direction === "out" && String(m?.body ?? "").trim()) return true;
  }
  const sinceOk = (iso?: string | null) => {
    const t = Date.parse(String(iso ?? ""));
    if (!Number.isFinite(t)) return true; // undatable ⇒ assume it responded (never fire on uncertainty)
    return t >= args.inboundAtMs;
  };
  if (args.todos.some(t => sinceOk(t?.createdAt))) return true;
  if (args.watches.some(w => sinceOk(w?.createdAt))) return true;
  return false;
}
