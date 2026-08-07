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
 * Every self-intro shape this codebase actually emits, matched for ONE given name:
 *   `buildAgentIntroPhrase` → "it's {name} over at {dealer}"  (also "it's {name} at …")
 *   the ADF/manual openers    → "This is {name} at {dealer}"
 *   older hand-written copy   → "I'm {name} at {dealer}"
 * Anchored on the dealer clause (`at`/`over at`) for the "it's"/"I'm" shapes on purpose: a bare
 * "it's Mike" also matches "it's Mike's bike", and this name ends up SIGNED ON A TEXT TO THE
 * CUSTOMER. Missing an intro is harmless (the caller keeps today's answer); matching the wrong
 * token is not — so the pattern is deliberately narrow.
 */
export function buildAgentSelfIntroPattern(agentName: string | null | undefined): RegExp | null {
  const clean = String(agentName ?? "").trim();
  if (!clean) return null;
  const escaped = clean
    .split(/\s+/)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const tail = /\w$/.test(clean) ? "\\b" : "";
  return new RegExp(`\\b(?:this is\\s+${escaped}${tail}|(?:it'?s|i'?m)\\s+${escaped}${tail}\\s+(?:over\\s+)?at\\b)`, "i");
}

/**
 * Has this customer already been introduced BY NAME to the rep who owns the thread?
 *
 * THE MISS (agent-watch, 2026-08-02). `resolveConversationAgentName` hands the thread to the
 * `leadOwner` only when the thread is a walk-in or a manual takeover. On an ordinary lead the owner
 * often introduced themselves anyway — through the CRM, an imported history row, or a hand-sent
 * text — and those rows carry no `actorUserName`, so the historic-backfill scan skips them and the
 * next draft signs with the configured persona instead. The customer heard "This is {owner} at …"
 * in May and gets "it's {persona} over at …" in August, on the same thread. 26 threads in the
 * americanharley store are in that state, and the live quality judge flags the flip as a real
 * defect ("introduces a new staff name inconsistent with prior thread") — it was the single most
 * common self-heal reason on 8/1-8/2.
 *
 * The evidence bar is deliberately high, because the return value gets SIGNED ON A CUSTOMER TEXT:
 *  - the name must be the thread's OWN `leadOwner` — never a name scraped out of free text, so a
 *    stray capitalized token can never become the sender;
 *  - the intro must appear in an outbound the customer actually RECEIVED
 *    (`keepCustomerReceivedOutbounds` — an unapproved `draft_ai` row is a proposal, not a message
 *    the customer got; same lesson as `buildCustomerReceivedHistory`).
 * No evidence → null → the caller keeps exactly today's behaviour. The fail direction is
 * "stay with the persona", which is the status quo.
 */
export function resolveIntroducedOwnerFirstName(args: {
  ownerName?: string | null;
  messages:
    | ReadonlyArray<{ direction?: string | null; provider?: string | null; body?: string | null } | null | undefined>
    | null
    | undefined;
}): string | null {
  const ownerRaw = String(args.ownerName ?? "").trim();
  if (!ownerRaw || /^(our team|sales team|team)$/i.test(ownerRaw)) return null;
  const ownerFirst = ownerRaw.split(/\s+/).filter(Boolean)[0] ?? "";
  if (!ownerFirst) return null;
  const messages = Array.isArray(args.messages) ? args.messages.filter(Boolean) : [];
  if (!messages.length) return null;
  // Match on the FIRST name alone: reps sign texts "This is Giovanni at …", never with a surname.
  const introPattern = buildAgentSelfIntroPattern(ownerFirst);
  if (!introPattern) return null;
  const received = keepCustomerReceivedOutbounds(
    messages as Array<{ direction?: string | null; provider?: string | null; body?: string | null }>
  );
  const introduced = received.some(
    m => m?.direction === "out" && introPattern.test(String(m?.body ?? ""))
  );
  return introduced ? ownerFirst : null;
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
  messages:
    | ReadonlyArray<{ direction?: string | null; provider?: string | null; delivered?: boolean | null } | null | undefined>
    | null
    | undefined
): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some(
    m =>
      m?.direction === "out" &&
      CUSTOMER_FACING_OUTBOUND_PROVIDERS.has(String(m?.provider ?? "")) &&
      // A recorded-but-unsendable fallback row (delivered: false) reached nobody — counting it
      // skips the intro on the customer's REAL first message, the exact failure this file exists
      // to prevent. Absent means delivered (pre-marker history).
      m?.delivered !== false
  );
}

