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

const { decideSchedulingTurn } = await import("../services/api/src/domain/routeStateReducer.ts");
const {
  buildAcceptedVisitTimeOffer,
  pickNextAvailableVisitSlots,
  resolveAcceptedVisitTimeOffer,
  shouldOfferTimesAfterAcceptance
} = await import("../services/api/src/domain/schedulingAcceptance.ts");
const { isShortAckNoReplyText, parserAcceptanceOutranksShortAckSignOff } = await import(
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
  // Mirrors the gate expression used in BOTH inbound paths. Section 8 is what catches this
  // going out of sync with index.ts.
  const wouldSkipAsSignOff = (text: string, accepted: boolean, action: string | null) =>
    isShortAckNoReplyText(text) && !parserAcceptanceOutranksShortAckSignOff({ accepted, action });

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
    wouldSkipAsSignOff(MICHAEL, false, "accept_offer_of_information") === true,
    "an UNACCEPTED parse must never override the sign-off gate, whatever action it names"
  );
  ok(
    wouldSkipAsSignOff("Thanks!", true, "no_response_needed") === true,
    "a plain thank-you after a commitment must still end the turn"
  );
}

// ---------------------------------------------------------------------------
// 8. WIRING, BY COUNT — neither the ratchet nor a source pin can prove this. The gate is only
//    fixed if BOTH inbound paths ask the shared predicate, so require an exact call count and
//    require every sign-off gate site to be guarded by it.
// ---------------------------------------------------------------------------
{
  const { readFileSync } = await import("node:fs");
  const index = readFileSync("services/api/src/index.ts", "utf8");

  const callSites = index.split("parserAcceptanceOutranksShortAckSignOff" + "(").length - 1;
  ok(
    callSites === 2,
    `expected exactly 2 sign-off exemption call sites in index.ts — live + regenerate; found ${callSites}`
  );

  const lines = index.split("\n");
  const gateLines = lines
    .map((line, i) => ({ line, i }))
    .filter(entry => entry.line.includes("isShortAckNoReplyText" + "("));
  ok(
    gateLines.length === 2,
    `expected exactly 2 sign-off gate sites in index.ts; found ${gateLines.length}`
  );
  for (const gate of gateLines) {
    const window = lines.slice(gate.i, gate.i + 8).join("\n");
    ok(
      window.includes("parserAcceptanceOutranksShortAckSignOff"),
      `the sign-off gate at index.ts line ${gate.i + 1} is UNGUARDED — the parser cannot outrank it there`
    );
  }
}

console.log(`short_affirmative_acceptance:eval OK (${checks} checks)`);
