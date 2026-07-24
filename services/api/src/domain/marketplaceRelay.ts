/**
 * Marketplace relay leads (AutoDealers.Digital / Facebook Marketplace with NO phone/email) can
 * ONLY be answered by a rep manually inside the Facebook Marketplace inbox — LeadRider has no
 * channel to message them, and full Facebook automation is OUT (Joe ruling, 2026-07-24:
 * personal-account ToS / ban risk). So instead of a dead auto-draft the operator has to discard,
 * we hand the rep a task OWNED BY THE LEAD OWNER with a warm, ready-to-paste first reply attached
 * — the rep copies it into Facebook and sends in ~10 seconds.
 *
 * Business gap this closes: 15 relay leads since 7/11 got ZERO human contact because the handoff
 * task was generic/low-signal. This reply is voice-charter tone ("texting a friend"), references
 * the actual bike, and ends low-pressure. It is REFERENCE COPY the rep pastes into Facebook — it
 * is NOT a LeadRider-sendable draft (the publish gate still suppresses any draft_ai for these
 * leads; see marketplace_relay_no_draft:eval).
 *
 * Deterministic on purpose: composed at intake time from context the ADF already carries
 * (customer first name + vehicle of interest + dealer/agent name). AGENTS.md allows reply COPY to
 * come from the LLM (voice), but an intake-time LLM round-trip on every relay ADF is unnecessary
 * risk/latency here — a context-filled charter-voiced first-touch is faithful and cheaper. Fail
 * direction: if any piece is missing the reply still composes (name/vehicle clauses degrade
 * gracefully) so the rep always gets something to paste — never a dropped lead.
 */

function cleanClause(raw: string | null | undefined): string {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildMarketplaceRelayFirstTouchReply(args: {
  firstName?: string | null;
  agentName?: string | null;
  dealerName?: string | null;
  vehicleLabel?: string | null;
}): string {
  const name = cleanClause(args.firstName);
  const agentName = cleanClause(args.agentName) || "the team";
  const dealerName = cleanClause(args.dealerName) || "American Harley-Davidson";
  const vehicle = cleanClause(args.vehicleLabel);

  const greeting = name ? `Hey ${name}, ` : "Hey, ";
  const thanks = vehicle
    ? `Thanks for reaching out about the ${vehicle}! `
    : "Thanks for reaching out! ";
  return (
    `${greeting}it's ${agentName} at ${dealerName}. ` +
    thanks +
    "Would you like to swing by and take a look, or want me to send over pricing and a few more details first?"
  );
}

/**
 * The task summary a rep sees in the console for a channel-less marketplace relay lead. Folds the
 * ready-to-paste reply straight into the summary string (no frontend change needed — the console
 * already renders the todo summary) behind a clear label so the rep knows to copy it INTO Facebook,
 * not send it from LeadRider.
 */
export function buildMarketplaceRelayTaskSummary(reply: string): string {
  const paste = cleanClause(reply);
  return (
    "Reply to this lead in Facebook Marketplace — this lead has NO SMS or email channel, so it can " +
    "only be answered inside the Facebook/Marketplace inbox. Copy-paste this first reply to send in " +
    `~10 seconds: "${paste}"`
  );
}
