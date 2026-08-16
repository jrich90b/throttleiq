/**
 * sold_sale_record_idempotency:eval — a sale happens ONCE. Recording an outcome about it later is
 * not a second sale.
 *
 * THE PRODUCTION MISS (Ethan Mouyeos +17166970787, raised by Joe 2026-08-16). He bought a 2008 Dyna
 * Fat Bob on 2026-04-15 and his owner sequence had already run — day 1 in April and day 60 on
 * 2026-06-13, which he answered. On 2026-08-16 Joe worked a digest list of appointments still
 * missing an outcome and recorded "showed -> sold" on that April appointment. Two independent
 * defects fired off that one click:
 *
 *   1. `conv.sale` was REPLACED wholesale. The console header's appointment-outcome branch stamps
 *      `soldAt: now`, attributes the sale to whoever took the APPOINTMENT, and names the bike off
 *      `lead.vehicle` — the bike the customer INQUIRED about, not the one they bought. The true
 *      sale date, the true unit label and the cadence anchor all became that afternoon's timestamp.
 *      A sibling writer, `applyUnitLessSoldSaleStub`, has refused exactly this since it was written
 *      (`if (conv.sale?.soldAt) return null`) and its own comment names the wrong-bike trap — so
 *      the LEAST careful of the three writers carried the WEAKEST data.
 *
 *   2. `post_sale` re-armed at step 0. `decideCadenceStart`'s post_sale arm was `start = sold ===
 *      true` and nothing else, so any sold signal rebuilt the owner sequence from day one. Ethan
 *      was queued for a day-ONE owner text the next morning, on a bike bought four months earlier,
 *      and the real 1-year anniversary step was re-dated to a year after the clean-up. Six more
 *      names on that same digest list would each have done the same thing.
 *
 * WHAT IS PINNED HERE — the two invariants, as BEHAVIOR (no source-text pins):
 *
 *   A. `soldAt` never moves FORWARD. A later sold signal may ENRICH a recorded sale (fill a field
 *      the stored record left empty, append its note) but may never restate the date, re-attribute
 *      the sale, or replace a NAMED unit with a lead-record guess. Filling an empty field and
 *      overwriting a set one are different acts, so the legitimate correction the stub's comment
 *      describes — a unit-less stub later given a real bike — still works.
 *
 *   B. The owner sequence is keyed to the SALE. An existing post_sale cadence anchored to this
 *      sale's `soldAt` means the sequence is already running and must be left where it is. A
 *      genuinely different sale still arms normally, and a caller that passes no `saleSoldAt`
 *      keeps today's behavior rather than going silent.
 *
 * The two are COUPLED and the test order matters: with (A) in place a back-filled outcome no
 * longer moves `soldAt`, so the running cadence's anchor still matches and (B) refuses. Either
 * fix alone leaves the replay reachable, which is why they ship together and are pinned together.
 *
 * FAIL DIRECTION. Preserving the earlier record keeps the truth we already had, and refusing to
 * re-arm leaves the customer on the schedule the real sale put them on. Overwriting is the unsafe
 * direction: it silently downgrades the sale date, the commission attribution and which unit was
 * sold, and it replays day-one copy at someone who bought months ago.
 *
 * NOT ASSERTED HERE, on purpose: this fix is FORWARD-ONLY. Ethan's own record was already
 * overwritten before it shipped and needs a data repair, not a code fix — see the
 * `second-sold-signal-overwrites-the-sale-and-replays-post-sale` memory for the recovered values.
 *
 * Behavior assertions only — no source-text pins (see eval_source_pin_ratchet:eval).
 *
 * Run: npx tsx scripts/sold_sale_record_idempotency_eval.ts
 */
import assert from "node:assert/strict";
import { decideCadenceStart, decideSoldSaleRecord } from "../services/api/src/domain/routeStateReducer.ts";

const failures: string[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures.push(`${name}: ${(err as Error).message}`);
    console.log(`FAIL ${name}: ${(err as Error).message}`);
  }
}

const APRIL_SALE = {
  soldAt: "2026-04-15T19:30:03.963Z",
  soldById: "giovanni",
  soldByName: "Giovanni Boccabella",
  stockId: "U577-08",
  vin: "1HD1GN4128K123456",
  label: "2008 Harley-Davidson Fat Bob",
  note: "Delivered."
};

/** The console header's appointment-outcome "sold" branch, shaped exactly as it builds its record. */
const BACKFILLED_OUTCOME = {
  soldAt: "2026-08-16T12:07:57.482Z",
  soldById: "appointment-taker",
  soldByName: "Appointment Taker",
  stockId: "",
  vin: "",
  label: "2008 Harley-Davidson Dyna Fat Bob (Efi)",
  note: "showed / sold"
};

// === A. the sale record ==========================================================================

