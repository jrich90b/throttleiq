/**
 * Reading an inventory WANT out of a walk-in staff note.
 *
 * Larry Godzich (+17164327329, 2026-07-27, Traffic Log Pro ref 11695) is why this module exists.
 * Scott's note read: "Was in for the Back the Blue ride and was asking about pre-owned trikes.
 * Showed him and his wife Kim the 2019 we have in the back (waiting on lien release). Is looking
 * for 2017-2020 Tri Glide in the $25,000 range (Step 2)". Every slot we needed came out right
 * (model "Tri Glide", years 2017-2020, condition used, a budget), the reply even said the spec
 * back to him — and no watch was ever created. Operator, 2026-08-01: "THIS SHOULD HAVE TRIGGERED
 * A WATCH FROM THE ADF."
 *
 * The reason is a question mismatch, not a comprehension miss. The ADF walk-in lane decided
 * "should we watch?" with two arms that both ask about CUSTOMER SPEECH:
 *   - `hasWatchIntentPhrase` needs a literal notify verb ("watch for", "let me know when"), and
 *   - `parseIntentWithLLM` needs `explicit_request` from a parser whose every few-shot is
 *     prefixed `Customer:` and whose contract is dealership SMS.
 * A Traffic Log Pro "Inquiry" is not customer speech. It is our own salesperson's CRM log, written
 * in the third person ABOUT the customer. Nobody in that note asks to be texted, so both arms say
 * no, forever — measured on the production text, the intent arm answered "availability +
 * explicit_request" 2 times in 7.
 *
 * So the question this module asks a staff note is the one a staff note actually answers:
 * **is there a want here we cannot fill today?** That is `unmet_inventory_want`, carried by
 * `parseWalkInOutcomeWithLLM` — the only parser in the repo already written for staff prose
 * ("You parse walk-in salesperson comments from dealership ADF leads") and already running on
 * this exact text on this exact lane, so the answer costs no extra round-trip.
 *
 * WHY THE QUESTION HAS TO BE THAT NARROW. Sampling every Traffic Log Pro walk-in note in the
 * production store: 48 notes, 5 with an explicit watch verb, 14 with a bare "want" verb, 8 of
 * those carrying no watch today. Reading those 8, only about 2 are genuine "we don't have it,
 * tell them when one lands". The rest belong to other lanes — an in-stock test ride
 * (+17162626218), a factory order (+17165238728), an allocated unit already dated for delivery
 * (+17165832512), a callback on one specific bike sitting in service (+17169570162). A naive
 * "want verb ⇒ watch" rule would mint 4-6 wrong watches out of 8, and a wrong watch is not a
 * quiet miss: weeks later it becomes an unsolicited proactive text. That is the over-attachment
 * failure CLAUDE.md warns is worse than the miss, which is why the enum separates those lanes
 * explicitly and why the few-shots below are drawn from those real notes.
 *
 * FAIL DIRECTION (AGENTS.md migrate-vs-keep): the regex arm `hasWatchIntentPhrase` is a KEEP —
 * dropping it would fail toward NOT doing the side effect, i.e. a lead we promised to text never
 * gets one. It stays as an independent OR arm and still wins on its own. The parser arm is a pure
 * MIGRATE that can only ADD watches the regex cannot see: unclear or low-confidence collapses to
 * "none", which is exactly today's behavior. The referee
 * (`decideWalkInInventoryWatchTurn`, routeStateReducer.ts) defaults to no watch.
 */

/** The lane a walk-in note's inventory want belongs to. Only `open_search` can mint a watch. */
export type UnmetInventoryWant =
  /** No want, or a want for something we are already handing them. */
  | "none"
  /** They want a unit we do not have and have not promised — the only watchable lane. */
  | "open_search"
  /** They want ONE identified bike of ours (in service, being prepped, on hold). A callback, not a watch. */
  | "specific_unit"
  /** We are placing a factory order for them. The deal is the follow-up, not an arrival alert. */
  | "order"
  /** An allocated/incoming unit, usually already dated. It is coming; a watch would double up. */
  | "incoming_allocated";

const UNMET_INVENTORY_WANTS: ReadonlySet<string> = new Set<UnmetInventoryWant>([
  "none",
  "open_search",
  "specific_unit",
  "order",
  "incoming_allocated"
]);

/**
 * Coerce the parser's raw string. Anything unrecognized becomes "none" — an unknown lane must
 * read as "no watch", never as the watchable one.
 */
export function coerceUnmetInventoryWant(raw: unknown): UnmetInventoryWant {
  const value = String(raw ?? "").trim().toLowerCase();
  return UNMET_INVENTORY_WANTS.has(value) ? (value as UnmetInventoryWant) : "none";
}

