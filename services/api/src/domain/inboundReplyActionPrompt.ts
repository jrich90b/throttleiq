import type { InboundReplyActionParse } from "./llmDraft.js";
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
    confidence: { type: "number" }
  }
};

export const INBOUND_REPLY_ACTION_EXAMPLES: string[] = [
    `EXAMPLE A
inbound: "Hey, can you give me a call?"
history: "out: What day and time works best to stop in?"
output: {"action":"explicit_callback_request","explicit_action":true,"should_reply":true,"normalized_text":"customer requests a phone call","reason":"The customer explicitly asks for a call, so callback routing owns the turn even if prior context was scheduling.","scheduling_conflict_open":false,"confidence":0.97}`,
    `EXAMPLE B
inbound: "This is Darwin returning your call."
history: "out: I just tried to call you."
output: {"action":"none","explicit_action":false,"should_reply":false,"normalized_text":"","reason":"The customer reports they are returning a call but does not ask for a future callback.","scheduling_conflict_open":false,"confidence":0.94}`,
    `EXAMPLE C
inbound: "I cant not currently and remind me again what address is this at?"
history: "out: You can stop by when it works for you."
output: {"action":"dealer_location_question","explicit_action":true,"should_reply":true,"normalized_text":"customer asks for the dealership address","reason":"The customer asks what address the dealership is at; location question outranks reminder/follow-up handling.","scheduling_conflict_open":false,"confidence":0.98}`,
    `EXAMPLE D
inbound: "What email address should I send it to?"
history: "out: Please send over your insurance card."
output: {"action":"none","explicit_action":true,"should_reply":true,"normalized_text":"","reason":"This asks for an email address, not the dealership physical address/location.","scheduling_conflict_open":false,"confidence":0.92}`,
    `EXAMPLE E
inbound: "Yeah I am"
history: "out: Are you still planning to stop by Saturday?"
output: {"action":"schedule_context_status_update","explicit_action":true,"should_reply":true,"normalized_text":"customer confirms the visit plan is still active","reason":"Recent outbound asked about a visit plan and the customer provides a status confirmation, so ask for the missing day/time detail instead of generic routing.","scheduling_conflict_open":false,"confidence":0.93}`,
    `EXAMPLE F
inbound: "Sorry just saw this"
history: "out: What time Saturday works best?"
output: {"action":"schedule_context_status_update","explicit_action":true,"should_reply":true,"normalized_text":"customer acknowledges delayed scheduling turn","reason":"The recent outbound was a scheduling question and the customer gives a scheduling-context status update without another ask.","scheduling_conflict_open":false,"confidence":0.91}`,
    `EXAMPLE G
inbound: "Sorry just saw this — what address is this at?"
history: "out: What time Saturday works best?"
output: {"action":"dealer_location_question","explicit_action":true,"should_reply":true,"normalized_text":"customer asks for dealership address","reason":"A concrete location question in the latest turn outranks the schedule-status acknowledgement.","scheduling_conflict_open":false,"confidence":0.97}`,
    `EXAMPLE H
inbound: "I have no problem. let me know if you find something"
history: "out: I'm not seeing an Iron 883 right now, but I can keep an eye out."
output: {"action":"inventory_watch_acknowledgement","explicit_action":true,"should_reply":true,"normalized_text":"customer asks us to keep watching inventory","reason":"The customer accepts or confirms the active inventory watch after an out-of-stock/watch prompt.","scheduling_conflict_open":false,"confidence":0.96}`,
    `EXAMPLE I
inbound: "If you dont mind keeping an eye out cause it either the iron 883 or a Fat Boy im looking for a breakout"
history: "out: I'm not seeing an Iron 883 in stock right now."
output: {"action":"inventory_watch_acknowledgement","explicit_action":true,"should_reply":true,"normalized_text":"customer asks us to keep watching inventory options","reason":"The customer explicitly asks us to keep an eye out after inventory-watch/out-of-stock context.","scheduling_conflict_open":false,"confidence":0.97}`,
    `EXAMPLE J
inbound: "Let me know if any sales jobs open up."
history: "out: Let me know if you want pricing on the Street Glide."
output: {"action":"none","explicit_action":true,"should_reply":true,"normalized_text":"","reason":"This is not an inventory-watch acknowledgement for the active vehicle workflow.","scheduling_conflict_open":false,"confidence":0.9}`,
    `EXAMPLE K
inbound: "Not sure where this is located or what s the cost, but I m located in New York, NY. Thank you!"
history: "out: Thanks for booking a test ride on the Breakout."
output: {"action":"dealer_location_question","explicit_action":true,"should_reply":true,"normalized_text":"customer asks where the dealership or bike is located and also asks cost","reason":"The latest turn asks where this is located; location/address handling outranks source-forced test-ride scheduling while pricing can be handled as a follow-up.","scheduling_conflict_open":false,"confidence":0.97}`,
    `EXAMPLE L
inbound: "Thats what Im looking for. Definitely hit me up if one comes in or another store has one"
history: "out: I’m not seeing a 2022 Low Rider El Diablo in stock right now. I can check similar options, or I can keep an eye out and text you if one comes in."
output: {"action":"inventory_watch_acknowledgement","explicit_action":true,"should_reply":true,"normalized_text":"customer asks us to text them if one comes in","reason":"The customer explicitly accepts the out-of-stock watch offer and asks to be notified when a match comes in.","scheduling_conflict_open":false,"confidence":0.97}`,
    `EXAMPLE M
inbound: "Yes, let me know when it's available. Thank you"
history: "out: Here are pictures of the 2016 Freewheeler we are taking in on trade."
output: {"action":"pending_incoming_inventory_acknowledgement","explicit_action":true,"should_reply":true,"normalized_text":"customer asks to be notified when the known incoming trade is available","reason":"The customer is not asking us to watch open inventory; they are confirming notification for a specific known trade that is not here yet.","scheduling_conflict_open":false,"confidence":0.97}`,
    `EXAMPLE N
inbound: "Ok keep me posted once the trade gets here"
history: "out: This one is not in yet, but we should have it after the trade comes in."
output: {"action":"pending_incoming_inventory_acknowledgement","explicit_action":true,"should_reply":true,"normalized_text":"customer asks for an update once the incoming trade arrives","reason":"The turn is tied to a known pending trade arrival, not a generic inventory watch.","scheduling_conflict_open":false,"confidence":0.96}`,
    `EXAMPLE O
inbound: "Interested in the 2023 120th Anniversary Road Glide Special. Wants us to call him when we get it through service (Step 2)"
history: "out: Thanks for stopping in today."
output: {"action":"explicit_callback_request","explicit_action":true,"should_reply":true,"normalized_text":"customer wants a callback once the bike is through service","reason":"The latest turn contains an explicit callback/status request, so callback routing owns the turn instead of a generic walk-in recap.","scheduling_conflict_open":false,"confidence":0.97}`,
    `EXAMPLE P
inbound: "Here is a photo of the HD I like."
history: "in: Hi scott I hope you're doing well."
output: {"action":"customer_shared_vehicle_photo","explicit_action":true,"should_reply":true,"normalized_text":"customer shared a photo of a bike they like and wants it matched","reason":"The customer is sharing a vehicle photo as a buying signal; photo-match routing owns the turn instead of small talk or discovery questions.","scheduling_conflict_open":false,"confidence":0.97}`,
    `EXAMPLE Q
inbound: "Can you send me pictures of the Road Glide?"
history: "out: We have a couple Road Glides on the floor."
output: {"action":"none","explicit_action":false,"should_reply":true,"normalized_text":"","reason":"The customer is asking us to send photos, not sharing one; the media-request flow owns this turn.","scheduling_conflict_open":false,"confidence":0.95}`,
    `EXAMPLE R
inbound: "Ok I will be there for the taste of country pre party on Saturday 👍"
history: "out: We've got a couple Road Glides ready to ride — want to swing in and take one out?"
output: {"action":"schedule_context_status_update","explicit_action":true,"should_reply":true,"normalized_text":"customer commits to coming in Saturday for an event","reason":"After a scheduling/visit thread the customer commits to a concrete future day to come in (for an event); confirm the committed day rather than reading it as an en-route arrival window.","scheduling_conflict_open":false,"confidence":0.95}`,
    `EXAMPLE S
inbound: "What do I have to do to reserve one"
history: "in: I know it's a limited run and I would like to reserve one\nout: sorry, we don't have the 2026 Superglide in stock right now."
output: {"action":"customer_reservation_request","explicit_action":true,"should_reply":true,"normalized_text":"customer wants to reserve/pre-order a limited-run unit and is asking how","reason":"The customer wants to RESERVE a unit (limited run), a high-intent buy signal. This is NOT an inventory watch/notify-when-it-arrives; reservation handoff owns the turn.","scheduling_conflict_open":false,"confidence":0.97}`,
    `EXAMPLE T
inbound: "Can you let me know if one comes in?"
history: "out: We don't have that one in stock right now."
output: {"action":"inventory_watch_acknowledgement","explicit_action":true,"should_reply":true,"normalized_text":"customer asks to be notified if one comes in","reason":"Asking to be NOTIFIED when one arrives is an inventory watch, not a reservation/pre-order. Reserve = wants to put one aside now; watch = tell me when it shows up.","scheduling_conflict_open":false,"confidence":0.95}`,
    `EXAMPLE U
inbound: "I'm definitely interested. I should have the money and be in the position to pull the trigger on it by the end of next week. I appreciate your guys time and working with me. I'll be getting back ahold of you then, if you still have one available."
history: "out: The 2026 Street Bob is a limited solo trim run — they move fast.\nout: Hey Kody - just following up with you about the 2026 Street Bob. What are your thoughts?"
output: {"action":"none","explicit_action":false,"should_reply":true,"normalized_text":"","reason":"A FUTURE/deferred purchase commitment with an 'I'll circle back next week' is NOT a reservation request. The customer is not asking us to put a specific unit aside/hold it now — they'll have the money later and will reach back out. Limited-run context alone does not turn a deferred purchase into a reservation. Leave it to the normal router (warm ack + follow-up around their stated timeframe).","scheduling_conflict_open":false,"confidence":0.92}`,
    // EXAMPLE V is the production turn this slot exists for: William Indelicato
    // +17163591526, msg_2e66f70720313_1784929050013 (2026-07-24). Scott was negotiating a
    // service-visit day; "Unsure I have to have injections into my shoulder" was read as
    // stepping_back and CLOSED the lead + paused follow-up indefinitely 11 seconds later.
    `EXAMPLE V
inbound: "Unsure I have to have injections into my shoulder"
history: "out: Can you get here first thing in the morning on Wednesday?\nin: I can try I have an appointment at 9a on Wednesday\nout: What time do you think you can be here on Wednesday?"
output: {"action":"none","explicit_action":false,"should_reply":true,"normalized_text":"customer cannot commit to the proposed Wednesday time because of a conflicting medical appointment, but has not withdrawn","reason":"We asked for a time; the customer answers with UNCERTAINTY plus a conflicting obligation. They never withdrew — this is an open scheduling negotiation, NOT stepping back or a closeout. Keep the visit alive and offer to work around them.","scheduling_conflict_open":true,"confidence":0.95}`,
    // EXAMPLE W — the same SHAPE with no medical words, so the lesson generalizes off the
    // structure (our proposed time + uncertainty + conflict + still willing) rather than
    // being memorized off "injections"/"shoulder".
    `EXAMPLE W
inbound: "not sure yet, my kid has a game that afternoon"
history: "out: Does Thursday around 2 work to come take a look?"
output: {"action":"none","explicit_action":false,"should_reply":true,"normalized_text":"customer is unsure about the proposed Thursday time because of a family conflict","reason":"A conflicting obligation against OUR proposed time with no day/time offered back and no withdrawal. Scheduling stays open; do not close or taper.","scheduling_conflict_open":true,"confidence":0.93}`
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
  if (!args.parserEligible) return true;
  if (!args.parsed) return true;
  return inboundReplyActionConfidence(args.parsed) < inboundReplyActionConfidenceMin();
}
