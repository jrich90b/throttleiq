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

/**
 * Neutral agent stand-in for fail paths where the dealer profile has no agentName.
 * Deliberately lowercase and phrase-shaped so it reads naturally mid-intro
 * ("it's the team over at {dealer}", "This is the team at {dealer}") — never a
 * baked-in persona. AH-era persona names were scattered through the code as
 * fallbacks; a second dealer must never inherit another store's persona
 * (identity-fallback sweep, 2026-07-17). Pinned by dealer_identity_fallback:eval.
 */
export const GENERIC_AGENT_DISPLAY_NAME = "the team";

/** Neutral dealership stand-in for public pages when the profile has no dealerName. */
export const GENERIC_DEALER_DISPLAY_NAME = "our dealership";

/**
 * THE agent-name accessor: the configured profile agentName when set, else the
 * neutral generic. Every fallback for "who signs/introduces the agent" should
 * route through here instead of hardcoding a persona.
 */
export function resolveDealerAgentName(
  profile: { agentName?: string | null } | null | undefined,
  fallback: string = GENERIC_AGENT_DISPLAY_NAME
): string {
  const clean = String(profile?.agentName ?? "").trim();
  return clean || fallback;
}

/**
 * Persona self-intro matcher ("this is {agent}") built from the CONFIGURED agent
 * name — used by the manual-sender persona lock (conversationStore.lockPersonaToStaffSender)
 * to recognize an unedited persona-signed draft. Returns null when there is no usable
 * name (no persona to protect → callers skip the check). Escapes regex metacharacters
 * and tolerates flexible whitespace inside multi-word names.
 */
export function buildPersonaSelfIntroPattern(agentName: string | null | undefined): RegExp | null {
  const clean = String(agentName ?? "").trim();
  if (!clean) return null;
  const escaped = clean
    .split(/\s+/)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  // A \b after a non-word final char (e.g. "…(Danny)") can never match — only close the
  // name with a word boundary when the name actually ends in a word character.
  const tail = /\w$/.test(clean) ? "\\b" : "";
  return new RegExp(`\\bthis is\\s+${escaped}${tail}`, "i");
}

/**
 * Footer identity line for the public marketing-unsubscribe page: the configured
 * dealerName, else the neutral generic — never a hardcoded dealership literal.
 */
export function buildMarketingUnsubscribeFooter(dealerName?: string | null): string {
  return String(dealerName ?? "").trim() || GENERIC_DEALER_DISPLAY_NAME;
}

/** Casual greeting, no em-dash. "Hey {name}, " or "Hey there, " when the name is unknown. */
export function buildAgentGreeting(firstName?: string | null): string {
  const name = String(firstName ?? "").trim();
  return name ? `Hey ${name}, ` : "Hey there, ";
}

/**
 * Full softened intro: "Hey {name}, it's {agent} over at {dealer}. " (trailing space).
 *
 * Name-collision guard: when the customer's first name equals the agent's OWN persona
 * name (case-insensitive), the naive form reads as a bug — a first-touch ADF ack to
 * customer Alexandra Meinhold went out as "Hey Alexandra, it's Alexandra over at American
 * Harley-Davidson." because the dealer's configured agentName is itself Alexandra
 * (open-critic +17162636134, 2026-07-22). Drop the greeting NAME on a collision (keep the
 * self-intro, which is the whole point of a first-touch line) so it degrades to
 * "Hey there, it's Alexandra over at American Harley-Davidson." Fail-direction is safe:
 * fires only on an exact first-name match, and the degraded form is still correct + on-voice.
 * Pinned by agent_voice:eval.
 */
export function buildAgentIntro(
  firstName: string | null | undefined,
  agentName: string,
  dealerName: string
): string {
  const firstToken = (v: string | null | undefined): string =>
    String(v ?? "").trim().split(/\s+/).filter(Boolean)[0] ?? "";
  const customerFirst = firstToken(firstName);
  const agentFirst = firstToken(agentName);
  const collides =
    customerFirst !== "" && agentFirst !== "" && customerFirst.toLowerCase() === agentFirst.toLowerCase();
  const greetingName = collides ? null : firstName;
  return `${buildAgentGreeting(greetingName)}${buildAgentIntroPhrase(agentName, dealerName)}`;
}

/**
 * Providers that mean the customer ACTUALLY RECEIVED the message. An ALLOWLIST on purpose: a
 * `draft_ai` row is a draft the staff may never approve (1,051 of 1,134 in the americanharley store
 * are `draftStatus: "stale"` — never sent), and `voice_call` / `voice_summary` / `voice_transcript` /
 * `payment_event` are internal log rows, not texts we sent. An unknown/new provider therefore fails
 * toward "not received" → we introduce again, which is harmless; the reverse (staying silent about who
 * we are on the customer's FIRST message) is the bug this exists to prevent.
 */
