// ---------------------------------------------------------------------------
// "Is this turn nothing but a courtesy word?" — the COST gate that decides
// whether a turn is worth spending a comprehension call on.
//
// isShortAckText / isEmojiOnlyText moved here verbatim from index.ts. They were
// written to answer "should we bother drafting a reply to 'ok thanks'?", and that
// is still exactly what they are good for.
//
// They were ALSO being used to decide whether the customer-disposition parser got
// to read the turn at all — and that is where they did damage. The predicate is a
// word list ("thanks | ok | appreciate | ..."), so ANY sentence under 60 characters
// that ends politely was ruled a non-event and the parser was never called:
//
//   Curran Terblanche +13105956498, 2026-08-04 20:50Z: "Found a better offer. Thanks"
//
// He was telling us he had bought elsewhere. Nothing replied, nothing closed, and
// the lead sat parked on an inventory watch. An operator filed it the same minute.
// Executed against the live record: the parser reads that turn as
// stepping_back / explicit / 0.90 and the closeout gate allows it — the parser was
// simply never asked, because the turn ended in "Thanks".
//
// isBareAcknowledgementText is the narrower question the cost gate actually meant:
// once the courtesy tokens and the connective filler are removed, is there any
// content LEFT? "Ok thanks" has none. "Found a better offer. Thanks" has three words
// of it. This reads OUR OWN turn for substance, never for meaning — the meaning is
// still read by the typed parser downstream, which is the only thing allowed to
// conclude a customer stepped back (AGENTS.md: comprehend, never regex).
//
// FAIL DIRECTION, both ways safe:
//  - wrongly "bare"      => parser skipped => today's behavior => we fail toward NOT
//                           closing the lead, which is the safe side.
//  - wrongly "not bare"  => parser runs and decides for itself; it still has to say
//                           explicit + >= 0.74, and shouldSuppressDispositionCloseout
//                           still vetoes. A false positive costs one LLM call.
// ---------------------------------------------------------------------------

const ACK_TOKENS =
  /\b(thanks|thank you|thanks again|thx|ty|appreciate|got it|sounds good|sounds great|will do|ok|okay|k|kk|cool|perfect|great|all good|no problem|you bet|yep|yup|sure)\b/;

/** Connective/filler that carries no standalone content once the courtesy word is gone. */
const FILLER_TOKENS =
  /\b(i|we|you|your|hi|hey|hello|yes|no|so|for|the|a|an|it|that|this|now|man|dude|bro|sir|maam|much|very|again|too|thank|guys|everything|help|info|update|time)\b/g;

export function isEmojiOnlyText(text: string): boolean {
  const t = String(text ?? "").trim();
  return t.length > 0 && /^[\p{Extended_Pictographic}\s]+$/u.test(t);
}

export function isShortAckText(text: string): boolean {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t) return false;
  if (isEmojiOnlyText(t)) return true;
  if (t.length > 60) return false;
  if (/[?]/.test(t)) return false;
  return ACK_TOKENS.test(t);
}

/**
 * TRUE only when the whole turn is acknowledgement — nothing survives once the
 * courtesy words and filler are stripped. An emoji-only turn is bare by definition.
 *
 * Deliberately NOT a reading of what the customer meant: it counts leftover content
 * words. Two or more is "there is something here worth comprehending".
 */
export function isBareAcknowledgementText(text: string): boolean {
  const raw = String(text ?? "").trim();
  if (!raw) return false;
  if (isEmojiOnlyText(raw)) return true;
  if (!isShortAckText(raw)) return false;
  const residual = raw
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(new RegExp(ACK_TOKENS.source, "g"), " ")
    .replace(FILLER_TOKENS, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const contentWords = residual.split(/\s+/).filter(Boolean);
  return contentWords.length < 2;
}