/**
 * Did the note say the customer is COMING BACK, and did it name a day?
 *
 * Ed Szulist (+17167255404, 2026-08-01, Traffic Log Pro ref 11719) is why this slot exists. The
 * note read "COMING BACK NXT WEEK TUESDAY AUGUST 4TH TO TEST RIDE A FEW DIFFERENT SPORTSTERS
 * (Step 5)" and the whole first text back was "Thanks again for your time. I'll follow up shortly
 * with next steps." The salesperson then rewrote it by hand to ask what time window worked on the
 * 4th — the feed filed it `human_correction_material / missing_info`, and the correction steering
 * says it outright: "ask for a preferred time window on the specified date."
 *
 * Why nothing caught it: the walk-in path extracts model / year / condition and nothing else, so
 * `buildWalkInSpecRecapClause` had no slots to speak from (and "Sportsters" is a FAMILY, not a
 * model), while `follow_up_window_text` answers a different question — when WE will reach out, not
 * when THEY are walking in. A day the customer commits to is the single most actionable fact a
 * walk-in note can carry, and we had nowhere to put it.
 *
 * THE ENUM IS THE WHOLE GUARD. Sampling the live Traffic Log Pro notes, dates in staff prose are
 * mostly OURS, not theirs — "projected ship date is 7/29", "Spot delivery 7/23", "Reach follow up
 * on 5/23/26". Reading any of those as "the customer is coming in Wednesday" would put a visit in
 * the customer's mouth that they never promised, and that clause asks them a question, so the miss
 * is loud. Hence an enum, not a boolean: `committed_day` (coming back, a day named, no time settled
 * — the only lane that speaks), `committed_day_and_time` (both already settled, so there is nothing
 * to ask), `tentative` (they said they'd be back, no day), `none` (everything else, including every
 * date that belongs to us).
 *
 * FAIL DIRECTION: unknown, unclear, low-confidence and dateless all collapse to a clause of "",
 * which is byte-for-byte today's generic tail. The slot can only ADD a question about a day the
 * note itself named. It carries its OWN confidence (`return_visit_confidence`, the `want_confidence`
 * shape from the Larry work above) precisely so it never rides on `walkInOutcomeAccepted` — that
 * gate needs an `explicit_state` from the state enum, which a "coming back to ride" note never has,
 * and that is why the existing `test_ride_requested` slot is unreachable for this whole note class.
 */
export type WalkInReturnVisit =
  /** No return commitment — including any date that is OURS (ship, delivery, our own callback). */
  | "none"
  /** The note says they are coming back AND names a day, with no time settled. Renders the ask. */
  | "committed_day"
  /**
   * A day AND a time are already settled ("coming in 4/6 at 4:00pm"). Kept distinct rather than
   * folded into `committed_day` because the clause's whole job is to ask for a time — asking a
   * customer who already gave one reads as not listening, which is the failure we are fixing.
   * Renders nothing today; it exists so the enum stays truthful and a later appointment lane has
   * something to read.
   */
  | "committed_day_and_time"
  /** They said they'd be back but named no day. Nothing to ask about yet. */
  | "tentative";

const WALK_IN_RETURN_VISITS: ReadonlySet<string> = new Set<WalkInReturnVisit>([
  "none",
  "committed_day",
  "committed_day_and_time",
  "tentative"
]);

/** Coerce the parser's raw string. Anything unrecognized becomes "none" — see fail direction. */
export function coerceWalkInReturnVisit(raw: unknown): WalkInReturnVisit {
  const value = String(raw ?? "").trim().toLowerCase();
  return WALK_IN_RETURN_VISITS.has(value) ? (value as WalkInReturnVisit) : "none";
}

/** The walk-in note's primary state. */
export type WalkInOutcomeState =
  | "none"
  | "deal_finalizing"
  | "deposit_left"
  | "sold_delivered"
  | "hold_requested"
  | "hold_cleared"
  | "cosigner_required"
  | "test_ride_completed"
  | "decision_pending"
  | "outside_financing_pending"
  | "down_payment_pending"
  | "trade_equity_pending"
  | "timing_defer_window"
  | "household_approval_pending"
  | "docs_or_insurance_pending";

const WALK_IN_OUTCOME_STATES: ReadonlySet<string> = new Set<WalkInOutcomeState>([
  "none",
  "deal_finalizing",
  "deposit_left",
  "sold_delivered",
  "hold_requested",
  "hold_cleared",
  "cosigner_required",
  "test_ride_completed",
  "decision_pending",
  "outside_financing_pending",
  "down_payment_pending",
  "trade_equity_pending",
  "timing_defer_window",
  "household_approval_pending",
  "docs_or_insurance_pending"
]);

