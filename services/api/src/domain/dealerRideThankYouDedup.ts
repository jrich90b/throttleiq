/**
 * Dealer-ride thank-you dedupe — shared "was the customer actually thanked?" check.
 *
 * "Already thanked" must mean the customer RECEIVED the post-ride thank-you (or a live
 * pending draft is about to deliver it). A `draftStatus: "stale"` draft_ai message was
 * never sent — counting it as a delivered thank-you latches the conversation into
 * permanent silence: the +17168641440 miss (2026-05) had the 5/16 thank-you draft go
 * stale unsent, so the 5/18 repeat Dealer Lead App ADF was deduped away and the rider
 * was never thanked (corpus_replay_judge_fail, anomaly batch 2 2026-07-23).
 *
 * Fail-direction: excluding stale drafts fails toward drafting the thank-you AGAIN —
 * staff-reviewed in suggest mode and backstopped by the 24h duplicate-outbound guard —
 * never toward customer silence. Including them (the old behavior) fails toward a
 * customer who rode a demo bike and never hears from us: the wrong direction.
 *
 * Deterministic on purpose (AGENTS.md-legal): this matches OUR OWN template output
 * (structured extraction of our own format) inside a side-effect dedupe guard — it
 * never interprets customer language.
 *
 * Used by:
 *  - services/api/src/routes/sendgridInbound.ts (live `dealer_ride_initial_thank_you_exists` dedupe)
 *  - services/api/src/index.ts (queueDealerRideOutcomeCustomerDraft once-per-conversation latch)
 *  - scripts/inbound_shadow_replay.ts (the replay classifier mirror — shared code IS the lockstep)
 */

/** The canonical post-ride thank-you shape both builders emit for a confirmed visit. */
export function isDealerRideThankYouMessageText(body: unknown): boolean {
  const text = String(body ?? "");
  return /thanks again for coming in/i.test(text) && /\b(?:test ride|ride|demo)\b/i.test(text);
}

/** A draft_ai message that went stale was never sent to the customer. */
export function isNeverSentStaleDraftMessage(message: any): boolean {
  return (
    message?.provider === "draft_ai" &&
    String(message?.draftStatus ?? "").toLowerCase() === "stale"
  );
}

/**
 * True when the thread holds a dealer-ride thank-you the customer actually got (sent
 * via twilio/human/sendgrid, or a legacy record without draft metadata) or is about to
 * get (a live pending draft). Stale never-sent drafts do NOT count.
 */
export function hasDeliveredOrPendingDealerRideThankYou(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((message: any) => {
    if (message?.direction !== "out") return false;
    if (!isDealerRideThankYouMessageText(message?.body)) return false;
    if (isNeverSentStaleDraftMessage(message)) return false;
    return true;
  });
}
