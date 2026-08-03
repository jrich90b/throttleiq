/**
 * appointment_attribution:eval — ONE referee for "who booked this appointment, and what do we
 * record when nobody told us?"
 *
 * WHAT WAS FIGHTING. Two places write `appointment.bookedBy`, answering different halves of the
 * same question with different rules:
 *
 *   setAppointmentBookedBy (index.ts)  a booking path HANDS IN an attribution — nine do (the
 *                                      customer-ack booking, the voice-transcript booking, the
 *                                      public link, the staff console, the manual-outbound lanes)
 *   onAppointmentBooked (index.ts)     nobody handed one in, so INFER it from `confirmedBy`
 *
 * The inference is not a curiosity: of the eighteen places that call `onAppointmentBooked`, eleven
 * reach it with no explicit attribution above them, so for those the inference IS the record.
 *
 * THE THREE DIVERGENCES, PINNED AS-IS:
 *
 *   1. OVERWRITE vs FILL-A-BLANK. The explicit lane writes over an attribution already on file;
 *      the inference refuses to touch one.
 *
 *   2. A CUSTOMER'S CONFIRMATION IS FILED AS THE AGENT'S BOOKING. `confirmedBy: "customer"` infers
 *      `{ actor: "ai", channel: "sms" }` — the customer confirmed, and the record says the agent
 *      booked it over SMS, with the channel hard-coded rather than read off the thread the way
 *      every explicit lane passes it.
 *
 *   3. AN UNRECOGNIZED `confirmedBy` RECORDS NOTHING AT ALL — blank, "staff", anything else. Safe
 *      direction: an absent attribution reads as unknown, a guessed one reads as fact.
 *
 * FAIL DIRECTION. `bookedBy` never gates a message, a close, or a booking — it records who did
 * something that already happened. The dangerous direction is a CONFIDENT WRONG attribution, not a
 * missing one, so an unrecognized lane writes nothing.
 *
 * THE LOAD-BEARING SECTION is "the two original rules, re-encoded" below: it replays every
 * (lane × stored state × confirmedBy) combination through the hand-written rules exactly as they
 * read before the un-stacking, and asserts the referee answers identically — including the two
 * lanes' DIFFERENT key shapes (six keys explicit, three inferred), which a tidy-up would erase.
 *
 * Unwiring a call site is caught directly: the last section asks the contention analyzer whether
 * any unrefereed writer still touches `appointment.bookedBy`, and names the offending file:line.
 *
 * Behavior assertions only — no source-text pins (see eval_source_pin_ratchet:eval).
 *
 * Run: npx tsx scripts/appointment_attribution_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH ||
  path.join(os.tmpdir(), `appointment-attribution-eval-${Date.now()}.json`);

const { decideAppointmentAttribution } = await import("../services/api/src/domain/routeStateReducer.ts");
const { applyAppointmentAttribution } = await import("../services/api/src/domain/conversationStore.ts");

let checks = 0;
const eq = (actual: unknown, expected: unknown, message: string) => {
  assert.deepEqual(actual, expected, message);
  checks++;
};

/** Every `confirmedBy` the store actually carries, plus the ones that fall through the table. */
const CONFIRMED_BY = ["salesperson", "customer", "staff", "", "SALESPERSON", "Customer", "ai"];

/** Attributions a booking path can hand in, including the ones the helper normalizes. */
const SUPPLIED: Array<{ label: string; supplied: any }> = [
  { label: "nothing", supplied: null },
  { label: "ai over sms", supplied: { actor: "ai", channel: "sms" } },
  { label: "ai over sms with a source message", supplied: { actor: "ai", channel: "sms", sourceMessageId: "m-1" } },
  { label: "human over phone", supplied: { actor: "human", channel: "phone" } },
  { label: "the staff console", supplied: { actor: "human", channel: "manual", userId: "u-9", userName: "Dana" } },
  { label: "the public link", supplied: { actor: "customer", channel: "public_booking" } },
  { label: "an explicitly inferred one", supplied: { actor: "ai", channel: "sms", inferred: true } },
  { label: "inferred: false", supplied: { actor: "ai", channel: "sms", inferred: false } },
  { label: "null sub-fields", supplied: { actor: "human", channel: "manual", userId: null, userName: null, sourceMessageId: null } }
];