check("a1 back-filled outcome keeps the REAL sale date, not today's", () => {
  const d = decideSoldSaleRecord({ existing: APRIL_SALE, incoming: BACKFILLED_OUTCOME });
  assert.equal(d.sale.soldAt, APRIL_SALE.soldAt);
  assert.equal(d.preservedExistingSale, true);
});

check("a2 back-filled outcome does not re-attribute the sale to whoever took the appointment", () => {
  const d = decideSoldSaleRecord({ existing: APRIL_SALE, incoming: BACKFILLED_OUTCOME });
  assert.equal(d.sale.soldById, "giovanni");
  assert.equal(d.sale.soldByName, "Giovanni Boccabella");
});

check("a3 a NAMED unit is never replaced by the lead-record guess (the #470 wrong-bike trap)", () => {
  const d = decideSoldSaleRecord({ existing: APRIL_SALE, incoming: BACKFILLED_OUTCOME });
  assert.equal(d.sale.stockId, "U577-08");
  assert.equal(d.sale.vin, APRIL_SALE.vin);
  assert.equal(d.sale.label, "2008 Harley-Davidson Fat Bob");
});

check("a4 the outcome note is KEPT — the outcome is real information about the deal", () => {
  const d = decideSoldSaleRecord({ existing: APRIL_SALE, incoming: BACKFILLED_OUTCOME });
  assert.ok(String(d.sale.note ?? "").includes("showed / sold"));
  assert.ok(String(d.sale.note ?? "").includes("Delivered."));
});

check("a5 a first sale is stamped as-is — the guard only ever protects an EXISTING record", () => {
  const d = decideSoldSaleRecord({ existing: null, incoming: BACKFILLED_OUTCOME });
  assert.equal(d.sale.soldAt, BACKFILLED_OUTCOME.soldAt);
  assert.equal(d.preservedExistingSale, false);
});

check("a5b a record with no soldAt is not a sale — the incoming signal owns it", () => {
  const d = decideSoldSaleRecord({ existing: { note: "walk-in logged" }, incoming: BACKFILLED_OUTCOME });
  assert.equal(d.sale.soldAt, BACKFILLED_OUTCOME.soldAt);
  assert.equal(d.preservedExistingSale, false);
});

check("a6 a unit-less STUB may still be given a real bike — enrichment, not restatement", () => {
  const stub = { soldAt: "2026-05-01T10:00:00.000Z", note: "Sold, unit not named." };
  const d = decideSoldSaleRecord({
    existing: stub,
    incoming: { ...BACKFILLED_OUTCOME, stockId: "U901-24", label: "2024 Street Glide" }
  });
  assert.equal(d.sale.soldAt, stub.soldAt, "the stub's date is still the sale date");
  assert.equal(d.sale.stockId, "U901-24", "the real bike fills the empty unit");
  assert.equal(d.sale.label, "2024 Street Glide");
  assert.ok(d.enrichedFields.includes("unit"));
});

check("a7 an empty attribution is filled, a set one is not", () => {
  const d = decideSoldSaleRecord({
    existing: { soldAt: "2026-05-01T10:00:00.000Z", stockId: "U901-24" },
    incoming: BACKFILLED_OUTCOME
  });
  assert.equal(d.sale.soldById, "appointment-taker", "empty attribution takes the incoming value");
  assert.equal(d.sale.stockId, "U901-24", "a named unit still wins");
  assert.ok(d.enrichedFields.includes("soldById"));
});

check("a8 replaying the SAME outcome twice is inert — no duplicated note, no drift", () => {
  const once = decideSoldSaleRecord({ existing: APRIL_SALE, incoming: BACKFILLED_OUTCOME });
  const twice = decideSoldSaleRecord({ existing: once.sale, incoming: BACKFILLED_OUTCOME });
  assert.deepEqual(twice.sale, once.sale);
  assert.equal(twice.sale.note, once.sale.note);
});

check("a9 the unit is decided as ONE fact — a named record never pairs one bike's id with another's label", () => {
  const d = decideSoldSaleRecord({
    existing: { soldAt: "2026-05-01T10:00:00.000Z", stockId: "U577-08", label: "2008 Fat Bob" },
    incoming: { ...BACKFILLED_OUTCOME, stockId: "U901-24", vin: "OTHERVIN", label: "2024 Street Glide" }
  });
  assert.equal(d.sale.stockId, "U577-08");
  assert.equal(d.sale.label, "2008 Fat Bob");
  assert.equal(d.sale.vin ?? null, null, "the other bike's VIN must not be grafted on");
});

// === B. the owner sequence =======================================================================

const RUNNING_POST_SALE = {
  status: "active",
  kind: "post_sale",
  anchorAt: APRIL_SALE.soldAt,
  stepIndex: 1
};

