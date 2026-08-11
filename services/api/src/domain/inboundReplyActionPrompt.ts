import type { InboundReplyActionParse } from "./llmDraft.js";
import { recordParserFallbackAudit } from "./parserFallbackAudit.js";
import { hasInventoryWatchConfirmationText } from "./workflowRegressionGuards.js";
// ---------------------------------------------------------------------------
// Inbound-reply-action parser prompt surface: the strict JSON schema + the
// few-shot corpus for parseInboundReplyActionWithLLM (llmDraft.ts).
//
// Extracted from llmDraft.ts verbatim (behavior-preserving move) so the prompt
// the de-tangle program keeps editing lives in a file a human can read, and so
// llmDraft.ts pays for its own growth under source_size_ratchet:eval.
// ---------------------------------------------------------------------------
export const INBOUND_REPLY_ACTION_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: [
    "action",
    "explicit_action",
    "should_reply",
    "normalized_text",
    "reason",
    "scheduling_conflict_open",
    "visit_not_possible",
    "confidence"
  ],
  properties: {
    action: {
      type: "string",
      enum: [
        "dealer_location_question",
        "explicit_callback_request",
        "schedule_context_status_update",
        "inventory_watch_acknowledgement",
        "pending_incoming_inventory_acknowledgement",
        "customer_shared_vehicle_photo",
        "customer_reservation_request",
        "none"
      ]
    },
    explicit_action: { type: "boolean" },
    should_reply: { type: "boolean" },
    normalized_text: { type: "string" },
    reason: { type: "string" },
    // A SLOT, not an `action` member (same precedent as sell_to_dealer_interest on the
    // customer-disposition parser): it must be able to co-occur with whatever action owns
    // the turn, and an enum member would let it STEAL turns from dealer_location_question /
    // explicit_callback_request. See the "Scheduling conflict" rule in the prompt.
    scheduling_conflict_open: { type: "boolean" },
    // The THIRD reading of "we invited them in and they answered". Its two siblings already exist
    // and this one only makes sense against them:
    //   scheduling_conflict_open — can't make THAT time, still coming. The visit is ON.
    //   a closing disposition     — they are out entirely. Owned by the disposition parser.
    //   visit_not_possible        — still interested, but coming in is not the path for them.
    // A SLOT for the same reason as its sibling: it must co-occur with whatever action owns the
    // turn, and it must never STEAL a turn from an action. It exists so a pre-qualification lead
    // who cannot come to the store is offered the credit application instead of being invited a
    // third time (Joe, 2026-08-11).
    visit_not_possible: { type: "boolean" },
    confidence: { type: "number" }
  }
};

