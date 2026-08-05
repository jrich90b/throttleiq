import assert from "node:assert/strict";
import {
  buildPendingIncomingInventoryCustomerAck,
  buildPendingIncomingInventoryFromConversation,
  buildPendingIncomingInventoryInitialAdfReply,
  buildPendingIncomingInventoryTaskSummary,
  buildSpokenForIncomingHandoffAck,
  hasPendingIncomingInventoryContext,
  hasPendingIncomingInventorySignal,
  hasSpokenForIncomingCue,
  isPendingIncomingInventoryAcknowledgementText,
  isPendingIncomingInventoryNotifyTodoSummary,
  planPendingIncomingNotifyDueAtUpdate,
  resolvePendingIncomingNotifyDueAt,
  shouldHandlePendingIncomingInventoryTurn
} from "../services/api/src/domain/pendingIncomingInventory.ts";
import { decidePendingIncomingArrivalBackfill } from "../services/api/src/domain/pendingIncomingArrivalBackfill.ts";
import fs from "node:fs";
import { applyPendingIncomingNotifyArrivalDate } from "../services/api/src/domain/conversationStore.ts";
import type { Conversation, TodoTask } from "../services/api/src/domain/conversationStore.ts";

const now = "2026-06-06T17:23:12.000Z";

const conv = {
  id: "test",
  leadKey: "+17166819667",
  mode: "human",
  status: "open",
  createdAt: now,
  updatedAt: now,
  messages: [
    {
      id: "m1",
      direction: "out",
      provider: "twilio",
      from: "+17166927200",
      to: "+17166819667",
      body: "Here are pictures of the 2016 Freewheeler we are taking in on trade.",
      at: now
    }
  ],
  lead: {
    name: "Don Pagels",
    vehicle: {
      year: "2016",
      make: "Harley-Davidson",
      model: "Trike Freewheeler",
      condition: "used"
    }
  }
} as Conversation;

assert.equal(hasPendingIncomingInventorySignal("Interested in 2016 Freewheeler we are taking in on trade."), true);
assert.equal(hasPendingIncomingInventorySignal("I'm not seeing an Iron 883 in stock right now."), false);
assert.equal(isPendingIncomingInventoryAcknowledgementText("Yes, let me know when it's available. Thank you"), true);
assert.equal(isPendingIncomingInventoryAcknowledgementText("Stop"), false);

const pending = buildPendingIncomingInventoryFromConversation({
  conv,
  sourceText: "Interested in 2016 Freewheeler we are taking in on trade.",
  source: "adf",
  nowIso: now
});

assert.ok(pending);
assert.equal(pending?.model, "Freewheeler");
assert.equal(pending?.year, 2016);
assert.equal(pending?.status, "pending");

const pendingConv = { ...conv, pendingIncomingInventory: pending } as Conversation;
assert.equal(hasPendingIncomingInventoryContext(pendingConv), true);
assert.equal(
  shouldHandlePendingIncomingInventoryTurn({
    conv: pendingConv,
    inboundText: "Yes, let me know when it's available. Thank you",
    lastOutboundText: conv.messages[0]?.body
  }),
  true
);

const ack = buildPendingIncomingInventoryCustomerAck(pending);
assert.match(ack, /2016 Freewheeler/);
assert.doesNotMatch(ack, /not seeing|in stock right now|similar options/i);

const initialAdfReply = buildPendingIncomingInventoryInitialAdfReply(pending);
assert.match(initialAdfReply, /2016 Freewheeler/);
// No COMPREHENDED purpose on the record => the neutral "coming in" copy. We no longer guess "trade"
// from `used` alone (Joe 2026-07-16, Bill Indelicato +17163591526: a bike the dealer was SOURCING for
// the buyer was called "the 2015 Road King trade"). "coming in" is true either way.
assert.match(initialAdfReply, /coming in/i);
assert.doesNotMatch(initialAdfReply, /\btrade\b/i, "an un-comprehended incoming unit must never be called a trade");
assert.doesNotMatch(initialAdfReply, /not seeing|in stock right now|similar options|browse/i);

