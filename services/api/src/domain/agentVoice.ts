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
 * Approved acknowledgement for a MARKETING/MAILING-LIST OPT-IN lead — a customer who asked
 * to be added to the dealer's email/text list for events and promotions ("Just wanting to
 * sign up for emails and text messages of any events or promotions..."). This is NOT a
 * sweepstakes/contest entry, so the `buildEventPromoAck` "Thanks for entering — good luck!"
 * frame is a FABRICATED contest context (2026-07-14 corpus-replay judge_fail, +17166985963:
 * a "Room58 - Contact Us" mailing-list opt-in was drafted "Thanks for entering — good luck!").
 * The correct reply confirms they are on the list, with NO contest frame, NO availability
 * claim, NO stop-in push, and NO appointment offer. Selected via
 * `decideEventPromoTurn(...).ackVariant === "list_opt_in"`. Pinned by `event_promo_ack:eval`.
 */
export function buildMarketingOptInAck(
  firstName: string | null | undefined,
  agentName: string,
  dealerName: string
): string {
  return (
    `${buildAgentIntro(firstName, agentName, dealerName)}` +
    "You're on the list — I'll make sure you get our events and promos. If you ever want to talk bikes, I'm here."
  );
}

/**
 * Approved SOFT INVITE for a corporate/GLA demo-ride lead (bucket=event_promo,
 * cta=demo_ride_event). These are H-D corporate demo-ride program leads — the ride does NOT
 * happen at the dealership, so a dealership scheduling push ("I can get you scheduled to come
 * in — Wed 9:30 or 11:30?") and the sweepstakes "thanks for entering — good luck!" ack are BOTH
 * wrong (operator-reported, Joe, 2026-07-02: "GLA demo rides are corporate demo rides that
 * don't happen at the dealership... this should be a soft invite and there should be no
 * follow-up cadence after the initial response"). One warm soft invite, then silence (the
 * event_promo bucket already closes `event_promo_no_cadence`). Deliberately contains NO
 * appointment offer/times, NO availability claim, and NO fabricated completed-ride frame
 * ("thanks for your recent demo ride") — the source alone doesn't prove the ride happened.
 * Pinned by `event_promo_ack:eval`.
 */
export function buildDemoRideEventSoftInvite(
  firstName: string | null | undefined,
  agentName: string,
  dealerName: string,
  bikeLabel?: string | null
): string {
  const bike = (bikeLabel ?? "").trim();
  const interestLine = bike
    ? `Saw your interest in the ${bike} through the H-D demo ride program. `
    : "Saw your interest through the H-D demo ride program. ";
  const inviteLine = bike
    ? `If you'd ever like to see one in person here at the shop, or have any questions about the ${bike}, I'm happy to help — no pressure at all.`
    : "If you'd ever like to stop by the shop or have any questions, I'm happy to help — no pressure at all.";
  return `${buildAgentIntro(firstName, agentName, dealerName)}${interestLine}${inviteLine}`;
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
 * Sibling-variant scope ask (Joe, 2026-07-04). A same-family sibling trim landed while the
 * customer holds a STRICT base-model watch — the fire guard rightly stays quiet, but the
 * agent asks ONCE whether they want variant alerts too. The answer is read by
 * parseWatchScopeWithLLM (decideWatchScopeTurn): yes => openToOtherTrims, no => stays
 * base-only, either way we never re-ask. Deliberately NO availability promise beyond the
 * one unit named, and the base model stays the default. Pinned by watch_sibling_scope:eval.
 */
export function buildWatchSiblingScopeAsk(args: {
  firstName?: string | null;
  watchModelLabel: string; // e.g. "Road Glide"
  unitLabel: string; // e.g. "2026 Harley-Davidson Road Glide Special"
}): string {
  const opener = args.firstName ? `Hey ${args.firstName}, quick one` : "Quick one";
  return (
    `${opener} — a ${args.unitLabel} just landed here at the shop. ` +
    `I know you're watching for the ${args.watchModelLabel}. Want me to give you a heads up on ` +
    `${args.watchModelLabel} variants like this too, or keep it to just the ${args.watchModelLabel}?`
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
 * Approved acknowledgement for a BUYER-side Dealer Lead App marketing-survey lead (the Tim
 * Williams class, +17163741119, 2026-06-24) — the twin of `buildNonBuyerSurveyAck`. A structured
 * "Marketing Questions: Dealer Lead App" survey (purchase timeframe + "which model are you
 * interested in?" + "Demo Bikes Ridden: <model>") was answered by the generic sales generator as
 * if the customer had already test-ridden the bike here — "Thanks again for coming in for the test
 * ride on the <model>. Congrats on the <model>." — because it read the survey's "Demo Bikes Ridden"
 * field as a completed dealer visit. Used when `decideDealerLeadSurveyTurn` returns
 * `buyer_survey_ack`. Acknowledges the customer's STATED model interest (when the survey named one)
 * and warmly invites a test ride / offers to pull availability — the correct opener for a buyer —
 * but asserts NO completed past action ("thanks for coming in" / "congrats"), NO availability/stock
 * claim, and NO fabricated frame. Pinned by `dealer_lead_survey_ack:eval`.
 */
export function buildBuyerSurveyAck(
  firstName: string | null | undefined,
  agentName: string,
  dealerName: string,
  interestedModel?: string | null
): string {
  const model = String(interestedModel ?? "").trim();
  const body = model
    ? `Thanks for letting us know the ${model} is on your radar — great pick. Want to come in for a test ride, or I can pull together current availability and options whenever you're ready? Just say the word.`
    : "Thanks for sharing what you're looking for. Want to come in for a test ride, or I can pull together current availability and options whenever you're ready? Just say the word.";
  return `${buildAgentIntro(firstName, agentName, dealerName)}${body}`;
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