/**
 * Coerce the parser's raw `state`. Set-based, mirroring `coerceUnmetInventoryWant` — moved out of
 * the inline ternary chain in llmDraft.ts, which sits at its size ceiling and had to come out net
 * negative to make room for the return-visit slots. Behaviour is identical: the same fifteen
 * strings pass, everything else is "none".
 */
export function coerceWalkInOutcomeState(raw: unknown): WalkInOutcomeState {
  const value = String(raw ?? "").trim().toLowerCase();
  return WALK_IN_OUTCOME_STATES.has(value) ? (value as WalkInOutcomeState) : "none";
}

/**
 * The explicit notify-verb segment of a staff note ("watch for a 2024 Street Glide" → the part
 * after the verb). Moved here from sendgridInbound.ts unchanged so the eval can exercise the
 * regex that actually runs instead of a hand-copy — the drift that made a cadence eval score
 * 0.8095 against a shipped 0.7727 (PR #432).
 */
export function extractWatchDirectiveSegment(text?: string | null): string {
  const source = String(text ?? "");
  if (!source) return "";
  const m = source.match(
    /\b(?:watch(?:ing)? for|keep an eye out for|please watch for|open to watch for|watch)\b([\s\S]*?)(?=(?:\b(?:step\s*\d+|email opt-?in|view lead)\b|[.;]|$))/i
  );
  return String(m?.[1] ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Does the text carry an explicit "tell me when one lands" verb? KEEP arm (see fail direction
 * above): this is the gate that fails toward doing the side effect, so it stands on its own and
 * the parser never vetoes it.
 */
export function hasWatchIntentPhrase(text?: string | null): boolean {
  const source = String(text ?? "").toLowerCase();
  if (!source.trim()) return false;
  return (
    /\b(keep an eye out(?: for)?|watch(?:ing)? for|please watch|open to watch for|notify me|let me know when|text me when|if you get one|when you get one|as soon as one comes in)\b/i.test(
      source
    ) || /\bif one comes in\b/i.test(source)
  );
}

/**
 * Which colour, if any, a walk-in staff note wants on the BIKE — parser first, keyword second.
 *
 * Rick Williamson Sr. (+17168609581, 2026-08-04, Traffic Log Pro ref 11728) is why this exists.
 * The note read "Rick was on for the back the blue ride and was asking about pricing on Road Glide
 * 3", the keyword colour list saw the word "blue", and `lead.vehicle.color` became "blue". We stock
 * three 2026 Road Glide 3s (Iron Horse Metallic, Dark Billiard Gray, Vivid Black) and the colour
 * match rejected all three, so the availability lane concluded "not in stock", drafted "I'll keep
 * an eye out for Road Glide 3 and let you know if one comes in", and armed a watch for a blue Road
 * Glide 3 that can never fire. His pricing question was never answered. The same note class did the
 * same thing to +17165241170 and +17164327329 — three leads, one charity ride's NAME.
 *
 * THE PRECEDENCE IS THE FIX. The old call site read
 * `extractColorFromText(text) ?? (accepted ? parser.color : undefined)` — the keyword list FIRST,
 * so a correct parser answer could never win. That is the inline `regex || parser` inversion
 * CLAUDE.md rule 1 forbids. Here the parser wins whenever it answered above the floor, and a
 * confident EMPTY answer is a real answer: "there is no bike colour in this note" must beat the
 * keyword, or nothing changes for Rick.
 *
 * FAIL DIRECTION: the keyword arm survives only as the fallback for when the parser did not run or
 * was unsure, so this can only ever REMOVE a colour the customer never asked for. Losing a colour
 * costs specificity, never correctness — an absent colour degrades to the model's honest range
 * (`narrowUnitsByColorFinish`, inventoryFeed.ts) and to a model-only watch that can actually fire.
 * Inventing one is what silences three in-stock bikes. Pinned by
 * `walkin_internal_note_topic_guard:eval`.
 */
export function resolveWalkInNoteColor(input: {
  parserColor?: string | null;
  parserConfidence?: number | null;
  keywordColor?: string | null;
  confidenceMin?: number;
}): string | undefined {
  const floorRaw = Number(input.confidenceMin);
  const floor = Number.isFinite(floorRaw) ? floorRaw : 0.8;
  const confidence = Number(input.parserConfidence);
  // A confident "" is an ANSWER (no colour here), not an absence — that is the whole point.
  if (Number.isFinite(confidence) && confidence >= floor) {
    return String(input.parserColor ?? "").trim() || undefined;
  }
  return String(input.keywordColor ?? "").trim() || undefined;
}

export const WALK_IN_OUTCOME_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: [
    "state",
    "explicit_state",
    "test_ride_requested",
    "weather_sensitive",
    "follow_up_window_text",
    "unmet_inventory_want",
    "want_is_satisfiable_from_note",
    "want_confidence",
    "return_visit",
    "return_day_text",
    "return_visit_confidence",
    "desired_color",
    "desired_color_confidence",
    "confidence"
  ],
  properties: {
    state: {
      type: "string",
      enum: [
        "none",
        "deal_finalizing",
        "deposit_left",
        "sold_delivered",
        "hold_requested",
        "hold_cleared",
        "cosigner_required",
        "test_ride_completed",
        "decision_pending",
        "outside_financing_pending",
        "down_payment_pending",
        "trade_equity_pending",
        "timing_defer_window",
        "household_approval_pending",
        "docs_or_insurance_pending"
      ]
    },
    explicit_state: { type: "boolean" },
    test_ride_requested: { type: "boolean" },
    weather_sensitive: { type: "boolean" },
    follow_up_window_text: { type: "string" },
    unmet_inventory_want: {
      type: "string",
      enum: ["none", "open_search", "specific_unit", "order", "incoming_allocated"]
    },
    want_is_satisfiable_from_note: { type: "boolean" },
    want_confidence: { type: "number" },
    return_visit: {
      type: "string",
      enum: ["none", "committed_day", "committed_day_and_time", "tentative"]
    },
    return_day_text: { type: "string" },
    return_visit_confidence: { type: "number" },
    desired_color: { type: "string" },
    desired_color_confidence: { type: "number" },
    confidence: { type: "number" }
  }
};

/**
 * Few-shots. The originals keep their `state` verdicts byte-for-byte — the new fields are additive
 * and must not drag the state classification around. The trailing block (R-V) is drawn from real
 * Traffic Log Pro notes in the production store, and exists mostly to teach the NEGATIVE lanes.
 */
export const WALK_IN_OUTCOME_EXAMPLES: string[] = [
  `EXAMPLE A
comment: "left $1,000 deposit on motorcycle. coming in 4/6 at 4:00pm to finalize deal. (step 6)"
output: {"state":"deposit_left","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"","unmet_inventory_want":"none","want_is_satisfiable_from_note":true,"want_confidence":0.95,"return_visit":"committed_day_and_time","return_day_text":"4/6 at 4:00pm","return_visit_confidence":0.9,"desired_color":"","desired_color_confidence":0.9,"confidence":0.98}`,
  `EXAMPLE B
comment: "thinking it over, will let you know next week"
output: {"state":"decision_pending","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"next week","unmet_inventory_want":"none","want_is_satisfiable_from_note":false,"want_confidence":0.9,"return_visit":"none","return_day_text":"","return_visit_confidence":0.9,"desired_color":"","desired_color_confidence":0.9,"confidence":0.95}`,
  `EXAMPLE C
comment: "wants a test ride next week when weather is better"
 output: {"state":"timing_defer_window","explicit_state":true,"test_ride_requested":true,"weather_sensitive":true,"follow_up_window_text":"next week","unmet_inventory_want":"none","want_is_satisfiable_from_note":true,"want_confidence":0.88,"return_visit":"none","return_day_text":"","return_visit_confidence":0.9,"desired_color":"","desired_color_confidence":0.9,"confidence":0.9}`,
  `EXAMPLE D
comment: "mark this lead on hold until next Friday"
output: {"state":"hold_requested","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"next Friday","unmet_inventory_want":"none","want_is_satisfiable_from_note":false,"want_confidence":0.9,"return_visit":"none","return_day_text":"","return_visit_confidence":0.9,"desired_color":"","desired_color_confidence":0.9,"confidence":0.94}`,
  `EXAMPLE E
comment: "clear hold and resume follow up"
output: {"state":"hold_cleared","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"","unmet_inventory_want":"none","want_is_satisfiable_from_note":false,"want_confidence":0.9,"return_visit":"none","return_day_text":"","return_visit_confidence":0.9,"desired_color":"","desired_color_confidence":0.9,"confidence":0.94}`,
  `EXAMPLE F
comment: "coming in tomorrow to finalize paperwork"
output: {"state":"deal_finalizing","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"tomorrow","unmet_inventory_want":"none","want_is_satisfiable_from_note":true,"want_confidence":0.9,"return_visit":"committed_day","return_day_text":"tomorrow","return_visit_confidence":0.9,"desired_color":"","desired_color_confidence":0.9,"confidence":0.93}`,
  `EXAMPLE G
comment: "Sean is looking for a 2026 Dark Billiard Gray Street Glide Limited, we need to order one for him. would like to get a commitment and put an order in for him."
output: {"state":"deal_finalizing","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"","unmet_inventory_want":"order","want_is_satisfiable_from_note":false,"want_confidence":0.93,"return_visit":"none","return_day_text":"","return_visit_confidence":0.9,"desired_color":"Dark Billiard Gray","desired_color_confidence":0.95,"confidence":0.9}`,
  `EXAMPLE H
comment: "going to credit union this week, waiting on approval"
output: {"state":"outside_financing_pending","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"this week","unmet_inventory_want":"none","want_is_satisfiable_from_note":true,"want_confidence":0.88,"return_visit":"none","return_day_text":"","return_visit_confidence":0.9,"desired_color":"","desired_color_confidence":0.9,"confidence":0.93}`,
  `EXAMPLE I
comment: "saving up for down payment, should be ready in a few weeks"
output: {"state":"down_payment_pending","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"few weeks","unmet_inventory_want":"none","want_is_satisfiable_from_note":true,"want_confidence":0.88,"return_visit":"none","return_day_text":"","return_visit_confidence":0.9,"desired_color":"","desired_color_confidence":0.9,"confidence":0.92}`,
  `EXAMPLE J
comment: "need to sell my bike first before moving forward"
output: {"state":"trade_equity_pending","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"","unmet_inventory_want":"none","want_is_satisfiable_from_note":false,"want_confidence":0.88,"return_visit":"none","return_day_text":"","return_visit_confidence":0.9,"desired_color":"","desired_color_confidence":0.9,"confidence":0.93}`,
  `EXAMPLE K
comment: "need to talk to my wife first"
output: {"state":"household_approval_pending","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"","unmet_inventory_want":"none","want_is_satisfiable_from_note":false,"want_confidence":0.88,"return_visit":"none","return_day_text":"","return_visit_confidence":0.9,"desired_color":"","desired_color_confidence":0.9,"confidence":0.93}`,
  `EXAMPLE L
comment: "picked out accessories and wants to go over final numbers this week"
output: {"state":"deal_finalizing","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"this week","unmet_inventory_want":"none","want_is_satisfiable_from_note":true,"want_confidence":0.88,"return_visit":"none","return_day_text":"","return_visit_confidence":0.9,"desired_color":"","desired_color_confidence":0.9,"confidence":0.9}`,
  `EXAMPLE M
comment: "looking for a 2026 Street Glide Limited in Dark Billiard Gray, please watch and let me know when one comes in"
output: {"state":"none","explicit_state":false,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"","unmet_inventory_want":"open_search","want_is_satisfiable_from_note":false,"want_confidence":0.96,"return_visit":"none","return_day_text":"","return_visit_confidence":0.9,"desired_color":"Dark Billiard Gray","desired_color_confidence":0.95,"confidence":0.78}`,
  `EXAMPLE N
comment: "Gary was a walk in and is buying 2026 Street Glide Limited. Trading in 2016 Ultra Limited and 2024 Pan Am Special. Had to discount bike to close deal. Plans on closing 4/24 (Step 6)"
output: {"state":"deal_finalizing","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"4/24","unmet_inventory_want":"none","want_is_satisfiable_from_note":true,"want_confidence":0.95,"return_visit":"committed_day","return_day_text":"4/24","return_visit_confidence":0.9,"desired_color":"","desired_color_confidence":0.9,"confidence":0.96}`,
  `EXAMPLE O
comment: "Thank for coming in and tell him it was nice working with him. I will be in touch about delivery and parts status. (Step 8)"
output: {"state":"deal_finalizing","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"","unmet_inventory_want":"none","want_is_satisfiable_from_note":true,"want_confidence":0.9,"return_visit":"none","return_day_text":"","return_visit_confidence":0.9,"desired_color":"","desired_color_confidence":0.9,"confidence":0.95}`,
  `EXAMPLE P
comment: "Stopped in, really liked the dark billiard and gray 2026 Street Glide. Would also like to watch for a 2024-2025 pre-owned street glide. Reach follow up on 5/23/26. (Step 2)"
output: {"state":"none","explicit_state":false,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"5/23/26","unmet_inventory_want":"open_search","want_is_satisfiable_from_note":false,"want_confidence":0.94,"return_visit":"none","return_day_text":"","return_visit_confidence":0.9,"desired_color":"Dark Billiard Gray","desired_color_confidence":0.85,"confidence":0.88}`,
  `EXAMPLE Q
comment: "Would like to take some time to go over finances. Going on a trip end of the month. Definitely interested in the bike."
output: {"state":"decision_pending","explicit_state":true,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"","unmet_inventory_want":"none","want_is_satisfiable_from_note":true,"want_confidence":0.85,"return_visit":"none","return_day_text":"","return_visit_confidence":0.9,"desired_color":"","desired_color_confidence":0.9,"confidence":0.9}`,
  `EXAMPLE R
comment: "Was in for the Back the Blue ride and was asking about pre-owned trikes. Showed him and his wife Kim the 2019 we have in the back (waiting on lien release). Is looking for 2017-2020 Tri Glide in the $25,000 range (Step 2)"
output: {"state":"none","explicit_state":false,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"","unmet_inventory_want":"open_search","want_is_satisfiable_from_note":false,"want_confidence":0.92,"return_visit":"none","return_day_text":"","return_visit_confidence":0.9,"desired_color":"","desired_color_confidence":0.95,"confidence":0.6}`,
  `EXAMPLE S
comment: "Wants to test ride 2026 Street Glide 3. Has 2019 Street Glide special for trade. (Step 2)"
output: {"state":"none","explicit_state":false,"test_ride_requested":true,"weather_sensitive":false,"follow_up_window_text":"","unmet_inventory_want":"none","want_is_satisfiable_from_note":true,"want_confidence":0.9,"return_visit":"none","return_day_text":"","return_visit_confidence":0.9,"desired_color":"","desired_color_confidence":0.9,"confidence":0.6}`,
  `EXAMPLE T
comment: "Wants to see the 2026 Street Glide in Teal Thunder / Vivid Black with chrome trim. Should be delivered 7/22 (Step 6)"
output: {"state":"none","explicit_state":false,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"","unmet_inventory_want":"incoming_allocated","want_is_satisfiable_from_note":true,"want_confidence":0.93,"return_visit":"none","return_day_text":"","return_visit_confidence":0.9,"desired_color":"Teal Thunder","desired_color_confidence":0.85,"confidence":0.6}`,
  `EXAMPLE U
comment: "Interested in the 2023 120th Anniversary Road Glide Special. Wants us to call him when we get it through service (Step 2)"
output: {"state":"none","explicit_state":false,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"","unmet_inventory_want":"specific_unit","want_is_satisfiable_from_note":true,"want_confidence":0.92,"return_visit":"none","return_day_text":"","return_visit_confidence":0.9,"desired_color":"","desired_color_confidence":0.9,"confidence":0.6}`,
  `EXAMPLE V
comment: "Looking for trike models. Was going to wait until spring of 2027 but saw the 2019 we had in back. Wants to take a test ride on new and pre-owned (Step 2)"
output: {"state":"none","explicit_state":false,"test_ride_requested":true,"weather_sensitive":false,"follow_up_window_text":"","unmet_inventory_want":"open_search","want_is_satisfiable_from_note":false,"want_confidence":0.8,"return_visit":"none","return_day_text":"","return_visit_confidence":0.9,"desired_color":"","desired_color_confidence":0.9,"confidence":0.6}`,
  // W-Y teach the return-visit lanes off real production notes. W is the Ed Szulist turn this slot
  // was built for; X is the dateless version of the same intent; Y is the trap — a date that is
  // OURS. (P "Reach follow up on 5/23/26" and T "Should be delivered 7/22" are the other two
  // our-date shapes, already in this corpus and now annotated none.)
  `EXAMPLE W
comment: "COMING BACK NXT WEEK TUESDAY AUGUST 4TH TO TEST RIDE A FEW DIFFERENT SPORTSTERS (Step 5)"
output: {"state":"none","explicit_state":false,"test_ride_requested":true,"weather_sensitive":false,"follow_up_window_text":"","unmet_inventory_want":"none","want_is_satisfiable_from_note":true,"want_confidence":0.7,"return_visit":"committed_day","return_day_text":"Tuesday August 4th","return_visit_confidence":0.95,"desired_color":"","desired_color_confidence":0.9,"confidence":0.6}`,
  `EXAMPLE X
comment: "Showed him the pre-owned wall. Says he will stop in to check them out (Step 2)"
output: {"state":"none","explicit_state":false,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"","unmet_inventory_want":"none","want_is_satisfiable_from_note":true,"want_confidence":0.7,"return_visit":"tentative","return_day_text":"","return_visit_confidence":0.9,"desired_color":"","desired_color_confidence":0.9,"confidence":0.6}`,
  // Z is the reported production turn (Rick Williamson Sr. +17168609581, TLP ref 11728): the ride's
  // NAME carries a colour word and the bike has none. Kept last so the negative is the freshest
  // thing the model reads before the note it must classify.
  `EXAMPLE Y
comment: "Ordered his 2026 Road Glide, projected ship date is 7/29 (Step 2)"
output: {"state":"none","explicit_state":false,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"","unmet_inventory_want":"order","want_is_satisfiable_from_note":false,"want_confidence":0.9,"return_visit":"none","return_day_text":"","return_visit_confidence":0.95,"desired_color":"","desired_color_confidence":0.9,"confidence":0.6}`,
  `EXAMPLE Z
comment: "Rick was on for the back the blue ride and was asking about pricing on Road Glide 3. Needs follow up (Step 2)"
output: {"state":"none","explicit_state":false,"test_ride_requested":false,"weather_sensitive":false,"follow_up_window_text":"","unmet_inventory_want":"none","want_is_satisfiable_from_note":true,"want_confidence":0.85,"return_visit":"none","return_day_text":"","return_visit_confidence":0.9,"desired_color":"","desired_color_confidence":0.95,"confidence":0.6}`
];

/**
 * The full walk-in outcome prompt. Lifted out of llmDraft.ts (which sits at its size ceiling)
 * so the prompt surface is editable on its own, the same move `inboundReplyActionPrompt.ts` and
 * `conversationStateParserPrompt.ts` already made.
 */
export function buildWalkInOutcomePrompt(args: {
  text: string;
  historyLines: string[];
  leadModel?: string | null;
  leadYear?: string | number | null;
  leadSource?: string | null;
}): string {
  const history = args.historyLines ?? [];
  return [
    "You parse walk-in salesperson comments from dealership ADF leads.",
    "Return only JSON that matches the schema.",
    "",
    "Choose exactly one primary state:",
    "- deal_finalizing: finalizing paperwork/deal soon but not explicitly sold yet.",
    "- deposit_left: left/placed/took deposit.",
    "- sold_delivered: sold, delivered, or picked up.",
    "- hold_requested: explicitly asks to mark/set/put lead on hold.",
    "- hold_cleared: explicitly asks to clear/release hold or resume.",
    "- cosigner_required: needs co-signer / credit app waiting for co-signer.",
    "- test_ride_completed: customer already took/completed test ride.",
    "- decision_pending: thinking it over / not ready / will let us know.",
    "- outside_financing_pending: waiting on credit union or bank financing.",
    "- down_payment_pending: saving/waiting for down payment.",
    "- trade_equity_pending: needs to sell bike first / waiting trade value / upside down.",
    "- timing_defer_window: defer with broad window (after winter/next month/after taxes/bonus).",
    "- household_approval_pending: needs spouse/partner approval.",
    "- docs_or_insurance_pending: waiting on title/docs/registration/insurance quote/DMV.",
    "- none: no clear state.",
    "",
    "Additional fields:",
    "- explicit_state=true only when state is clearly stated.",
    "- test_ride_requested=true when they want to schedule/line up a test ride (even if not immediate).",
    "- weather_sensitive=true when timing depends on weather being nicer/warmer.",
    "- follow_up_window_text: short raw window phrase like 'next week' or 'after winter'; empty string if none.",
    "- confidence is 0..1.",
    "",
    "Rules:",
    "- If both sold/delivered and another pending state appear, prefer sold_delivered.",
    "- If deposit and pending state both appear, prefer deposit_left.",
    "- If finalizing language appears without explicit sold/delivered, choose deal_finalizing.",
    "- Phrases like 'left $X deposit' and high pipeline notes such as '(step 6)' usually indicate deposit_left unless sold/delivered is explicit.",
    "- Do not set follow_up_window_text for incidental customer availability/travel timing (for example 'going on a trip end of month') unless the note explicitly asks to call, text, reach out, or follow up at that time.",
    "- If uncertain, return state=none, explicit_state=false, low confidence.",
    "",
    // The inventory-want question is deliberately separate from `state`: a note can be
    // state=none and still describe a real unmet want (Larry), or state=deal_finalizing and
    // carry an order (Sean). Answering them together is what made the old gate wrong.
    "SEPARATELY, classify the customer's INVENTORY WANT as recorded in this note. This is not",
    "about whether the customer ASKED to be notified — a salesperson's log almost never says that.",
    "It is about whether the note describes a bike we cannot hand them today.",
    "- unmet_inventory_want=open_search: they want a bike we do not have and have not promised —",
    "  a model, a year range, a condition, a budget. THE ONLY lane that can start a watch.",
    "- unmet_inventory_want=specific_unit: they want ONE identified bike of ours (in service, being",
    "  prepped, on hold, needs a callback when ready). We know the unit; nothing to search for.",
    "- unmet_inventory_want=order: we are placing or discussing a factory order for them.",
    "- unmet_inventory_want=incoming_allocated: the bike is already allocated/incoming, often dated.",
    "- unmet_inventory_want=none: no want, or the want is a bike they are already buying or can",
    "  ride today.",
    "- want_is_satisfiable_from_note=true when the note itself says the exact bike they want is",
    "  ours to sell or show them right now. A unit we cannot deliver yet — waiting on a lien",
    "  release or title, still in service, not yet arrived — is NOT satisfiable.",
    "- want_confidence is 0..1 for the want classification only, independent of `confidence`.",
    "- When the note names a specific in-stock bike AND a broader search, the broader search wins:",
    "  open_search. When you are unsure which lane, answer none — a wrong watch becomes an",
    "  unsolicited text weeks later, which is worse than no watch.",
    "",
    // A day the CUSTOMER commits to walking in on is a different question from follow_up_window_text
    // (when WE reach out) and from the shipping/delivery dates that fill these notes. Ed Szulist
    // +17167255404: the note named the day and the reply never mentioned it.
    "SEPARATELY AGAIN, classify the customer's RETURN VISIT — is the customer coming back in, and",
    "did the note name when? This is about THEIR visit, never about our own schedule.",
    "- return_visit=committed_day: the note says they are coming back and names a day or date, and",
    "  no specific time of day is settled yet.",
    "- return_visit=committed_day_and_time: they are coming back and BOTH the day and a time are",
    "  already settled ('coming in 4/6 at 4:00pm').",
    "- return_visit=tentative: they said they would be back but named no day.",
    "- return_visit=none: no return commitment at all.",
    "- return_day_text: the day phrase EXACTLY as the note wrote it ('Tuesday August 4th', '4/24',",
    "  'tomorrow'); empty string when there is none. Never invent or reformat a date.",
    "- return_visit_confidence is 0..1 for this classification only, independent of `confidence`.",
    "- A date that is OURS is return_visit=none: a projected ship date, a spot delivery, when a unit",
    "  lands, or a day WE said we would reach out. Only a day the CUSTOMER is walking in on counts.",
    "- A day they are coming in on belongs in return_day_text, never in follow_up_window_text.",
    "- If you are unsure whether the day is theirs or ours, answer none. Overreading it means asking",
    "  a customer to confirm a visit they never promised.",
    "",
    // A colour word in a staff note is usually not paint. Rick Williamson Sr. +17168609581: "was on
    // for the back the blue ride" made the lead blue, the colour match against three in-stock Road
    // Glide 3s failed, and we told him we would "keep an eye out" for a bike we had three of.
    "SEPARATELY AGAIN, extract the PAINT COLOUR the customer wants on the BIKE, if the note states",
    "one. This is the colour of the motorcycle, never anything else a colour word can name.",
    "- desired_color: the colour or finish exactly as the note wrote it ('Dark Billiard Gray',",
    "  'Vivid Black', 'Teal Thunder'); empty string when the note states no bike colour.",
    "- An EVENT, RIDE, CHAPTER, CHARITY or GROUP NAME that contains a colour word is NOT a paint",
    "  colour: 'the Back the Blue ride', 'Blue Knights', 'Redline ride', 'Black Sheep HOG chapter'.",
    "  Those name something the customer ATTENDED or belongs to. Answer empty string.",
    "- A colour naming a place, a person, a trade-in the customer is leaving, or anything other than",
    "  the bike they want is also empty string.",
    "- desired_color_confidence is 0..1 for this extraction only, independent of `confidence`. Be",
    "  CONFIDENT when you are sure the note states no bike colour — that is a real answer, and it is",
    "  what stops an event name becoming paint.",
    "- When you genuinely cannot tell whether a colour word describes the bike, answer empty string",
    "  with LOW confidence. A colour we invent narrows our inventory to nothing and arms a watch for",
    "  a bike that will never arrive.",
    "",
    ...WALK_IN_OUTCOME_EXAMPLES,
    "",
    `Known lead info: ${JSON.stringify({
      model: args.leadModel ?? null,
      year: args.leadYear ?? null,
      source: args.leadSource ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Comment: ${args.text}`
  ].join("\n");
}