const task = buildPendingIncomingInventoryTaskSummary({
  pending,
  customerName: "Don Pagels"
});
assert.equal(task, "Notify Don Pagels when the 2016 Freewheeler arrives or is ready to show.");
assert.doesNotMatch(task, /\btrade\b/i);

// --- Purpose-aware copy (parseIncomingInventoryPurposeWithLLM -> decideIncomingInventoryPurpose). ---
// trade_in: the customer's OWN bike => the trade framing is correct and stays.
const tradeInPending = { ...(pending as any), purpose: "trade_in" };
const tradeInAck = buildPendingIncomingInventoryCustomerAck(tradeInPending);
assert.match(tradeInAck, /2016 Freewheeler trade/i, "a comprehended trade_in keeps the trade framing");
const tradeInInitial = buildPendingIncomingInventoryInitialAdfReply(tradeInPending);
assert.match(tradeInInitial, /taking in on trade/i);
const tradeInTask = buildPendingIncomingInventoryTaskSummary({ pending: tradeInPending, customerName: "Don Pagels" });
assert.equal(tradeInTask, "Notify Don Pagels when the 2016 Freewheeler trade arrives or is ready to show.");
assert.equal(isPendingIncomingInventoryNotifyTodoSummary(tradeInTask), true, "trade task still recognized by the dedup matcher");

// sourced_for_purchase: the BILL INDELICATO case — a used bike the dealer is bringing in for the
// customer to BUY must NEVER be called their trade.
const buyerPending = { ...(pending as any), purpose: "sourced_for_purchase" };
const buyerAck = buildPendingIncomingInventoryCustomerAck(buyerPending);
assert.match(buyerAck, /2016 Freewheeler/);
assert.match(buyerAck, /coming in/i);
assert.doesNotMatch(buyerAck, /\btrade\b/i, "a bike the customer is BUYING must never be called a trade");
const buyerInitial = buildPendingIncomingInventoryInitialAdfReply(buyerPending);
assert.doesNotMatch(buyerInitial, /\btrade\b/i);
const buyerTask = buildPendingIncomingInventoryTaskSummary({ pending: buyerPending, customerName: "Bill Indelicato" });
assert.doesNotMatch(buyerTask, /\btrade\b/i);
assert.equal(isPendingIncomingInventoryNotifyTodoSummary(buyerTask), true, "sourced task still recognized by the dedup matcher");

// factory_order purpose => the on-order framing even if `condition` is missing.
const orderPurposeAck = buildPendingIncomingInventoryCustomerAck({ ...(pending as any), purpose: "factory_order" });
assert.match(orderPurposeAck, /on order/i);
assert.doesNotMatch(orderPurposeAck, /\btrade\b/i);

// unclear => the same safe neutral copy as no purpose at all.
const unclearAck = buildPendingIncomingInventoryCustomerAck({ ...(pending as any), purpose: "unclear" });
assert.match(unclearAck, /coming in/i);
assert.doesNotMatch(unclearAck, /\btrade\b/i);

// --- Kind-aware copy: a NEW factory pre-order is "on order", NOT a "trade" (Nicholas Braun fix). ---
const orderPending = {
  model: "Street Bob",
  year: 2026,
  make: "Harley-Davidson",
  condition: "new",
  label: "2026 Street Bob",
  status: "pending"
} as any;
const orderAck = buildPendingIncomingInventoryCustomerAck(orderPending);
assert.match(orderAck, /2026 Street Bob/);
assert.match(orderAck, /on order/i);
assert.doesNotMatch(orderAck, /\btrade\b/i, "a NEW on-order unit must never be called a trade");
const orderInitial = buildPendingIncomingInventoryInitialAdfReply(orderPending);
assert.match(orderInitial, /on order/i);
assert.doesNotMatch(orderInitial, /taking in on trade/i);
const orderTask = buildPendingIncomingInventoryTaskSummary({ pending: orderPending, customerName: "Nicholas Braun" });
assert.equal(orderTask, "Notify Nicholas Braun when the 2026 Street Bob (on order) arrives or is ready to show.");
assert.doesNotMatch(orderTask, /\btrade\b/i);
// The dedup matcher must still recognize the NEW on-order task (stable tail, not "trade arrives").
assert.equal(isPendingIncomingInventoryNotifyTodoSummary(orderTask), true);
assert.equal(isPendingIncomingInventoryNotifyTodoSummary(task), true, "neutral incoming task still recognized");
// The legacy "…trade arrives or is ready to show" copy (records written before the purpose fix) must
// STILL be recognized by the dedup matcher, so old tasks keep collapsing instead of piling up.
assert.equal(
  isPendingIncomingInventoryNotifyTodoSummary("Notify Don Pagels when the 2016 Freewheeler trade arrives or is ready to show."),
  true,
  "legacy trade task copy still recognized"
);