export const INBOUND_REPLY_ACTION_EXAMPLES: string[] = [
    // The three misses from Mike Ganley (+15853075478, 2026-08-05): one lead, three different
    // messages, and the SAME "We're located at 1149 Erie Ave…" draft on all three. The parser
    // understood every turn correctly and still filed each under dealer_location_question — its
    // own reason on the third literally said the customer was answering "the dealer's request for
    // town". `none` hands the turn back to the normal path, which already read the first as
    // availability at 0.92.
    `EXAMPLE ON-LOCATION-1
inbound: "Is the bike on location?"
history: "out: Mike, here is the quote on the billiard gray with black trim road glide."
output: {"action":"none","explicit_action":false,"should_reply":true,"normalized_text":"customer asks whether the quoted bike is physically at the store","reason":"Asking if the BIKE is on location is an availability question about the unit, not a request for our address.","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.95}`,
    `EXAMPLE ON-LOCATION-2
inbound: "Is there a similar bike on location? I could at least look at today before that one get shipped"
history: "out: I just checked, this is an incoming order with a estimated ship date of 8/28"
output: {"action":"none","explicit_action":false,"should_reply":true,"normalized_text":"customer asks whether a similar bike is at the store to look at today","reason":"Availability of a comparable unit on the lot, not a request for the dealership address.","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.95}`,
    `EXAMPLE ADDRESS-SUPPLIED
inbound: "5 Timberlake Dr. orchard Park, NY 14127"
history: "out: Mike, I am putting your name on the order right now and just need to add your info. What town/zip code are you?"
output: {"action":"none","explicit_action":false,"should_reply":true,"normalized_text":"customer provides their address in reply to our request for it","reason":"The customer is ANSWERING our request for their town/zip. Supplying an address is not asking where we are located.","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.96}`,
    `EXAMPLE A
inbound: "Hey, can you give me a call?"
history: "out: What day and time works best to stop in?"
output: {"action":"explicit_callback_request","explicit_action":true,"should_reply":true,"normalized_text":"customer requests a phone call","reason":"The customer explicitly asks for a call, so callback routing owns the turn even if prior context was scheduling.","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.97}`,
    `EXAMPLE B
inbound: "This is Darwin returning your call."
history: "out: I just tried to call you."
output: {"action":"none","explicit_action":false,"should_reply":false,"normalized_text":"","reason":"The customer reports they are returning a call but does not ask for a future callback.","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.94}`,
    `EXAMPLE C
inbound: "I cant not currently and remind me again what address is this at?"
history: "out: You can stop by when it works for you."
output: {"action":"dealer_location_question","explicit_action":true,"should_reply":true,"normalized_text":"customer asks for the dealership address","reason":"The customer asks what address the dealership is at; location question outranks reminder/follow-up handling.","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.98}`,
    `EXAMPLE D
inbound: "What email address should I send it to?"
history: "out: Please send over your insurance card."
output: {"action":"none","explicit_action":true,"should_reply":true,"normalized_text":"","reason":"This asks for an email address, not the dealership physical address/location.","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.92}`,
    `EXAMPLE E
inbound: "Yeah I am"
history: "out: Are you still planning to stop by Saturday?"
output: {"action":"schedule_context_status_update","explicit_action":true,"should_reply":true,"normalized_text":"customer confirms the visit plan is still active","reason":"Recent outbound asked about a visit plan and the customer provides a status confirmation, so ask for the missing day/time detail instead of generic routing.","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.93}`,
    `EXAMPLE F
inbound: "Sorry just saw this"
history: "out: What time Saturday works best?"
output: {"action":"schedule_context_status_update","explicit_action":true,"should_reply":true,"normalized_text":"customer acknowledges delayed scheduling turn","reason":"The recent outbound was a scheduling question and the customer gives a scheduling-context status update without another ask.","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.91}`,
    `EXAMPLE G
inbound: "Sorry just saw this — what address is this at?"
history: "out: What time Saturday works best?"
output: {"action":"dealer_location_question","explicit_action":true,"should_reply":true,"normalized_text":"customer asks for dealership address","reason":"A concrete location question in the latest turn outranks the schedule-status acknowledgement.","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.97}`,
    `EXAMPLE H
inbound: "I have no problem. let me know if you find something"
history: "out: I'm not seeing an Iron 883 right now, but I can keep an eye out."
output: {"action":"inventory_watch_acknowledgement","explicit_action":true,"should_reply":true,"normalized_text":"customer asks us to keep watching inventory","reason":"The customer accepts or confirms the active inventory watch after an out-of-stock/watch prompt.","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.96}`,
    `EXAMPLE I
inbound: "If you dont mind keeping an eye out cause it either the iron 883 or a Fat Boy im looking for a breakout"
history: "out: I'm not seeing an Iron 883 in stock right now."
output: {"action":"inventory_watch_acknowledgement","explicit_action":true,"should_reply":true,"normalized_text":"customer asks us to keep watching inventory options","reason":"The customer explicitly asks us to keep an eye out after inventory-watch/out-of-stock context.","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.97}`,
    `EXAMPLE J
inbound: "Let me know if any sales jobs open up."
history: "out: Let me know if you want pricing on the Street Glide."
output: {"action":"none","explicit_action":true,"should_reply":true,"normalized_text":"","reason":"This is not an inventory-watch acknowledgement for the active vehicle workflow.","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.9}`,
    `EXAMPLE K
inbound: "Not sure where this is located or what s the cost, but I m located in New York, NY. Thank you!"
history: "out: Thanks for booking a test ride on the Breakout."
output: {"action":"dealer_location_question","explicit_action":true,"should_reply":true,"normalized_text":"customer asks where the dealership or bike is located and also asks cost","reason":"The latest turn asks where this is located; location/address handling outranks source-forced test-ride scheduling while pricing can be handled as a follow-up.","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.97}`,
    `EXAMPLE L
inbound: "Thats what Im looking for. Definitely hit me up if one comes in or another store has one"
history: "out: I’m not seeing a 2022 Low Rider El Diablo in stock right now. I can check similar options, or I can keep an eye out and text you if one comes in."
output: {"action":"inventory_watch_acknowledgement","explicit_action":true,"should_reply":true,"normalized_text":"customer asks us to text them if one comes in","reason":"The customer explicitly accepts the out-of-stock watch offer and asks to be notified when a match comes in.","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.97}`,
    `EXAMPLE M
inbound: "Yes, let me know when it's available. Thank you"
history: "out: Here are pictures of the 2016 Freewheeler we are taking in on trade."
output: {"action":"pending_incoming_inventory_acknowledgement","explicit_action":true,"should_reply":true,"normalized_text":"customer asks to be notified when the known incoming trade is available","reason":"The customer is not asking us to watch open inventory; they are confirming notification for a specific known trade that is not here yet.","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.97}`,
    `EXAMPLE N
inbound: "Ok keep me posted once the trade gets here"
history: "out: This one is not in yet, but we should have it after the trade comes in."
output: {"action":"pending_incoming_inventory_acknowledgement","explicit_action":true,"should_reply":true,"normalized_text":"customer asks for an update once the incoming trade arrives","reason":"The turn is tied to a known pending trade arrival, not a generic inventory watch.","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.96}`,
    `EXAMPLE O
inbound: "Interested in the 2023 120th Anniversary Road Glide Special. Wants us to call him when we get it through service (Step 2)"
history: "out: Thanks for stopping in today."
output: {"action":"explicit_callback_request","explicit_action":true,"should_reply":true,"normalized_text":"customer wants a callback once the bike is through service","reason":"The latest turn contains an explicit callback/status request, so callback routing owns the turn instead of a generic walk-in recap.","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.97}`,
    `EXAMPLE P
inbound: "Here is a photo of the HD I like."
history: "in: Hi scott I hope you're doing well."
output: {"action":"customer_shared_vehicle_photo","explicit_action":true,"should_reply":true,"normalized_text":"customer shared a photo of a bike they like and wants it matched","reason":"The customer is sharing a vehicle photo as a buying signal; photo-match routing owns the turn instead of small talk or discovery questions.","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.97}`,
    `EXAMPLE Q
inbound: "Can you send me pictures of the Road Glide?"
history: "out: We have a couple Road Glides on the floor."
output: {"action":"none","explicit_action":false,"should_reply":true,"normalized_text":"","reason":"The customer is asking us to send photos, not sharing one; the media-request flow owns this turn.","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.95}`,
    `EXAMPLE R
inbound: "Ok I will be there for the taste of country pre party on Saturday 👍"
history: "out: We've got a couple Road Glides ready to ride — want to swing in and take one out?"
output: {"action":"schedule_context_status_update","explicit_action":true,"should_reply":true,"normalized_text":"customer commits to coming in Saturday for an event","reason":"After a scheduling/visit thread the customer commits to a concrete future day to come in (for an event); confirm the committed day rather than reading it as an en-route arrival window.","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.95}`,
    `EXAMPLE S
inbound: "What do I have to do to reserve one"
history: "in: I know it's a limited run and I would like to reserve one\nout: sorry, we don't have the 2026 Superglide in stock right now."
output: {"action":"customer_reservation_request","explicit_action":true,"should_reply":true,"normalized_text":"customer wants to reserve/pre-order a limited-run unit and is asking how","reason":"The customer wants to RESERVE a unit (limited run), a high-intent buy signal. This is NOT an inventory watch/notify-when-it-arrives; reservation handoff owns the turn.","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.97}`,
    `EXAMPLE T
inbound: "Can you let me know if one comes in?"
history: "out: We don't have that one in stock right now."
output: {"action":"inventory_watch_acknowledgement","explicit_action":true,"should_reply":true,"normalized_text":"customer asks to be notified if one comes in","reason":"Asking to be NOTIFIED when one arrives is an inventory watch, not a reservation/pre-order. Reserve = wants to put one aside now; watch = tell me when it shows up.","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.95}`,
    `EXAMPLE U
inbound: "I'm definitely interested. I should have the money and be in the position to pull the trigger on it by the end of next week. I appreciate your guys time and working with me. I'll be getting back ahold of you then, if you still have one available."
history: "out: The 2026 Street Bob is a limited solo trim run — they move fast.\nout: Hey Kody - just following up with you about the 2026 Street Bob. What are your thoughts?"
output: {"action":"none","explicit_action":false,"should_reply":true,"normalized_text":"","reason":"A FUTURE/deferred purchase commitment with an 'I'll circle back next week' is NOT a reservation request. The customer is not asking us to put a specific unit aside/hold it now — they'll have the money later and will reach back out. Limited-run context alone does not turn a deferred purchase into a reservation. Leave it to the normal router (warm ack + follow-up around their stated timeframe).","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.92}`,
    // EXAMPLE V is the production turn this slot exists for: William Indelicato
    // +17163591526, msg_2e66f70720313_1784929050013 (2026-07-24). Scott was negotiating a
    // service-visit day; "Unsure I have to have injections into my shoulder" was read as
    // stepping_back and CLOSED the lead + paused follow-up indefinitely 11 seconds later.
    `EXAMPLE V
inbound: "Unsure I have to have injections into my shoulder"
history: "out: Can you get here first thing in the morning on Wednesday?\nin: I can try I have an appointment at 9a on Wednesday\nout: What time do you think you can be here on Wednesday?"
output: {"action":"none","explicit_action":false,"should_reply":true,"normalized_text":"customer cannot commit to the proposed Wednesday time because of a conflicting medical appointment, but has not withdrawn","reason":"We asked for a time; the customer answers with UNCERTAINTY plus a conflicting obligation. They never withdrew — this is an open scheduling negotiation, NOT stepping back or a closeout. Keep the visit alive and offer to work around them.","scheduling_conflict_open":true,"visit_not_possible":false,"confidence":0.95}`,
    // EXAMPLE W — the same SHAPE with no medical words, so the lesson generalizes off the
    // structure (our proposed time + uncertainty + conflict + still willing) rather than
    // being memorized off "injections"/"shoulder".
    `EXAMPLE W
inbound: "not sure yet, my kid has a game that afternoon"
history: "out: Does Thursday around 2 work to come take a look?"
output: {"action":"none","explicit_action":false,"should_reply":true,"normalized_text":"customer is unsure about the proposed Thursday time because of a family conflict","reason":"A conflicting obligation against OUR proposed time with no day/time offered back and no withdrawal. Scheduling stays open; do not close or taper.","scheduling_conflict_open":true,"visit_not_possible":false,"confidence":0.93}`,
    // visit_not_possible (Joe, 2026-08-11): a pre-qualification lead who cannot come to the store
    // should be handed the credit application, not invited in a third time. These four teach the
    // slot against its neighbours, because every one of them is "we asked them in and they replied"
    // and only the FIRST is this slot. X and Y are a deliberate contrast pair: same distance, same
    // warmth, opposite answers — the difference is whether they intend to come.
    `EXAMPLE X
inbound: "I'm down in Florida for the winter, no way I can get to the shop. Can we do it all online?"
history: "out: Want to swing by this week and we'll go through the numbers?"
output: {"action":"none","explicit_action":false,"should_reply":true,"normalized_text":"customer cannot come to the store and asks to handle it remotely","reason":"Still interested and proposing a remote path — coming in is not going to happen for them. Not a withdrawal, and not a conflict with one proposed time.","scheduling_conflict_open":false,"visit_not_possible":true,"confidence":0.95}`,
    `EXAMPLE Y
inbound: "I'm about two hours out but I could make the drive. What days are you open till 6?"
history: "out: Want to swing by this week and we'll go through the numbers?"
output: {"action":"none","explicit_action":true,"should_reply":true,"normalized_text":"customer asks which days are open late so they can drive in","reason":"Distance alone is not an obstacle — they are asking how to GET here, so the visit is on. visit_not_possible is about intent, never about mileage.","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.94}`,
    `EXAMPLE Z
inbound: "I don't have a way to get out there honestly. Is there something I can fill out from my phone?"
history: "out: Come see it Saturday and we'll get you approved while you're here."
output: {"action":"none","explicit_action":true,"should_reply":true,"normalized_text":"customer has no transport to the store and asks for something to complete on their phone","reason":"They are asking to keep going without coming in, which is exactly this slot. Do not read a transport problem as a hardship or a withdrawal.","scheduling_conflict_open":false,"visit_not_possible":true,"confidence":0.96}`,
    `EXAMPLE Z2
inbound: "Nah I'm all set, I ended up buying one last weekend."
history: "out: Want to swing by this week and we'll go through the numbers?"
output: {"action":"none","explicit_action":true,"should_reply":true,"normalized_text":"customer bought elsewhere and is withdrawing","reason":"A withdrawal is a DISPOSITION and its own parser owns it. This slot must never be the thing that closes a lead, so it stays false.","scheduling_conflict_open":false,"visit_not_possible":false,"confidence":0.97}`
];

