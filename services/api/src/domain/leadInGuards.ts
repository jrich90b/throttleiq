// Guards for the blended conversational lead-in (generateBlendedLeadInWithLLM). The lead-in
// LLM acknowledges a customer's chatter before the business reply — but it must not invent a
// reaction the customer's message doesn't warrant.
//
// Real miss (mike jaglowski, +17163350819, 6/16): "I have to be honest I absolutely love my
// bike, was more curiosity of what the value is" — affection for his OWN bike, no thanks — yet
// the lead-in opened "You're welcome.", which then went out unedited. "You're welcome" with no
// thanks is the same class as "Totally fair question" on a non-question: a fabricated frame.
//
// isFabricatedGratitudeLeadIn is an invariant guard on the LLM output (deterministic, fail-safe:
// dropping a wrong opener only loses a greeting, never a customer reply). A genuine thank-you in
// the customer's turn keeps the gratitude lead-in allowed.
const GRATITUDE_RESPONSE_LEADIN =
  /\b(you'?re\s+welcome|no\s+problem|no\s+worries|any\s?time|happy\s+to\s+help|glad\s+to\s+help|my\s+pleasure)\b/i;
const CUSTOMER_GRATITUDE =
  /\b(thanks|thank\s*(?:you|ya|u)|thx|ty|appreciate|grateful|much\s+obliged)\b/i;

export function isFabricatedGratitudeLeadIn(leadIn: string, customerText: string): boolean {
  if (!GRATITUDE_RESPONSE_LEADIN.test(String(leadIn ?? ""))) return false;
  return !CUSTOMER_GRATITUDE.test(String(customerText ?? ""));
}
