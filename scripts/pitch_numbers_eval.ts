/**
 * pitch_numbers:eval — pins the ONE number in the readiness bar that doubles as a sales claim.
 *
 * Section 5 gets put in front of a dealer, so the failure that matters is not "the script crashed",
 * it is "the number flattered us". Every check below EXECUTES `computePitchNumbers` (a source-text
 * assertion could not tell the difference) and asserts a DECISION — reported vs not reported —
 * rather than a spelling.
 *
 * The four ways this number could lie, each pinned:
 *   1. The immature-cohort trap. Counting leads that arrived last week in the denominator without
 *      the sales they have not had time to close. Measured on the live store 2026-08-09: win lag
 *      p50=8d, p75=17d, p90=41d — the July cohort read 5.3%, BELOW Joe's 6% baseline, purely from
 *      immaturity. Pinned by asserting 200 week-old leads move the rate NOT AT ALL, and that
 *      dropping the lag visibly collapses it (the contrast proves the lag is load-bearing).
 *   2. Knob-picking. A lift that only appears at one window/maturity choice. Pinned: when any
 *      defensible grid point loses the lift, the headline goes NULL, not "the good one".
 *   3. A tiny cohort read as a measurement. Pinned at the PITCH_MIN_COHORT floor.
 *   4. A manufactured BDC number. Pinned: bdcHoursReplacedPerWeek is null on every path.
 *
 * Plus the wiring, which no source-text check can prove: the produced object is fed to the REAL
 * consumer (`evaluateReadiness`) and section 5 must actually move off NOT_MEASURED.
 *
 * Clock-safe: every fixture date is built relative to a pinned `now`, so this cannot go red at
 * midnight (memory `eval-red-at-midnight-wall-clock`).
 */
import assert from "node:assert/strict";

import {
  computePitchNumbers,
  isOnlineSalesLead,
  PITCH_MIN_COHORT
} from "./pitch_numbers_report.ts";
import { evaluateReadiness, READINESS_TARGETS } from "./rollout_readiness_report.ts";

const NOW_MS = Date.parse("2026-08-09T20:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}: ${err?.message ?? err}`);
  }
}

/** A plain online sales lead created `daysAgo` before the pinned now. */
function lead(id: string, daysAgo: number, opts: { won?: boolean; wonVia?: "closedReason" | "sale"; source?: string; bucket?: string } = {}): any {
  const conv: any = {
    id,
    createdAt: new Date(NOW_MS - daysAgo * DAY).toISOString(),
    lead: { source: opts.source ?? "Room58 - Request details" },
    messages: [{ direction: "in", provider: "twilio", at: new Date(NOW_MS - daysAgo * DAY).toISOString(), body: "how much for the road glide?" }]
  };
  if (opts.bucket) conv.classification = { bucket: opts.bucket };
  if (opts.won) {
    if (opts.wonVia === "sale") conv.sale = { soldAt: new Date(NOW_MS - (daysAgo - 5) * DAY).toISOString() };
    else {
      conv.status = "closed";
      conv.closedReason = "sold";
      conv.closedAt = new Date(NOW_MS - (daysAgo - 5) * DAY).toISOString();
    }
  }
  return conv;
}

function batch(prefix: string, count: number, daysAgo: number, wins: number, opts: Parameters<typeof lead>[2] = {}): any[] {
  return Array.from({ length: count }, (_, i) => lead(`${prefix}${i}`, daysAgo, { ...opts, won: i < wins }));
}

function compute(conversations: any[], overrides: { maturityDays?: number; windowDays?: number } = {}) {
  return computePitchNumbers({ conversations, nowMs: NOW_MS, medianResponseMin: 28.8, ...overrides });
}

// A mature, healthy cohort: 100 online sales leads that arrived 100 days ago, 15 of them bought.
// 15% vs the 6% baseline = a +150% lift.
const HEALTHY = batch("h", 100, 100, 15);

console.log("pitch_numbers:eval");

