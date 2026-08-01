/**
 * decision_equivalence:eval — pins the harness that proves an un-stacking changed nothing.
 *
 * This harness is the thing that lets un-stacking go fast: once "behavior-preserving" is MEASURED
 * across the live corpus instead of asserted, there is nothing left for a human to eyeball. That
 * makes its failure mode uniquely dangerous — a harness that reports "identical" because it
 * compared NOTHING would launder an unverified refactor as proven, and would do it silently.
 *
 * So most of these rows are about refusing to pass, not about passing:
 *   - an empty corpus, an empty registry, a clock mismatch, or ANY projection error is a BLOCKER
 *   - zero decisions actually compared is a BLOCKER, never a clean run
 *   - and the diff must genuinely catch a changed decision (proven here by changing one)
 */
import assert from "node:assert/strict";
import {
  buildDecisionRegistry,
  diffFingerprints,
  fingerprintCorpus,
  type FingerprintClock
} from "../services/api/src/domain/decisionFingerprint.ts";

const CLOCK: FingerprintClock = { nowMs: Date.parse("2026-08-01T12:00:00.000Z"), timeZone: "America/New_York" };

const CORPUS = [
  {
    id: "+15550000001",
    followUp: { reason: "financing_declined" },
    financeOutcome: { status: "declined" },
    followUpCadence: { kind: "engaged", status: "active" },
    appointment: { whenIso: "2026-07-20T17:00:00.000Z", staffNotify: { outcome: { primaryStatus: "did_not_show" } } }
  },
  {
    id: "+15550000002",
    followUp: { reason: "active" },
    followUpCadence: { kind: "standard", status: "active" },
    sale: { soldAt: "2026-05-01T00:00:00.000Z" }
  },
  { id: "+447700900123", lead: { phone: "+447700900123" } }
];

const reducer = await import("../services/api/src/domain/routeStateReducer.ts");

// --- a real run over a real registry produces real decisions ---
const registry = buildDecisionRegistry(reducer);
assert.ok(registry.length >= 4, "the registry samples several decisions");
const run = fingerprintCorpus(CORPUS, registry, CLOCK);
assert.equal(run.errors.length, 0, "no projection throws on well-formed conversations");
assert.equal(run.conversations.length, 3, "every conversation is fingerprinted");
const first = run.conversations.find(c => c.convId === "+15550000001")!;
assert.ok(Object.keys(first.decisions).length > 0, "a conversation with state yields decisions");

// --- DETERMINISM: the same corpus + clock must fingerprint identically, twice ---
{
  const a = fingerprintCorpus(CORPUS, registry, CLOCK);
  const b = fingerprintCorpus(CORPUS, registry, CLOCK);
  assert.deepEqual(a.conversations, b.conversations, "fingerprinting is deterministic (no wall-clock reads)");
  assert.equal(diffFingerprints(a, b).identical, true, "a run against itself is IDENTICAL");
}

// --- it CATCHES a changed decision (the whole point) ---
{
  const before = fingerprintCorpus(CORPUS, registry, CLOCK);
  const after = fingerprintCorpus(CORPUS, registry, CLOCK);
  const target = after.conversations.find(c => c.convId === "+15550000001")!;
  const name = Object.keys(target.decisions)[0];
  target.decisions[name] = { deliberately: "different" };
  const diff = diffFingerprints(before, after);
  assert.equal(diff.identical, false, "a changed decision is NOT identical");
  assert.equal(diff.changes.length, 1, "exactly the changed decision is reported");
  assert.equal(diff.changes[0].convId, "+15550000001", "the affected conversation is named");
  assert.equal(diff.changes[0].decision, name, "the affected decision is named");
}

// --- FAIL CLOSED: everything that makes a comparison meaningless must BLOCK, not pass ---
{
  const good = fingerprintCorpus(CORPUS, registry, CLOCK);

  const empty = fingerprintCorpus([], registry, CLOCK);
  const emptyDiff = diffFingerprints(good, empty);
  assert.equal(emptyDiff.identical, false, "an empty corpus is NOT a pass");
  assert.ok(emptyDiff.blockers.length > 0, "an empty corpus is reported as a blocker");

  const noRegistry = fingerprintCorpus(CORPUS, [], CLOCK);
  const noRegDiff = diffFingerprints(noRegistry, noRegistry);
  assert.equal(noRegDiff.identical, false, "an empty registry is NOT a pass");

  // Clock drift: time-dependent decisions would differ for reasons unrelated to the change.
  const drifted = fingerprintCorpus(CORPUS, registry, {
    nowMs: CLOCK.nowMs + 86_400_000,
    timeZone: CLOCK.timeZone
  });
  const driftDiff = diffFingerprints(good, drifted);
  assert.equal(driftDiff.identical, false, "two different clocks cannot produce a clean verdict");
  assert.ok(
    driftDiff.blockers.some(b => /clock/i.test(b)),
    "clock drift is named as the blocker"
  );

  // A projection that throws means those conversations were not compared — never a clean run.
  const exploding = [{ name: "boom", sample: () => { throw new Error("projection failed"); } }];
  const withErrors = fingerprintCorpus(CORPUS, [...registry, ...exploding], CLOCK);
  assert.ok(withErrors.errors.length > 0, "a throwing projection is RECORDED, not swallowed");
  assert.equal(
    diffFingerprints(withErrors, withErrors).identical,
    false,
    "projection errors block the verdict even when both sides match"
  );
}

// --- a decision present on only ONE side is NOT a behavior change ---
// (a newly added referee has no baseline; treating that as a change would make every
//  un-stacking PR look like a regression and the harness would be ignored within a week)
{
  const before = fingerprintCorpus(CORPUS, registry, CLOCK);
  const after = fingerprintCorpus(CORPUS, registry, CLOCK);
  after.conversations[0].decisions.brandNewReferee = { kind: "whatever" };
  after.decisionNames = [...after.decisionNames, "brandNewReferee"];
  const diff = diffFingerprints(before, after);
  assert.equal(diff.identical, true, "a decision added by the candidate is not a behavior change");
  assert.ok(diff.comparedDecisions > 0, "and the shared decisions were still genuinely compared");
}

// --- coverage is always reported, so a verdict can never be quoted without its denominator ---
{
  const diff = diffFingerprints(run, run);
  assert.ok(diff.comparedConversations === 3, "the conversation count backing the verdict is reported");
  assert.ok(diff.comparedDecisions > 0, "the decision count backing the verdict is reported");
}

console.log("PASS decision equivalence — determinism, catches real changes, fails CLOSED on an empty/untrustworthy run");
