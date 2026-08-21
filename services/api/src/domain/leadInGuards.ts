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

/** Word-bounded gratitude test — the SAME notion of "the customer thanked us" the guard above
 *  uses, exported so the deterministic lead-in picker can't drift to a looser rule. */
export function hasCustomerGratitude(text: string): boolean {
  return CUSTOMER_GRATITUDE.test(String(text ?? ""));
}

// ---------------------------------------------------------------------------
// LEAD-IN SOURCE guard (2026-07-31). The guard above protects the LLM lead-in path. Its
// DETERMINISTIC twin (pickLeadInVariant in conversationStore) was never given the same
// protection, and it fabricated a frame a different way: not by picking a wrong opener for the
// customer's words, but by picking the opener from text that was never the customer's words.
//
// Real miss (dominic, +17169309966, 7/20 — Joe thumbed it down: "Should have never said you're
// welcome"). A cadence ack "Sounds good — I'll be here when you're ready…" went out as
// "You're welcome. I'll be here when you're ready…". Two independent defects stacked:
//   1. SPEAKER-BLIND. The thread's last inbound was a VOICE-CALL TRANSCRIPT — a two-speaker
//      script, "Customer: Go ahead.\nAgent: Thank you." — and the picker matched "thank you"
//      spoken by OUR OWN agent. Only the Customer: lines are ever the customer's words.
//   2. STALE. That transcript was 93 days old. "You're welcome" only makes sense as a reply to
//      something just said; an inbound from three months ago must never frame a fresh send.
// A third latent defect found while fixing these: the picker's gratitude test was an UNBOUNDED
// substring match, so "ty" matched inside warranty / pretty / twenty / city / safety / quality
// — i.e. "what's the warranty?" earned a "You're welcome." Fixed by reusing the word-bounded
// CUSTOMER_GRATITUDE above.
//
// FAIL DIRECTION (AGENTS.md migrate-vs-keep): these are invariant guards on provenance, not
// comprehension — deterministic is correct here. Every one fails SAFE: when a guard fires we
// simply drop the lead-in fragment, and the business sentence still ships in full. Nothing goes
// silent, no reply is lost, no side effect is skipped. The dangerous direction is the other one
// (inventing a conversational frame the customer never opened), which is exactly the miss.

/** An inbound older than this can no longer frame a fresh outbound's lead-in. Generous on
 *  purpose — real reply threads turn around in minutes to hours, so this only ever trips on a
 *  long-dormant thread, where a contextual opener is fabricated by definition. */
export const LEAD_IN_MAX_INBOUND_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const TRANSCRIPT_CUSTOMER_LINE = /^\s*customer\s*:\s*/i;

/**
 * The customer's OWN words from an inbound message. A `voice_transcript` inbound is a
 * two-speaker script in which our agent also speaks, so only the `Customer:` lines count; if it
 * carries no Customer: line at all we return "" rather than risk framing our reply with our own
 * speech. Every other inbound provider is the customer's own message, returned unchanged.
 */
export function customerSpokenText(body: string, provider?: string | null): string {
  const text = String(body ?? "");
  if (String(provider ?? "") !== "voice_transcript") return text;
  const lines = text
    .split(/\r?\n/)
    .filter(line => TRANSCRIPT_CUSTOMER_LINE.test(line))
    .map(line => line.replace(TRANSCRIPT_CUSTOMER_LINE, "").trim())
    .filter(Boolean);
  return lines.join(" ");
}

/**
 * The text a deterministic lead-in may be derived from: the customer's own words, and only
 * while they are recent enough to still be what we are replying to. Returns "" when no lead-in
 * should be fabricated at all. Pure + fail-safe; pinned by blended_lead_in_guard:eval.
 */
export function resolveLeadInSourceText(input: {
  body?: string | null;
  provider?: string | null;
  at?: string | null;
  now?: string | number | Date | null;
}): string {
  const spoken = customerSpokenText(String(input.body ?? ""), input.provider);
  if (!spoken.trim()) return "";
  const inboundMs = Date.parse(String(input.at ?? ""));
  if (!Number.isFinite(inboundMs)) return spoken; // no timestamp to judge by → leave as-is
  const nowMs =
    input.now == null || input.now === "" ? Date.now() : new Date(input.now as string).getTime();
  if (!Number.isFinite(nowMs)) return spoken;
  if (nowMs - inboundMs > LEAD_IN_MAX_INBOUND_AGE_MS) return "";
  return spoken;
}

