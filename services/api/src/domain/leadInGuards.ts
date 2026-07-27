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

// A reassurance affirmation ("no problem", "no worries", "happy/glad to help", "anytime")
// is DUAL-USE: besides responding to thanks, it legitimately ANSWERS a customer request or
// yes/no question — "Can I drop off Tuesday afternoon?" → "No problem at all" means "yes,
// that's fine", not a fabricated you're-welcome (reassurance-opener-voice-ok, Joe 2026-07-08).
// "You're welcome" / "my pleasure" can only respond to thanks, so they stay flagged.
// NOTE: this exemption is AUDIT-ONLY (detectFabricatedFrame grades a full sent reply). The
// live blended-lead-in guard (isFabricatedGratitudeLeadIn, wired in llmDraft.ts) is left
// strict on purpose — a lead-in FRAGMENT never carries the business answer, so a bare "No
// problem" lead-in with no thanks is still fabricated there (blended_lead_in_guard:eval).
const REASSURANCE_AFFIRMATION =
  /\b(no\s+problem|no\s+worries|happy\s+to\s+help|glad\s+to\s+help|any\s?time)\b/i;

// Inspect ONLY the opening sentence of a reply — the fabricated frame is always the opener.
// Used by the nightly fabricated_frame audit to surface replies that invent a conversational
// frame (you thanked me / you asked a question) the customer's turn doesn't warrant.
export function detectFabricatedFrame(reply: string, customerText: string): FabricatedFrame {
  const opener = String(reply ?? "").split(/(?<=[.!?])\s+/)[0] ?? "";
  if (isFabricatedGratitudeLeadIn(opener, customerText)) {
    // Audit refinement: a reassurance affirmation answering a customer request/question is
    // a real answer, not a fabricated gratitude frame. CUSTOMER_IS_QUESTION is the generous
    // request/question detector (also covers "can I drop off …?").
    const reassuranceAnswer =
      REASSURANCE_AFFIRMATION.test(opener) && CUSTOMER_IS_QUESTION.test(String(customerText ?? ""));
    if (!reassuranceAnswer) return { fabricated: true, type: "gratitude" };
  }
  if (isFabricatedQuestionFrame(opener, customerText)) return { fabricated: true, type: "question" };
  return { fabricated: false, type: null };
}

// ---------------------------------------------------------------------------
// ECHOED-INBOUND-OPENING guard (draft-quality, 2026-07-27). A recurring miss class: the reply LLM
// opens by PARROTING the customer's own words back verbatim, then bolts a few words on — e.g.
// customer "Might be able to swing tomorrow after work" -> draft "might be able to swing tomorrow
// after work can work. Just give me a heads up...". It reads robotic and often starts lowercase
// (it grabbed the customer's fragment). A person acknowledges in their OWN words ("Tomorrow after
// work works great —"). This detector flags a reply whose OPENING is a long verbatim run of the
// customer's message. It is intentionally CONSERVATIVE (a self-heal REGENERATE trigger, not a hard
// strip): natural 2-3 word reuse ("tomorrow after work works") is NOT an echo — only a run of
// ECHO_MIN_RUN+ consecutive customer words, anchored at the very start of the reply, trips it.
const ECHO_MIN_RUN = 4; // consecutive customer words at the reply's opening → a parrot, not an ack

function echoTokens(s: string): string[] {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ") // drop punctuation/emoji so "work…" == "work"
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * True when `reply` OPENS by repeating a run of >= ECHO_MIN_RUN consecutive words taken verbatim
 * from `customerText`, starting within the reply's first word or two. Deterministic + fail-safe:
 * used only to TRIGGER a re-draft (never to block a send), so a rare false positive costs one
 * regenerate, never a lost reply. Pinned by outbound_echo_guard:eval.
 */
export function isEchoedInboundOpening(reply: string, customerText: string): boolean {
  const r = echoTokens(reply);
  const c = echoTokens(customerText);
  if (r.length < ECHO_MIN_RUN || c.length < ECHO_MIN_RUN) return false;
  // The echoed run must begin at the reply's opening (word 0 or 1 — allow one throwaway lead word).
  for (let start = 0; start <= 1 && start < r.length; start++) {
    // Find where r[start] appears in the customer text, then measure the contiguous match length.
    for (let ci = 0; ci < c.length; ci++) {
      if (c[ci] !== r[start]) continue;
      let run = 0;
      while (
        start + run < r.length &&
        ci + run < c.length &&
        r[start + run] === c[ci + run]
      ) {
        run++;
      }
      if (run >= ECHO_MIN_RUN) return true;
    }
  }
  return false;
}