// --- the two original rules, re-encoded ----------------------------------------------------------
// The behavior-preservation proof: each is the hand-written body that site carried BEFORE the
// un-stacking, transcribed literally — key shapes and normalizations included.

// setAppointmentBookedBy:
//   if (!conv.appointment || !bookedBy) return;
//   conv.appointment.bookedBy = { actor, channel, userId ?? undefined, userName ?? undefined,
//                                 sourceMessageId ?? undefined,
//                                 inferred: bookedBy.inferred === true ? true : undefined };
const originalExplicit = (hasAppt: boolean, supplied: any) => {
  if (!hasAppt || !supplied) return null;
  return {
    actor: supplied.actor,
    channel: supplied.channel,
    userId: supplied.userId ?? undefined,
    userName: supplied.userName ?? undefined,
    sourceMessageId: supplied.sourceMessageId ?? undefined,
    inferred: supplied.inferred === true ? true : undefined
  };
};

// onAppointmentBooked:
//   if (conv?.appointment && !conv.appointment.bookedBy) {
//     const confirmedBy = String(conv.appointment.confirmedBy ?? "").toLowerCase();
//     if (confirmedBy === "salesperson") bookedBy = { actor: "human", channel: "manual", inferred: true };
//     else if (confirmedBy === "customer") bookedBy = { actor: "ai", channel: "sms", inferred: true };
//   }
const originalInferred = (hasAppt: boolean, hasExisting: boolean, confirmedByRaw: string) => {
  if (!hasAppt || hasExisting) return null;
  const confirmedBy = String(confirmedByRaw ?? "").toLowerCase();
  if (confirmedBy === "salesperson") return { actor: "human", channel: "manual", inferred: true };
  if (confirmedBy === "customer") return { actor: "ai", channel: "sms", inferred: true };
  return null;
};

const written = (d: any) => (d.write ? d.bookedBy : null);

// The full cross-product for the EXPLICIT lane.
for (const hasAppt of [true, false]) {
  for (const hasExisting of [true, false]) {
    for (const { label, supplied } of SUPPLIED) {
      const decision = decideAppointmentAttribution({
        lane: "explicit",
        hasAppointment: hasAppt,
        hasExistingAttribution: hasExisting,
        supplied
      });
      eq(
        written(decision),
        originalExplicit(hasAppt, supplied),
        `explicit (${label}, appointment=${hasAppt}, existing=${hasExisting}) matches its own inline rule`
      );
    }
  }
}

// The full cross-product for the INFERRED lane.
for (const hasAppt of [true, false]) {
  for (const hasExisting of [true, false]) {
    for (const confirmedBy of CONFIRMED_BY) {
      const decision = decideAppointmentAttribution({
        lane: "inferred",
        hasAppointment: hasAppt,
        hasExistingAttribution: hasExisting,
        confirmedBy
      });
      eq(
        written(decision),
        originalInferred(hasAppt, hasExisting, confirmedBy),
        `inferred (confirmedBy="${confirmedBy}", appointment=${hasAppt}, existing=${hasExisting}) matches its own inline rule`
      );
    }
  }
}