// ---------------------------------------------------------------------------
// ACCEPTANCE HELPERS for parseInboundReplyActionWithLLM — the confidence floor and the
// per-slot readers every caller shares. Moved here from index.ts (behavior-preserving)
// alongside the scheduling_conflict_open slot they now gate: the parser prompt, its schema,
// and the rules for trusting its output belong in one module.
// ---------------------------------------------------------------------------
export function inboundReplyActionConfidence(parsed: InboundReplyActionParse | null): number {
  return typeof parsed?.confidence === "number" && Number.isFinite(parsed.confidence)
    ? parsed.confidence
    : 0;
}

export function inboundReplyActionConfidenceMin(): number {
  return Number(process.env.LLM_INBOUND_REPLY_ACTION_CONFIDENCE_MIN ?? 0.74);
}

export function isInboundReplyActionParserAccepted(parsed: InboundReplyActionParse | null): boolean {
  if (!parsed || parsed.action === "none" || !parsed.explicitAction) return false;
  return inboundReplyActionConfidence(parsed) >= inboundReplyActionConfidenceMin();
}

export function isAcceptedInboundReplyAction(
  parsed: InboundReplyActionParse | null,
  action: Exclude<InboundReplyActionParse["action"], "none">
): boolean {
  return isInboundReplyActionParserAccepted(parsed) && parsed?.action === action;
}

