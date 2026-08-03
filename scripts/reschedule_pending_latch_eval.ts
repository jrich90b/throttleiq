/**
 * reschedule_pending_latch:eval — ONE referee for "something says this lead owes us a rebook; do we
 * ARM the reschedule latch?"
 *
 * WHAT WAS FIGHTING. Two referees already owned CLEARING `appointment.reschedulePending`
 * (`decideAppointmentConfirmRecord`, `decideAppointmentBookingRecord`). Nobody owned the opposite
 * question, so three places armed it inline on their own preconditions:
 *
 *   appointment_outcome_reschedule_draft  a rebook offer was just SENT after staff recorded the
 *                                         appointment as missed/cancelled (index.ts ~20050)
 *   staff_context_note                    a staff note parsed as an explicit cancel/reschedule
 *                                         request (applyAppointmentStateFromContextNote)
 *   customer_inbound_cancel_reschedule    the CUSTOMER's own message parsed as cancel/reschedule
 *                                         on a non-human thread (index.ts ~61080)
 *
 * WHY THE LATCH IS NOT A NOTE. `pendingRescheduleCarriesTurnIntent` (and its regen twin) uses it to
 * read the lead's NEXT message as "they want to move their appointment". Arming it wrongly gets a
 * customer answered about rescheduling something they never raised; failing to arm it drops a rebook
 * we owe. Both directions touch a customer — Tier 1.
 *
 * THE ONE DIVERGENCE, PRESERVED and ruled NOT a defect (ruling 5 in the rulings ledger): the two
 * staff-side lanes require an appointment record to already exist and skip silently without one; the
 * customer lane mints a `{ status: "none" }` stub and arms on that. That is the lane's INPUT, not a
 * fight about the same question — the staff lanes INFER a rebook debt from a record we hold, and
 * with no record there is nothing to infer from, while the customer lane has the customer saying it
 * in their own words this turn.
 *
 * FAIL DIRECTION. An unrecognized lane must REFUSE to arm: a missed rebook chase costs a follow-up,
 * a wrongly armed latch mis-routes the customer's next message.
 *
 * Behavior assertions only — no source-text pins (see eval_source_pin_ratchet:eval).
 *
 * Run: npx tsx scripts/reschedule_pending_latch_eval.ts
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH ||
  path.join(os.tmpdir(), `reschedule-pending-latch-eval-${Date.now()}.json`);

const { decideReschedulePendingLatch } = await import(
  "../services/api/src/domain/routeStateReducer.ts"
);
const { applyReschedulePendingLatch } = await import(
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

const STAFF_LANES = ["appointment_outcome_reschedule_draft", "staff_context_note"] as const;
const CUSTOMER_LANE = "customer_inbound_cancel_reschedule";
const ALL_LANES = [...STAFF_LANES, CUSTOMER_LANE] as const;

// ---------------------------------------------------------------------------------------------
// 1. Every recognized lane arms the latch when the lead HAS an appointment record. This is the
//    agreement the three sites always had, and the whole reason one referee can serve all three.
// ---------------------------------------------------------------------------------------------
for (const lane of ALL_LANES) {
  const d = decideReschedulePendingLatch({ lane, hasAppointmentRecord: true });
  ok(d.arm === true, `${lane}: must arm the latch when an appointment record exists`);
  ok(
    d.divergence === null,
    `${lane}: with a record present the lanes agree, so nothing may be flagged as divergent`
  );
}

// ---------------------------------------------------------------------------------------------
// 2. THE PRESERVED DIVERGENCE, asserted in both directions. This is the behaviour the un-stacking
//    had to carry across unchanged; if a later edit "tidies" the lanes into agreement, this fails.
// ---------------------------------------------------------------------------------------------
for (const lane of STAFF_LANES) {
  const d = decideReschedulePendingLatch({ lane, hasAppointmentRecord: false });
  ok(d.arm === false, `${lane}: a staff INFERENCE lane must not arm with no appointment record`);
  ok(
    d.createRecordIfAbsent === false,
    `${lane}: a staff inference lane may never mint an appointment record`
  );
  ok(
    d.divergence === "staff_inference_lane_refuses_to_latch_without_an_appointment_record",
    `${lane}: the preserved divergence must be NAMED, not silent`
  );
}
{
  const d = decideReschedulePendingLatch({ lane: CUSTOMER_LANE, hasAppointmentRecord: false });
  ok(
    d.arm === true,
    "customer lane: the customer asked for a new time in their own words — arm even with no record"
  );
  ok(
    d.createRecordIfAbsent === true,
    "customer lane: it is the only lane allowed to mint a record to arm on"
  );
  ok(
    d.divergence === "customer_speech_lane_mints_an_appointment_record_to_latch_on",
    "customer lane: the preserved divergence must be NAMED, not silent"
  );
}

// ---------------------------------------------------------------------------------------------
// 3. FAIL DIRECTION: an unrecognized lane refuses. A typo'd or renamed lane must never arm a
//    routing switch that changes how we read the customer's next message.
// ---------------------------------------------------------------------------------------------
for (const lane of ["", "  ", "reschedule", "customer_inbound", "staff_note", "unknown_lane"]) {
  for (const hasAppointmentRecord of [true, false]) {
    const d = decideReschedulePendingLatch({ lane, hasAppointmentRecord });
    ok(d.arm === false, `unrecognized lane "${lane}": must refuse to arm (record=${hasAppointmentRecord})`);
    ok(
      d.createRecordIfAbsent === false,
      `unrecognized lane "${lane}": must never mint an appointment record`
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 4. PURITY: the referee reads only its inputs. The already-standing latch may colour the
//    explanation but must never change the answer — arming an armed latch is a no-op, not a veto.
// ---------------------------------------------------------------------------------------------
for (const lane of ALL_LANES) {
  const armed = decideReschedulePendingLatch({
    lane,
    hasAppointmentRecord: true,
    reschedulePending: true
  });
  const clear = decideReschedulePendingLatch({
    lane,
    hasAppointmentRecord: true,
    reschedulePending: false
  });
  ok(
    armed.arm === clear.arm && armed.createRecordIfAbsent === clear.createRecordIfAbsent,
    `${lane}: the stored latch must not change the decision, only the explanation`
  );
  ok(typeof armed.why === "string" && armed.why.length > 0, `${lane}: must explain itself`);
}

// ---------------------------------------------------------------------------------------------
// 5. THE WRAPPER ACTUALLY WRITES WHAT THE REFEREE DECIDED. This is the half that catches a write
//    site being unwired from the referee: the store helper is the only place allowed to arm.
// ---------------------------------------------------------------------------------------------
{
  // A staff lane on a lead with a record: arms in place, record shape untouched.
  const conv: any = { id: "c1", appointment: { status: "confirmed", updatedAt: "2026-01-01T00:00:00.000Z" } };
  const d = applyReschedulePendingLatch(conv, { lane: "staff_context_note" });
  ok(d.arm === true, "wrapper: staff lane with a record arms");
  ok(conv.appointment.reschedulePending === true, "wrapper: the latch is actually written");
  ok(conv.appointment.status === "confirmed", "wrapper: it must not disturb the rest of the record");
  ok(
    conv.appointment.updatedAt !== "2026-01-01T00:00:00.000Z",
    "wrapper: the record is re-stamped when it changes"
  );
}
{
  // A staff lane on a lead with NO record: writes nothing at all, and mints nothing.
  const conv: any = { id: "c2" };
  const d = applyReschedulePendingLatch(conv, { lane: "appointment_outcome_reschedule_draft" });
  ok(d.arm === false, "wrapper: staff lane without a record refuses");
  ok(!conv.appointment, "wrapper: a staff lane must NOT mint an appointment record");
}
{
  // The customer lane on a lead with NO record: mints the stub and arms on it.
  const conv: any = { id: "c3" };
  const d = applyReschedulePendingLatch(conv, { lane: CUSTOMER_LANE });
  ok(d.arm === true, "wrapper: customer lane arms with no record");
  ok(!!conv.appointment, "wrapper: the customer lane mints the record it arms on");
  ok(conv.appointment.status === "none", "wrapper: the minted record starts as a 'none' stub");
  ok(conv.appointment.reschedulePending === true, "wrapper: the minted record carries the latch");
}
{
  // An unrecognized lane touches nothing, on a lead with and without a record.
  const withRecord: any = { id: "c4", appointment: { status: "confirmed", reschedulePending: false } };
  applyReschedulePendingLatch(withRecord, { lane: "not_a_lane" });
  ok(
    withRecord.appointment.reschedulePending === false,
    "wrapper: an unrecognized lane must not arm an existing record"
  );
  const bare: any = { id: "c5" };
  applyReschedulePendingLatch(bare, { lane: "not_a_lane" });
  ok(!bare.appointment, "wrapper: an unrecognized lane must not mint a record");
}

// ---------------------------------------------------------------------------------------------
// 6. REGISTERED IN THE DECISION REGISTRY, once per lane — otherwise the decision-equivalence
//    harness is blind to this referee and a future change to it would prove "identical" for free.
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
      keys.has(`reschedulePendingLatch:${lane}`),
      `decision registry must sample reschedulePendingLatch:${lane} — one entry per lane, or the ` +
        "divergence between lanes is invisible to decision-equivalence"
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 7. NOBODY ARMS THE LATCH BEHIND THE REFEREE'S BACK.
//
// This exists because the obvious guard does not cover one of the three sites. Unwiring the
// outcome-draft lane or the context-note lane raises `state_writer_contention:eval` by one and
// fails the build (verified by sabotage). Unwiring the CUSTOMER lane does not: taking its inline
// write out is what un-collapsed a neighbouring `reschedulePending = false` clear-write a few
// hundred lines below, so putting the inline write back re-collapses that neighbour and the total
// lands right back on the baseline. +1 and -1 cancel, and the ratchet reports green on a genuine
// re-stacking.
//
// So assert the invariant directly, through the same analyzer the ratchet uses rather than by
// matching source text: outside the store helper, no unrefereed writer of `appointment` may ARM
// this latch. Arming is the question this referee owns; clearing is the sibling question and is
// deliberately still allowed to appear here.
// ---------------------------------------------------------------------------------------------
{
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  const { rankContention, unstackingQueue } = await import(
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

  const appointment: any = unstackingQueue(rankContention(files as any, { minWrites: 4 })).find(
    (entry: any) => entry.field === "appointment"
  );
  const armSites = (appointment?.unrefereedWriterSites ?? []).filter((site: any) =>
    /reschedulePending\s*=\s*true/.test(String(site.snippet ?? ""))
  );
  ok(
    armSites.length === 0,
    "a place outside applyReschedulePendingLatch arms appointment.reschedulePending without asking " +
      "the referee — route it through applyReschedulePendingLatch instead. Offending site(s): " +
      armSites.map((site: any) => `${site.file}:${site.line}`).join(", ")
  );
}

console.log(
  `PASS reschedule-pending latch — one referee for ARMING the rebook latch across 3 lanes ` +
    `(${checks} checks; the record-required divergence preserved and named)`
);