// --- the two lanes write DIFFERENT key shapes, and that is preserved ------------------------------
{
  const explicit = decideAppointmentAttribution({
    lane: "explicit",
    hasAppointment: true,
    hasExistingAttribution: false,
    supplied: { actor: "human", channel: "manual" }
  });
  eq(
    Object.keys(explicit.bookedBy ?? {}),
    ["actor", "channel", "userId", "userName", "sourceMessageId", "inferred"],
    "the explicit lane writes all six keys, as the helper always has"
  );
  const inferred = decideAppointmentAttribution({
    lane: "inferred",
    hasAppointment: true,
    hasExistingAttribution: false,
    confirmedBy: "salesperson"
  });
  eq(
    Object.keys(inferred.bookedBy ?? {}),
    ["actor", "channel", "inferred"],
    "the inference writes only three — a uniform shape would be a change, not a cleanup"
  );
}

// --- divergence 1: overwrite vs fill-a-blank -------------------------------------------------------
{
  const overwrite = decideAppointmentAttribution({
    lane: "explicit",
    hasAppointment: true,
    hasExistingAttribution: true,
    supplied: { actor: "human", channel: "phone" }
  });
  eq(overwrite.write, true, "the explicit lane rewrites an attribution already on file");
  eq(overwrite.divergence, "explicit_overwrites_an_existing_attribution", "...and names that it did");
  const defer = decideAppointmentAttribution({
    lane: "inferred",
    hasAppointment: true,
    hasExistingAttribution: true,
    confirmedBy: "salesperson"
  });
  eq(defer.write, false, "the inference never overwrites one");
}

// --- divergence 2: a customer's confirmation is filed as the agent's booking -----------------------
{
  const d = decideAppointmentAttribution({
    lane: "inferred",
    hasAppointment: true,
    hasExistingAttribution: false,
    confirmedBy: "customer"
  });
  eq(d.bookedBy?.actor, "ai", "the CUSTOMER confirmed and the record credits the agent — preserved as-is");
  eq(d.bookedBy?.channel, "sms", "...over a hard-coded SMS channel, not the thread's own");
  eq(
    d.divergence,
    "customer_confirmation_is_filed_as_the_agents_booking",
    "...and the referee NAMES it rather than burying it"
  );
  const sp = decideAppointmentAttribution({
    lane: "inferred",
    hasAppointment: true,
    hasExistingAttribution: false,
    confirmedBy: "salesperson"
  });
  eq(sp.divergence, null, "the salesperson inference attributes to the right party, so it names nothing");
}

// --- divergence 3: an unrecognized confirmedBy records nothing --------------------------------------
for (const confirmedBy of ["staff", "", "ai", "unknown"]) {
  const d = decideAppointmentAttribution({
    lane: "inferred",
    hasAppointment: true,
    hasExistingAttribution: false,
    confirmedBy
  });
  eq(d.write, false, `confirmedBy "${confirmedBy}" leaves the appointment unattributed rather than guessing`);
  eq(
    d.divergence,
    "an_unrecognized_confirmedBy_records_no_attribution_at_all",
    `...and names it ("${confirmedBy}")`
  );
}

// --- fail direction: an unregistered lane records nothing --------------------------------------------
for (const lane of ["", "  ", "auto", "booked", "explicit_v2"]) {
  const d = decideAppointmentAttribution({
    lane,
    hasAppointment: true,
    hasExistingAttribution: false,
    supplied: { actor: "ai", channel: "sms" },
    confirmedBy: "customer"
  });
  eq(d.write, false, `an unrecognized lane ("${lane}") records nothing — a wrong attribution is the danger`);
}