export const CUSTOMER_FACING_OUTBOUND_PROVIDERS = new Set(["twilio", "sendgrid", "human", "web_widget"]);

export function hasCustomerReceivedOutbound(
  messages: ReadonlyArray<{ direction?: string | null; provider?: string | null } | null | undefined> | null | undefined
): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some(
    m => m?.direction === "out" && CUSTOMER_FACING_OUTBOUND_PROVIDERS.has(String(m?.provider ?? ""))
  );
}

/**
 * Should an inbound ADF's reply introduce the agent ("Hey Zackary, it's Alexandra over at American
 * Harley-Davidson.")?
 *
 * The old gate was `isInitialAdf` = "is this the FIRST ADF on the thread". That conflates *we drafted
 * something* with *the customer heard from us*: when the first ADF's draft is never sent, a second ADF
 * minutes later is "not initial", so the customer's FIRST EVER received message skips the intro and
 * opens "Thanks Zackary — we just received your online credit application" as if they already knew us.
 * Six americanharley leads landed that way (Zackary Hauff +17165985414 2026-07-16, Aaron +13463990700,
 * Francis +17173823519, Curtis +17164005844, Elijah +17165729565, John +17169974120) — every one with
 * an unsent draft ahead of the send. Operator-reported (Joe, 2026-07-16): "even though there were two
 * ADFs that came through, the first outgoing message, the agent should always introduce itself."
 *
 * So key the intro off what the customer RECEIVED, not off draft history. This is strictly a superset
 * of the old gate (no real send ⊇ no outbound at all), so a genuine first ADF still introduces exactly
 * as before. Deliberately scoped to the intro decision — `isInitialAdf` still owns cadence/availability
 * /side-effect routing, which is a different question.
 */
