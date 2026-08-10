/**
 * Short-list clarifier — the narrowing question we ask before pulling a list of bikes.
 *
 * Moved verbatim out of index.ts (2026-08-10) so the budget-gated-on-financing handoff could
 * be added without raising index.ts's size ceiling, and so the slot hints below sit next to
 * the parser that now owns the budget question (domain/budgetFinancingDeferral.ts).
 *
 * ⚠️ THE HINTS BELOW ARE WORD LISTS, AND THEY ARE NOT COMPREHENSION.
 * `hasBudgetHint` recognises exactly `$<digits>`, "under", "over", "around", "about", "max".
 * Measured 2026-08-10 against a real turn (+17164208660): the customer answered
 *   "No I want used and I don't know it depends on how much money I have to put down"
 * and the list scored it `hasBudgetHint: false`, so the clarifier asked for a budget again —
 * the one thing he had just explained he could not give. Every natural way of saying "I have
 * no number yet" is invisible to it: "whatever my payment works out to", "depends what the
 * bank says", "I have no idea yet", "as cheap as possible".
 *
 * The FIX for that turn is not a longer word list (AGENTS.md: comprehend, never regex) — it is
 * `resolveBudgetGatedOnFinancingReply`, which runs a typed parser BEFORE any of these doors and
 * hands the thread to finance. These hints stay as a cheap positive shortcut for the plain
 * cases ("around 15k"), where a miss only costs one extra clarifying question.
 */

export type ShortListClarifier = {
  reply: string;
  hasPreferenceHint: boolean;
};

/**
 * @param hasModelContext caller-supplied: a model named in this turn, or a known model already
 *   on the thread. Injected rather than resolved here because both lookups are index.ts-local.
 */
export function buildShortListClarifierReply(
  inboundText: string,
  hasModelContext: boolean
): ShortListClarifier {
  const text = String(inboundText ?? "").trim();
  const hasStyleHint =
    /\b(touring|bagger|cruiser|sport|sportster|adventure|pan america|trike|tri glide|freewheeler)\b/i.test(
      text
    ) ||
    /\b(crotch\s*rocket|sport\s*bike)\b/i.test(text) ||
    /\bsit\s+back\b/i.test(text) ||
    /\b(relaxed|comfortable)\s+(ride|riding|bike)\b/i.test(text) ||
    /\bopposite\b[\s\S]{0,24}\b(crotch\s*rocket|sport\s*bike)\b/i.test(text);
  const hasConditionHint = /\b(new|used|pre[-\s]?owned|preowned|both)\b/i.test(text);
  const hasBudgetHint =
    /\$\s*\d|\bunder\b|\bover\b|\baround\b|\babout\b|\bmax(?:imum)?\b/i.test(text);
  const needsFamily = !hasModelContext && !hasStyleHint;
  const needsCondition = !hasConditionHint;
  const needsBudget = !hasBudgetHint;
  const hasPreferenceHint = hasStyleHint || hasConditionHint || hasBudgetHint || hasModelContext;

  if (needsFamily && needsCondition) {
    return {
      hasPreferenceHint,
      reply:
        "Perfect — happy to. Are you leaning Grand American Touring, Cruiser, Sport, Adventure Touring, or Trike? Also, do you want new, used, or both, and what budget should I target?"
    };
  }
  if (needsFamily) {
    return {
      hasPreferenceHint,
      reply: needsBudget
        ? "Perfect — which family are you leaning toward (Grand American Touring, Cruiser, Sport, Adventure Touring, or Trike), and what budget should I target?"
        : "Perfect — which family are you leaning toward (Grand American Touring, Cruiser, Sport, Adventure Touring, or Trike)?"
    };
  }
  if (needsCondition) {
    return {
      hasPreferenceHint,
      reply: "Perfect — do you want new, used, or both, and what budget should I target?"
    };
  }
  if (needsBudget) {
    return {
      hasPreferenceHint,
      reply: "Perfect — any budget range I should target before I pull the short list?"
    };
  }
  return {
    hasPreferenceHint,
    reply: "Perfect — any must-have model or color before I pull the short list?"
  };
}

/**
 * Reply for an "open_to_alternatives" turn. Reuses the short-list clarifier (our existing
 * recommendation funnel) so we never freehand inventory: acknowledge the bike they referenced
 * without undercutting it, offer to line up a couple of options to compare, then ask the one
 * narrowing question the clarifier already owns.
 */
export function buildVehicleChoiceAlternativesReply(
  clarifier: ShortListClarifier,
  referencedLabel: string | null
): string {
  const lead = referencedLabel
    ? `Totally fair — the ${referencedLabel} is a strong pick, and I'm happy to line up a couple of other options to compare so you feel good about it. `
    : `Totally fair — happy to line up a couple of other options to compare so you feel good about it. `;
  return `${lead}${clarifier.reply}`;
}
