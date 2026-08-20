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

/**
 * A leading agent self-introduction sentence, in either shape we emit:
 *   "Hey Wesley, it's Alexandra over at American Harley-Davidson. "  (buildAgentIntro)
 *   "Hi Wesley — This is Alexandra at American Harley-Davidson. "    (legacy inline intros)
 * Inspecting OUR OWN composed draft, not the customer's words — same rationale as
 * `draftAlreadyAcknowledgesHardship` above.
 */
const AGENT_INTRO_LEAD_RE =
  /^(?:(?:hi|hey|hello)\b[^.!?]{0,60}?[,—-]\s*)?(?:it[’']?s|this is)\s+[^.!?]{2,120}?\bat\s+[^.!?]{2,160}?[.!]\s*/i;

/**
 * Apply the hardship acknowledgment to a FIXED department/handoff template.
 *
 * Why this exists instead of reusing the orchestrator's finalize hook: the department arms
 * (parts/apparel/service/credit — the "we'll have the team reach out" acks) EARLY-RETURN their
 * own hand-built template and never pass through `finalize()`, and they all call
 * `setFollowUpMode(conv, "manual_handoff", ...)` first — so the orchestrator's `wrongContext`
 * veto ("manual handoff owns its own empathy") would suppress the ack even if they did. That
 * veto is correct for the MENTION-handoff arm, which composes its own "I'm really sorry to hear
 * that." beat; it is wrong for these templates, which own no empathy beat at all. Wesley Buzzard
 * (+17162913658, 2026-07-30) disclosed his mother's death while asking for a shirt and got the
 * bare "Thanks — I've received your apparel request." So the templates OPT IN here rather than
 * being vetoed generically; `orchestrator.ts`'s suppression is deliberately left untouched.
 *
 * INTRO-AWARE on purpose: the ADF lane prefixes an agent introduction before publishing, and a
 * naive prepend yields "I'm really sorry to hear that. Hey Wesley, it's Alexandra over at …".
 * The ack goes AFTER the intro sentence, never before it.
 *
 * `needsEmpathy` comes from the LLM affect parser's confidence-gated snapshot (parser-first —
 * no regex reads the customer's words here). Pinned by scripts/hardship_empathy_ack_eval.ts.
 */
export function applyHardshipAckToHandoffTemplate(args: {
  draft: string;
  needsEmpathy: boolean;
}): string {
  const original = String(args.draft ?? "");
  if (!args.needsEmpathy) return original;
  const trimmed = original.trim();
  if (!trimmed) return original;
  const introMatch = trimmed.match(AGENT_INTRO_LEAD_RE);
  const intro = introMatch ? introMatch[0] : "";
  const body = intro ? trimmed.slice(intro.length) : trimmed;
  if (
    !shouldPrependHardshipAck({
      needsEmpathy: true,
      shouldRespond: true,
      draft: body,
      // The whole point: these templates carry no empathy beat, so manual_handoff must not veto.
      wrongContext: false
    })
  ) {
    return original;
  }
  return intro ? `${intro.trimEnd()} ${prependHardshipAck(body)}` : prependHardshipAck(body);
}

/**
 * The composer's HARDSHIP rule block, moved out of llmDraft.ts (2026-08-20) to pay for the
 * department-collaboration wiring under the source-size ratchet. Same text, same behaviour — it
 * simply lives next to the deterministic backstop (`prependHardshipAck`) that enforces the same
 * rule at finalize, so the prompt-side and the finalize-side of "lead with the acknowledgment"
 * are readable together.
 */
export const HARDSHIP_DRAFT_PROMPT_RULES = `
HARDSHIP (the customer disclosed a personal hardship or serious situation — illness, injury, hospitalization, grief/loss, a family or financial emergency):
- OPEN with one short, genuine line acknowledging THAT specific hardship before anything else.
- Be human and warm; never minimize it and never sound scripted.
- Drop ALL scarcity/urgency/sales pressure ("moves quick", "won't last", "limited", "act now") — this is not the moment.
- You may still answer their actual request (e.g. how to leave a deposit / hold a bike), but gently, with no push to come in.
- Reassure there's no rush and you're there when they're ready.
`;
