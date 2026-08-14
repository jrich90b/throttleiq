/**
 * Does the human-mode inventory-watch arm CLAIM this turn?
 *
 * "Claim" is load-bearing: the flag it feeds (`humanModeInventoryWatchHandled`) suppresses the
 * human-mode terminus backstop — the "needs YOUR reply" task that is the ONLY thing standing
 * between a substantive customer message and total silence on a rep-owned thread.
 *
 * THE MISS (Rick Williamson +17168609581, 2026-08-13). Rick asked, mid-negotiation, "What is the
 * lowest interest rate you can get me on the flex financing on the 36 and the 48 month?" — a pure
 * finance question naming no bike. 16 hours of silence: no reply (correct — a rep owns the
 * thread), no draft, and NO task. Instrumented replay (EXIT@terminus, GATE watchHandled=true)
 * proved the silencer: the arm set the handled flag on its ELIGIBILITY HINT — and one leg of that
 * hint is "the thread has an inventoryWatch at all". Rick carries a paused Road Glide 3 watch
 * from 8/4, so EVERY message he sends was marked "already surfaced as a watch" and the backstop
 * never fired. Measured 2026-08-14: 24 human-mode threads carry a watch/pending — every one had
 * a permanently dead reply-needed backstop. The route audit confirms the class: the
 * `human_mode_reengagement_reply_needed` outcome fired for NOBODY between 7/25 and 8/14.
 *
 * The hint answers "is it worth PAYING for the semantic parse?" (a cost gate). This function
 * answers "did the arm actually HANDLE the turn as a watch?" — and only the parser's verdict can
 * say that (comprehend, never regex): the parse read a watch action, the inbound-reply-action
 * parser read a watch acknowledgement, or the low-confidence fallback lane confirmed one. Those
 * are exactly the sub-branches that go on to write watch state; everything else falls through to
 * the backstop.
 *
 * FAIL DIRECTION: claiming too LITTLE is safe — the backstop adds one merged, auto-closing task
 * (median close 2.7 min after the rep's next outbound). Claiming too MUCH is this bug: silence
 * on a live lead. So every uncertain input reads as "not claimed".
 */
export interface HumanModeWatchClaimInput {
  /** Demo-day event questions are answered elsewhere; the watch arm never owns them. */
  demoDayQuestion: boolean;
  /** The ACCEPTED semantic-slot parse's watchAction ("none" or absent when not accepted). */
  semanticWatchAction: string | null | undefined;
  /** inbound_reply_action parser read this turn as an inventory-watch acknowledgement. */
  inboundParserWatchAcknowledgement: boolean;
  /** The semantic parse met its confidence floor (gates the fallback lane OFF when true). */
  semanticConfident: boolean;
  /** The audited fallback gate allows deterministic confirmation on this turn. */
  fallbackAllowed: boolean;
  /** Deterministic watch-confirmation phrasing matched (fallback lane only). */
  watchConfirmationText: boolean;
}

/**
 * COST hint only (not comprehension — the semantic parser owns the verdict): is there watch-ish
 * phrasing worth paying a parse for? Lived inline in the twilio handler until 2026-08-14; moved
 * here with the claim decision so the hint and the verdict it must never be confused with sit in
 * one file. Over-matching costs one parser call and nothing else.
 */
export function hasWatchPhraseHint(textLower: string): boolean {
  return /\b(let me know|lmk|keep me posted|keep an eye out|watch for|notify me|if you get one|if you get it|if you get another|when you get one|when you get it|when you get another|as soon as one comes in)\b/i.test(
    textLower
  );
}

export function decideHumanModeWatchClaim(input: HumanModeWatchClaimInput): boolean {
  if (input.demoDayQuestion) return false;
  return (
    String(input.semanticWatchAction ?? "") === "set_watch" ||
    input.inboundParserWatchAcknowledgement === true ||
    (!input.semanticConfident && input.fallbackAllowed === true && input.watchConfirmationText === true)
  );
}