export function shouldIntroduceOnAdfTouch(args: {
  isAdfEvent: boolean;
  messages: ReadonlyArray<{ direction?: string | null; provider?: string | null } | null | undefined> | null | undefined;
}): boolean {
  if (!args.isAdfEvent) return false;
  return !hasCustomerReceivedOutbound(args.messages);
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
 * Deterministic color-compatibility check between the arriving UNIT's feed color and the color
 * the CUSTOMER asked for at watch creation (parser-captured, customer-sourced — see the
 * watch-field hygiene rules). This compares two STRUCTURED fields we already hold (inventory-feed
 * color vs the watch's captured color) — structured-field comparison / invariant guard, NOT
 * customer-intent comprehension, so a normalized string compare is the sanctioned tool here.
 * Containment either way counts as compatible ("Black" asked, "Vivid Black" arrived), so the
 * "different color" disclosure only fires when the colors genuinely differ. Fail direction: a
 * false "different" produces an extra honest disclosure line (harmless); the guard never lets a
 * mismatched unit masquerade as the asked-about color.
 */
function watchColorsCompatible(unitColor: string, watchedColor: string): boolean {
  const norm = (s: string) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const unit = norm(unitColor);
  const watched = norm(watchedColor);
  if (!unit || !watched) return false;
  return unit === watched || unit.includes(watched) || watched.includes(unit);
}

/**
 * Inventory-watch "your bike is in stock" notification (the watch-fire reply). Beyond announcing the unit,
 * it (1) ASKS whether they're still looking, and (2) offers a clean opt-out — "if you're all set I'll take
 * you off the list." A "no / all set / found one" reply is read by the watch-opt-out parser
 * (decideWatchOptOutTurn) which PAUSES the watch, so the customer can remove themselves and we stop pinging
 * a lead who has moved on (Joe, 2026-06-26). Pinned by watch_available_reply:eval.
 *
 * COLOR HONESTY (Joe ruling, 2026-07-23 — Gregory +17165981862): a same-model different-color
 * arrival still fires, but the text must be honest about color. The composer owns the phrasing:
 * - unit color ≠ the color the customer asked about → announce the unit AND disclose the
 *   difference ("this one's Teal Thunder, not the Dark Billiard Gray you asked about").
 * - the customer never gave a color (model-only watch) → the unit's color is stated as the
 *   UNIT's color ("this one's Teal Thunder"), never inside the "you were watching for" claim —
 *   Gregory's watch was model-only and the old template claimed he was watching for Teal Thunder.
 * - colors compatible → the old "in <color> you were watching for" phrasing (the claim is true).
 * - unit color unknown → no color claim at all (never present the WATCH's color as the unit's).
 * NEVER claim the customer was watching for a color he didn't ask for.
 */
export function buildWatchAvailableReply(args: {
  firstName?: string | null;
  bikeLabel: string; // e.g. "2025 Harley-Davidson Breakout"
  unitColor?: string | null; // the arriving UNIT's color, from the inventory feed ONLY
  watchedColor?: string | null; // the color the CUSTOMER asked for at watch creation (parser-captured)
  availability?: "new" | "in_stock" | "again";
}): string {
  const opener = args.firstName ? `Hey ${args.firstName}, good news` : "Good news";
  const unitColor = String(args.unitColor ?? "").trim();
  const watchedColor = String(args.watchedColor ?? "").trim();
  const arrival =
    args.availability === "new" ? "just came in" : args.availability === "again" ? "is available again" : "is in stock now";
  const tail =
    "Are you still looking? If so I can send details or set up a time to come see it — " +
    "and if you're all set, just let me know and I'll take you off the list.";
  if (unitColor && watchedColor && !watchColorsCompatible(unitColor, watchedColor)) {
    // Same model, different color — fire, but disclose the difference honestly.
    return (
      `${opener} — a ${args.bikeLabel} you were watching for ${arrival}. ` +
      `One thing: this one's ${unitColor}, not the ${watchedColor} you asked about — still worth a look if you're open on color. ` +
      tail
    );
  }
  if (unitColor && !watchedColor) {
    // Model-only watch — state the color as the UNIT's, never as what they watched for.
    return `${opener} — a ${args.bikeLabel} you were watching for ${arrival} — this one's ${unitColor}. ${tail}`;
  }
  // Compatible color (claim is true) — or no unit color to speak of (no color claim at all).
  const bike = unitColor ? `${args.bikeLabel} in ${unitColor}` : args.bikeLabel;
  return `${opener} — a ${bike} you were watching for ${arrival}. ${tail}`;
}

/**
 * BUNDLED inventory-watch notification (Joe ruling 2026-07-23): when the per-conversation daily
 * alert cap held back additional same-day matches, the next delivery covers ALL of them in ONE
 * text instead of a drip of separate alerts (MD +19292685345 got 5 in two days, two minutes
 * apart). One bike delegates to buildWatchAvailableReply so the single-alert copy — including its
 * color-honesty disclosure — stays pinned by watch_available_reply:eval. A multi-bike bundle names
 * each unit with the UNIT's real feed color only (never presented as the color the customer asked
 * for), so it can never make a false color claim; the per-bike "not the color you asked about"
 * disclosure is left to the single-alert path to keep the bundle readable. Keeps the still-looking
 * ask + clean opt-out tail — the watch-opt-out parser (decideWatchOptOutTurn) backs the "take you
 * off the list" promise either way. Pinned by watch_alert_daily_cap:eval.
 */
export function buildWatchAvailableBundleReply(args: {
  firstName?: string | null;
  bikes: Array<{ bikeLabel: string; unitColor?: string | null; watchedColor?: string | null }>;
  availability?: "new" | "in_stock" | "again";
}): string {
  const bikes = (args.bikes ?? []).filter(b => b && String(b.bikeLabel ?? "").trim());
  if (bikes.length <= 1) {
    return buildWatchAvailableReply({
      firstName: args.firstName,
      bikeLabel: bikes[0]?.bikeLabel ?? "",
      unitColor: bikes[0]?.unitColor ?? null,
      watchedColor: bikes[0]?.watchedColor ?? null,
      availability: args.availability
    });
  }
  const opener = args.firstName ? `Hey ${args.firstName}, good news` : "Good news";
  const count = bikes.length === 2 ? "a couple of bikes" : "a few bikes";
  const arrival =
    args.availability === "new"
      ? "just came in"
      : args.availability === "again"
        ? "are available again"
        : "are in stock now";
  const labels = bikes.map(b => {
    const unitColor = String(b.unitColor ?? "").trim();
    return `a ${b.bikeLabel}${unitColor ? ` in ${unitColor}` : ""}`;
  });
  const list = `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  return (
    `${opener} — ${count} you were watching for ${arrival}: ${list}. ` +
    "Are you still looking? If so I can send details or set up a time to come see them — " +
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

/**
 * Strip an "it's {someone} over at {dealerName}." clause (the softened
 * `buildAgentIntroPhrase` shape) wherever it names THIS dealer. Twin of
 * `applyInitialAdfPrefix`'s "this is X at Y" strips (sendgridInbound): deterministic
 * templates (e.g. buildLongTermTimelineMessage) now carry their own profile-built softened
 * intro, and when the template's first name or a per-send agent override differs from the
 * prefix being prepended, the cheap startsWith dedupe misses. Anchoring on the dealer name
 * keeps it surgical — ordinary sentences don't take the "it's … over at {dealer}." shape.
 * Fail direction: one consistent profile-based intro, never a double introduction.
 * Pinned by long_term_message:eval.
 */
export function stripAgentIntroPhraseForDealer(body: string, dealerName: string): string {
  const dealer = String(dealerName ?? "").trim();
  const text = String(body ?? "");
  if (!dealer) return text;
  const dealerEsc = dealer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`\\bit[’']s\\s+[^.]{1,80}?\\s+over\\s+at\\s+${dealerEsc}\\.?\\s*`, "ig"), "");
}
