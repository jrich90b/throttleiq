/**
 * short_affirmative_acceptance:eval — "Sounds great!" is a YES, and a YES gets a TIME.
 *
 * THE MEASURED LEAK (booking funnel, 30 days to 2026-08-04, n=238 engaged sales leads):
 * 136 were offered a time, 41 booked (offer->book 30.1% against a 40% target). The largest
 * recoverable bucket was `accepted_no_time` = 18 leads who AGREED to come in and never got a
 * time pinned. Real threads, all still in the bucket the day this shipped:
 *   Maurice   +17164289392  "what day and time works best?"        -> "Sounds great!"
 *   Clifton   +17164792868  "text me what day works"               -> "Sounds good"
 *   Zebediah  +17165155413  "what works best for you?"             -> "Sounds perfect"
 *   Michael   +16076549423  "want me to set up a time?"            -> "That would be great"
 *   Carmel    +17164208383  "want me to get you scheduled?"        -> "That would be great"
 *   Harry     +17163312613  "want me to save you a spot [Jul 18]?" -> "Yes"
 *
 * WHY IT HAPPENED. A bare affirmative carries no meaning of its own — its meaning lives entirely
 * in OUR OWN previous message. The pipeline had no representation of that: `isShortAckNoReplyText`
 * is a LEXICAL sign-off test that matches "sounds good"/"great"/"perfect", and it terminated the
 * live handler in silence before any scheduling decision ran. Its existing escape hatch was a
 * hand-maintained word list (day-part words were bolted on after "Afternoon would be great" was
 * dropped in June) — a regex answering a comprehension question, which AGENTS.md forbids.
 *
 * THE FIX, in the three places it has to live:
 *   1. COMPREHENSION — a new `accept_scheduling_ask` action on the customer-ack parser, which
 *      already receives our prior outbound as history. Few-shots pair each affirmative WITH the
 *      dealer message it answers, and CONTRAST pairs use the identical words after a
 *      non-scheduling outbound so the sign-off reading survives.
 *   2. ROUTE — `decideSchedulingTurn` gains `offer_times_after_acceptance`, gated on live
 *      schedule context so the route never rests on the parser's read of our own text alone.
 *   3. ANSWER — concrete times off the calendar, never another open question. Re-asking "what day
 *      works?" is the loop that stranded these leads; `buildAcceptedVisitTimeOffer` returns null
 *      rather than fall back to it.
 *
 * FAIL DIRECTION. The lexical sign-off gate is KEPT and still wins whenever the parser is silent,
 * unaccepted, or says anything else — a recognition miss is exactly today's behavior. An over-fire
 * offers two real times to someone who was signing off: recoverable, and it can never book, since
 * the customer named no time to book.
 */
import assert from "node:assert/strict";

const { decideSchedulingTurn, decideShortAckTurnEnd } = await import("../services/api/src/domain/routeStateReducer.ts");
const {
  buildAcceptedVisitTimeOffer,
  pickNextAvailableVisitSlots,
  resolveAcceptedVisitTimeOffer,
  shouldOfferTimesAfterAcceptance
} = await import("../services/api/src/domain/schedulingAcceptance.ts");
const { isShortAckNoReplyText, parserAcceptanceDeclinesAutoSilence, shouldEndTurnAsShortAckSignOff, SHORT_ACK_SIGN_OFF_SUBFLOOR } = await import(
  "../services/api/src/domain/workflowRegressionGuards.ts"
);

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks += 1;
};

// ---------------------------------------------------------------------------
// 1. THE ROUTE. The acceptance only becomes a times-offer inside real schedule context.
// ---------------------------------------------------------------------------
const base = {
  customerAckActionAccepted: false,
  appointmentTimingAccepted: false,
  parserScheduleStatusUpdate: false,
  pricingOrPaymentsIntent: false,
  scheduleDialogState: false,
  scheduleOfferContext: false
};