// ---------------------------------------------------------------------------
// POST-SALE WARMTH guard (2026-08-04). A third site fabricating a frame, found by the corpus
// replay on Jeff (+17164322105 shape, conv +17164182619): he wrote "Hey Scott, it's Jeff. I'm
// gonna swing in on Saturday because I have that lien release. Did you call the old owner about
// the second key?" and the post-sale item-pickup reply opened
// "Love hearing that — glad the ride home went great."
//
// Two stacked defects, the same shapes this module already documents:
//   1. SPEAKER-BLIND. The positivity test ran against the customer's turn CONCATENATED WITH
//      recent conversation context — and that context includes OUR OWN outbound copy, which for
//      a post-sale thread is very often "Thanks again for coming to see us for your bike." So we
//      congratulated the customer on the strength of our own words. Same class as the
//      voice-transcript miss above (#389) and the walk-in note judged as customer speech (#368).
//   2. ASSERTED AN EVENT NOBODY MENTIONED. Even for a genuinely delighted customer, "glad the
//      ride home went great" claims they took delivery and rode home. Jeff had not — he was
//      coming IN with a lien release. Positive sentiment licenses warmth, never a fact.
//
// FAIL DIRECTION: this is an invariant guard on provenance, not comprehension, so deterministic
// is correct (AGENTS.md migrate-vs-keep). It fails SAFE exactly like its neighbours — when the
// guard declines, only the warmth fragment is dropped and the business sentence still ships in
// full. The dangerous direction is the other one: inventing an experience the customer never
// reported. Pinned by blended_lead_in_guard:eval.
const CUSTOMER_POSITIVE_EXPERIENCE =
  /\b(thank\s*(?:you|ya|u)|thanks|amazing|smiles?|priceless|great|awesome|love|loved)\b/i;

/**
 * True when the CUSTOMER's own words this turn report a positive experience. Deliberately takes
 * only the customer's message — never the surrounding thread — because our own outbound copy is
 * relentlessly positive and would otherwise earn the frame on its own. `provider` is optional and
 * routes through customerSpokenText, so a two-speaker voice transcript can only ever match on its
 * Customer: lines.
 */
