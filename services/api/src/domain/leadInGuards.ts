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

// The other half of the same class: a reply opening "Totally fair question / Great question"
// when the customer did not actually ask a question (a form, a statement). We detect the
// customer-IS-a-question GENEROUSLY (any "?" or interrogative phrasing) so the audit only
// flags clear non-questions — it should never cry wolf on a real question.
const QUESTION_FRAME_LEADIN = /\b(totally fair question|fair question|great question|good question)\b/i;
const CUSTOMER_IS_QUESTION =
  /\?|\b(what|whats|how|hows|when|where|which|who|why|do you|does|did you|can you|could you|would you|will you|is there|are there|any|how much|how many|tell me|wondering|curious about|let me know)\b/i;

export function isFabricatedQuestionFrame(replyOpener: string, customerText: string): boolean {
  if (!QUESTION_FRAME_LEADIN.test(String(replyOpener ?? ""))) return false;
  return !CUSTOMER_IS_QUESTION.test(String(customerText ?? ""));
}

export type FabricatedFrame = { fabricated: boolean; type: "gratitude" | "question" | null };

// Inspect ONLY the opening sentence of a reply — the fabricated frame is always the opener.
// Used by the nightly fabricated_frame audit to surface replies that invent a conversational
// frame (you thanked me / you asked a question) the customer's turn doesn't warrant.
export function detectFabricatedFrame(reply: string, customerText: string): FabricatedFrame {
  const opener = String(reply ?? "").split(/(?<=[.!?])\s+/)[0] ?? "";
  if (isFabricatedGratitudeLeadIn(opener, customerText)) return { fabricated: true, type: "gratitude" };
  if (isFabricatedQuestionFrame(opener, customerText)) return { fabricated: true, type: "question" };
  return { fabricated: false, type: null };
}
