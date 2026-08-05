/**
 * reschedule_pending_clear:eval — ONE referee for "the rebook debt is settled; who takes
 * `appointment.reschedulePending` OFF?"
 *
 * WHAT WAS FIGHTING. The SETTLEMENT half of the latch — the last unowned half of it. The booking
 * referees (`decideAppointmentBookingRecord` / `decideAppointmentConfirmRecord`) already clear the
 * latch when a new time goes on the calendar; that is "we booked them again", a different event.
 * Nobody owned the case where the debt simply STOPS being owed without a new booking, so three
 * places answered it inline on three different preconditions:
 *
 *   stale_pending_reschedule_slot  the scheduler holds a reschedule slot for an appointment that is
 *                                  no longer reschedulable at all (index.ts ~62725)
 *   settled_past_appointment       the appointment is past AND settled, so the latch is stuck and
 *                                  re-arms on every future inbound (index.ts ~62729)
 *   staff_outcome_showed_up        a staff context note recorded the outcome as SHOWED UP
 *                                  (applyAppointmentStateFromContextNote, index.ts ~25370)
 *
 * WHY IT MATTERS AS MUCH AS ARMING. `pendingRescheduleCarriesTurnIntent` (and its regen twin) reads
 * the lead's NEXT message as "they want to move their appointment" for as long as the latch stands.
 * Failing to clear it keeps answering a customer about moving an appointment they already kept —
 * which is why two downstream guards carry hand-written armor against a record that reads
 * "confirmed" and "reschedule pending" at once. Tier 1: it touches a customer either way.
 *
 * THE ONE DIVERGENCE, PRESERVED and NAMED: does taking the latch off stamp `updatedAt`?
 * `settled_past_appointment` clears AND stamps; the other two clear and leave the stamp alone. It is
 * coupled to the other half of the same divergence — that lane is also the only one that acts solely
 * on a latch that is actually STANDING, which is what stops it re-stamping records it did not
 * change. Preserved: `updatedAt` is a freshness input read by staleness checks, and a cleanup does
 * not get to start or stop refreshing one.
 *
 * WHERE THEY AGREE, asserted so a later tidy-up cannot break it: none of the three mints an
 * appointment record. With nothing on file there is no debt to settle, and inventing a stub just to
 * write `false` onto it would hand the ARM half's staff lanes a phantom record to reason about.
 *
 * FAIL DIRECTION. An unrecognized lane must REFUSE to clear: leaving a latch standing costs a
 * mis-routed turn a human can correct, while clearing one we should have kept silently drops a
 * rebook the customer asked for. This is the opposite default to the arm half, and deliberately so —
 * each half refuses to ACT, so an unknown lane changes nothing in either direction.
 *
 * Behavior assertions only — no source-text pins (see eval_source_pin_ratchet:eval).
 *
 * Run: npx tsx scripts/reschedule_pending_clear_eval.ts
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH ||
  path.join(os.tmpdir(), `reschedule-pending-clear-eval-${Date.now()}.json`);

const { decideReschedulePendingClear } = await import(
  "../services/api/src/domain/routeStateReducer.ts"
);
const { applyReschedulePendingClear } = await import(
  "../services/api/src/domain/conversationStore.ts"
);
const { buildDecisionRegistry } = await import(
  "../services/api/src/domain/decisionFingerprint.ts"
);

let checks = 0;
const ok = (condition: boolean, message: string) => {
  checks += 1;
  assert.ok(condition, message);
};

const STALE_SLOT = "stale_pending_reschedule_slot";
const SETTLED_PAST = "settled_past_appointment";
const STAFF_SHOWED = "staff_outcome_showed_up";
const ALL_LANES = [STALE_SLOT, SETTLED_PAST, STAFF_SHOWED] as const;

// ---------------------------------------------------------------------------------------------
// 1. THE LOAD-BEARING SECTION: the three ORIGINAL inline rules, re-encoded as a lookup table, and
//    the referee must match every one of them. Decision-equivalence cannot carry this proof — a
//    brand-new referee has no baseline to be identical to — so "behavior-preserving" lives here as
//    an executable table rather than as a claim. Each entry is the rule exactly as it stood before
//    the un-stacking:
//
//      stale_pending_reschedule_slot   `if (conv.appointment) conv.appointment.reschedulePending
//                                      = false` — writes over whatever is there, no stamp
//      settled_past_appointment        `if (settled && reschedulePending === true) { … = false;
//                                      updatedAt = now }` — only a STANDING latch, and it stamps
//      staff_outcome_showed_up         `conv.appointment.reschedulePending = false` inside a
//                                      function that already returned early without a record —
//                                      writes over whatever is there, no stamp of its own
// ---------------------------------------------------------------------------------------------
const ORIGINAL_RULES: Array<{
  lane: string;
  hasAppointmentRecord: boolean;
  reschedulePending: boolean | null;
  clear: boolean;
  stampUpdatedAt: boolean;
}> = [
  // The stale-slot lane: record present ⇒ always writes false, never stamps.
  { lane: STALE_SLOT, hasAppointmentRecord: true, reschedulePending: true, clear: true, stampUpdatedAt: false },
  { lane: STALE_SLOT, hasAppointmentRecord: true, reschedulePending: false, clear: true, stampUpdatedAt: false },
  { lane: STALE_SLOT, hasAppointmentRecord: true, reschedulePending: null, clear: true, stampUpdatedAt: false },
  { lane: STALE_SLOT, hasAppointmentRecord: false, reschedulePending: null, clear: false, stampUpdatedAt: false },
  // The settled-past lane: only a STANDING latch moves, and that move stamps the record.
  { lane: SETTLED_PAST, hasAppointmentRecord: true, reschedulePending: true, clear: true, stampUpdatedAt: true },
  { lane: SETTLED_PAST, hasAppointmentRecord: true, reschedulePending: false, clear: false, stampUpdatedAt: false },
  { lane: SETTLED_PAST, hasAppointmentRecord: true, reschedulePending: null, clear: false, stampUpdatedAt: false },
  { lane: SETTLED_PAST, hasAppointmentRecord: false, reschedulePending: null, clear: false, stampUpdatedAt: false },
  // The staff showed-up lane: record present ⇒ always writes false, never stamps for the latch.
  { lane: STAFF_SHOWED, hasAppointmentRecord: true, reschedulePending: true, clear: true, stampUpdatedAt: false },
  { lane: STAFF_SHOWED, hasAppointmentRecord: true, reschedulePending: false, clear: true, stampUpdatedAt: false },
  { lane: STAFF_SHOWED, hasAppointmentRecord: true, reschedulePending: null, clear: true, stampUpdatedAt: false },
  { lane: STAFF_SHOWED, hasAppointmentRecord: false, reschedulePending: null, clear: false, stampUpdatedAt: false }
];

for (const row of ORIGINAL_RULES) {
  const d = decideReschedulePendingClear({
    lane: row.lane,
    hasAppointmentRecord: row.hasAppointmentRecord,
    reschedulePending: row.reschedulePending
  });
  ok(
    d.clear === row.clear,
    `${row.lane} (record=${row.hasAppointmentRecord}, latch=${row.reschedulePending}): the original ` +
      `inline rule ${row.clear ? "cleared" : "left"} the latch — the referee must answer the same`
  );
  ok(
    d.stampUpdatedAt === row.stampUpdatedAt,
    `${row.lane} (record=${row.hasAppointmentRecord}, latch=${row.reschedulePending}): the original ` +
      `rule ${row.stampUpdatedAt ? "stamped" : "did not stamp"} appointment.updatedAt`
  );
}

// ---------------------------------------------------------------------------------------------
// 2. THE PRESERVED DIVERGENCE, named in BOTH directions. If a later edit tidies the three lanes
//    into agreement about the stamp, this fails rather than the change passing silently.
// ---------------------------------------------------------------------------------------------
{
  const settled = decideReschedulePendingClear({
    lane: SETTLED_PAST,
    hasAppointmentRecord: true,
    reschedulePending: true
  });
  ok(
    settled.divergence === "settled_past_appointment_stamps_updated_at_when_it_clears_the_latch",
    "the stamping lane must NAME itself as the odd one out, not stamp silently"
  );
  for (const lane of [STALE_SLOT, STAFF_SHOWED]) {
    const d = decideReschedulePendingClear({
      lane,
      hasAppointmentRecord: true,
      reschedulePending: true
    });
    ok(
      d.divergence ===
        "stale_slot_and_staff_outcome_lanes_clear_the_latch_without_stamping_updated_at",
      `${lane}: the non-stamping half of the divergence must be named too`
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 3. WHERE THE THREE AGREE — no lane may invent an appointment record to settle a debt against.
//    With nothing on file there is no rebook debt, and a minted stub would feed the ARM half's
//    staff-inference lanes a phantom record on the next turn.
// ---------------------------------------------------------------------------------------------
for (const lane of ALL_LANES) {
  const d = decideReschedulePendingClear({ lane, hasAppointmentRecord: false });
  ok(d.clear === false, `${lane}: with no appointment record there is nothing to settle`);
  ok(d.stampUpdatedAt === false, `${lane}: and nothing to stamp`);
  ok(d.divergence === null, `${lane}: the lanes AGREE here, so nothing may be flagged divergent`);
}

// ---------------------------------------------------------------------------------------------
// 4. FAIL DIRECTION: an unrecognized lane refuses to clear. A renamed or typo'd lane must never
//    silently drop a rebook the customer asked for.
// ---------------------------------------------------------------------------------------------
for (const lane of ["", "   ", "settled", "showed_up", "stale_slot", "unknown_lane", "arm"]) {
  for (const reschedulePending of [true, false, null]) {
    const d = decideReschedulePendingClear({
      lane,
      hasAppointmentRecord: true,
      reschedulePending
    });
    ok(
      d.clear === false,
      `unrecognized lane "${lane}": must refuse to clear the latch (latch=${reschedulePending})`
    );
    ok(d.stampUpdatedAt === false, `unrecognized lane "${lane}": must not stamp the record either`);
  }
}

// ---------------------------------------------------------------------------------------------
// 5. SHAPE, not just rules — the junk-input pass. A referee's shape is where a fresh one actually
//    goes wrong (`Number("")` is 0, and a budget of zero once wore a default's clothes). Anything
//    that is not literally `true` must read as "the latch is not standing".
// ---------------------------------------------------------------------------------------------
for (const junk of [undefined, null, 0, 1, "true", "", "yes", NaN, {}, []] as any[]) {
  const d = decideReschedulePendingClear({
    lane: SETTLED_PAST,
    hasAppointmentRecord: true,
    reschedulePending: junk
  });
  ok(
    d.clear === (junk === true),
    `settled_past: a latch of ${JSON.stringify(junk) ?? String(junk)} is not a STANDING latch`
  );
}
for (const junk of [undefined, null, 0, "", "false", NaN] as any[]) {
  const d = decideReschedulePendingClear({
    lane: STALE_SLOT,
    hasAppointmentRecord: junk,
    reschedulePending: true
  });
  ok(d.clear === false, `stale_slot: a record flag of ${String(junk)} is not a record`);
}

// ---------------------------------------------------------------------------------------------
// 6. THE WRAPPER WRITES WHAT THE REFEREE DECIDED — asserted against real conversation objects.
//    This is the half that catches a write site being unwired: the contention analyzer alone is
//    not enough (a restored inline write within 40 lines of another applier call reads as
//    refereed), so the proof has to be that the applier itself still produces the write.
// ---------------------------------------------------------------------------------------------
const STAMP = "2026-01-01T00:00:00.000Z";
{
  // Stale slot: clears in place, does NOT re-stamp, leaves the rest of the record alone.
  const conv: any = {
    id: "c1",
    appointment: { status: "confirmed", reschedulePending: true, whenIso: "x", updatedAt: STAMP }
  };
  const d = applyReschedulePendingClear(conv, { lane: STALE_SLOT });
  ok(d.clear === true, "wrapper: the stale-slot lane clears");
  ok(conv.appointment.reschedulePending === false, "wrapper: the latch is actually written");
  ok(conv.appointment.updatedAt === STAMP, "wrapper: the stale-slot lane must NOT stamp updatedAt");
  ok(
    conv.appointment.status === "confirmed" && conv.appointment.whenIso === "x",
    "wrapper: it must not disturb the rest of the appointment record"
  );
}
{
  // Settled past on a STANDING latch: clears and stamps.
  const conv: any = {
    id: "c2",
    appointment: { status: "confirmed", reschedulePending: true, updatedAt: STAMP }
  };
  const d = applyReschedulePendingClear(conv, { lane: SETTLED_PAST });
  ok(d.clear === true && d.stampUpdatedAt === true, "wrapper: settled-past clears and stamps");
  ok(conv.appointment.reschedulePending === false, "wrapper: the stuck latch is healed");
  ok(conv.appointment.updatedAt !== STAMP, "wrapper: healing the stuck latch re-stamps the record");
}
{
  // Settled past on a latch that is NOT standing: writes absolutely nothing, stamp included.
  const conv: any = {
    id: "c3",
    appointment: { status: "confirmed", reschedulePending: false, updatedAt: STAMP }
  };
  const d = applyReschedulePendingClear(conv, { lane: SETTLED_PAST });
  ok(d.clear === false, "wrapper: settled-past with no standing latch decides nothing");
  ok(
    conv.appointment.updatedAt === STAMP,
    "wrapper: and must not re-stamp a record it did not change"
  );
}
{
  // Staff showed-up: clears in place, no stamp of its own (its caller stamps for the OUTCOME).
  const conv: any = {
    id: "c4",
    appointment: { status: "confirmed", reschedulePending: true, updatedAt: STAMP }
  };
  applyReschedulePendingClear(conv, { lane: STAFF_SHOWED });
  ok(conv.appointment.reschedulePending === false, "wrapper: showed-up settles the rebook debt");
  ok(conv.appointment.updatedAt === STAMP, "wrapper: the showed-up lane does not stamp for the latch");
}
{
  // No record: nothing is minted, by any lane.
  for (const lane of ALL_LANES) {
    const conv: any = { id: `bare-${lane}` };
    applyReschedulePendingClear(conv, { lane });
    ok(!conv.appointment, `wrapper: ${lane} must never mint an appointment record`);
  }
}
{
  // An unrecognized lane touches nothing at all.
  const conv: any = {
    id: "c5",
    appointment: { status: "confirmed", reschedulePending: true, updatedAt: STAMP }
  };
  applyReschedulePendingClear(conv, { lane: "not_a_lane" });
  ok(
    conv.appointment.reschedulePending === true && conv.appointment.updatedAt === STAMP,
    "wrapper: an unrecognized lane must leave the record exactly as it found it"
  );
}

// ---------------------------------------------------------------------------------------------
// 7. REGISTERED IN THE DECISION REGISTRY, once per lane — otherwise decision-equivalence is blind
//    to this referee and any future change to it proves "identical" for free.
// ---------------------------------------------------------------------------------------------
{
  const registry = buildDecisionRegistry();
  const keys = new Set(
    (Array.isArray(registry) ? registry : Object.values(registry ?? {})).map((entry: any) =>
      String(entry?.key ?? entry?.name ?? entry)
    )
  );
  for (const lane of ALL_LANES) {
    ok(
      keys.has(`reschedulePendingClear:${lane}`),
      `decision registry must sample reschedulePendingClear:${lane} — one entry per lane, or the ` +
        "divergence between lanes is invisible to decision-equivalence"
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 8. NOBODY SETTLES THE LATCH BEHIND THE REFEREE'S BACK.
//
// The ratchet TOTAL cannot carry this on its own: removing an inline write can un-collapse a
// neighbouring one, so a +1 and a -1 cancel and the total reports green on a genuine re-stacking
// (measured three times on this program). So ask the same analyzer directly and name the offender.
//
// Scoped to CLEARS, because arming is the sibling question (`reschedule_pending_latch:eval` owns
// that one) and the BOOKING lanes legitimately clear the latch as part of putting a new time on the
// calendar — those go through `applyAppointmentBookingRecord` / `applyAppointmentConfirmRecord`, so
// they never surface as unrefereed writers here.
// ---------------------------------------------------------------------------------------------
{
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  const { rankContention } = await import(
    "../services/api/src/domain/stateWriterContention.ts"
  );

  const root = nodePath.resolve("services/api/src");
  const files: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (entry.name.endsWith(".ts")) {
        files.push({ path: nodePath.relative(process.cwd(), full), text: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(root);

  const appointment: any = rankContention(files as any, { minRawWrites: 1 }).find(
    (entry: any) => entry.field === "appointment"
  );
  // Assert the analyzer can still SEE the field before asserting it is clean — otherwise a rename
  // makes this check vacuous while it still reports green.
  ok(
    (appointment?.writeSites ?? []).length > 0,
    "the contention analyzer must still see raw writes of `appointment` — if it cannot, this whole " +
      "section is vacuous and proves nothing"
  );
  const clearSites = (appointment?.unrefereedWriterSites ?? []).filter((site: any) =>
    /reschedulePending\s*=\s*false/.test(String(site.snippet ?? ""))
  );
  ok(
    clearSites.length === 0,
    "a place outside applyReschedulePendingClear settles appointment.reschedulePending without " +
      "asking the referee — route it through applyReschedulePendingClear instead. Offending " +
      `site(s): ${clearSites.map((site: any) => `${site.file}:${site.line}`).join(", ")}`
  );

  // AND THE PART THAT ACTUALLY CATCHES AN UNWIRING. The queue check above is not enough, measured:
  // re-inlining either the settled-past heal or the staff showed-up write leaves it GREEN, because a
  // restored inline write within 40 lines of ANY applier call that touches the same field reads as
  // refereed. Both of those sites sit near one. So ratchet the RAW count instead — every remaining
  // raw clear in index.ts belongs to one of the seven hand-maintained booking blocks (the
  // "a real calendar event now holds this lead's time" question, which `decideAppointmentBooking
  // Record` owns and which is the next slice). Re-inlining any settlement lane makes it eight.
  // DOWN ONLY: when the booking copies are refereed this becomes 0.
  const INDEX_RAW_CLEAR_CEILING = 7;
  const indexRawClears = (appointment?.writeSites ?? []).filter(
    (site: any) =>
      String(site.file ?? "").endsWith("index.ts") &&
      /reschedulePending\s*=\s*false/.test(String(site.snippet ?? ""))
  );
  ok(
    indexRawClears.length <= INDEX_RAW_CLEAR_CEILING,
    `index.ts carries ${indexRawClears.length} raw \`reschedulePending = false\` writes, ceiling ` +
      `${INDEX_RAW_CLEAR_CEILING}. A settlement lane was un-wired from applyReschedulePendingClear, ` +
      "or a new place is settling the rebook debt on its own. Sites: " +
      indexRawClears.map((site: any) => `${site.file}:${site.line}`).join(", ")
  );
}

console.log(
  `PASS reschedule-pending clear — one referee for SETTLING the rebook latch across 3 lanes ` +
    `(${checks} checks; the updatedAt-stamp divergence preserved and named)`
);