export function hasCustomerPositiveExperience(
  customerText: string | null | undefined,
  provider?: string | null
): boolean {
  return CUSTOMER_POSITIVE_EXPERIENCE.test(customerSpokenText(String(customerText ?? ""), provider));
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

// An APOLOGY is the OTHER thing a reassurance affirmation legitimately answers, and on this store
// it is by far the commonest one. Measured 2026-08-21 over the whole conversation history: of the
// 12 all-time fabricated-frame findings, SIX were the agent answering a customer apology —
// "Sorry for the delay" → "No worries. see you around 2:00 PM.", "…I apologize" → "No worries —",
// "Yeah I can't fit it in my budget sorry" → "No worries!", "SORRY for the slow response." →
// "No worries — I get why you'd be frustrated", "Didn't mean to inquire about it was just looking
// boss" → "No worries! We are here to help", "I will have to reschedule unfortunately" → "No
// problem, Michael". Every one of those is the correct human reply, so the detector was reporting
// good replies as misses at a ~50% phantom rate and minting work orders for them. "You're welcome"
// / "my pleasure" still cannot answer an apology, so they stay flagged exactly as before.
// Same AUDIT-ONLY scope as the request/question exemption above: this predicate is reachable only
// from detectFabricatedFrame, which only scripts/fabricated_frame_audit.ts calls. The live
// blended-lead-in guard stays strict.
const CUSTOMER_APOLOGY =
  /\b(sorry|apolog(?:y|ies|ize|ise|izing|ized)|my\s+bad|did\s?n'?t\s+mean\s+to|unfortunately)\b/i;

// Inspect ONLY the opening sentence of a reply — the fabricated frame is always the opener.
// Used by the nightly fabricated_frame audit to surface replies that invent a conversational
// frame (you thanked me / you asked a question) the customer's turn doesn't warrant.
export function detectFabricatedFrame(reply: string, customerText: string): FabricatedFrame {
  const opener = String(reply ?? "").split(/(?<=[.!?])\s+/)[0] ?? "";
  if (isFabricatedGratitudeLeadIn(opener, customerText)) {
    // Audit refinement: a reassurance affirmation answering a customer request/question — or
    // waving off a customer APOLOGY — is a real answer, not a fabricated gratitude frame.
    // CUSTOMER_IS_QUESTION is the generous request/question detector (also covers "can I drop
    // off …?"); CUSTOMER_APOLOGY covers "sorry for the delay" / "I apologize" / "unfortunately".
    const customer = String(customerText ?? "");
    const reassuranceAnswer =
      REASSURANCE_AFFIRMATION.test(opener) &&
      (CUSTOMER_IS_QUESTION.test(customer) || CUSTOMER_APOLOGY.test(customer));
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

/**
 * True when `reply` asks a question we have ALREADY asked this customer, word for word.
 *
 * Joe, 2026-08-11: *"we have to make sure the questions aren't repeated exactly the same"* — raised
 * while wiring the pre-qualification ladder, and it is not hypothetical. MEASURED the same day across
 * 743 conversations touched in 45 days: **60 of them (8%) contain a verbatim repeated question, 128
 * repeat-askings in total.** Every reply now ends with a question, so a customer who does not answer
 * one gets it fired at them again in identical words, which is exactly how a person sounds like a
 * machine.
 *
 * Sibling of `isEchoedInboundOpening`, and deliberately built the same way: DETERMINISTIC, and used
 * only to TRIGGER a re-draft, never to block a send. A rare false positive costs one regenerate; it
 * can never cost a reply. That is the fail direction that makes a text-matching rule acceptable here
 * at all — it decides nothing about meaning, it only says "you already said this exact sentence".
 *
 * Deliberately STRICT (verbatim after normalising case/punctuation, >= MIN_QUESTION_WORDS words):
 *  - Joe's ask is about EXACT repeats. "Which bike are you looking at?" following "What bike do you
 *    have your eye on?" is a re-ask in different words, which is the behaviour we WANT when someone
 *    has not answered — pressing again is fine, sounding like a recording is not.
 *  - Short questions ("Sound good?", "Does that work?") legitimately recur in natural conversation.
 */
const MIN_QUESTION_WORDS = 4;

/**
 * Split on SENTENCE ends first, then normalise — not the other way round.
 *
 * The first cut normalised first, which strips "." and "!", so "Thanks! What day works best?" came
 * back as ONE chunk carrying the preamble. Two messages asking the identical question after different
 * lead-ins would then have compared unequal and the repeat would have gone unnoticed — the exact miss
 * this guard exists to catch. (The 8%-of-conversations measurement was taken with that same flaw, so
 * it is a LOWER bound on how often this really happens.)
 */
export function extractAskedQuestions(text: string): string[] {
  const withoutLinks = String(text ?? "").replace(/https?:\/\/\S+/g, " "); // "?dealerid=" is not a question
  return withoutLinks
    .split(/(?<=[.!?])\s+/)
    .filter(sentence => sentence.trim().endsWith("?"))
    .map(sentence =>
      sentence
        .toLowerCase()
        .replace(/[^a-z0-9?\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(part => part.endsWith("?") && part.split(" ").filter(Boolean).length >= MIN_QUESTION_WORDS);
}

export function isRepeatedOutboundQuestion(
  reply: string,
  priorOutboundTexts: Array<string | null | undefined>
): boolean {
  const asked = extractAskedQuestions(reply);
  if (!asked.length) return false;
  const already = new Set<string>();
  for (const prior of priorOutboundTexts ?? []) {
    for (const q of extractAskedQuestions(String(prior ?? ""))) already.add(q);
  }
  if (!already.size) return false;
  return asked.some(q => already.has(q));
}

/** `isRepeatedOutboundQuestion` against a draft history — the shape both reply paths already hold. */
export function repeatsAQuestionFromHistory(
  reply: string,
  history?: { direction: "in" | "out"; body: string }[] | null
): boolean {
  return isRepeatedOutboundQuestion(
    reply,
    (history ?? []).filter(h => h.direction === "out").map(h => h.body)
  );
}
