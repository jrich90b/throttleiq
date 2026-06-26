/**
 * Agent voice — the single source of truth for the customer-facing greeting + intro.
 *
 * Voice Charter (AGENTS.md "Agent Voice Charter" + docs/voice_charter.md): the agent
 * texts like a real American H-D salesperson — warm, short, low-pressure. The intro is
 * softened from the old corporate "Hi {name} — This is {agent} at {dealer}." (em-dash +
 * stiff) to the friendlier "Hey {name}, it's {agent} over at {dealer}." This kills the
 * single biggest charter-violation class (em-dash overuse + long brand repeat in the
 * opener). Keep all intro wording here so future tweaks are one edit, never scattered.
 */

/** Casual greeting, no em-dash. "Hey {name}, " or "Hey there, " when the name is unknown. */
export function buildAgentGreeting(firstName?: string | null): string {
  const name = String(firstName ?? "").trim();
  return name ? `Hey ${name}, ` : "Hey there, ";
}

/** Full softened intro: "Hey {name}, it's {agent} over at {dealer}. " (trailing space). */
export function buildAgentIntro(
  firstName: string | null | undefined,
  agentName: string,
  dealerName: string
): string {
  return `${buildAgentGreeting(firstName)}${buildAgentIntroPhrase(agentName, dealerName)}`;
}

/**
 * Greeting-less intro clause: "it's {agent} over at {dealer}. " (trailing space).
 * Use when a greeting is emitted separately (e.g. a template already opens with
 * `buildAgentGreeting(...)`) or for a bare mid-reply identity line that should not
 * re-introduce with a fresh "Hey {name}," — pair it after a comma/greeting, never
 * standalone after a period (the lowercase "it's" would start a sentence). Openers
 * that build their own greeting should use `buildAgentIntro` instead.
 */
export function buildAgentIntroPhrase(agentName: string, dealerName: string): string {
  return `it's ${agentName} over at ${dealerName}. `;
}

/**
 * Approved acknowledgement for a NON-SALES marketing lead (sweepstakes entry, event RSVP,
 * bare event_promo). Used when `decideEventPromoTurn` returns `event_promo_ack` so the lead
 * gets a warm, low-pressure thank-you instead of a sales/availability/stop-in/model-fact
 * answer it never asked for. Deliberately contains NO availability claim, stop-in push,
 * appointment offer, or vehicle-fact assertion (those are the out-of-context failure modes
 * this replaces). Pinned by `event_promo_ack:eval`.
 */
export function buildEventPromoAck(
  firstName: string | null | undefined,
  agentName: string,
  dealerName: string
): string {
  return (
    `${buildAgentIntro(firstName, agentName, dealerName)}` +
    "Thanks for entering — good luck! If you ever want to talk bikes, I'm here."
  );
}

/**
 * Inventory-watch "your bike is in stock" notification (the watch-fire reply). Beyond announcing the unit,
 * it (1) ASKS whether they're still looking, and (2) offers a clean opt-out — "if you're all set I'll take
 * you off the list." A "no / all set / found one" reply is read by the watch-opt-out parser
 * (decideWatchOptOutTurn) which PAUSES the watch, so the customer can remove themselves and we stop pinging
 * a lead who has moved on (Joe, 2026-06-26). Pinned by watch_available_reply:eval.
 */
export function buildWatchAvailableReply(args: {
  firstName?: string | null;
  bikeLabel: string; // e.g. "2025 Harley-Davidson Breakout"
  colorText?: string | null; // e.g. " in Billiard Gray" (already prefixed) or empty
  availability?: "new" | "in_stock" | "again";
}): string {
  const opener = args.firstName ? `Hey ${args.firstName}, good news` : "Good news";
  const bike = `${args.bikeLabel}${args.colorText ?? ""}`;
  const arrival =
    args.availability === "new" ? "just came in" : args.availability === "again" ? "is available again" : "is in stock now";
  return (
    `${opener} — a ${bike} you were watching for ${arrival}. ` +
    "Are you still looking? If so I can send details or set up a time to come see it — " +
    "and if you're all set, just let me know and I'll take you off the list."
  );
}

/**
 * Approved acknowledgement for a NON-BUYER / passenger survey lead (Elizabeth Klapa class,
 * 2026-06-25) — a Dealer Lead App survey whose structured purchase-timeframe says the person
 * is explicitly NOT a buyer ("I am not interested in purchasing at this time"). Used when
 * `decideNonBuyerSurveyTurn` returns `non_buyer_survey_ack` so the FIRST touch is a warm,
 * no-pressure acknowledgement instead of the sales pitch ("Which bike are you asking about?"
 * / "want me to send photos or price and payment numbers?") it was getting. Deliberately
 * contains NO availability claim, model-fact assertion, "which bike?" ask, photo/price offer,
 * or stop-in/appointment push — those are exactly the out-of-context failure modes for a
 * self-declared non-buyer. Leaves the door open without pressure. Pinned by
 * `non_buyer_survey_ack:eval`.
 */
export function buildNonBuyerSurveyAck(
  firstName: string | null | undefined,
  agentName: string,
  dealerName: string
): string {
  return (
    `${buildAgentIntro(firstName, agentName, dealerName)}` +
    "Thanks for reaching out — no pressure at all. If you ever decide you'd like a bike of your own down the road, I'm here whenever you're ready."
  );
}

/**
 * Strip a leading agent greeting/intro (old "Hi {name} — …" or new "Hey {name}, …") from a
 * body before re-prefixing, so we never double up. Initial-ADF use only.
 */
export function stripLeadingAgentGreeting(body: string): string {
  return String(body ?? "")
    .replace(/^hi\s+[^—]+—\s*/i, "")
    .replace(/^hey\s+[^,]+,\s*/i, "")
    .trim();
}