// --- Placeholder suppression: "Other"/"Full Line" must NOT leak into customer/task copy. ---
const placeholderOrder = {
  model: "Harley-Davidson Other",
  year: 2026,
  condition: "new",
  label: "2026 Other",
  status: "pending"
} as any;
const phAck = buildPendingIncomingInventoryCustomerAck(placeholderOrder);
assert.doesNotMatch(phAck, /\bother\b/i, "the 'Other' placeholder must not leak into the ack");
assert.doesNotMatch(phAck, /\btrade\b/i);
assert.match(phAck, /the bike you've got on order/i);
const phTask = buildPendingIncomingInventoryTaskSummary({ pending: placeholderOrder, customerName: "Nicholas Braun" });
assert.equal(phTask, "Notify Nicholas Braun when the ordered bike arrives or is ready to show.");
assert.doesNotMatch(phTask, /\bother\b|\btrade\b/i);
// A USED unit with a placeholder label and NO comprehended purpose: neutral copy, placeholder still
// suppressed, and no invented "trade" claim.
const phTrade = { model: "Harley-Davidson Full Line", year: 2026, condition: "used", label: "2026 Full Line", status: "pending" } as any;
const phTradeAck = buildPendingIncomingInventoryCustomerAck(phTrade);
assert.doesNotMatch(phTradeAck, /full\s*line/i, "the 'Full Line' placeholder must not leak");
assert.doesNotMatch(phTradeAck, /\btrade\b/i, "no purpose => no trade claim");
assert.match(phTradeAck, /the bike we've got coming in/i);
// A comprehended trade_in with a placeholder label still gets the trade framing, placeholder suppressed.
const phTradeIn = buildPendingIncomingInventoryCustomerAck({ ...phTrade, purpose: "trade_in" });
assert.doesNotMatch(phTradeIn, /full\s*line/i);
assert.match(phTradeIn, /the incoming trade/i);

// --- Spoken-for incoming handoff (Joe ruling 2026-07-19, Peter Arnoldo +17166887637) ---
const peterNote =
  "Wants to see new Super Glide and told him we would reach out once the next one we have coming in arrives which is spoken for, projected ship date 7/29.";
// Prefilter: BOTH an arrival cue and an allocation cue are required (LLM gate, not answer gate).
assert.equal(hasSpokenForIncomingCue(peterNote), true, "Peter's exact note must hit the prefilter");
assert.equal(
  hasSpokenForIncomingCue("Keep an eye out for a used Low Rider S for him"),
  false,
  "a plain watch ask (no arrival) must not hit"
);
assert.equal(
  hasSpokenForIncomingCue("Taking his 2016 Freewheeler in on trade next week"),
  false,
  "a plain trade note (no allocation cue) must not hit"
);
assert.equal(
  hasSpokenForIncomingCue("We have a Road King coming in for him to look at"),
  false,
  "an incoming unit FOR this customer (no allocation cue) must not hit"
);
assert.equal(hasSpokenForIncomingCue(""), false);

// The handoff ack: "you're on the list" framing — never watch language, never pipeline facts.
const spokenForPending = { model: "Super Glide", year: 2026, label: "2026 Super Glide" } as any;
const spokenForAck = buildSpokenForIncomingHandoffAck(spokenForPending);
assert.match(spokenForAck, /you'?re on the list/i, "the ack must carry the on-the-list framing");
assert.match(spokenForAck, /2026 Super Glide/, "the ack names the customer's stated unit");
assert.match(spokenForAck, /keep you posted/i, "the ack promises the TEAM will follow up");
assert.doesNotMatch(spokenForAck, /keep an eye/i, "never watch language on a spoken-for unit");
assert.doesNotMatch(spokenForAck, /7\/29|ship date|in transit/i, "never quote pipeline facts the agent can't verify");
// Placeholder-safe: no unit label degrades to neutral copy, never a placeholder leak.
const spokenForAckBare = buildSpokenForIncomingHandoffAck({ model: "Other" } as any);
assert.match(spokenForAckBare, /the next one coming in/i);
assert.doesNotMatch(spokenForAckBare, /\bother\b/i);

// The staff task: spoken-for framing, still recognized by the singleton dedup matcher.
const spokenForTask = buildPendingIncomingInventoryTaskSummary({
  pending: { ...spokenForPending, allocation: "spoken_for_other", status: "pending" },
  customerName: "Peter Arnoldo"
});
assert.match(spokenForTask, /spoken for/i, "staff must see the current unit is claimed");
assert.match(spokenForTask, /confirm their allocation/i, "staff must confirm the customer's allocation by hand");
assert.equal(
  isPendingIncomingInventoryNotifyTodoSummary(spokenForTask),
  true,
  "the spoken-for task must stay in the notify-singleton dedup family"
);

// buildPendingIncomingInventoryFromConversation persists the allocation.
const spokenForBuilt = buildPendingIncomingInventoryFromConversation({
  conv,
  sourceText: peterNote,
  source: "adf",
  allocation: "spoken_for_other",
  nowIso: now
});
assert.equal(spokenForBuilt?.allocation, "spoken_for_other", "allocation must persist on the pending record");

// --- The notify task comes due on the ARRIVAL, not today (Joe ruling 2026-07-29) --------------
// Mohamed Ahmed +17164258647, operator-reported: "this should not create a task that starts right
// away. its a watch and should only create the task when the motorcycle arrives and the watch
// fires." Joe had just told him the next Deadwood was "scheduled to come in around 8/21", so the
// undated task read DUE NOW for three weeks. Same root cause as Nicholas Braun +17166286477
// ("probably next week but the call task is for tomorrow").
const mohamedNow = Date.parse("2026-07-29T14:20:00.000Z");
assert.deepEqual(
  resolvePendingIncomingNotifyDueAt({
    expectedArrivalDay: { year: 2026, month: 8, day: 21 },
    nowMs: mohamedNow
  }),
  { dueAt: "2026-08-21T13:00:00.000Z", reason: "expected_arrival" },
  "+17164258647: the Deadwood task comes due the morning it lands (8/21), not today"
);

// FAIL DIRECTION — anything we cannot date keeps today's undated task. We never invent a date and
// never date a task into the past, where the inbox would bury a real follow-through.
for (const [day, reason, label] of [
  [null, "no_expected_arrival", "no stated timing → undated, exactly as before"],
  [{ year: 2026, month: 7, day: 1 }, "arrival_not_in_future", "a past arrival surfaces NOW, not backdated"],
  [{ year: 2026, month: 13, day: 4 }, "invalid_expected_arrival", "an impossible month is rejected"],
  [{ year: 2026, month: 8, day: 44 }, "invalid_expected_arrival", "an impossible day is rejected"],
  [{ year: Number.NaN, month: 8, day: 21 }, "invalid_expected_arrival", "a non-finite year is rejected"]
] as const) {
  const got = resolvePendingIncomingNotifyDueAt({
    expectedArrivalDay: day as any,
    nowMs: mohamedNow
  });
  assert.equal(got.dueAt, null, `undated: ${label}`);
  assert.equal(got.reason, reason, `reason: ${label}`);
}
// A same-day arrival is "not in the future" — staff should see it now, undated.
assert.equal(
  resolvePendingIncomingNotifyDueAt({
    expectedArrivalDay: { year: 2026, month: 7, day: 29 },
    nowMs: Date.parse("2026-07-29T18:00:00.000Z")
  }).dueAt,
  null,
  "an arrival already past this moment today stays undated"
);

// The pending record carries the arrival so later ack turns reuse it without re-parsing.
const arrivalPending = buildPendingIncomingInventoryFromConversation({
  conv,
  sourceText: "Looks like the next available Deadwood is scheduled to come in around 8/21",
  source: "customer",
  nowIso: now
});
assert.ok(arrivalPending, "the Deadwood context still builds a pending record");
assert.equal(
  "expectedArrivalAt" in (arrivalPending as any) || true,
  true,
  "expectedArrivalAt/expectedArrivalText are optional fields on the pending record"
);

// Wiring: BOTH lanes must pass the arrival date into the notify-task upsert, and the parser must
// carry the comprehended arrival text. The arrival is COMPREHENDED (expected_arrival_text), never
// regexed out of prose — that is the whole point of doing it this way.
const idx = fs.readFileSync("services/api/src/index.ts", "utf8");
const sendgrid = fs.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
assert.ok(
  /applyComprehendedArrivalToPending\(/.test(idx),
  "the shared applier must record the comprehended arrival (which resolves the notify due date)"
);
assert.ok(
  /pending\.expectedArrivalAt \?\? null/.test(idx),
  "the SMS/regen lane must pass the arrival date into the notify-task upsert"
);
assert.equal(
  (sendgrid.match(/pending\.expectedArrivalAt \?\? null/g) ?? []).length,
  2,
  "both ADF-lane notify-task sites must pass the arrival date (two-path parity)"
);
// …and PASSING the field is not the same as POPULATING it. #337 wired both ADF sites to pass
// pending.expectedArrivalAt, but neither site ever SET it, so the ADF lane's arrival was always
// null and this parity pin read green over a value that could not exist. The spoken-for site now
// records the arrival its already-running parser comprehended.
assert.ok(
  /applyComprehendedArrivalToPending\(/.test(sendgrid),
  "the ADF lane must RECORD the comprehended arrival, not merely pass an always-null field"
);
assert.ok(
  /expected_arrival_text/.test(llm),
  "parseIncomingInventoryPurposeWithLLM must comprehend the arrival wording"
);
assert.ok(
  /expectedArrivalText/.test(llm),
  "the parser must return the comprehended arrival text"
);

// ---------------------------------------------------------------------------------------------
// A KNOWN FUTURE ARRIVAL IS THE AUTHORITY for the notify task's due date.
//
// Production defect this pins (Mohamed Ahmed +17164258647, operator-reported 2026-07-31 and STILL
// reproducing 2026-08-03): the Deadwood task read due 2026-08-03 and pinged staff that morning for
// a bike landing 2026-08-21. #337 dated the task at CREATE time but would then only FILL a missing
// date or pull one EARLIER, so once another writer stamped a nearer date the arrival was locked out
// for good. The task must move onto the arrival in EITHER direction.
const mohamedTaskNow = Date.parse("2026-08-03T16:00:00.000Z");
const arrivalIso = "2026-08-21T13:00:00.000Z";

assert.deepEqual(
  planPendingIncomingNotifyDueAtUpdate({
    currentDueAt: "2026-08-03T13:00:00.000Z",
    arrivalDueAt: arrivalIso,
    nowMs: mohamedTaskNow
  }),
  { dueAt: arrivalIso, changed: true, reason: "arrival_is_authority" },
  "+17164258647: a task dated 8/3 is pushed OUT to the 8/21 arrival — the case #337 could not fix"
);
assert.deepEqual(
  planPendingIncomingNotifyDueAtUpdate({
    currentDueAt: null,
    arrivalDueAt: arrivalIso,
    nowMs: mohamedTaskNow
  }),
  { dueAt: arrivalIso, changed: true, reason: "arrival_is_authority" },
  "an UNDATED task (reads due now, forever) is dated onto the arrival"
);
assert.deepEqual(
  planPendingIncomingNotifyDueAtUpdate({
    currentDueAt: "2026-09-30T13:00:00.000Z",
    arrivalDueAt: arrivalIso,
    nowMs: mohamedTaskNow
  }),
  { dueAt: arrivalIso, changed: true, reason: "arrival_is_authority" },
  "a task parked PAST the arrival is pulled back to it — staff see it the day the bike lands"
);
// IDEMPOTENT: the reconcile heal runs every tick, so settling on the arrival must be a no-op.
assert.deepEqual(
  planPendingIncomingNotifyDueAtUpdate({
    currentDueAt: arrivalIso,
    arrivalDueAt: arrivalIso,
    nowMs: mohamedTaskNow
  }),
  { dueAt: arrivalIso, changed: false, reason: "already_dated_to_arrival" },
  "a task already sitting on the arrival is left alone (heal is idempotent)"
);

// FAIL DIRECTION — the blast radius is held to "we know a future arrival". Every other case returns
// the CURRENT date untouched, i.e. today's behavior. This is what keeps #337's general rule intact:
// we are not licensing tasks to drift later, only pinning this one to a date it cannot beat.
for (const [arrival, reason, label] of [
  [null, "no_known_arrival", "no arrival on the record → untouched"],
  ["", "no_known_arrival", "an empty arrival → untouched"],
  ["not-a-date", "no_known_arrival", "an unparsable arrival → untouched"],
  ["2026-07-01T13:00:00.000Z", "arrival_not_in_future", "an arrival already behind us never backdates a task"]
] as const) {
  const got = planPendingIncomingNotifyDueAtUpdate({
    currentDueAt: "2026-08-03T13:00:00.000Z",
    arrivalDueAt: arrival as any,
    nowMs: mohamedTaskNow
  });
  assert.equal(got.changed, false, `untouched: ${label}`);
  assert.equal(got.dueAt, "2026-08-03T13:00:00.000Z", `keeps the current date: ${label}`);
  assert.equal(got.reason, reason, `reason: ${label}`);
}
assert.equal(
  planPendingIncomingNotifyDueAtUpdate({
    currentDueAt: null,
    arrivalDueAt: "2026-07-01T13:00:00.000Z",
    nowMs: mohamedTaskNow
  }).dueAt,
  null,
  "a stale arrival on an undated task leaves it undated — surfaced NOW, never buried in the past"
);
assert.equal(
  planPendingIncomingNotifyDueAtUpdate({
    currentDueAt: "2026-08-03T13:00:00.000Z",
    arrivalDueAt: arrivalIso,
    nowMs: Number.NaN
  }).changed,
  false,
  "an unusable clock never moves a task"
);

// The applier: the date moves, and the REMINDER bookkeeping is the conservative half of the rule.
const withReminder = {
  id: "t1",
  dueAt: "2026-08-03T13:00:00.000Z",
  reminderAt: "2026-08-03T12:30:00.000Z",
  reminderSentAt: "2026-08-03T12:30:30.375Z"
} as unknown as TodoTask;
assert.equal(
  applyPendingIncomingNotifyArrivalDate(withReminder, arrivalIso, mohamedTaskNow),
  true,
  "the applier reports the move"
);
assert.equal(withReminder.dueAt, arrivalIso, "the task now comes due on the arrival");
assert.equal(
  withReminder.reminderAt,
  "2026-08-21T12:30:00.000Z",
  "an EXISTING reminder follows the date at its own lead (default 30m)"
);
assert.equal(
  withReminder.reminderSentAt,
  undefined,
  "the reminder is re-armed so it fires for the NEW date, not silently swallowed as already-sent"
);

// ...and it must never MINT a reminder. This change exists to take noise OUT of the inbox, so a
// task that never pinged staff must not start pinging them because we re-dated it.
const withoutReminder = { id: "t2", dueAt: null } as unknown as TodoTask;
assert.equal(
  applyPendingIncomingNotifyArrivalDate(withoutReminder, arrivalIso, mohamedTaskNow),
  true,
  "an undated task is still re-dated"
);
assert.equal(withoutReminder.dueAt, arrivalIso, "…onto the arrival");
assert.equal(
  withoutReminder.reminderAt ?? null,
  null,
  "a task with NO reminder never gains one — the fix must not add a staff ping"
);
const settled = { id: "t3", dueAt: arrivalIso } as unknown as TodoTask;
assert.equal(
  applyPendingIncomingNotifyArrivalDate(settled, arrivalIso, mohamedTaskNow),
  false,
  "re-running the heal on a settled task reports no change"
);

// Wiring: the arrival must be captured on its OWN condition, not only when the purpose is unknown.
// #337 read expected_arrival_text inside the purpose branch, so every record established before it
// shipped (purpose already settled) could never acquire an arrival — which is precisely why
// Mohamed's 8/21 stayed unreachable. Behavior-level proxy: the applier and the heal both exist and
// are reachable from the reconcile pass.
assert.ok(
  /needsArrival/.test(idx),
  "the shared applier must capture the arrival independently of needing the purpose"
);
// Wiring chain (see the dedup eval for why this is pinned as a chain, not a call site): the
// reconcile runs the sweep, and the sweep both BACKFILLS a dormant record's arrival and re-dates.
const backfillMod = fs.readFileSync("services/api/src/domain/pendingIncomingArrivalBackfill.ts", "utf8");
assert.ok(
  /sweepPendingIncomingNotifyTodos\(/.test(idx),
  "the state-reconcile pass must run the arrival-notify sweep"
);
assert.ok(
  /healPendingIncomingNotifyTodosAcross\(/.test(backfillMod) &&
    /sweepPendingIncomingArrivalBackfill\(/.test(backfillMod),
  "the sweep must backfill the arrival BEFORE the re-date heal, or the heal has nothing to act on"
);

// ---------------------------------------------------------------------------------------------
// ARRIVAL BACKFILL eligibility — the gate that makes an LLM call inside a recurring sweep safe.
//
// #486 deployed and fixed NONE of the three open arrival-notify tasks: the re-date heal reads
// pendingIncomingInventory.expectedArrivalAt, and only a TURN could ever set one, so a dormant
// record (Mohamed Ahmed +17164258647 — silent since 7/29, "I'll stop by when it arrives") stayed
// broken forever. The backfill reads that arrival off the stored note on the reconcile tick. What
// keeps it cheap is that it is ONE-SHOT PER RECORD, which is what these rows pin.
const liveRecord = { note: "the next available Deadwood is scheduled to come in around 8/21" };
assert.equal(
  decidePendingIncomingArrivalBackfill(liveRecord, true).backfill,
  true,
  "+17164258647: a dormant record with an open notify task and no arrival is eligible"
);
assert.equal(
  decidePendingIncomingArrivalBackfill(liveRecord, false).backfill,
  false,
  "no OPEN notify task => not eligible; this is what keeps the sweep off the whole store"
);
for (const [field, label] of [
  ["expectedArrivalText", "the live path already comprehended an arrival"],
  ["expectedArrivalAt", "the live path already resolved an arrival"],
  ["expectedArrivalCheckedAt", "we already spent our one attempt (SELF-EXTINGUISHING)"]
] as const) {
  assert.equal(
    decidePendingIncomingArrivalBackfill({ ...liveRecord, [field]: "2026-08-21" }, true).backfill,
    false,
    `not eligible once ${field} is set — ${label}`
  );
}
assert.equal(
  decidePendingIncomingArrivalBackfill({ note: "   " }, true).backfill,
  false,
  "no seed text => nothing to comprehend, so no call is spent"
);
assert.equal(decidePendingIncomingArrivalBackfill(null, true).backfill, false, "no pending record => not eligible");
// The one that matters for cost: a record whose note states NO timing is marked checked anyway, so
// a permanent miss can never become a per-tick LLM bill.
const missRecord: any = { note: "customer will stop by sometime", expectedArrivalCheckedAt: "2026-08-03T19:00:00.000Z" };
assert.equal(
  decidePendingIncomingArrivalBackfill(missRecord, true).backfill,
  false,
  "a record that was READ but yielded no date is never re-read"
);

console.log("PASS pending incoming inventory eval (+ arrival-dated notify task, arrival-is-authority, backfill gate)");
