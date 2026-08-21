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

/**
 * Courtesy words in the SAME family as `great` / `perfect` / `cool` above, deliberately NOT added
 * to ACK_TOKENS.
 *
 * Joe, 2026-08-13, on Christopher +17169400722: "Why did this create a task when the customer just
 * said awesome?" A bare "Awesome " minted a `needs YOUR reply` task for the owner, because
 * `awesome` is missing from the list while `great` and `perfect` are on it.
 *
 * The one-token fix is to drop it into ACK_TOKENS, and that is the trap. `isShortAckText` is read
 * at eighteen decision points in index.ts, several of which decide whether we REPLY AT ALL, and it
 * only asks "does a courtesy word appear anywhere in a short sentence?" — so a token added there
 * also silences "Awesome I'll be there at 3". Measured on the live store: 12 short inbound turns
 * carry `awesome` as their only courtesy word, and one of them is "Awesome let's do it".
 *
 * These tokens are therefore visible ONLY to `isBareAcknowledgementText`, which additionally
 * requires that nothing be LEFT once courtesy words and filler are stripped. "Awesome" is bare;
 * "Awesome let's do it" is not, and keeps every arm it has today. Measured, not guessed:
 * `awesome` (7 short turns), `thank u` (4 — a spelling ACK_TOKENS' `thank you` misses),
 * `ur welcome` (2).
 *
 * `absolutely` joins them on the same evidence, 2026-08-21, and it is the THIRD report of one
 * shape (after `awesome` 08-13 and the `at all` intensifier 08-19). Joe, on Brent Marshall
 * +17169941544: "no need to show a awaiting your reply for 'absolutley'". Brent replied
 * "Absolutely!" to a heads-up, and because `absolutely` is on neither list the turn read as
 * substantive: the inbox lit "Awaiting your reply" for a thread with nothing pending.
 * REPRODUCED BY EXECUTION against this file on `d526942f`: isBareAcknowledgementText("Absolutely!")
 * === false.
 *
 * MEASURED on the live store, 3,296 inbound turns, BOTH directions:
 *   flips to bare   "Absolutely!"                            <- the reported turn
 *                   "Absolutely love it!!!!"                 <- one residual word, nothing pending
 *   stays substantive
 *                   "Yes absolutely Tuesday 5pm works"       <- a booking; 3 residual words
 *                   "Absolutely! let me know any details..." <- an open loop; 7 residual words
 *
 * Two turns of 3,296 change behaviour, and the two that must not are the two that carry a
 * commitment. That is the whole reason the token lives HERE and not in ACK_TOKENS: the residual
 * bar, not the word, is what keeps "Yes absolutely Tuesday 5pm works" a real turn.
 *
 * `awaiting_reply_flag_eval.ts` says DO NOT WIDEN THIS PREDICATE, and that ruling still stands as
 * written — it is about the residual-content BAR, and about loose tokens in ACK_TOKENS, which
 * `isShortAckText` reads at eighteen reply-or-not decision points. Neither moves here. #769 drew
 * the same line two days after that comment landed. The exit it protects
 * ("Found a better offer. Thanks", Curran Terblanche +13105956498) is unaffected and still pinned.
 */
const BARE_ONLY_COURTESY_TOKENS = /\b(awesome|absolutely|thank u|ur welcome)\b/;

/** Connective/filler that carries no standalone content once the courtesy word is gone. */
const FILLER_TOKENS =
  /\b(i|we|you|your|hi|hey|hello|yes|no|so|for|the|a|an|it|that|this|now|man|dude|bro|sir|maam|much|very|again|too|thank|guys|everything|help|info|update|time)\b/g;

/**
 * Emphasis that trails a courtesy word and adds nothing to it — "no problem AT ALL",
 * "thanks A LOT", "no trouble WHATSOEVER". Stripped as a UNIT, never token by token.
 *
 * Joe's staff, 2026-08-19 (Jason Roorda +17165104578): the agent signed off, Jason replied
 * "No problem at all", and because `at` and `all` survive the filler pass as TWO content
 * words the turn read as substantive. It was not bare, so the awaiting-reply flag lit
 * ("courtesy_closer" never fired) and the per-message tripwire minted a "needs a reply"
 * task, which paged the manager phone at 18:36Z. Two operator complaints, 46 seconds
 * apart. Plain "no problem" was bare all along — three words of emphasis were the whole
 * defect. Single-word intensifiers ("whatsoever", "a lot") already passed by luck: they
 * leave ONE residual word, under the two-word bar.
 *
 * Stripping the PHRASE rather than adding `at` and `all` to FILLER_TOKENS is the point:
 * loose tokens would also empty "Thanks at 3" (a customer confirming a time), which stays
 * substantive here — measured, both ways, in `courtesy_intensifier:eval`.
 */
const INTENSIFIER_TOKENS = /\b(at all|whatsoever|a lot|a ton|a bunch|a million)\b/g;

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
  const lowered = raw.toLowerCase();
  // Same shape guards isShortAckText applies (short, not a question), then EITHER token set.
  if (raw.length > 60) return false;
  if (/[?]/.test(raw)) return false;
  if (!ACK_TOKENS.test(lowered) && !BARE_ONLY_COURTESY_TOKENS.test(lowered)) return false;
  const residual = raw
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(new RegExp(ACK_TOKENS.source, "g"), " ")
    .replace(new RegExp(BARE_ONLY_COURTESY_TOKENS.source, "g"), " ")
    .replace(INTENSIFIER_TOKENS, " ")
    .replace(FILLER_TOKENS, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const contentWords = residual.split(/\s+/).filter(Boolean);
  return contentWords.length < 2;
}