check("b1 a re-recorded outcome does NOT re-arm an owner sequence already running for that sale", () => {
  const d = decideCadenceStart({
    lane: "post_sale",
    conversationStatus: "closed",
    existing: RUNNING_POST_SALE,
    sold: true,
    saleSoldAt: APRIL_SALE.soldAt
  });
  assert.equal(d.start, false);
  assert.match(d.why, /already running/);
});

check("b2 a STOPPED owner sequence for that sale is not quietly revived either", () => {
  const d = decideCadenceStart({
    lane: "post_sale",
    conversationStatus: "closed",
    existing: { ...RUNNING_POST_SALE, status: "stopped" },
    sold: true,
    saleSoldAt: APRIL_SALE.soldAt
  });
  assert.equal(d.start, false);
});

check("b3 a genuinely NEW sale still arms the owner sequence", () => {
  const d = decideCadenceStart({
    lane: "post_sale",
    conversationStatus: "closed",
    existing: RUNNING_POST_SALE,
    sold: true,
    saleSoldAt: "2026-08-16T12:07:57.482Z"
  });
  assert.equal(d.start, true);
});

check("b4 a first sale with no cadence at all still arms", () => {
  const d = decideCadenceStart({
    lane: "post_sale",
    conversationStatus: "closed",
    existing: null,
    sold: true,
    saleSoldAt: APRIL_SALE.soldAt
  });
  assert.equal(d.start, true);
});

check("b5 a PRE-sale chase is still replaced — the buyer must come off the sales ladder", () => {
  const d = decideCadenceStart({
    lane: "post_sale",
    conversationStatus: "closed",
    existing: { status: "active", kind: "standard", anchorAt: "2026-03-01T00:00:00.000Z" },
    sold: true,
    saleSoldAt: APRIL_SALE.soldAt
  });
  assert.equal(d.start, true, "only a post_sale cadence for THIS sale blocks the arm");
  assert.equal(d.replacesActiveCadence, true);
});

check("b6 a caller that passes no saleSoldAt keeps today's behavior, not silence", () => {
  const d = decideCadenceStart({
    lane: "post_sale",
    conversationStatus: "closed",
    existing: RUNNING_POST_SALE,
    sold: true
  });
  assert.equal(d.start, true);
});

check("b7 nothing says it sold — still refused, and for the ORIGINAL reason", () => {
  const d = decideCadenceStart({
    lane: "post_sale",
    conversationStatus: "closed",
    existing: null,
    sold: false,
    saleSoldAt: null
  });
  assert.equal(d.start, false);
  assert.match(d.why, /nothing on this lead says it sold/);
});

check("b8 the other lanes are untouched by the post_sale clause", () => {
  const ramp = decideCadenceStart({
    lane: "standard_ramp",
    conversationStatus: "open",
    existing: null,
    saleSoldAt: APRIL_SALE.soldAt
  });
  assert.equal(ramp.start, true);
  const longTerm = decideCadenceStart({
    lane: "deferred_long_term",
    conversationStatus: "open",
    existing: RUNNING_POST_SALE,
    saleSoldAt: APRIL_SALE.soldAt
  });
  assert.equal(longTerm.start, true);
});

// === C. the two fixes together — the actual production sequence ==================================

check("c1 the FULL Ethan sequence: outcome recorded in August on an April sale replays nothing", () => {
  // 1. the outcome lands and the referee decides what the sale record becomes
  const saleAfter = decideSoldSaleRecord({ existing: APRIL_SALE, incoming: BACKFILLED_OUTCOME }).sale;
  // 2. the sold path then asks whether to arm the owner sequence, keyed on that record
  const cadence = decideCadenceStart({
    lane: "post_sale",
    conversationStatus: "closed",
    existing: RUNNING_POST_SALE,
    sold: true,
    saleSoldAt: saleAfter.soldAt ?? null
  });
  assert.equal(saleAfter.soldAt, APRIL_SALE.soldAt, "the April sale survived the August outcome");
  assert.equal(cadence.start, false, "no day-one owner text was queued");
});

check("c2 the coupling is real: had the sale been restated, the sequence WOULD have re-armed", () => {
  // The counterfactual that proves (A) and (B) are load-bearing together rather than one masking
  // the other — this is the pre-fix behavior, reconstructed from the referee's own inputs.
  const cadence = decideCadenceStart({
    lane: "post_sale",
    conversationStatus: "closed",
    existing: RUNNING_POST_SALE,
    sold: true,
    saleSoldAt: BACKFILLED_OUTCOME.soldAt
  });
  assert.equal(cadence.start, true);
});

if (failures.length) {
  console.error(`\nsold_sale_record_idempotency:eval FAILED (${failures.length})`);
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`\nsold_sale_record_idempotency:eval PASSED`);