check("a mature cohort reports the close rate AND the lift over Joe's baseline", () => {
  const r = compute(HEALTHY);
  assert.equal(r.cohort.n, 100);
  assert.equal(r.cohort.wins, 15);
  assert.equal(r.closeRatePct, 15);
  assert.equal(r.baselineCloseRatePct, READINESS_TARGETS.pitch.preLeadRiderCloseRatePct);
  assert.equal(r.bookingLiftPct, 150, "lift is RELATIVE to the 6% baseline, not a point delta");
  assert.equal(r.medianResponseMin, 28.8, "the latency figure is passed through, never recomputed here");
});

check("TRAP 1 — leads too young to have closed yet do not enter the denominator", () => {
  const withImmature = [...HEALTHY, ...batch("young", 200, 5, 0)];
  const r = compute(withImmature);
  assert.equal(r.cohort.n, 100, "200 week-old leads must not dilute a mature cohort");
  assert.equal(r.closeRatePct, 15);
  assert.equal(r.bookingLiftPct, 150);
});

check("TRAP 1 contrast — without the maturity lag the same store reads BELOW the baseline", () => {
  const withImmature = [...HEALTHY, ...batch("young", 200, 5, 0)];
  const noLag = compute(withImmature, { maturityDays: 0 });
  assert.equal(noLag.cohort.n, 300, "with no lag the young leads are counted");
  assert.equal(noLag.closeRatePct, 5, "15/300 — under the 6% baseline purely from immaturity");
  assert.equal(noLag.bookingLiftPct, null, "and a negative lift is never reported as a claim");
});

// A store whose HEADLINE looks excellent and whose band does not: 100 mature buyers at 20%, plus
// 400 leads at 35 days old that have bought nothing yet. The default 45d cut sees +233%; move the
// lag to 30d and the same store reads 4% — BELOW the baseline. A knob-picked headline would quote
// the first number and never mention the second.
const KNOB_SENSITIVE = [...batch("m", 100, 100, 20), ...batch("s", 400, 35, 0)];

check("TRAP 2 — a lift that only survives one knob setting is NOT reported", () => {
  const r = compute(KNOB_SENSITIVE);
  assert.ok(r.cohort.n >= PITCH_MIN_COHORT, "the cohort is big enough — this is about robustness, not size");
  assert.equal(r.closeRatePct, 20, "the headline rate is well ABOVE the baseline, so nothing else withheld it");
  assert.equal(r.bookingLiftPct, null, "but the band crosses zero, so no headline lift");
  assert.ok((r.sensitivity.liftMinPct as number) <= 0, "the band is what withheld it");
  assert.ok(r.notes.some(n => n.includes("not robust")), "and it says why in plain words");
});

check("the published band always contains the configuration the headline was computed at", () => {
  // Otherwise the robustness check describes a set of knob settings the headline is not one of,
  // and — for a window the static grid does not cover — a real claim gets withheld because a
  // DIFFERENT window happened to have no data. Both are reporting defects in a dealer-facing number.
  const old = batch("old", 100, 190, 15); // outside every static grid window
  const r = compute(old, { windowDays: 200, maturityDays: 40 });
  assert.ok(
    r.sensitivity.points.some(p => p.windowDays === 200 && p.maturityDays === 40),
    "the config actually used must appear in the band it is judged against"
  );
  assert.equal(r.cohort.n, 100);
  assert.equal(r.bookingLiftPct, 150, "and the claim survives, rather than being withheld by an empty neighbour");
});

check("a close rate below the baseline is never dressed up as a lift", () => {
  const r = compute([...batch("m", 60, 100, 2), ...batch("n", 60, 120, 2)]);
  assert.ok((r.closeRatePct as number) < READINESS_TARGETS.pitch.preLeadRiderCloseRatePct);
  assert.equal(r.bookingLiftPct, null);
  assert.ok(r.notes.some(n => n.includes("not above")), "it says we are behind, rather than going quiet");
});

check("TRAP 3 — a cohort too small to mean anything reports no lift", () => {
  const r = compute(batch("t", 10, 100, 5));
  assert.equal(r.cohort.n, 10);
  assert.equal(r.closeRatePct, 50, "the raw rate is still visible");
  assert.equal(r.bookingLiftPct, null, "but 10 leads is not a measurement");
  assert.ok(r.notes.some(n => n.includes(String(PITCH_MIN_COHORT))), "the note names the floor");
});

