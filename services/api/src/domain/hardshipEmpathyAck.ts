/**
 * Hardship empathy acknowledgment (generation-only).
 *
 * When a customer discloses a personal hardship or serious situation (illness, injury,
 * hospitalization, grief/loss, a family or financial emergency) the LLM affect parser sets
 * `needsEmpathy` (parser-first comprehension; gated on confidence >= LLM_AFFECT_CONFIDENCE_MIN).
 * The handoff path and the frustration/complaint path already LEAD with a warm acknowledgment
 * ("I'm really sorry to hear that."), but a normal sales/logistics turn that happens to carry a
 * hardship disclosure — e.g. a deposit/hold request texted from a hospital bed (Nicholas Braun,
 * 2026-06-17) — went out with no acknowledgment and a tone-deaf sales push ("those limited runs
 * move quick"). The frustration path is deliberately scoped to pure frustration with no explicit
 * request, so it skips exactly this case.
 *
 * This prepends the SAME short, on-brand acknowledgment at the orchestrator's finalize choke
 * point, which BOTH the live (/webhooks/twilio) and regenerate (/conversations/:id/regenerate)
 * paths funnel through.
 *
 * CONSERVATIVE + purely additive (generation-only — no routing/state/side-effects):
 *  - only when the affect parser CONFIDENTLY flagged needsEmpathy,
 *  - never when the draft ALREADY opens with an acknowledgment/empathy beat (no double-ack),
 *  - never in a wrong context (manual handoff owns its own empathy),
 *  - empathy LEADS, so it prepends; the proactive visit invite (which appends) is suppressed on
 *    the same turn — we don't nudge a booking in the same breath as acknowledging hardship.
 *
 * The regex here inspects OUR OWN composed draft to avoid a double acknowledgment — it is NOT
 * customer-intent comprehension (that is the LLM affect parser). This mirrors how
 * proactiveVisitInvite.ts inspects the draft via textContainsSchedulingOffer.
 *
 * Pinned by scripts/hardship_empathy_ack_eval.ts.
 */

/** The short, warm acknowledgment — identical to the line the handoff/frustration paths already use. */
export const HARDSHIP_EMPATHY_ACK = "I'm really sorry to hear that.";

/** True when the draft already leads with an acknowledgment/empathy beat, so we must not double-ack. */
export function draftAlreadyAcknowledgesHardship(draft: string): boolean {
  const t = String(draft ?? "").trimStart().toLowerCase();
  if (!t) return false;
  return (
    /^(i'?m |i am |so |we'?re |we are |really |truly )?(so |very |truly )?sorry\b/.test(t) ||
    /^sorry to hear\b/.test(t) ||
    /^(oh no|oh man|that'?s (so |really )?(tough|rough|hard|terrible|awful|brutal|unfortunate))\b/.test(t) ||
    /^(i'?m |we'?re )?(really |so )?(sorry|saddened|heartbroken)\b/.test(t) ||
    /^(i |we )?(really |truly )?hope (you|everything|things|all|she|he|they)\b/.test(t) ||
    /^(glad|happy|relieved) (you'?re|to hear)\b/.test(t) ||
    /^(wishing you|sending|take care|get well|feel better|praying|thinking of you|stay strong)\b/.test(t) ||
    // Ack-led openers ("Totally hear you — …", the price-objection reply shape) already lead
    // with an acknowledgment beat — prepending "I'm really sorry to hear that." would double-ack.
    /^(totally|i|we) hear you\b/.test(t)
  );
}

export function shouldPrependHardshipAck(args: {
  needsEmpathy: boolean;
  shouldRespond: boolean;
  draft: string;
  wrongContext: boolean; // manual handoff / a context that owns its own empathy beat
}): boolean {
  if (!args.needsEmpathy) return false;
  if (!args.shouldRespond) return false;
  if (args.wrongContext) return false;
  const draft = String(args.draft ?? "").trim();
  if (!draft) return false;
  if (draftAlreadyAcknowledgesHardship(draft)) return false;
  return true;
}

/** Prepend the acknowledgment to a composed reply (no-op-safe: returns the ack alone if draft empty). */
export function prependHardshipAck(draft: string): string {
  const base = String(draft ?? "").trimStart();
  return base ? `${HARDSHIP_EMPATHY_ACK} ${base}` : HARDSHIP_EMPATHY_ACK;
}