// --- the applier stores exactly what the referee decided ---------------------------------------------
{
  const conv: any = { appointment: { status: "confirmed", confirmedBy: "customer" } };
  applyAppointmentAttribution(conv, { lane: "inferred" });
  eq(
    conv.appointment.bookedBy,
    { actor: "ai", channel: "sms", inferred: true },
    "the inference stores exactly the record it used to build inline"
  );
  // ...and a second pass is a no-op, because an attribution is now on file.
  applyAppointmentAttribution(conv, { lane: "inferred" });
  eq(
    conv.appointment.bookedBy,
    { actor: "ai", channel: "sms", inferred: true },
    "inferring twice changes nothing — the second pass sees an attribution and defers"
  );
}
{
  const conv: any = { appointment: { status: "confirmed", confirmedBy: "customer" } };
  applyAppointmentAttribution(conv, {
    lane: "explicit",
    supplied: { actor: "human", channel: "manual", userId: "u-3", userName: "Dana" }
  });
  eq(
    conv.appointment.bookedBy,
    { actor: "human", channel: "manual", userId: "u-3", userName: "Dana", sourceMessageId: undefined, inferred: undefined },
    "the explicit lane stores exactly the record the helper used to build inline"
  );
}
{
  // No appointment record at all: both lanes write nothing and neither creates one.
  const conv: any = {};
  eq(applyAppointmentAttribution(conv, { lane: "inferred" }).write, false, "no appointment, nothing inferred");
  eq(
    applyAppointmentAttribution(conv, { lane: "explicit", supplied: { actor: "ai", channel: "sms" } }).write,
    false,
    "no appointment, nothing recorded explicitly"
  );
  eq(conv.appointment, undefined, "and neither lane conjures an appointment record");
}
{
  // The explicit lane reads `confirmedBy` not at all — it is handed the answer.
  const conv: any = { appointment: { status: "confirmed", confirmedBy: "salesperson" } };
  applyAppointmentAttribution(conv, { lane: "explicit", supplied: { actor: "customer", channel: "public_booking" } });
  eq(
    conv.appointment.bookedBy?.actor,
    "customer",
    "an explicit attribution beats what confirmedBy would have inferred"
  );
}

// --- no unrefereed writer may still touch appointment.bookedBy --------------------------------------
// The direct form of the un-wiring test — the ratchet TOTAL is not enough on its own, because
// removing an inline write can un-collapse a neighbouring one and cancel the delta (see #462).
{
  const { rankContention } = await import("../services/api/src/domain/stateWriterContention.ts");
  const ROOT = path.resolve("services/api/src");
  const files: Array<{ path: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        files.push({ path: path.relative(process.cwd(), full), text: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(ROOT);
  const row = rankContention(files as any, { minRawWrites: 1 }).find((r: any) => r.field === "appointment");
  eq(Boolean(row), true, "the contention analyzer still sees the appointment field");
  const offenders = ((row as any).unrefereedWriterSites ?? []).filter((s: any) =>
    String(s.snippet ?? "").includes("bookedBy")
  );
  eq(
    offenders.map((s: any) => `${s.file}:${s.line}`),
    [],
    `no unrefereed writer may set appointment.bookedBy — found: ${offenders
      .map((s: any) => `${s.file}:${s.line} (${s.fn})`)
      .join(", ")}`
  );
}

// --- the referee is registered with the equivalence harness ------------------------------------------
{
  const reducer = await import("../services/api/src/domain/routeStateReducer.ts");
  const { buildDecisionRegistry } = await import("../services/api/src/domain/decisionFingerprint.ts");
  const registry = buildDecisionRegistry(reducer as any);
  const covered = registry.filter((entry: any) =>
    (entry.covers ?? []).includes("decideAppointmentAttribution")
  );
  eq(covered.length, 2, "both attribution lanes are sampled by the equivalence harness");
  for (const lane of ["explicit", "inferred"]) {
    eq(
      covered.some((entry: any) => entry.name === `appointmentAttribution:${lane}`),
      true,
      `the harness samples the ${lane} lane specifically`
    );
  }
  const lead = { appointment: { status: "confirmed", confirmedBy: "customer" } } as any;
  for (const entry of covered) {
    eq(entry.sample(lead, { nowMs: Date.parse("2026-08-03T15:00:00.000Z"), timeZone: "America/New_York" }) !== undefined,
      true, `${entry.name} projects a real answer off a stored appointment`);
  }
}

console.log(`appointment_attribution:eval OK — ${checks} checks`);