/**
 * Drop the outbounds the customer never actually received, keeping every inbound. Same
 * allowlist (and therefore the same fail direction) as `hasCustomerReceivedOutbound`: an
 * unknown provider is treated as NOT received.
 *
 * Use this wherever a consumer is answering "what has this customer actually heard from us?".
 * A `draft_ai` row is a proposal, not a message: the staff may never approve it (1,051 of 1,134
 * in the americanharley store are `draftStatus: "stale"`). Feeding one to a reviewer as a prior
 * `out:` turn invents a conversation that never happened — see `buildCustomerReceivedHistory`.
 */
export function keepCustomerReceivedOutbounds<
  T extends { direction?: string | null; provider?: string | null; delivered?: boolean | null }
>(messages: ReadonlyArray<T> | null | undefined): T[] {
  if (!Array.isArray(messages)) return [];
  return messages.filter(
    m =>
      m?.direction !== "out" ||
      (CUSTOMER_FACING_OUTBOUND_PROVIDERS.has(String(m?.provider ?? "")) && m?.delivered !== false)
  );
}

/**
 * Did a REAL human send actually reach this customer inside the window? The proactive-cadence
 * loop uses this to decide "a rep is driving, downgrade to draft-only" — before the delivered
 * marker existed it read any provider "human" row, so the cadence's own unsendable fallback
 * (recorded as "human") benched the cadence for 14 days on a thread no human ever touched.
 */
export function hasRecentDeliveredHumanOutbound(
  messages:
    | ReadonlyArray<
        { direction?: string | null; provider?: string | null; delivered?: boolean | null; at?: string | null } | null | undefined
      >
    | null
    | undefined,
  nowMs: number,
  windowMs: number = 14 * 24 * 60 * 60 * 1000
): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some(m => {
    if (m?.direction !== "out" || m?.provider !== "human" || m?.delivered === false) return false;
    const atMs = new Date(String(m?.at ?? "")).getTime();
    if (Number.isNaN(atMs)) return false;
    // Same window arithmetic the inline block used (no lower bound) — behavior-preserving lift.
    return nowMs - atMs <= windowMs;
  });
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
 * CHOLO build-segment watch alert (Cholo style vision, 2026-07-26). A cholo watch is a STYLE watch, not
 * a model watch — the customer asked for "a cholo", never for the specific model that happens to match.
 * So the generic buildWatchAvailableReply ("a <model> you were watching for") is WRONG here: it would name
 * a model they never asked about and drop the always-confirm hedge. This copy instead (a) names the STYLE
 * they watched for, (b) keeps the "let me double-check" hedge — cholo is the vision's READ of the photos,
 * never asserted as fact (Joe ruling 3) — and (c) still names the real arriving unit + offers pics/a visit
 * and the opt-out. The unit color, when known, is stated as the UNIT's (never as a "watched color" — a
 * cholo watch carries none). Pinned by cholo_style_vision:eval + voice_charter:eval.
 */
