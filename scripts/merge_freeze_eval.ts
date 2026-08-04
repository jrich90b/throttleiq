import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MERGE_FREEZE_MAX_AGE_MINUTES,
  describeMergeFreeze,
  evaluateMergeFreeze
} from "../services/api/src/domain/mergeFreeze.ts";

/**
 * merge_freeze:eval — pins the freeze that makes a full-suite release gate possible (Joe, 2026-08-04:
 * "let's set up the full suite with the golden corpus").
 *
 * THE WHOLE POINT IS THE FAIL-DIRECTION, and it is the opposite of most guards in this repo. A stuck
 * freeze silently stops EVERY routine landing work — far worse than one deploy shipping on a main
 * that moved a little. So every ambiguous state must read as NOT FROZEN. These assertions exist so
 * nobody "tightens" that later without noticing they are trading a small risk for a total stall.
 *
 * Deterministic; no IO beyond reading the two scripts to prove the wiring.
 */

const NOW = Date.parse("2026-08-04T18:00:00.000Z");
const MIN = 60_000;

// --- FRESH freeze is honoured ---
{
  const s = evaluateMergeFreeze(
    { owner: "release-gate", at: new Date(NOW - 10 * MIN).toISOString(), reason: "full release gate + golden corpus" },
    { nowMs: NOW }
  );
  assert.equal(s.frozen, true, "a fresh, well-formed freeze is honoured");
  if (s.frozen) {
    assert.equal(s.owner, "release-gate");
    assert.equal(s.ageMinutes, 10);
    assert.match(describeMergeFreeze(s), /MERGE FROZEN by release-gate 10m ago/, "the message names who and when");
    assert.match(describeMergeFreeze(s), /Do not merge/, "…and says what to do");
  }
}

// --- EVERY ambiguous state fails OPEN (merging allowed) ---
{
  const cases: Array<[string, unknown]> = [
    ["absent", null],
    ["undefined", undefined],
    ["no owner", { at: new Date(NOW).toISOString() }],
    ["empty owner", { owner: "   ", at: new Date(NOW).toISOString() }],
    ["no timestamp", { owner: "x" }],
    ["unparseable timestamp", { owner: "x", at: "whenever" }],
    ["corrupt record marker", { malformed: true }]
  ];
  for (const [label, raw] of cases) {
    const s = evaluateMergeFreeze(raw, { nowMs: NOW });
    assert.equal(s.frozen, false, `${label} must NOT freeze merging`);
    assert.match(describeMergeFreeze(s), /merging is allowed/, `${label} says merging is allowed`);
  }
}

// --- a freeze EXPIRES on its own: a crashed gate must never stall the fleet ---
{
  const justInside = evaluateMergeFreeze(
    { owner: "release-gate", at: new Date(NOW - (DEFAULT_MERGE_FREEZE_MAX_AGE_MINUTES - 1) * MIN).toISOString() },
    { nowMs: NOW }
  );
  assert.equal(justInside.frozen, true, "inside the window it still holds");

  const justOutside = evaluateMergeFreeze(
    { owner: "release-gate", at: new Date(NOW - (DEFAULT_MERGE_FREEZE_MAX_AGE_MINUTES + 1) * MIN).toISOString() },
    { nowMs: NOW }
  );
  assert.equal(justOutside.frozen, false, "past the window it is abandoned, not honoured");
  assert.match(describeMergeFreeze(justOutside), /stale merge freeze.*IGNORED/, "an expired freeze is reported, not silent");

  // The default window must outlast a full gate run (~45m) but stay well under a working day —
  // long enough to be useful, short enough that a crash costs one cycle, not an afternoon.
  assert.ok(DEFAULT_MERGE_FREEZE_MAX_AGE_MINUTES >= 60, "window must comfortably outlast a ~45m ci:eval");
  assert.ok(DEFAULT_MERGE_FREEZE_MAX_AGE_MINUTES <= 180, "window must not be able to stall a whole day");

  // A future-dated record must not become immortal by having a negative age.
  const future = evaluateMergeFreeze({ owner: "x", at: new Date(NOW + 10 * MIN).toISOString() }, { nowMs: NOW });
  assert.equal(future.frozen, true, "clock skew reads as fresh, not as expired");
  if (future.frozen) assert.equal(future.ageMinutes, 0, "age never goes negative");
}