for (const row of [
  { id: "offer_context", extra: { scheduleOfferContext: true }, kind: "offer_times_after_acceptance" },
  { id: "dialog_state", extra: { scheduleDialogState: true }, kind: "offer_times_after_acceptance" },
  { id: "both", extra: { scheduleOfferContext: true, scheduleDialogState: true }, kind: "offer_times_after_acceptance" },
  // NO schedule context anywhere => fall through to today's behavior, never a cold times-offer.
  { id: "no_context", extra: {}, kind: "none" }
] as const) {
  const decision = decideSchedulingTurn({
    ...base,
    customerAckActionAccepted: true,
    customerAckAction: "accept_scheduling_ask",
    ...row.extra
  });
  ok(
    decision.kind === row.kind,
    `route ${row.id}: expected ${row.kind}, got ${decision.kind}`
  );
}

// An UNACCEPTED parse must never reach the arm — low confidence keeps today's behavior.
ok(
  decideSchedulingTurn({
    ...base,
    customerAckActionAccepted: false,
    customerAckAction: "accept_scheduling_ask",
    scheduleOfferContext: true
  }).kind !== "offer_times_after_acceptance",
  "an unaccepted customer-ack parse must not trigger the times-offer"
);

// Pricing/payments still outranks Block A entirely.
ok(
  decideSchedulingTurn({
    ...base,
    customerAckActionAccepted: true,
    customerAckAction: "accept_scheduling_ask",
    scheduleOfferContext: true,
    pricingOrPaymentsIntent: true
  }).kind !== "offer_times_after_acceptance",
  "a pricing/payments turn must not be hijacked into a times-offer"
);

// The arm must NOT swallow the actions around it — these keep their own routes.
for (const [action, kind] of [
  ["confirm_proposed_appointment", "none"], // needs shouldBook; without it, falls through
  ["ask_for_available_times", "ask_available_times"],
  ["accept_tentative_appointment", "accept_tentative"],
  ["no_response_needed", "none"]
] as const) {
  ok(
    decideSchedulingTurn({
      ...base,
      customerAckActionAccepted: true,
      customerAckAction: action,
      scheduleOfferContext: true
    }).kind === kind,
    `neighbouring action ${action} must still route to ${kind}`
  );
}

// A confirmed CONCRETE time still books — the acceptance arm must not have stolen it.
ok(
  decideSchedulingTurn({
    ...base,
    customerAckActionAccepted: true,
    customerAckAction: "confirm_proposed_appointment",
    customerAckShouldBook: true,
    scheduleOfferContext: true
  }).kind === "confirm_appointment",
  "a customer confirming a concrete offered time must still reach the booking arm"
);

