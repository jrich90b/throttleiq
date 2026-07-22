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
 * Does the customer's first name collide with the agent's OWN persona name (case-insensitive,
 * first-token)? When it does, any intro that greets the customer by name AND names the agent
 * ("Hey Alexandra, it's Alexandra over at …" / "Hi Alexandra — This is Alexandra at …") reads
 * as a bug on the customer's first contact — a real first-touch ADF ack went out that way to
 * customer Alexandra Meinhold because the dealer's configured agentName is itself Alexandra
 * (open-critic +17162636134, 2026-07-22). Callers drop the greeting NAME on a collision and
 * keep the self-intro (the whole point of a first-touch line). Fail-direction is safe: fires
 * only on an exact first-name match, and the degraded "Hey there / Hi —" form is still correct.
 * Shared by buildAgentIntro (SMS chokepoint) AND the sendgrid inline ADF/email intros so both
 * lanes stay in lock-step. Pinned by agent_voice:eval + email_intro_name_collision:eval.
 */
export function firstNameCollidesWithAgentName(
  firstName: string | null | undefined,
  agentName: string | null | undefined
): boolean {
  const firstToken = (v: string | null | undefined): string =>
    String(v ?? "").trim().split(/\s+/).filter(Boolean)[0] ?? "";
  const customerFirst = firstToken(firstName);
  const agentFirst = firstToken(agentName);
  return customerFirst !== "" && agentFirst !== "" && customerFirst.toLowerCase() === agentFirst.toLowerCase();
}

/**
 * The customer first name to use in a GREETING given the agent name: the name itself, or ""
 * (blank → a name-less greeting) when the two collide. Lets an inline greeting keep its own
 * "Hi {name} — " / "Hi {name}," / "Hey {name}," shape while still honoring the collision guard:
 * `const greeting = greetingFirstName(firstName, agentName) ? \`Hi ${...} — \` : "Hi — ";`
 */
export function greetingFirstName(
  firstName: string | null | undefined,
  agentName: string | null | undefined
): string {
  return firstNameCollidesWithAgentName(firstName, agentName) ? "" : String(firstName ?? "").trim();
}

/**
 * Full softened intro: "Hey {name}, it's {agent} over at {dealer}. " (trailing space).
 * On a customer/agent name collision the greeting name is dropped (see
 * `firstNameCollidesWithAgentName`) → "Hey there, it's Alexandra over at …". Pinned by
 * agent_voice:eval.
 */
export function buildAgentIntro(
  firstName: string | null | undefined,
  agentName: string,
  dealerName: string
): string {
  const greetingName = firstNameCollidesWithAgentName(firstName, agentName) ? null : firstName;
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