// OPEN SCHEDULING CONFLICT (William Indelicato +17163591526, 2026-07-24) — read off the
// scheduling_conflict_open SLOT, not the action enum, so it can co-occur with whichever action
// won the turn. Same acceptance floor as the action arms. Shared by both reply paths.
export function isSchedulingConflictStillOpen(parsed: InboundReplyActionParse | null): boolean {
  return isInboundReplyActionParserAccepted(parsed) && !!parsed?.schedulingConflictOpen;
}

export function canUseInboundReplyActionFallback(args: {
  parserEligible: boolean;
  parsed: InboundReplyActionParse | null;
}): boolean {
  return classifyInboundReplyActionFallback(args).allowed;
}

/**
 * WHY the keyword fallback was allowed — the same three branches
 * `canUseInboundReplyActionFallback` always had, now named instead of collapsed into one boolean.
 * Pure; it is the audited wrapper below that writes anything down.
 *
 * `hedged_below_floor` is the branch that matters. AGENTS.md "Fallback-vs-Parser Precedence" says a
 * fallback may only fill a gap when there is NO reading at all — "including a hedged one below the
 * accept floor... a hedged reading of the sentence beats a keyword that never read it." This branch
 * is the code doing the opposite of that rule, and until now nothing counted it.
 */
export type InboundReplyActionFallbackReason =
  | "parser_disabled"
  | "no_parse"
  | "hedged_below_floor"
  | "reading_at_or_above_floor";