// --- a caller-supplied window is honoured ---
{
  const s = evaluateMergeFreeze({ owner: "x", at: new Date(NOW - 30 * MIN).toISOString() }, { nowMs: NOW, maxAgeMinutes: 15 });
  assert.equal(s.frozen, false, "a shorter window expires it sooner");
}

// --- WIRING: the gate takes it, releases it on every exit path, and the gold check is in the chain ---
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const gate = fs.readFileSync(path.join(here, "release_gate_full.sh"), "utf8");
  assert.match(gate, /merge_freeze\.ts take/, "the gate takes the freeze");
  assert.match(gate, /trap release_freeze EXIT INT TERM/, "the freeze is released on EVERY exit path, including failure");
  assert.match(gate, /npm run ci:eval/, "the gate runs the FULL suite, not a subset");
  assert.match(gate, /gold_score_gate\.ts/, "the gate asks the golden-corpus question");
  assert.match(gate, /CI_EXIT=\$\?/, "the gate captures ci:eval's own exit code rather than trusting the pipeline");
  // ci:eval must be proven BEFORE anything deploys.
  assert.ok(gate.indexOf("npm run ci:eval") < gate.indexOf("npm run deploy:api"), "nothing deploys before the suite is green");
  assert.ok(gate.indexOf("gold_score_gate.ts") < gate.indexOf("npm run deploy:api"), "nothing deploys before the gold check");

}

// --- the gold gate's FAIL-CLOSED behaviour, exercised for real ---
// Pinned by RUNNING it, not by grepping it: a source pin on `process.exit(1)` would survive any
// refactor that quietly turned a failure into a pass, which is the whole failure mode here.
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gold-gate-eval-"));
  const scoreDir = path.join(tmp, "gold_score");
  fs.mkdirSync(scoreDir, { recursive: true });
  const reportFile = path.join(scoreDir, "gold_score_report.json");
  const write = (generatedAt: string, score: number, scored: number) =>
    fs.writeFileSync(reportFile, JSON.stringify({ generatedAt, summary: { score, scored, correct: Math.round((score / 100) * scored), byTier: {} } }));

  const run = (env: Record<string, string>) =>
    spawnSync("npx", ["tsx", path.join(here, "gold_score_gate.ts")], {
      env: { ...process.env, REPORT_ROOT: tmp, ...env },
      encoding: "utf8"
    }).status;

  const fresh = new Date().toISOString();

  write(fresh, 45, 20);
  assert.equal(run({ GOLD_SCORE_FLOOR: "30" }), 0, "a fresh score above the floor ships");
  assert.equal(run({ GOLD_SCORE_FLOOR: "60" }), 1, "below the floor STOPS the release");
  assert.equal(run({ GOLD_SCORE_FLOOR: "30", GOLD_SCORE_MIN_SCORED: "50" }), 1, "a thin run is a broken run, never a pass");
  assert.equal(run({ GOLD_SCORE_FLOOR: "30", GOLD_SCORE_MAX_AGE_HOURS: "0" }), 1, "a STALE score is not evidence about today's agent");

  write("2026-07-01T00:00:00.000Z", 99, 500);
  assert.equal(run({ GOLD_SCORE_FLOOR: "30" }), 1, "even a great score stops the release once it is stale");

  fs.rmSync(reportFile);
  assert.equal(run({ GOLD_SCORE_FLOOR: "30" }), 1, "a MISSING report fails closed — never 'no news is good news'");

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(
  "PASS merge_freeze eval — fresh freeze honoured; absent/malformed/expired all fail OPEN; window outlasts a gate but cannot stall a day; release gate wiring pinned"
);