check("TRAP 4 — BDC hours replaced is null on every path, healthy or not", () => {
  for (const r of [compute(HEALTHY), compute(batch("t", 10, 100, 5)), compute([])]) {
    assert.equal(r.bdcHoursReplacedPerWeek, null);
  }
  assert.ok(
    compute(HEALTHY).notes.some(n => n.includes("staffing baseline")),
    "and it says a dealer has to supply it, rather than going quiet"
  );
});

check("a sale recorded only as sale.soldAt still counts as a win", () => {
  const viaSale = batch("v", 100, 100, 15, { wonVia: "sale" });
  const r = compute(viaSale);
  assert.equal(r.cohort.wins, 15, "closedReason is not the only way a win is recorded");
  assert.equal(r.bookingLiftPct, 150);
});

check("the denominator is ONLINE SALES leads — service/parts and walk-ins are out", () => {
  const polluted = [
    ...HEALTHY,
    ...batch("svc", 50, 100, 0, { bucket: "service" }),
    ...batch("walk", 50, 100, 0, { source: "Walk In" })
  ];
  const r = compute(polluted);
  assert.equal(r.cohort.n, 100, "Joe's 6% is scoped to online leads, so the comparable must be too");
  assert.equal(r.closeRatePct, 15);
  assert.equal(isOnlineSalesLead(lead("w", 100, { source: "Walk In" })), false);
  assert.equal(isOnlineSalesLead(lead("o", 100, { source: "Website Text Widget" })), true);
});

check("an empty store reports nothing rather than dividing by zero", () => {
  const r = compute([]);
  assert.equal(r.closeRatePct, null);
  assert.equal(r.bookingLiftPct, null);
  assert.equal(r.cohort.n, 0);
});

// -------------------------------------------------------------------------------------------
// THE WIRING. The producer exists to move ONE section of the real scorecard. Assert that by
// running the real consumer over the real output — not by checking field names by eye.
// -------------------------------------------------------------------------------------------

const EMPTY_READINESS = {
  bookingFunnel: null,
  latency: null,
  portability: null,
  ahHardcodes: null,
  checklistRows: [],
  releaseGate: null,
  agentManagerTasks: null,
  strangerTest: null,
  pitchNumbers: null
} as const;

function pitchSection(pitchNumbers: any) {
  const score = evaluateReadiness({ ...EMPTY_READINESS, pitchNumbers });
  const section = score.sections.find(s => s.id === "pitch_numbers");
  assert.ok(section, "the scorecard always carries all five sections");
  return section!;
}

check("WIRING — with no producer the scorecard reads NOT_MEASURED (the state before this change)", () => {
  assert.equal(pitchSection(null).status, "NOT_MEASURED");
});

check("WIRING — this producer's output actually moves section 5 off NOT_MEASURED", () => {
  const r = compute(HEALTHY);
  const section = pitchSection({
    medianResponseMin: r.medianResponseMin,
    bookingLiftPct: r.bookingLiftPct,
    bdcHoursReplacedPerWeek: r.bdcHoursReplacedPerWeek
  });
  assert.notEqual(section.status, "NOT_MEASURED", "the fields must be the ones the scorecard reads");
  assert.equal(section.status, "OPEN", "response time is still over target, so OPEN — never MET by default");
  assert.ok(
    section.metrics.some(m => m.label.toLowerCase().includes("booking lift") && m.met === true),
    "the lift lands on the booking-lift row, measured"
  );
  assert.ok(
    section.metrics.some(m => m.value === "not yet measured"),
    "and BDC hours still reads not yet measured — it was never manufactured"
  );
});

check("WIRING — a withheld lift never rounds up to a pass", () => {
  const r = compute(KNOB_SENSITIVE);
  const section = pitchSection({
    medianResponseMin: r.medianResponseMin,
    bookingLiftPct: r.bookingLiftPct,
    bdcHoursReplacedPerWeek: r.bdcHoursReplacedPerWeek
  });
  assert.notEqual(section.status, "MET");
  assert.ok(section.blockers.length > 0, "a withheld claim is a blocker, not silence");
});

if (failures) {
  console.error(`\npitch_numbers:eval FAILED (${failures})`);
  process.exit(1);
}
console.log("pitch_numbers:eval passed");