export type InboundReplyActionFallbackGate = {
  allowed: boolean;
  reason: InboundReplyActionFallbackReason;
  confidence: number | null;
  floor: number;
  action: string | null;
  explicitAction: boolean | null;
};

export function classifyInboundReplyActionFallback(args: {
  parserEligible: boolean;
  parsed: InboundReplyActionParse | null;
}): InboundReplyActionFallbackGate {
  const floor = inboundReplyActionConfidenceMin();
  const base = {
    floor,
    action: args.parsed ? String(args.parsed.action ?? "") || null : null,
    explicitAction: args.parsed ? !!args.parsed.explicitAction : null,
    confidence: args.parsed ? inboundReplyActionConfidence(args.parsed) : null
  };
  if (!args.parserEligible) return { ...base, allowed: true, reason: "parser_disabled" };
  if (!args.parsed) return { ...base, allowed: true, reason: "no_parse" };
  return inboundReplyActionConfidence(args.parsed) < floor
    ? { ...base, allowed: true, reason: "hedged_below_floor" }
    : { ...base, allowed: false, reason: "reading_at_or_above_floor" };
}

/**
 * The gate, plus a durable record of what it decided. **Returns exactly what the pure gate returns**
 * — this is an instrument, not a behaviour change, and `decision_equivalence` proves it.
 *
 * `keywordWatchConfirmation` is what ONE of the eleven flag-gated keyword predicates would have
 * said about this turn. `hasInventoryWatchConfirmationText` was chosen because it sits on the
 * side-effecting path (it can create an inventory watch, which texts the customer later), and
 * because it lives in a domain module — `isWatchConfirmationIntentText`, its sibling, is still
 * inside index.ts and importing it would mean moving code, which an instrument has no business
 * doing. So `disagreesWithKeyword` is a FLOOR on the real disagreement rate, never the whole of it;
 * say so when the numbers are read.
 */