export function buildCholoWatchAvailableReply(args: {
  firstName?: string | null;
  bikeLabel: string; // the arriving UNIT, e.g. "2020 Harley-Davidson Road King"
  unitColor?: string | null; // the arriving unit's FEED color only
  availability?: "new" | "in_stock" | "again";
}): string {
  const opener = args.firstName ? `Hey ${args.firstName}, good news` : "Good news";
  const arrival =
    args.availability === "again" ? "just came back in" : args.availability === "in_stock" ? "just turned up" : "just landed";
  const unitColor = String(args.unitColor ?? "").trim();
  const bikeLabel = String(args.bikeLabel ?? "").trim();
  const bike = bikeLabel ? (unitColor ? `${bikeLabel} in ${unitColor}` : bikeLabel) : "one";
  return (
    `${opener} — something ${arrival} that's got that cholo style you're after: a ${bike}. ` +
    "Let me double-check the details, but want me to send a few pics or line up a time to come see it? " +
    "If you're all set, just let me know and I'll take you off the list."
  );
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
/**
 * The JUMPSTART 1-on-1 invite (Joe, 2026-08-05) — one sentence, woven into the first-time-rider
 * reply when `decideJumpstartInviteTurn` says this store HAS a Jumpstart and this customer has
 * no-to-little riding experience.
 *
 * May say: what the Jumpstart is (a real bike on a stationary stand), that it needs no license, and
 * an offer of one-on-one time on it. Must NOT say, because none of it is this sentence's to
 * promise: a price, a test ride or road ride, a specific day or time (the scheduler owns booking),
 * or any suggestion that it replaces training or a license. Pinned by `jumpstart_invite:eval`.
 */
export function buildJumpstartOneOnOneInvite(): string {
  return (
    " We also have a Jumpstart here — a real bike on a stand where you can start it up and work the " +
    "clutch and gears, no license needed. Want me to set up one-on-one time on it for you?"
  );
}

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
 * Approved first touch for a RIDING ACADEMY ENROLLMENT lead (Joe, 2026-08-05). The rider-training
 * school files an ADF when someone REGISTERS for a course; the person has already signed up and
 * paid (or owes the store), so the generic ADF opener — "Thanks for asking about our Riding Academy
 * course. Course details and pricing are here: <link>" — quoted the price back at two customers who
 * had already bought a seat. Used when `decideRidingAcademyTurn` returns
 * `riding_academy_enrollment_ack`.
 *
 * JOE'S SPEC, and the whole content of this message: an introduction, a thank-you, and that the
 * agent is here to help with anything about the course. Deliberately contains NO price or payment
 * reference (Payment Status is on the record — raising an unpaid seat over SMS is Joe's call, not
 * the agent's), NO bike pitch, availability claim or "which model?" ask, NO stop-in push, and NO
 * claim about the class date or what to bring (we assert nothing we would have to be right about).
 * It also says nothing about being new to riding — this lane carries skills-refresher students too.
 * Pinned by `riding_academy_enrollment_ack:eval`.
 */
/**
 * Approved acknowledgement for a Riding Academy **WAIT LIST** registration — the twin of
 * `buildRidingAcademyEnrollmentAck`, used when `decideRidingAcademyTurn` returns
 * `riding_academy_waitlist_ack`.
 *
 * WHY IT EXISTS (igor yuzbashev, +17164442120, 2026-08-06). His record read
 * `Enrollment Status: Wait List`, and the agent drafted:
 *   "Thanks - I saw you want to do the Jumpstart experience before the course."
 * He never said that. Two FIELD LABELS in the form - `Motivation: Learn to ride` and
 * `Training Experience: No` - satisfied a keyword rule meant for customer prose, so a form's
 * schema became a customer's request. The waitlist status was also ignored entirely: the reply
 * spoke as though a seat was his.
 *
 * So this message asserts only what the record actually says:
 *   - he is on the WAIT LIST, not enrolled, and we will tell him when a seat frees up;
 *   - the course and start date only when the record carries them (never invented);
 *   - the Jumpstart as OUR offer, phrased as an offer - never as something he asked for.
 *
 * The Jumpstart line is caller-supplied precisely so the experience read stays where it belongs
 * (`resolveRiderExperienceLevel`) and the dealer toggle still governs it. Joe, 2026-08-06:
 * fix the claim, keep the invite.
 */
export function buildRidingAcademyWaitlistAck(
  firstName: string | null | undefined,
  agentName: string,
  dealerName: string,
  extras: { course?: string | null; startDate?: string | null; jumpstartInvite?: string } = {}
): string {
  const intro = buildAgentIntro(firstName, agentName, dealerName);
  const course = String(extras.course ?? "").trim();
  const startDate = String(extras.startDate ?? "").trim();
  const jumpstart = String(extras.jumpstartInvite ?? "").trim();

  // Name the class only when the record named it. "the New Rider Course starting 8/15" is a fact
  // off the form; "the course" is the honest fallback when it is not.
  const classPhrase = course
    ? startDate
      ? `the ${course} starting ${startDate}`
      : `the ${course}`
    : "the Riding Academy";

  // Joe, 2026-08-06: "you can say we will follow up." The first draft of this line promised
  // "I'll let you know as soon as a seat opens up" — a TRIGGER promise that commits somebody to
  // watching the list and to noticing the moment it moves. "We'll follow up" is the commitment the
  // store actually makes, and it stays true whether the update is a seat, a later class, or a
  // cancellation.
  const body =
    `Thanks for signing up for ${classPhrase} - you're on the wait list right now, ` +
    "and we'll follow up with you as soon as we have an update. I'm your contact here for anything to do with the course.";

  return `${intro}${body}${jumpstart ? ` ${jumpstart}` : ""}`;
}

/**
 * THE WAIT ENDED — wait list -> a seat (Joe, 2026-08-07). The school files a SECOND enrollment
 * record when someone moves off the wait list, and until now that record never reached this lane at
 * all: the Riding Academy branch ran on the FIRST record only, so Maya Iversen's "Enrolled" notice
 * fell through to generic sales routing and drafted her *"I can ballpark payments once I confirm the
 * exact price. If you'd like to stop in, what day and time works best?"* — to someone whose own form
 * says she has never been on a motorcycle, even as a passenger.
 *
 * THE INTRO IS CONDITIONAL, and that is Joe's rule twice over. 2026-08-07: *"If it's a 2nd touch it
 * should not say I'm your contact again."* 2026-07-16, on the same question: key the intro off what
 * the customer has actually RECEIVED, not off what we drafted — a draft nobody sent means they have
 * never heard of us. Both point the same way; the caller passes `introduce` from
 * `hasCustomerReceivedOutbound`. Maya is exactly why the distinction matters: her wait-list text
 * FAILED to send (#586), so her "second" touch is really her first hello.
 *
 * The e-course sentence rides along from the dealer profile, same as the plain registration reply —
 * this is the same "you're registered" moment, so the same note applies. Blank profile ⇒ absent.
 */
export function buildRidingAcademyWaitlistToEnrolledAck(
  firstName: string | null | undefined,
  agentName: string,
  dealerName: string,
  extras: {
    course?: string | null;
    startDate?: string | null;
    registrationNote?: string;
    introduce?: boolean;
  } = {}
): string {
  const course = String(extras.course ?? "").trim();
  const startDate = String(extras.startDate ?? "").trim();
  const note = String(extras.registrationNote ?? "").trim();
  const introduce = extras.introduce !== false;
  const greetName = firstNameCollidesWithAgentName(firstName, agentName) ? null : firstName;

  // Same honesty rule as the wait-list ack: name the class only when the record named it.
  const classPhrase = course
    ? startDate
      ? `the ${course} starting ${startDate}`
      : `the ${course}`
    : "the Riding Academy";

  const opener = introduce
    ? `${buildAgentIntro(firstName, agentName, dealerName)}Good news - `
    : `${buildAgentGreeting(greetName)}good news - `;
  const contact = introduce ? " I'm your contact here for anything to do with the course." : "";

  return `${opener}a seat opened up and you're registered for ${classPhrase}.${contact}${note ? ` ${note}` : ""}`;
}

/**
 * THEY FINISHED (source 2844, RIDING ACADEMY - COMPLETE). Joe chose this shape on 2026-08-07 from
 * three options: **congratulate, and stop.** No pitch, no price, no "which model", no stop-in push.
 *
 * That restraint is the point, not an oversight. A course completion is the strongest buying signal
 * this lane produces — a newly licensed rider with no bike — and the temptation is to open with a
 * sale. Joe's call is that the dealership's first word after five days with its instructors is
 * congratulations. The door stays open; nothing is asked for. Same conditional intro as above.
 */
export function buildRidingAcademyCompletionAck(
  firstName: string | null | undefined,
  agentName: string,
  dealerName: string,
  extras: { course?: string | null; introduce?: boolean } = {}
): string {
  const course = String(extras.course ?? "").trim();
  const introduce = extras.introduce !== false;
  const greetName = firstNameCollidesWithAgentName(firstName, agentName) ? null : firstName;
  const what = course ? `the ${course}` : "the Riding Academy";

  // `buildAgentGreeting` ends in a COMMA ("Hey Maya, "), so the sentence that follows it has to start
  // lower-case or the message reads "Hey Maya, Congratulations…". The intro path ends in a full stop
  // ("…over at American Harley-Davidson. ") and takes the capital.
  const opener = introduce
    ? buildAgentIntro(firstName, agentName, dealerName)
    : buildAgentGreeting(greetName);
  const congrats = introduce ? "Congratulations" : "congratulations";
  const contact = introduce
    ? " I'm your contact here if anything comes up."
    : " Anything you need, just text me.";

  return `${opener}${congrats} on finishing ${what} - that's a real accomplishment.${contact}`;
}

export function buildRidingAcademyEnrollmentAck(
  firstName: string | null | undefined,
  agentName: string,
  dealerName: string,
  extras: { registrationNote?: string; unpaidSeatLine?: string; jumpstartInvite?: string } | string = {}
): string {
  // Back-compat: earlier callers passed the Jumpstart invite as a bare 4th string.
  const e = typeof extras === "string" ? { jumpstartInvite: extras } : extras;
  const note = String(e.registrationNote ?? "").trim();
  const unpaid = String(e.unpaidSeatLine ?? "").trim();
  const jumpstart = String(e.jumpstartInvite ?? "").trim();
  const intro = buildAgentIntro(firstName, agentName, dealerName);

  // Joe's ruling stack for this one message (2026-08-05), in priority order:
  //   1. intro + thanks + "I'm your contact" — always;
  //   2. the dealer's own registration note (the e-course link sentence) — always, when written;
  //   3. EITHER the unpaid-seat line OR the Jumpstart offer — never both.
  //
  // Why never both: measured against the real SMS brevity budget, all four run to 501 characters
  // across five sentences and stop reading like a text. The unpaid seat wins because it has a
  // DEADLINE (the class date) and the Jumpstart is an invitation that can wait for any later turn.
  const tail = unpaid || jumpstart;
  if (!note && !tail) {
    // Nothing configured and nothing to flag — the plain intro Joe approved, byte for byte.
    return (
      `${intro}Thanks for signing up for the Riding Academy — glad to have you in the class. ` +
      "I'm your contact here for anything to do with the course, so if a question comes up, just text me and I'll take care of it."
    );
  }
  const contact =
    "Thanks for signing up for the Riding Academy — I'm your contact here for anything to do with the course.";
  return `${intro}${contact}${note ? ` ${note}` : ""}${tail ? ` ${tail}` : ""}`;
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
    ? `Thanks for letting us know the ${model} is on your radar — great pick. Want to come in for a test ride, or I can pull together current availability and options whenever you're ready? Just let me know.`
    : "Thanks for sharing what you're looking for. Want to come in for a test ride, or I can pull together current availability and options whenever you're ready? Just let me know.";
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

/**
 * Price-objection reply: acknowledge + offer a cheaper-unit watch (Joe ruling 2026-07-23,
 * +17166021492 Brian Serena). When a customer objects to a price WE quoted, the answer is
 * never a sticker re-quote — it's a warm ack plus an offer to keep an eye out for the same
 * kind of bike at a lower price (mirrors the reply staff actually sent on the evidence
 * thread). Carries NO dollar figures and NO re-introduction — mid-thread voice only.
 * Pinned by reply_anchor_live_conversation:eval.
 */
export function buildPriceObjectionCheaperWatchReply(modelLabel?: string | null): string {
  const model = String(modelLabel ?? "").trim();
  const target = model ? `a ${model}` : "something similar";
  return (
    `Totally hear you — I'll keep an eye out for ${target} at a lower price and text you first when one comes in. ` +
    "Any specific year, color, or mileage you want me to target?"
  );
}

/**
 * The customer on an inventory watch tells us they BOUGHT A BIKE (Joe, 2026-08-04: "these should
 * acknowledge, let them know we are here if they need anything for the bike and take them off the
 * watch list"). Lives here with the rest of the customer-facing copy so it is testable without
 * booting the server.
 *
 * Names the bike ONLY when the customer named it in that very message — the parser refuses to carry
 * one over from the thread or the lead record. Congratulating someone on the wrong bike is worse
 * than congratulating them on no bike at all, so a blank falls back to the generic line.
 */
export function buildAcquiredVehicleAck(vehicle?: string | null): string {
  const named = String(vehicle ?? "").replace(/\s+/g, " ").trim();
  const congrats = named ? `Congrats on the ${named}!` : "Congrats on the new bike!";
  return (
    `${congrats} Thanks for letting me know — I'll take you off the alert list. ` +
    "If you ever need anything for it — parts, service, or gear — just text me here."
  );
}

/**
 * The three BEGINNER-facing first-time-rider replies, composed in one place.
 *
 * Lives here rather than inline in `index.ts` for a reason that cost a sabotage round on
 * 2026-08-05: while these strings were assembled inline, `jumpstart_invite:eval` could only GREP
 * for them, and a sabotage that APPENDED the Jumpstart invite instead of substituting it — blowing
 * the SMS brevity budget and re-asking a question the customer had just answered — passed the eval
 * clean. Composed here, the eval imports this and runs it, so the substitution is a fact the gate
 * can check instead of a shape it has to recognise.
 *
 * `jumpstartInvite` is "" for a dealer with no Jumpstart, and every branch then returns TODAY'S
 * exact wording, byte for byte. When it is set it REPLACES the clause it improves on: the generic
 * "sit on a few bikes" offer, or the "do you have your endorsement?" question we no longer need to
 * ask (the invite only fires once we have been told they are starting out).
 */
export function buildFirstTimeRiderBeginnerReply(args: {
  branch: "no_endorsement" | "asks_test_ride" | "general";
  jumpstartInvite: string;
  requirement?: string;
  courseText?: string;
}): string {
  const invite = String(args.jumpstartInvite ?? "");
  if (args.branch === "no_endorsement") {
    const hands =
      invite || " We can still help you sit on a few bikes and talk through beginner-friendly options.";
    return `${args.requirement ?? ""}${hands} If you’re still getting started, ${args.courseText ?? ""} is a good next step.`;
  }
  if (args.branch === "asks_test_ride") {
    return (
      "That’s exciting. For a first ride, I’d want to make sure we match you with something comfortable " +
      `and manageable before setting up a test ride.${invite || " Do you already have your motorcycle endorsement?"}`
    );
  }
  return (
    "That’s exciting. For a first bike, I’d focus on comfort, seat height, weight, and confidence." +
    `${invite || " Do you already have your motorcycle endorsement, or are you still getting started?"}`
  );
}

/**
 * The UNPAID-SEAT line for a course registration (Joe, 2026-08-05: *"Unpaid seats can be paid at
 * the dealer or over the phone if the payment fails."*).
 *
 * `paymentMethods` is the dealer's own words from their profile ("at the dealership or over the
 * phone"); blank ⇒ "" ⇒ the agent never raises payment. States that the seat is not settled and
 * WHERE to settle it — never HOW MUCH, and never a due date we would have to be right about. The
 * wording works for both statuses seen live ("Failed" and "Awaiting Payment at Dealer"): "isn't
 * showing as paid yet" is true of both, where "your payment failed" would be wrong for the second.
 * Pinned by `riding_academy_enrollment_ack:eval`.
 */
export function buildUnpaidSeatLine(paymentMethods: string): string {
  const methods = String(paymentMethods ?? "").trim();
  if (!methods) return "";
  return `One thing to flag: your seat isn't showing as paid yet — you can take care of that ${methods}.`;
}

/**
 * The SHORT Jumpstart offer used inside a course registration, where the message is already
 * carrying an intro and the dealer's e-course note. The full `buildJumpstartOneOnOneInvite` wording
 * pushes the registration reply to five sentences; this one keeps it at four.
 */
export function buildJumpstartRegistrationInvite(): string {
  return "We've also got a Jumpstart here you can try before class — want me to set up one-on-one time on it?";
}
