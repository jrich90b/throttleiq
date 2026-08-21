/**
 * booking_task_calendar_close:eval
 *
 * A "book this visit" task closes on the CALENDAR, never on the conversation.
 *
 * Lance Scarafia +17168603628, 2026-08-17 (operator report 2026-08-20T17:25Z). The scheduling-leak
 * safety net had minted its one task — "Schedule the visit for Lance — a time was discussed but
 * nothing is booked. Confirm a time (check availability) and put it on the calendar." The rep asked
 * "Would you like to schedule your 1,000 mile service for Thursday 9/3?", Lance replied "Yes", the
 * rep replied "Thank you!", and the LLM fulfillment judge closed the task at 0.90 with the evidence
 * pinned in REAL_LANCE_VERDICT below. `conv.appointment` is absent to this day; three days later the
 * leak detector re-minted the task (`scheduling_leak_flagged`, 2026-08-20T19:17Z) and the cycle
 * restarted. Meanwhile the agent drafted "Do you want me to go ahead and get you on the schedule for
 * that 1,000-mile service on 9/3, Lance?" — re-asking a question already answered.
 *
 * This task family already HAS a closer: the state-reconcile pass retires it the moment
 * isSchedulingLeakConversation goes false (booked / closed / aged out). The judge is a second,
 * competing closer that reads talk instead of state.
 *
 * MEASURED on the live store (route audit, 181 daily files): 545 auto-closes, 39 of them this family
 * across 21 conversations — and 18 of the 21 have NO appointment record at all. The 3 that did book
 * would have been retired by the reconcile pass anyway, so refusing them here costs nothing; section
 * 1 pins that a booked visit still closes.
 *
 * FAIL DIRECTION: the guard can only ever REFUSE a close, so the worst case is a "book this visit"
 * task staying in the staff inbox. Never a discussed-but-unbooked visit going quiet.
 *
 * Section 3 is the WIRING proof (the ratchet cannot prove wiring — trap 2): the guard is inert
 * unless index.ts actually passes `appointmentBooked` at the one call site, and unless the summary
 * the generator writes really contains the marker the guard matches.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  decideTaskAutoClose,
  isSchedulingLeakTask,
  SCHEDULING_LEAK_TODO_MARKER,
  TASK_AUTO_CLOSE_MIN_CONFIDENCE
} = await import("../services/api/src/domain/taskFulfillmentAutoClose.ts");

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  ${name}: ${(err as Error).message}`);
  }
}

// The exact summary the scheduling-leak generator writes (index.ts), for the real lead.
const LANCE_TASK = {
  status: "open",
  reason: "call",
  taskClass: "followup",
  summary:
    "Schedule the visit for Lance — a time was discussed but nothing is booked. Confirm a time (check availability) and put it on the calendar."
};

// The verdict the fulfillment judge actually returned, copied from the route-audit row
// (route_traces_20260817.jsonl, taskId todo_9b6c9da6f38ef_1786994203127).
const REAL_LANCE_VERDICT = {
  taskId: "todo_9b6c9da6f38ef_1786994203127",
  fulfilled: true,
  confidence: 0.9,
  evidence:
    "Dealer confirmed scheduling details and asked if customer would like to schedule the 1,000-mile service for Thursday 9/3; customer replied 'Yes' and dealer acknowledged. That const"
};

// An ordinary answered-question task, to prove the guard is scoped to the booking family.
const ORDINARY_TASK = {
  status: "open",
  reason: "parts",
  taskClass: "followup",
  summary: "Customer asked whether the Saddlemen Road Sofa seat is in stock — answer him."
};

console.log("1. The decision table — the real Lance shape, and everything around it");

check("Lance's real verdict no longer closes his booking task while nothing is booked", () => {
  const d = decideTaskAutoClose({
    enabled: true,
    eligible: true,
    verdict: REAL_LANCE_VERDICT,
    task: LANCE_TASK,
    dealerOutboundTrigger: true,
    appointmentBooked: false
  });
  assert.equal(d.close, false);
  assert.equal(d.reason, "booking_task_needs_a_booked_appointment");
});

check("the same booking task DOES close once the visit is on the calendar", () => {
  const d = decideTaskAutoClose({
    enabled: true,
    eligible: true,
    verdict: REAL_LANCE_VERDICT,
    task: LANCE_TASK,
    dealerOutboundTrigger: true,
    appointmentBooked: true
  });
  assert.equal(d.close, true);
  assert.equal(d.reason, "fulfilled_high_confidence");
});

check("an ordinary fulfilled task is untouched by the guard", () => {
  const d = decideTaskAutoClose({
    enabled: true,
    eligible: true,
    verdict: { taskId: "t2", fulfilled: true, confidence: 0.92 },
    task: ORDINARY_TASK,
    dealerOutboundTrigger: true,
    appointmentBooked: false
  });
  assert.equal(d.close, true);
  assert.equal(d.reason, "fulfilled_high_confidence");
});

check("a missing appointmentBooked (an un-updated caller) refuses, it does not close", () => {
  // Fail-safe default: the flag is optional on the type, so an unwired caller must land on the
  // refusal, never silently keep today's behaviour.
  const d = decideTaskAutoClose({
    enabled: true,
    eligible: true,
    verdict: REAL_LANCE_VERDICT,
    task: LANCE_TASK,
    dealerOutboundTrigger: true
  });
  assert.equal(d.close, false);
  assert.equal(d.reason, "booking_task_needs_a_booked_appointment");
});

check("the guard is reported in SHADOW too — it blocks before the flag check", () => {
  const d = decideTaskAutoClose({
    enabled: false,
    eligible: true,
    verdict: REAL_LANCE_VERDICT,
    task: LANCE_TASK,
    dealerOutboundTrigger: true,
    appointmentBooked: false
  });
  assert.equal(d.close, false);
  assert.equal(d.reason, "booking_task_needs_a_booked_appointment");
});

console.log("2. The guards that already existed still decide first");

check("not_fulfilled still wins over the booking guard", () => {
  const d = decideTaskAutoClose({
    enabled: true,
    eligible: true,
    verdict: { taskId: "t", fulfilled: false, confidence: 0.99 },
    task: LANCE_TASK,
    appointmentBooked: false
  });
  assert.equal(d.reason, "not_fulfilled");
});

check("below_confidence still wins over the booking guard", () => {
  const d = decideTaskAutoClose({
    enabled: true,
    eligible: true,
    verdict: { taskId: "t", fulfilled: true, confidence: TASK_AUTO_CLOSE_MIN_CONFIDENCE - 0.01 },
    task: LANCE_TASK,
    appointmentBooked: false
  });
  assert.equal(d.reason, "below_confidence");
});

check("the quiet-triggered guard is still reported when both would apply", () => {
  const quietBooking = {
    ...LANCE_TASK,
    summary: `${LANCE_TASK.summary} quiet since Aug 1`
  };
  const d = decideTaskAutoClose({
    enabled: true,
    eligible: true,
    verdict: REAL_LANCE_VERDICT,
    task: quietBooking,
    dealerOutboundTrigger: false,
    appointmentBooked: false
  });
  assert.equal(d.close, false);
  assert.equal(d.reason, "quiet_task_needs_new_outbound");
});

check("isSchedulingLeakTask matches the real summary and nothing else", () => {
  assert.equal(isSchedulingLeakTask(LANCE_TASK), true);
  assert.equal(isSchedulingLeakTask(ORDINARY_TASK), false);
  assert.equal(isSchedulingLeakTask({ summary: null }), false);
  assert.equal(isSchedulingLeakTask({}), false);
});

console.log("3. Wiring — the guard is inert unless index.ts feeds it");

const INDEX_SRC = readFileSync(new URL("../services/api/src/index.ts", import.meta.url), "utf8");

check("the ONE decideTaskAutoClose call site passes appointmentBooked", () => {
  const callSites = INDEX_SRC.split("decideTaskAutoClose({").slice(1);
  assert.equal(callSites.length, 1, `expected exactly 1 call site, found ${callSites.length}`);
  const args = callSites[0].slice(0, 400);
  assert.ok(args.includes("appointmentBooked:"), "call site does not pass appointmentBooked");
  assert.ok(
    args.includes("appointment?.bookedEventId"),
    "appointmentBooked must be derived from the conversation's booked calendar event"
  );
});

check("the leak-task marker has ONE definition, imported by index.ts", () => {
  assert.ok(
    INDEX_SRC.includes("SCHEDULING_LEAK_TODO_MARKER"),
    "index.ts no longer references the shared marker"
  );
  assert.ok(
    !INDEX_SRC.includes(`const SCHEDULING_LEAK_TODO_MARKER =`),
    "index.ts re-declares the marker — two copies drift apart"
  );
});

check("the summary the generator writes really contains the marker the guard matches", () => {
  // The generator's template literal, as it appears in index.ts. If someone reworded the task copy,
  // the guard would stop matching and this fails rather than shipping inert.
  const generated = `Schedule the visit for Lance — ${SCHEDULING_LEAK_TODO_MARKER}. Confirm a time (check availability) and put it on the calendar.`;
  assert.ok(
    INDEX_SRC.includes("a time was discussed but nothing is booked. Confirm a time"),
    "the generator's task copy no longer contains the marker phrase"
  );
  assert.equal(isSchedulingLeakTask({ summary: generated }), true);
  assert.equal(generated, LANCE_TASK.summary);
});

check("the reconcile pass still retires this family off the marker", () => {
  assert.ok(
    INDEX_SRC.includes("includes(SCHEDULING_LEAK_TODO_MARKER)"),
    "the state-reconcile retirement no longer keys off the marker — the family would have NO closer"
  );
  assert.ok(
    INDEX_SRC.includes("isSchedulingLeakConversation(conv, now)) continue; // still a live leak"),
    "the retirement's booked/aged-out condition is gone"
  );
});

console.log(failures === 0 ? "\nbooking_task_calendar_close:eval PASS" : `\nbooking_task_calendar_close:eval FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