export function auditInboundReplyActionFallbackGate(args: {
  lane: "live" | "regen";
  parserEligible: boolean;
  parsed: InboundReplyActionParse | null;
  text?: string | null;
  convId?: string | null;
  messageId?: string | null;
}): boolean {
  const gate = classifyInboundReplyActionFallback(args);
  const keywordWatchConfirmation = hasInventoryWatchConfirmationText(args.text ?? "");
  recordParserFallbackAudit({
    kind: "inbound_reply_action_fallback_gate",
    lane: args.lane,
    allowed: gate.allowed,
    reason: gate.reason,
    confidence: gate.confidence,
    floor: gate.floor,
    action: gate.action,
    explicitAction: gate.explicitAction,
    keywordWatchConfirmation,
    // The question this instrument exists to answer: the parser DID read the turn, its reading was
    // hedged, and a keyword that never read it is now allowed to speak — and wants to.
    disagreesWithKeyword: gate.reason === "hedged_below_floor" && keywordWatchConfirmation,
    convId: args.convId ?? null,
    messageId: args.messageId ?? null
  });
  return gate.allowed;
}

/**
 * Prompt rules for the `visit_not_possible` slot (Joe, 2026-08-11). They live here, not in
 * llmDraft.ts, because llmDraft pays for its own growth under source_size_ratchet:eval and this
 * module exists to hold exactly this surface.
 */
export const INBOUND_REPLY_ACTION_VISIT_NOT_POSSIBLE_RULES: string[] = [
    "Coming in is not the path (visit_not_possible):",
    "- visit_not_possible = true when the customer is STILL INTERESTED but tells us that coming to the store is not going to happen for them — they live too far, they have no way to get here, they are out of state, they cannot get away from work, or they would rather handle it online/over the phone. They want to keep going; they just do not want to do it in person.",
    "- visit_not_possible = false when they simply cannot make THAT time but still intend to come — that is scheduling_conflict_open, and the visit is still on.",
    "- visit_not_possible = false when they are WITHDRAWING (\"I'll pass\", \"not interested\", \"bought elsewhere\"). That is a disposition and another parser owns it. Do not use this slot to close a lead.",
    "- visit_not_possible = false when we never invited them in, and false when they name a day or time back.",
    "- Distance alone is not enough: someone 90 miles away who asks what day works IS coming. Read what they intend, not how far away they live.",
    ""
];
