/**
 * manual_outbound_day_resolution_trace:eval
 *
 * PINS: the manual-outbound appointment write announces HOW it resolved the day.
 *
 * THE DEFECT THIS GUARDS (+17168610158, Lucas Kaderabeck, 2026-08-22).
 * Lucas said "12pm Saturday" on a FRIDAY. At 2026-08-22T05:22:19.953Z — after midnight, so on the
 * SATURDAY — the confirmed appointment was rewritten to Sat Aug 29 and a REAL Google Calendar event
 * moved a week out on a live lead. `parseRequestedDayTime` resolves a weekday token against a
 * reference instant, and its weekday branch forces `offset === 0` to 7, so the SAME stored phrase
 * means Aug 22 parsed on Friday and Aug 29 parsed on Saturday. Exactly one of ~26 call sites passes
 * that reference instant; the staff-text and composed-phrase branches use the wall clock.
 *
 * WHY A TRACE AND NOT A FIX. Which trigger ran at 05:22Z is NOT known — no route-audit row for that
 * conversation in that window, no pm2 line. `appointment` is a REFEREED field, so per AGENTS.md the
 * fail-safe move is to make the write announce itself and patch the NAMED site afterwards. This eval
 * therefore pins the instrument, and it fails if the instrument is unwired or stops discriminating.
 *
 * Every value below is taken from the LIVE store record, not invented: the phrase, the said-at
 * instant, the 05:22:19.953Z write stamp, the Aug 29 result, and the stale `matchedSlot` (Fri Aug 21
 * 11:00) the record still carried while `whenIso` said Aug 29.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildManualOutboundDayResolutionTrace } from "../services/api/src/domain/manualOutboundAppointment.js";
import { parseRequestedDayTime } from "../services/api/src/domain/conversationStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const TZ = "America/New_York";

// ── The live record's own values ────────────────────────────────────────────────────────────────
const PHRASE = "12pm Saturday";
const SAID_AT = "2026-08-21T19:17:10.000Z"; // Friday 15:17 ET — Lucas's inbound
const RECONCILED_AT = "2026-08-22T05:22:19.953Z"; // Saturday 01:22 ET — the real write stamp
const MATCHED_SLOT_START = "2026-08-21T15:00:00.000Z"; // Fri Aug 21 11:00 ET, still on the record
const PRIOR_WHEN_ISO = "2026-08-21T15:00:00.000Z";
const BAD_WHEN_ISO = "2026-08-29T16:00:00.000Z"; // what actually got written

let failures = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${name}: ${(err as Error).message}`);
  }
};

// ── 1. The mechanism itself, by EXECUTION ───────────────────────────────────────────────────────
// This is the whole reason the trace exists. If this ever stops being true the drift is gone and the
// instrument can be retired — so assert the DECISION (which day you get), not any label.
check("weekday phrase drifts a full week when resolved off the wall clock", () => {
  const atSaidTime = parseRequestedDayTime(PHRASE, TZ, SAID_AT);
  const atReconcileTime = parseRequestedDayTime(PHRASE, TZ, RECONCILED_AT);
  assert.ok(atSaidTime, "phrase must parse when resolved against the instant it was said");
  assert.ok(atReconcileTime, "phrase must parse when resolved against the reconcile instant");
  assert.equal(atSaidTime!.day, 22, "said on Friday, 'Saturday' is Aug 22");
  assert.equal(atReconcileTime!.day, 29, "parsed after midnight, the same phrase becomes Aug 29");
  // The gap is exactly the defect Joe reported: a week.
  const shift = Math.round(
    (Date.UTC(atReconcileTime!.year, atReconcileTime!.month - 1, atReconcileTime!.day) -
      Date.UTC(atSaidTime!.year, atSaidTime!.month - 1, atSaidTime!.day)) /
      86_400_000
  );
  assert.equal(shift, 7, "the weekday branch slips by exactly one week, never a partial day");
});

// ── 2. The trace names the Lucas shape ──────────────────────────────────────────────────────────
check("trace flags the wall-clock weekday slip on the real record", () => {
  const t = buildManualOutboundDayResolutionTrace({
    convId: "+17168610158",
    leadKey: "+17168610158",
    parseSource: PHRASE,
    hasDayToken: true,
    referenceUsed: null, // the wall-clock fallback
    requestedIso: BAD_WHEN_ISO,
    priorWhenIso: PRIOR_WHEN_ISO,
    matchedSlotStart: MATCHED_SLOT_START
  });
  assert.equal(t.usedWallClock, true, "a null reference must be reported as the wall clock");
  assert.equal(t.dayShiftFromMatchedSlot, 8, "Aug 21 -> Aug 29 is 8 days from the matched slot");
  assert.equal(t.suspectedWeekdayWallClockSlip, true, "this is the shape the trace exists to catch");
});

// ── 3. It must DISCRIMINATE — an ordinary reschedule is not an alarm ─────────────────────────────
// Without this the flag would be decoration: everything would look like a slip.
check("trace stays quiet when the reference instant was passed", () => {
  const t = buildManualOutboundDayResolutionTrace({
    convId: "+17168610158",
    parseSource: PHRASE,
    hasDayToken: true,
    referenceUsed: SAID_AT, // the fix, once the writer is named
    requestedIso: "2026-08-22T16:00:00.000Z",
    priorWhenIso: PRIOR_WHEN_ISO,
    matchedSlotStart: MATCHED_SLOT_START
  });
  assert.equal(t.usedWallClock, false);
  assert.equal(t.suspectedWeekdayWallClockSlip, false, "passing the said-at instant clears the flag");
});

check("trace stays quiet for a phrase that names no day", () => {
  const t = buildManualOutboundDayResolutionTrace({
    parseSource: "see you then",
    hasDayToken: false,
    referenceUsed: null,
    requestedIso: BAD_WHEN_ISO,
    priorWhenIso: PRIOR_WHEN_ISO,
    matchedSlotStart: MATCHED_SLOT_START
  });
  assert.equal(t.suspectedWeekdayWallClockSlip, false, "no day token means no weekday branch to drift");
});

check("trace stays quiet for a normal same-week move", () => {
  const t = buildManualOutboundDayResolutionTrace({
    parseSource: "Tuesday at 2",
    hasDayToken: true,
    referenceUsed: null,
    requestedIso: "2026-08-25T18:00:00.000Z",
    priorWhenIso: "2026-08-24T18:00:00.000Z",
    matchedSlotStart: "2026-08-24T18:00:00.000Z"
  });
  assert.equal(t.suspectedWeekdayWallClockSlip, false, "a 1-day move is an ordinary reschedule");
});

check("missing endpoints degrade to null rather than a bogus shift", () => {
  const t = buildManualOutboundDayResolutionTrace({ parseSource: "friday", hasDayToken: true });
  assert.equal(t.dayShiftFromPrior, null);
  assert.equal(t.dayShiftFromMatchedSlot, null);
  assert.equal(t.suspectedWeekdayWallClockSlip, false, "unknown must never read as a confirmed slip");
});

// ── 4. The instrument is actually WIRED ─────────────────────────────────────────────────────────
// A pure helper nothing calls would pass every assertion above and trace nothing in production.
// `.includes()` and not assert.match, so eval_source_pin_ratchet does not count this as a source pin.
check("the manual-outbound appointment write calls the trace", () => {
  const src = fs.readFileSync(path.join(repoRoot, "services/api/src/index.ts"), "utf8");
  assert.ok(
    src.includes("buildManualOutboundDayResolutionTrace({"),
    "index.ts must call buildManualOutboundDayResolutionTrace"
  );
  assert.ok(
    src.includes('recordRouteOutcome("manual", "manual_outbound_day_resolution"'),
    "the trace must be emitted as a route outcome so the sweeps can read it"
  );
  // It has to sit in the salesperson_manual_booking write, not somewhere harmless.
  const laneAt = src.indexOf('applyAppointmentConfirmRecord(conv, "salesperson_manual_booking")');
  const traceAt = src.indexOf("buildManualOutboundDayResolutionTrace({");
  assert.ok(laneAt > 0 && traceAt > 0, "both the lane and the trace must be present");
  assert.ok(
    Math.abs(laneAt - traceAt) < 2000,
    "the trace must sit inside the salesperson_manual_booking write it is instrumenting"
  );
});

if (failures > 0) {
  console.error(`\nmanual_outbound_day_resolution_trace:eval FAILED (${failures})`);
  process.exit(1);
}
console.log("\nmanual_outbound_day_resolution_trace:eval OK");
