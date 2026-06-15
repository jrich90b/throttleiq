/**
 * First-touch ack auto-send — pure eligibility decision (Joe-approved scope A,
 * 2026-06-15; spec: docs/first_touch_autosend_spec.md).
 *
 * The biggest real-world quality lever is latency: the agent DRAFTS in ~30s but
 * the customer-facing SENT reply waits ~186 min median because suggest mode holds
 * every draft for staff approval (scripts/response_latency_audit.ts — the
 * agentDraft-vs-effective split). This module decides whether ONE reply — a
 * brand-new lead's first-touch acknowledgement, the part that is already
 * deterministic + Agent-Voice-Charter-clean — may auto-send in suggest mode.
 * Everything else (every non-first turn, every LLM-composed reply, every cadence
 * follow-up) stays staff-approved, exactly as today.
 *
 * PURE + fail-safe: any uncertainty resolves to send=false (hold the draft). The
 * env flag is read by the caller (isFirstTouchAckAutoSendEnabled) and passed in
 * as `enabled`, so this function stays deterministic + unit-testable. SHIPS DARK:
 * with FIRST_TOUCH_ACK_AUTOSEND unset/0, `enabled` is false ⇒ send=false always ⇒
 * exact current behavior. The live customer-send wiring is STEP 2 (approve-first).
 */

export type FirstTouchAutoSendInput = {
  /** Feature flag (FIRST_TOUCH_ACK_AUTOSEND). Off ⇒ never auto-send. */
  enabled: boolean;
  /** Brand-new lead, no prior outbound in the thread (isInitialAdf / first-outbound predicate). */
  isFirstTouch: boolean;
  /** Reply is the deterministic template/intro path (buildAgentIntro/applyInitialAdfPrefix), NOT LLM-composed. */
  isDeterministicReply: boolean;
  /** Destination phone is on the opt-out/STOP suppression list. */
  suppressed: boolean;
  /** Lead prefers calls only (contactPreference call_only / preferredContactMethod phone). */
  callOnly: boolean;
  /** Inbound was itself an opt-out (STOP/unsubscribe/cancel). */
  optedOut: boolean;
  /** Draft-state invariants allowed publication (applyDraftStateInvariants .allow). */
  invariantAllow: boolean;
  /** Resolved customer destination is a valid E.164 phone (SMS-deliverable; guards email-only leads). */
  hasDeliverablePhone: boolean;
};

export type FirstTouchAutoSendDecision = { send: boolean; reason: string };

/**
 * Pure. Returns send=true ONLY for an enabled, first-touch, deterministic reply
 * to an SMS-deliverable, non-opted-out, non-call-only lead whose draft cleared
 * the invariant guard. Any other state holds the draft (the current behavior).
 * Order matters only for the `reason` label (compliance reasons surface first).
 */
export function decideFirstTouchAutoSend(input: FirstTouchAutoSendInput): FirstTouchAutoSendDecision {
  if (!input.enabled) return { send: false, reason: "flag_off" };
  if (!input.isFirstTouch) return { send: false, reason: "not_first_touch" };
  if (!input.isDeterministicReply) return { send: false, reason: "llm_substantive_reply" };
  if (input.suppressed) return { send: false, reason: "suppressed" };
  if (input.optedOut) return { send: false, reason: "opted_out" };
  if (input.callOnly) return { send: false, reason: "call_only" };
  if (!input.invariantAllow) return { send: false, reason: "invariant_block" };
  if (!input.hasDeliverablePhone) return { send: false, reason: "no_deliverable_phone" };
  return { send: true, reason: "first_touch_deterministic_ack" };
}

/** Reads FIRST_TOUCH_ACK_AUTOSEND. Default OFF (dark). */
export function isFirstTouchAckAutoSendEnabled(): boolean {
  const raw = String(process.env.FIRST_TOUCH_ACK_AUTOSEND ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Reads FIRST_TOUCH_ACK_AUTOSEND_DEBUG. When on, the call site logs the shadow decision (no send). */
export function firstTouchAutoSendDebugEnabled(): boolean {
  const raw = String(process.env.FIRST_TOUCH_ACK_AUTOSEND_DEBUG ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