// ---------------------------------------------------------------------------
// 2. BOTH PATHS ASK THE SAME REFEREE. The regen path calls
//    `shouldOfferTimesAfterAcceptance`; it must agree with the live path's `decideSchedulingTurn`
//    on every combination, or the two paths drift (AGENTS.md: parser-first in BOTH paths).
// ---------------------------------------------------------------------------
for (const action of ["accept_scheduling_ask", "ask_for_available_times", "no_response_needed"]) {
  for (const scheduleOfferContext of [true, false]) {
    for (const scheduleDialogState of [true, false]) {
      const live =
        decideSchedulingTurn({
          ...base,
          customerAckActionAccepted: true,
          customerAckAction: action,
          scheduleOfferContext,
          scheduleDialogState
        }).kind === "offer_times_after_acceptance";
      const regen = shouldOfferTimesAfterAcceptance({
        action,
        scheduleDialogState,
        scheduleOfferContext
      });
      ok(
        live === regen,
        `live/regen disagreed for ${action} offer=${scheduleOfferContext} dialog=${scheduleDialogState}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 3. THE LEXICAL SIGN-OFF GATE IS KEPT. Every affirmative below still matches it — which is
//    exactly why the parser has to outrank it, and why deleting the gate is NOT the fix.
// ---------------------------------------------------------------------------
for (const text of ["Sounds great!", "Sounds good", "Sounds perfect", "Perfect.", "ok", "Thanks!"]) {
  ok(
    isShortAckNoReplyText(text) === true,
    `the sign-off gate must still match "${text}" — the parser, not a word list, is what overrides it`
  );
}
// And it must still NOT match a real question or a day-part reply.
for (const text of ["ok thanks, what time do you close?", "Afternoon would be great"]) {
  ok(isShortAckNoReplyText(text) === false, `the sign-off gate must not swallow "${text}"`);
}

// ---------------------------------------------------------------------------
// 4. THE ANSWER IS A TIME, NEVER ANOTHER QUESTION.
// ---------------------------------------------------------------------------
{
  const two = buildAcceptedVisitTimeOffer([
    { startLocal: "Sat, Aug 9, 11:00 AM" },
    { startLocal: "Sat, Aug 9, 1:00 PM" }
  ]);
  ok(!!two && two.includes("11:00 AM") && two.includes("1:00 PM"), "two slots must both be named");
  ok(!!two && /which works better/i.test(two), "two slots must ask the customer to pick one");

  const one = buildAcceptedVisitTimeOffer([{ startLocal: "Sat, Aug 9, 11:00 AM" }]);
  ok(!!one && one.includes("11:00 AM"), "a single slot must still be named");

  // THE LOAD-BEARING ONE: with no real slot we return null so the caller keeps its existing path.
  // Returning an open "what day works?" here would rebuild the exact loop this eval exists to stop.
  for (const empty of [[], null, undefined, [{ startLocal: "" }], [{ startLocal: null }]]) {
    ok(
      buildAcceptedVisitTimeOffer(empty as any) === null,
      "with no real slot the offer must be null, never a re-ask"
    );
  }
  for (const reply of [two, one]) {
    ok(
      !!reply && !/what day|what time|works best|let me know when/i.test(reply),
      `the answer must never re-ask an open scheduling question: "${reply}"`
    );
  }
}

// ---------------------------------------------------------------------------
// 5. NEXT-AVAILABLE SEARCH: no day was named, so "next open" is the question.
// ---------------------------------------------------------------------------
{
  const cfg = {
    timezone: "America/New_York",
    minGapBetweenAppointmentsMinutes: 60,
    appointmentTypes: { inventory_visit: { durationMinutes: 60 } },
    salespeople: [
      { id: "sp1", name: "Geo", calendarId: "cal1" },
      { id: "sp2", name: "Stone", calendarId: "cal2" }
    ],
    minLeadTimeHours: 4,
    businessHours: {
      monday: { open: "09:00", close: "17:00" },
      tuesday: { open: "09:00", close: "17:00" },
      wednesday: { open: "09:00", close: "17:00" },
      thursday: { open: "09:00", close: "17:00" },
      friday: { open: "09:00", close: "17:00" },
      saturday: { open: "09:00", close: "17:00" },
      sunday: { open: "09:00", close: "17:00" }
    }
  };
  const now = new Date("2026-08-05T13:00:00.000Z");

  const open = pickNextAvailableVisitSlots({
    cfg,
    preferredSalespeople: ["sp1"],
    appointmentType: "inventory_visit",
    now,
    limit: 2
  });
  ok(open.length === 2, `an open calendar must yield 2 slots, got ${open.length}`);
  ok(
    open.every(s => s.salespersonId === "sp1" && !!s.startLocal),
    "slots must carry the preferred rep and a human-readable local time"
  );
  ok(
    new Date(open[0].start).getTime() < new Date(open[1].start).getTime(),
    "next-available slots must come back in chronological order"
  );
  ok(
    new Date(open[0].start).getTime() >= now.getTime(),
    "next-available must never offer a time in the past"
  );

  // No preferred rep / no roster => no invented slots.
  ok(
    pickNextAvailableVisitSlots({ cfg, preferredSalespeople: [], appointmentType: "inventory_visit", now })
      .length === 0,
    "no preferred salesperson must yield no slots, never an invented one"
  );
  ok(
    pickNextAvailableVisitSlots({
      cfg: { ...cfg, salespeople: [] },
      preferredSalespeople: ["sp1"],
      appointmentType: "inventory_visit",
      now
    }).length === 0,
    "an empty roster must yield no slots"
  );

  // A fully-booked rep falls through to the next preferred rep rather than going silent.
  const busyAllWeek = Array.from({ length: 14 }, (_, i) => ({
    start: new Date(now.getTime() + i * 864e5 - 12 * 36e5),
    end: new Date(now.getTime() + i * 864e5 + 24 * 36e5)
  }));
  const fellThrough = pickNextAvailableVisitSlots({
    cfg,
    preferredSalespeople: ["sp1", "sp2"],
    appointmentType: "inventory_visit",
    busyBySalesperson: { cal1: busyAllWeek },
    now,
    limit: 2
  });
  ok(
    fellThrough.length > 0 && fellThrough.every(s => s.salespersonId === "sp2"),
    "a fully-booked first rep must fall through to the next, not produce silence"
  );
}

// ---------------------------------------------------------------------------
// 6. THE WHOLE ARM, INCLUDING AN UNREACHABLE CALENDAR. We would rather offer a time staff can
//    move than go silent on a customer who just said yes — same fail-direction the day-scoped
//    search already takes.
// ---------------------------------------------------------------------------
{
  const cfg = {
    timezone: "America/New_York",
    minGapBetweenAppointmentsMinutes: 60,
    appointmentTypes: { inventory_visit: { durationMinutes: 60 } },
    salespeople: [{ id: "sp1", name: "Geo", calendarId: "cal1" }],
    minLeadTimeHours: 4,
    businessHours: {
      monday: { open: "09:00", close: "17:00" },
      tuesday: { open: "09:00", close: "17:00" },
      wednesday: { open: "09:00", close: "17:00" },
      thursday: { open: "09:00", close: "17:00" },
      friday: { open: "09:00", close: "17:00" },
      saturday: { open: "09:00", close: "17:00" },
      sunday: { open: "09:00", close: "17:00" }
    }
  };
  const now = new Date("2026-08-05T13:00:00.000Z");

  const healthy = await resolveAcceptedVisitTimeOffer({
    cfg,
    preferredSalespeople: ["sp1"],
    appointmentType: "inventory_visit",
    now,
    calendarClientFactory: async () => ({}),
    freeBusy: (async () => ({ calendars: { cal1: { busy: [] } } })) as any
  });
  ok(!!healthy.reply && healthy.slots.length === 2, "the healthy path must name two times");

  const unreachable = await resolveAcceptedVisitTimeOffer({
    cfg,
    preferredSalespeople: ["sp1"],
    appointmentType: "inventory_visit",
    now,
    calendarClientFactory: async () => {
      throw new Error("calendar down");
    }
  });
  ok(
    !!unreachable.reply,
    "an unreachable calendar must still offer a time — silence is the failure being fixed"
  );

  const freeBusyThrew = await resolveAcceptedVisitTimeOffer({
    cfg,
    preferredSalespeople: ["sp1"],
    appointmentType: "inventory_visit",
    now,
    calendarClientFactory: async () => ({}),
    freeBusy: (async () => {
      throw new Error("freebusy failed");
    }) as any
  });
  ok(!!freeBusyThrew.reply, "a failed free/busy lookup must not produce silence either");

  // No roster => genuinely nothing to offer => null, and the caller keeps its own path.
  const nothing = await resolveAcceptedVisitTimeOffer({
    cfg: { ...cfg, salespeople: [] },
    preferredSalespeople: ["sp1"],
    appointmentType: "inventory_visit",
    now,
    calendarClientFactory: async () => ({}),
    freeBusy: (async () => ({ calendars: {} })) as any
  });
  ok(nothing.reply === null, "with no bookable rep the arm must decline rather than improvise");
}

// ---------------------------------------------------------------------------
// 7. THE GATE ITSELF — recognising the acceptance is worthless if the sign-off gate still ends
//    the turn. MEASURED 2026-08-07 on +16076549423: the parser change alone was INERT. Michael
//    answered our own "I can also check current incentives on the Street Glide Limited and send
//    only what applies" with "That would be great" on 2026-06-09 and got NOTHING but cadence for
//    ten days. Replayed on the parser-only branch the turn STILL produced no draft, because this
//    gate fires on the word "great" and exempted `accept_scheduling_ask` alone.
//    So assert the DECISION — does the turn get skipped? — never the parser's label.
// ---------------------------------------------------------------------------
{
  // The real gate both paths call — not a re-implementation of it.
  const wouldSkipAsSignOff = (text: string, accepted: boolean, action: string | null, confidence?: number) =>
    shouldEndTurnAsShortAckSignOff({ provider: "twilio", text, accepted, action, confidence });

  const MICHAEL = "That would be great"; // +16076549423, 2026-06-09T21:36Z

  ok(
    isShortAckNoReplyText(MICHAEL) === true,
    "the lexical gate must still match this turn — the parser, not a word list, is what overrides it"
  );
  ok(
    wouldSkipAsSignOff(MICHAEL, true, "accept_offer_of_information") === false,
    "accepting our own offer to SEND something must not be skipped as a sign-off"
  );
  ok(
    wouldSkipAsSignOff("Sounds great!", true, "accept_scheduling_ask") === false,
    "accepting our own scheduling ask must not be skipped as a sign-off"
  );

  // FAIL DIRECTION. Anything short of an ACCEPTED parse naming one of those two actions leaves
  // the word list in charge — a recognition miss is exactly today's behavior, never worse.
  for (const action of ["no_response_needed", "customer_will_provide_time", "neutral_ack", "none", null]) {
    ok(
      wouldSkipAsSignOff(MICHAEL, true, action) === true,
      `an accepted parse reading "${action}" must leave the sign-off gate in charge`
    );
  }
  ok(
    wouldSkipAsSignOff(MICHAEL, false, "accept_offer_of_information", 0.2) === true,
    "a parse below the sub-floor must never override the sign-off gate, whatever action it names"
  );
  ok(
    wouldSkipAsSignOff("Thanks!", true, "no_response_needed") === true,
    "a plain thank-you after a commitment must still end the turn"
  );
  // The lexical test is SMS shorthand — it must never end an ADF or widget turn.
  for (const provider of ["sendgrid_adf", "web_widget", "", null]) {
    ok(
      shouldEndTurnAsShortAckSignOff({ provider, text: "Thanks!", accepted: false, action: null }) === false,
      `the sign-off gate must stay Twilio-only, not fire on "${provider}"`
    );
  }
}

// ---------------------------------------------------------------------------
// 7b. THE SUB-FLOOR (Joe, 2026-08-07). Shipping the exemption was still not enough: replayed 6x
//     against the deployed build, Michael's turn answered ONCE. The parser named the action right
//     on 6 probes of 8 but reported 0.53-0.78, under the 0.74 every other consumer requires.
//     Joe chose the narrow fix: an uncertain parse may DECLINE AUTO-SILENCING and nothing else.
//     0.5 was picked from measurement, not taste — 25 real sign-off turns pulled from the live
//     store (a short ack after a dealer COMMITMENT, never after an open ask) drew an accept action
//     0 times out of 25, at every candidate bar down to 0.40. The LABEL discriminates; the number
//     is the model hedging on a case it has already read correctly.
// ---------------------------------------------------------------------------
{
  const MICHAEL = "That would be great";
  const skip = (accepted: boolean, action: string | null, confidence?: number) =>
    shouldEndTurnAsShortAckSignOff({ provider: "twilio", text: MICHAEL, accepted, action, confidence });

  ok(SHORT_ACK_SIGN_OFF_SUBFLOOR === 0.5, "the sub-floor is the measured 0.5, not an ad-hoc number");

  // THE WHOLE POINT: the confidences actually observed on this turn now answer instead of going quiet.
  for (const confidence of [0.53, 0.57, 0.6, 0.62, 0.65, 0.7, 0.73]) {
    for (const action of ["accept_offer_of_information", "accept_scheduling_ask"]) {
      ok(
        skip(false, action, confidence) === false,
        `an unaccepted ${action} at ${confidence} must decline to auto-silence — this is the fix`
      );
    }
  }
  // Below the sub-floor the parser is genuinely confused: stay on the silent side.
  for (const confidence of [0, 0.2, 0.35, 0.49]) {
    ok(
      skip(false, "accept_offer_of_information", confidence) === true,
      `a parse at ${confidence} is below the sub-floor and must leave the word list in charge`
    );
  }
  // A missing confidence is not a low one by accident — it must read as zero, i.e. silent.
  ok(skip(false, "accept_offer_of_information", undefined) === true, "an absent confidence must not pass the sub-floor");

  // THE CLOSED LIST STILL RULES. The sub-floor loosens the CONFIDENCE, never the set of actions:
  // no other action may ride it, at any confidence at all.
  for (const action of ["no_response_needed", "customer_will_provide_time", "neutral_ack", "none", null]) {
    for (const confidence of [0.5, 0.74, 0.99]) {
      ok(
        skip(false, action, confidence) === true,
        `${action} at ${confidence} must never ride the sub-floor — it loosens confidence, not the action list`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 7c. CONTAINMENT — the sub-floor buys ONE thing: not being auto-silenced. It must never reach a
//     booking, a state write, or the offer-times arm. Those all key off the FULL 0.74 acceptance
//     (`customerAckActionAccepted`), which this change does not touch. Proven by driving the
//     referee directly: unaccepted in, no times arm out, whatever the action or the context.
// ---------------------------------------------------------------------------
for (const action of ["accept_scheduling_ask", "accept_offer_of_information"]) {
  for (const scheduleOfferContext of [true, false]) {
    for (const scheduleDialogState of [true, false]) {
      ok(
        decideSchedulingTurn({
          ...base,
          customerAckActionAccepted: false,
          customerAckAction: action,
          scheduleOfferContext,
          scheduleDialogState
        }).kind !== "offer_times_after_acceptance",
        `a sub-floor ${action} must NOT reach the offer-times arm (offer=${scheduleOfferContext} dialog=${scheduleDialogState})`
      );
      ok(
        shouldOfferTimesAfterAcceptance({ action, scheduleDialogState, scheduleOfferContext }) ===
          (decideSchedulingTurn({
            ...base,
            customerAckActionAccepted: true,
            customerAckAction: action,
            scheduleOfferContext,
            scheduleDialogState
          }).kind === "offer_times_after_acceptance"),
        `both paths must still agree at FULL acceptance for ${action}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 8. WIRING, BY COUNT — neither the ratchet nor a source pin can prove this. The gate is only
//    fixed if BOTH inbound paths ask the shared predicate, so require an exact call count and
//    require every sign-off gate site to be guarded by it.
// ---------------------------------------------------------------------------
{
  const { readFileSync } = await import("node:fs");
  const index = readFileSync("services/api/src/index.ts", "utf8");

  const callSites = index.split("shouldEndTurnAsShortAckSignOff" + "(").length - 1;
  ok(
    callSites === 2,
    `expected exactly 2 sign-off gate call sites in index.ts — live + regenerate; found ${callSites}`
  );

  // And the raw lexical test must not be reachable from the handler any more: calling it directly
  // is how the regenerate path ended up with no parser exemption at all.
  const rawUses = index.split("isShortAckNoReplyText" + "(").length - 1;
  ok(
    rawUses === 0,
    `index.ts must reach the sign-off test only through the shared gate; found ${rawUses} direct call(s)`
  );

  // THE SUB-FLOOR IS DEAD IF THE CONFIDENCE NEVER ARRIVES. A call site that omits it passes
  // undefined, the sub-floor reads it as zero, and the whole of 7b becomes decoration that still
  // goes green — the exact "correct fix, zero effect" trap this file was rewritten for once today.
  // So require BOTH sites to hand over the parser's confidence.
  const lines = index.split("\n");
  const liveSite = lines.filter(
    line => line.includes("shouldEndTurnAsShortAckSignOff" + "(") && line.includes("inboundText")
  );
  ok(liveSite.length === 1, `expected one live sign-off gate site; found ${liveSite.length}`);
  ok(
    liveSite[0].includes("confidence: customerAckActionParse?.confidence"),
    "the LIVE sign-off gate must be handed the parser's confidence, or the sub-floor never fires"
  );
  const regenSite = lines.filter(
    line => line.includes("shouldEndTurnAsShortAckSignOff" + "(") && line.includes("regenCustomerAckActionParse")
  );
  ok(regenSite.length === 1, `expected one regenerate sign-off gate site; found ${regenSite.length}`);
  ok(
    regenSite[0].includes("confidence: regenCustomerAckActionParse?.confidence"),
    "the REGENERATE sign-off gate must be handed the parser's confidence too, or the two paths drift"
  );

  // THERE ARE TWO SILENCING GATES, AND THE SUB-FLOOR IS WORTHLESS UNLESS IT COVERS BOTH.
  // MEASURED 2026-08-07: with the sub-floor wired into the sign-off gate ALONE, Michael's turn
  // still replayed 0 for 6 — WORSE than before. The response-control parser calls the same turn
  // `no_response` at 0.85-0.86 on 3 probes of 8, and its gate runs EARLIER and keys off the FULL
  // acceptance (`!customerAckActionAccepted`), so a sub-floor parse never suppressed it.
  // Fixing one silencer just hands the turn to the next one.
  const noResponseGate = lines.filter(line => line.includes("llmNoResponse && !customerAckActionAccepted"));
  ok(
    noResponseGate.length === 1,
    `expected one response-control no-response gate; found ${noResponseGate.length}`
  );
  ok(
    noResponseGate[0].includes("parserAcceptanceDeclinesAutoSilence" + "("),
    "the response-control no-response gate must ALSO honour the sub-floor, or the sign-off fix is dead on arrival"
  );
  ok(
    noResponseGate[0].includes("confidence: customerAckActionParse?.confidence"),
    "and it must be handed the parser's confidence, not just the action"
  );

  // AND THE THIRD SILENCER — the one that actually ended this turn. Found 2026-08-07 only by
  // driving the live handler and reading the recorded route outcome: `resolveNoResponsePolicyDecision`
  // returned `no_actionable_context`, because "the customer accepted what we offered" was not on
  // its list. Both paths must feed it the same signal, or the referee silences a turn the two
  // gates above just agreed to answer.
  const refereeSites = lines.filter(line => line.includes("acceptedPendingOfferSignal:"));
  ok(
    refereeSites.length === 2,
    `both inbound paths must feed the no-response referee the accepted-offer signal; found ${refereeSites.length}`
  );
  ok(
    refereeSites.some(line => line.includes("customerAckActionParse?.confidence")) &&
      refereeSites.some(line => line.includes("regenCustomerAckActionParse?.confidence")),
    "one live and one regenerate, each carrying the parser's own confidence"
  );

  // Every silencer asks the SAME predicate — one idea, one implementation, no drift.
  const declineSites = index.split("parserAcceptanceDeclinesAutoSilence" + "(").length - 1;
  ok(
    declineSites === 4,
    `expected 4 direct predicate calls in index.ts — the response-control gate, both no-response referee sites, and the short-ack turn-end referee; the sign-off gate reaches it through shouldEndTurnAsShortAckSignOff. Found ${declineSites}`
  );

  // THE FOURTH SILENCER. Three hand-maintained `return empty TwiML` blocks used to sit in a row
  // here, recording NOTHING — invisible to decision tracing, to the route-outcome log and to the
  // replay harness, which is why finding it needed markers bisected through 3,700 lines. One
  // referee now, and it must LOG. Assert the copies are gone and cannot come back.
  const turnEndSites = index.split("decideShortAckTurnEnd" + "(").length - 1;
  ok(turnEndSites === 1, `expected exactly 1 short-ack turn-end referee call; found ${turnEndSites}`);
  ok(
    index.includes('logRouteOutcome("short_ack_turn_end"'),
    "the short-ack turn end must record WHY — an exit that logs nothing is how this one hid for a day"
  );
  const bareShortAckExits = lines.filter(
    (line, i) =>
      line.includes("shortAck &&") &&
      lines.slice(i, i + 8).some(l => l.includes("<Response></Response>"))
  );
  ok(
    bareShortAckExits.length === 0,
    `a bare shortAck exit returning empty TwiML is back in index.ts (${bareShortAckExits.length}) — route it through the referee`
  );
}

// ---------------------------------------------------------------------------
// 9. THE FOURTH SILENCER'S DECISION TABLE. `lastOutboundAskedQuestion` is a WORD LIST — a trailing
//    "?" or `want me to|should i|can i|would you like|…`. We had written "**I can also** check
//    current incentives and send only what applies": no "?", and "I can" is not "can i". So the
//    handler decided we had asked nothing and ended the turn. The word list is deliberately NOT
//    widened — widening it is the anti-pattern that produced all four silencers. The parser
//    outranks it instead.
// ---------------------------------------------------------------------------
{
  const MICHAEL = {
    provider: "twilio",
    shortAck: true,
    schedulingBlocked: false,
    ackOnlyCloseTurn: false,
    lastOutboundAskedQuestion: false, // "I can also check current incentives…" — no "?", not "can i"
    hasPendingWatch: false,
    hasPendingSlot: false,
    hasReschedulePending: false,
    acceptedPendingOffer: false
  };
  ok(
    decideShortAckTurnEnd(MICHAEL).end === true,
    "today's behaviour is preserved when the parser says nothing: the turn still ends"
  );
  ok(
    decideShortAckTurnEnd({ ...MICHAEL, acceptedPendingOffer: true }).end === false,
    "THE FIX: an accepted offer must not be ended here either"
  );
  ok(
    decideShortAckTurnEnd({ ...MICHAEL, acceptedPendingOffer: true }).reason === "accepted_pending_offer",
    "and it must say so, so this exit is never invisible again"
  );
  // The acceptance outranks the scheduling-blocked arm too — same ruling, same reason.
  ok(
    decideShortAckTurnEnd({ ...MICHAEL, schedulingBlocked: true, acceptedPendingOffer: true }).end === false,
    "an accepted offer outranks the scheduling-blocked short-ack arm"
  );
  // EVERY OTHER RULE UNCHANGED — a parser miss lands on exactly today's behaviour.
  for (const [patch, expected, why] of [
    [{ schedulingBlocked: true }, true, "scheduling blocked + short ack still ends"],
    [{ lastOutboundAskedQuestion: true }, false, "we asked something, so the turn continues"],
    [{ hasPendingWatch: true }, false, "a pending watch keeps the turn alive"],
    [{ hasPendingSlot: true }, false, "a pending slot keeps the turn alive"],
    [{ hasReschedulePending: true }, false, "a pending reschedule keeps the turn alive"],
    [{ shortAck: false, ackOnlyCloseTurn: true }, true, "an ack-only close turn still ends"],
    [{ shortAck: false }, false, "not a short ack and not a close turn: the turn continues"],
    [{ provider: "sendgrid_adf" }, false, "this gate is Twilio-only"]
  ] as const) {
    ok(
      decideShortAckTurnEnd({ ...MICHAEL, ...patch }).end === expected,
      `${why} (got ${decideShortAckTurnEnd({ ...MICHAEL, ...patch }).end})`
    );
  }
}

console.log(`short_affirmative_acceptance:eval OK (${checks} checks)`);
