/**
 * customer_risk_referees:eval — the last four referees over state where a mistake reaches a customer.
 *
 * Joe's triage test (2026-08-02): can a mistake in this field TEXT a customer, CLOSE a lead, or
 * BOOK/KILL an appointment? These four were the last write sites on that list still deciding for
 * themselves, so every rule below used to live only inside one call site's body with no name and no
 * test aimed at it. BEHAVIOUR ASSERTIONS ONLY — nothing here pins source text.
 *
 *   1. decideStaleBookingReplacement  — which parts of an EXPIRED booking die when a new time
 *                                       replaces them (appointment)
 *   2. decideHealthRecoveryPause      — how long a recovering customer's chase stays paused, and
 *                                       whether a standing later pause wins (followUpCadence)
 *   3. decideStaffReopenResidue       — what closeout residue a staff Reopen undoes (followUpCadence)
 *   4. resolveInventoryWatchDefaults  — how a half-specified watch's blanks get filled, which is
 *                                       what decides WHICH ARRIVING UNIT TEXTS THIS CUSTOMER
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import {
  decideStaleBookingReplacement,
  decideHealthRecoveryPause,
  decideStaffReopenResidue,
  resolveInventoryWatchDefaults
} from "../services/api/src/domain/routeStateReducer.ts";

let checks = 0;
const eq = (actual: unknown, expected: unknown, msg: string) => {
  checks += 1;
  assert.deepEqual(actual, expected, msg);
};

// ── 1. STALE BOOKING REPLACEMENT ─────────────────────────────────────────────────────────────
// An expired booking is being replaced: the calendar identity all dies together. Leave any of it
// and a later cancel or reschedule edits the wrong Google event, and the confirmation names the rep
// who owned the dead slot.
{
  const d = decideStaleBookingReplacement({
    confirmsPendingRequest: true,
    existingBookedAppointmentIsPast: true
  });
  eq(d.clearBookedEvent, true, "an expired booking's calendar event is wiped");
  eq(d.clearBookedSalesperson, true, "…and the rep who owned the dead slot");
  eq(d.clearMatchedSlot, true, "…and the availability row it came from");
}
// A LIVE booking is never torn down from this lane. This is the fail-unsafe direction: rebooking
// over a good appointment from a "see you then" text is the failure the dedupe guard exists to stop.
{
  const d = decideStaleBookingReplacement({
    confirmsPendingRequest: true,
    existingBookedAppointmentIsPast: false
  });
  eq(d.clearBookedEvent, false, "a LIVE booking is never wiped by a confirm-the-pending-request text");
  eq(d.clearBookedSalesperson, false, "…nor its rep");
  eq(d.clearMatchedSlot, false, "…nor its matched slot");
}
{
  const d = decideStaleBookingReplacement({
    confirmsPendingRequest: false,
    existingBookedAppointmentIsPast: true
  });
  eq(d.clearBookedEvent, false, "a text that confirmed nothing wipes nothing, expired booking or not");
}

// ── 2. HEALTH-RECOVERY PAUSE ─────────────────────────────────────────────────────────────────
const NOW = Date.parse("2026-08-05T12:00:00.000Z");
const FALLBACK = "2026-08-26T13:00:00.000Z"; // now + 21 days, resolved by the caller
// THE RULE THAT MATTERS. Every inbound from a recovering customer re-enters this lane. Without
// "a standing future pause wins", each "thanks" they send slides the pause back to today + N and the
// chase creeps forward on someone who is unwell.
{
  const d = decideHealthRecoveryPause({
    currentPausedUntil: "2026-09-30T13:00:00.000Z",
    fallbackUntilIso: FALLBACK,
    nowMs: NOW
  });
  eq(d.pausedUntilIso, "2026-09-30T13:00:00.000Z", "a pause already standing in the future is KEPT");
  eq(d.keptExisting, true, "…and says so");
}
{
  const d = decideHealthRecoveryPause({
    currentPausedUntil: "2026-07-01T13:00:00.000Z",
    fallbackUntilIso: FALLBACK,
    nowMs: NOW
  });
  eq(d.pausedUntilIso, FALLBACK, "a pause already in the PAST is not a pause — restart the delay");
}
{
  const d = decideHealthRecoveryPause({ currentPausedUntil: null, fallbackUntilIso: FALLBACK, nowMs: NOW });
  eq(d.pausedUntilIso, FALLBACK, "no pause on the record — start one");
  eq(d.keptExisting, false, "…and it is a fresh one");
}
// A junk date must NOT read as "already paused": that would leave pausedUntil = Invalid Date and the
// chase would never resume at all — a lead silently parked forever.
{
  const d = decideHealthRecoveryPause({
    currentPausedUntil: "not-a-date",
    fallbackUntilIso: FALLBACK,
    nowMs: NOW
  });
  eq(d.pausedUntilIso, FALLBACK, "an unparseable pause is replaced, never carried through as-is");
  eq(d.keptExisting, false, "…and is not counted as an existing pause");
}

// ── 3. STAFF REOPEN RESIDUE ──────────────────────────────────────────────────────────────────
const reopen = (over: Partial<Parameters<typeof decideStaffReopenResidue>[0]> = {}) =>
  decideStaffReopenResidue({
    hasCadence: false,
    cadenceKind: null,
    cadenceStatus: null,
    cadenceStopReason: null,
    followUpReason: null,
    dialogState: null,
    hasSale: false,
    ...over
  });

// THE ORDER RULE. A post-sale chase is blanked, and blanking it is also what stops the revive arm
// from resurrecting a delivery-congrats ladder onto a deal whose sale was just un-done. Both arms
// would otherwise claim the same record — the reason they are two flags and not one.
{
  const d = reopen({
    hasCadence: true,
    cadenceKind: "post_sale",
    cadenceStatus: "stopped",
    cadenceStopReason: "customer_stepping_back",
    hasSale: true
  });
  eq(d.blankPostSaleCadence, true, "a post-sale chase does not survive un-doing the sale");
  eq(
    d.reviveDispositionCadence,
    false,
    "…and is NEVER revived, even carrying a disposition stopReason — that would re-fire delivery congrats"
  );
  eq(d.clearSale, true, "the sale record goes with it");
}
// The zombie reopen this exists to prevent (Dave Batka 2026-06-11): reopen alone left followUp
// paused_indefinite / customer_sell_on_own and the cadence stopped — open thread, dead chase.
{
  const d = reopen({
    hasCadence: true,
    cadenceStatus: "stopped",
    cadenceStopReason: "customer_sell_on_own",
    followUpReason: "customer_sell_on_own",
    dialogState: "customer_sell_on_own"
  });
  eq(d.reviveDispositionCadence, true, "staff reopening a lead they archived as a disposition restarts the chase");
  eq(d.clearDispositionFollowUp, true, "…the disposition follow-up reason is cleared");
  eq(d.resetDispositionDialogState, true, "…and the dialog state stops claiming the lead stepped back");
}
// A chase stopped for something ELSE keeps its own stop. Opting out, a hold and a human handoff are
// not dispositions, and reviving one would text a customer who asked us to stop.
for (const stopReason of ["opt_out", "manual_handoff", "holding_inventory", "ack_after_soft_close"]) {
  const d = reopen({ hasCadence: true, cadenceStatus: "stopped", cadenceStopReason: stopReason });
  eq(d.reviveDispositionCadence, false, `a chase stopped for ${stopReason} is NOT revived by a reopen`);
}
// An already-active chase is left alone rather than restarted at rung zero.
{
  const d = reopen({ hasCadence: true, cadenceStatus: "active", cadenceStopReason: "customer_deferred" });
  eq(d.reviveDispositionCadence, false, "an ACTIVE chase is not restarted at rung zero by a reopen");
}
// A cadence record with no `status` reads as not-active and IS revived — the literal behaviour of the
// handler this replaced (`status !== "active"` over a missing status is true), and the right one: a
// statusless record carrying a disposition stopReason is a stopped chase either way.
{
  const d = reopen({ hasCadence: true, cadenceStatus: null, cadenceStopReason: "customer_deferred" });
  eq(d.reviveDispositionCadence, true, "a statusless cadence with a disposition stop is still revived");
}
// No cadence record at all — nothing to revive, and nothing to blank.
{
  const d = reopen({ hasCadence: false, cadenceStopReason: "customer_deferred" });
  eq(d.reviveDispositionCadence, false, "no cadence record means nothing to revive");
}
{
  const d = reopen({ followUpReason: "post_sale" });
  eq(d.clearPostSaleFollowUp, true, "a post-sale follow-up reason is cleared on reopen");
  eq(d.clearDispositionFollowUp, false, "…and post_sale is not itself a disposition reason");
}

// ── 4. INVENTORY-WATCH DEFAULTS ──────────────────────────────────────────────────────────────
const watch = (over: Partial<Parameters<typeof resolveInventoryWatchDefaults>[0]> = {}) =>
  resolveInventoryWatchDefaults({
    watchMake: null,
    watchTrim: null,
    watchCondition: null,
    leadMake: null,
    leadTrim: null,
    conditionFromText: null,
    semanticCondition: undefined,
    conditionFromLead: null,
    ...over
  });

// ONLY EVER FILL A BLANK. What the customer described outranks anything we infer for them; a
// default that overwrote a stated preference would alert them about the wrong bike.
{
  const d = watch({ watchMake: "Indian", leadMake: "Harley-Davidson", watchCondition: "used", conditionFromLead: "new" });
  eq(d.make, undefined, "a make the customer stated is never overwritten by the lead record");
  eq(d.condition, undefined, "…nor a condition they stated");
  eq(d.conditionSource, "already_set", "…and the source says so");
}
{
  const d = watch({ leadMake: "Harley-Davidson", leadTrim: "CVO" });
  eq(d.make, "Harley-Davidson", "a blank make is filled from the lead record");
  eq(d.trim, "CVO", "…and a blank trim");
}
// THE LADDER ORDER. What they said THIS TURN beats what the parser inferred, which beats the lead
// record. Reversed, a stale "new" on the lead record alerts someone who asked for a used bike.
{
  eq(
    watch({ conditionFromText: "used", semanticCondition: "new", conditionFromLead: "new" }).condition,
    "used",
    "the customer's own words outrank both the parser and the lead record"
  );
  eq(
    watch({ semanticCondition: "used", conditionFromLead: "new" }).conditionSource,
    "parser",
    "the parser's reading of this turn outranks the lead record"
  );
  eq(watch({ conditionFromLead: "new" }).conditionSource, "lead_record", "the lead record is the last rung");
  eq(watch({}).conditionSource, "none", "nothing to go on leaves the watch unconditioned, not guessed");
}
// "unknown" and "any" are the parser saying it COULD NOT TELL. Treating either as a condition would
// pin the watch to a literal condition the customer never named.
for (const nonAnswer of ["unknown", "any"]) {
  const d = watch({ semanticCondition: nonAnswer, conditionFromLead: "new" });
  eq(d.condition, "new", `the parser's "${nonAnswer}" is not a condition — fall through to the lead record`);
  eq(d.conditionSource, "lead_record", `…and "${nonAnswer}" never claims to be the source`);
}
{
  const d = watch({ semanticCondition: "unknown" });
  eq(d.condition, undefined, "a parser non-answer with nothing behind it leaves the condition blank");
}
// A LANE THAT ASKS NOBODY still falls to the lead record. Kept because it is the exact failure
// ruling 24 closed: a lane that stops supplying the parser rung goes back to letting a possibly
// stale STORED condition decide which arriving unit texts the customer.
{
  const legacy = watch({ semanticCondition: undefined, conditionFromLead: "new" });
  eq(legacy.conditionSource, "lead_record", "a lane passing no parser rung still falls to the lead record");
}

// ── 5. THE WIRING GUARD ──────────────────────────────────────────────────────────────────────
// A referee nobody asks is not arbitration, it is dead code — and re-inlining a rule next to a
// referee is exactly how an un-stacking gets quietly undone.
//
// THIS IS HERE BECAUSE `state_writer_contention:eval` CANNOT SEE IT. That ratchet credits a write as
// refereed on the mere PRESENCE of a nearby `decide*`/`apply*` call, and all four of these sites sit
// beside one. Measured, not assumed: unwiring the stale-booking site, the reopen site and a
// watch-defaults site each left the ratchet reporting 64/64 and passing. So the count is the wrong
// instrument for this property, and the call sites get counted directly instead.
//
// Not a source-text pin on prose — it counts call expressions of a named function, the same way the
// contention scanner does. Renaming a referee is supposed to break this.
{
  const serving = ["services/api/src/index.ts", "services/api/src/domain/conversationStore.ts"]
    .map(f => fs.readFileSync(path.resolve(f), "utf8"))
    .join("\n")
    // A function's own DECLARATION is not a call site. `applyStaleBookingReplacement` lives in the
    // store, so without this it would count itself and read as wired even with no caller at all.
    .replace(/export\s+function\s+\w+\s*\(/g, "export function __decl__(");
  const callsTo = (name: string): number =>
    (serving.match(new RegExp(`(?<![\\w.])${name}\\s*\\(`, "g")) ?? []).length;

  // The counts are the point. `applyInventoryWatchDefaults` replaced FOUR hand-written ladders; if
  // that drops to three, one lane has gone back to deciding for itself and the drift restarts.
  for (const [name, expected] of [
    ["applyStaleBookingReplacement", 1],
    ["decideHealthRecoveryPause", 1],
    ["decideStaffReopenResidue", 1],
    ["applyInventoryWatchDefaults", 4],
    ["resolveInventoryWatchDefaults", 1]
  ] as const) {
    eq(callsTo(name), expected, `${name} is asked at exactly its ${expected} write site(s) in the serving path`);
  }
  // And the wrapper actually consults its referee rather than hand-rolling the field list.
  const store = fs.readFileSync(path.resolve("services/api/src/domain/conversationStore.ts"), "utf8");
  checks += 1;
  assert.ok(
    /decideStaleBookingReplacement\s*\(/.test(store),
    "applyStaleBookingReplacement must ask decideStaleBookingReplacement, not decide for itself"
  );
  checks += 1;
  assert.ok(
    /resolveInventoryWatchDefaults\s*\(/.test(store),
    "applyInventoryWatchDefaults must ask resolveInventoryWatchDefaults, not decide for itself"
  );

  // RULING 24 — EVERY lane supplies the parser rung, not just the live inbound one. Counting the
  // calls (above) cannot see this: a lane that hands the referee `semanticCondition: undefined`
  // still counts as wired while quietly taking its condition from a stale stored field. So each
  // call site's own argument object is read, and a lane that stops asking the parser goes red.
  const serving_index = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");
  const watchDefaultsArgs = serving_index
    .split("applyInventoryWatchDefaults(")
    .slice(1)
    .map(chunk => chunk.slice(0, Math.max(0, chunk.indexOf("});"))));
  eq(watchDefaultsArgs.length, 4, "all four watch-defaults call sites are read back for the parser rung");
  for (const [i, args] of watchDefaultsArgs.entries()) {
    const rung = (args.split("semanticCondition:")[1] ?? "").split(",")[0].trim();
    eq(rung.length > 0, true, `watch-defaults lane ${i + 1} passes a semanticCondition rung at all`);
    eq(rung === "undefined", false, `watch-defaults lane ${i + 1} asks the parser, not a stale stored condition`);
  }
}

console.log(`PASS customer_risk_referees:eval — ${checks} checks across 4 referees + the wiring guard`);
