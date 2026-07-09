/**
 * ACT runner eval (pure-ish: runs `list`/`prep` against a fixture work order; source-guards the safety
 * properties). The runner turns a loop finding into an approvable PR — so the non-negotiables are: it NEVER
 * merges (PR-only), it REFUSES to PR from main, it requires commits ahead of main, it ENFORCES the gates
 * (tsc; ci:eval unless explicitly verified), and `prep` emits a brief carrying the parser-first contract.
 *
 * Run: npx tsx scripts/act_runner_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  findingKeyMarker,
  findOpenPrForFindingKey,
  isMeaningfulFindingKey
} from "../services/api/src/domain/loopPrDedup.ts";

const src = fs.readFileSync("scripts/act_runner.ts", "utf8");

// --- Safety guarantees (source-level — these are the properties that keep ACT trustworthy). ---
assert.ok(/"pr", "create"/.test(src), "opens an auditable PR via gh pr create");
// Merge is now GATED, not forbidden: the runner merges ONLY inside the `if (gate.ship)` block — i.e. only
// on a clean cross-model pre-ship approve. open-pr stays PR-only; review escalates (leaves the PR open)
// on anything short of approve.
assert.ok(/if \(gate\.ship\) \{[\s\S]*?"pr", "merge"/.test(src), "merges ONLY on a clean cross-model approve (gate.ship)");
assert.ok(/ESCALATED — PR left OPEN for a human/.test(src), "anything short of approve => PR left open + escalate (not merged)");
// On escalation, the runner emails the operator IMMEDIATELY (not just the daily digest), best-effort.
assert.ok(/a fix needs your review/.test(src), "escalation sends an immediate 'needs your review' email");
assert.ok(/import\("\.\.\/services\/api\/src\/domain\/emailSender\.ts"\)/.test(src), "the escalation email reuses the existing sendEmail (no new infra)");
assert.ok(/Escalation email failed \(non-fatal\)/.test(src), "a notification failure never changes the escalation outcome (best-effort)");
assert.match(src, /Refusing to open a PR from main|Refusing to review\/ship from main/, "refuses to PR/ship from main");
assert.match(src, /rev-list", "--count", "main\.\.HEAD"/, "requires commits ahead of main");
assert.match(src, /Running tsc/, "enforces tsc before the PR");
assert.match(src, /npm", \["run", "ci:eval"\]/, "runs ci:eval (unless --eval-verified)");
assert.match(src, /eval-verified/, "supports --eval-verified to skip a just-run ci:eval");
assert.match(src, /COMPREHEND, never regex/, "the prep brief carries the parser-first law");

// --- Behavior: prep against a fixture next.json writes a brief with the finding + contract. ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "act-eval-"));
fs.mkdirSync(path.join(tmp, "anomaly_loop"), { recursive: true });
fs.writeFileSync(
  path.join(tmp, "anomaly_loop", "next.json"),
  JSON.stringify({
    workOrders: [
      { convId: "+1555", leadKey: "+1555", dimension: "open_critic_finding", category: "discovery", severity: "P2", tier: 2, action: "escalate", notify: true, detail: "watch_set_for_wrong_model — opened a Road Glide watch on a Street Glide ask" }
    ]
  })
);
const out = execFileSync("npx", ["tsx", "scripts/act_runner.ts", "prep", "--top"], {
  encoding: "utf8",
  env: { ...process.env, REPORT_ROOT: tmp, CONVERSATIONS_DB_PATH: "" }
});
assert.match(out, /Fix brief written/, "prep writes a brief");
assert.match(out, /Suggested branch: fix\/loop-/, "prep proposes a feature branch");
const briefPath = path.join(tmp, "act", "brief-_1555_open_critic_finding.md");
assert.ok(fs.existsSync(briefPath), "the brief file exists");
const brief = fs.readFileSync(briefPath, "utf8");
assert.match(brief, /watch_set_for_wrong_model/, "brief carries the finding");
assert.match(brief, /route parity|both/i, "brief states the both-paths requirement");
assert.match(brief, /deterministic eval wired into ci:eval/, "brief requires an eval");

// --- list runs clean. ---
const listOut = execFileSync("npx", ["tsx", "scripts/act_runner.ts", "list"], {
  encoding: "utf8",
  env: { ...process.env, REPORT_ROOT: tmp }
});
assert.match(listOut, /open_critic_finding/, "list shows the work order");
assert.match(listOut, /id: \+1555::open_critic_finding/, "list shows the work-order id");

// --- Cross-routine PR dedup (the pure matcher + the wiring source-guards). ---
const k = "+17163308822::watch_fire_miss";
const openPrs = [
  { number: 7, title: "Daily review: watch_fire_miss", body: `root cause...\n${findingKeyMarker(k)}\n` },
  { number: 8, title: "unrelated", body: "no marker here" }
];
assert.equal(findOpenPrForFindingKey(openPrs, k)?.number, 7, "finds the open PR carrying the finding-key marker");
assert.equal(findOpenPrForFindingKey(openPrs, "+1999::other_dim"), null, "no false match for a different finding");
assert.equal(findOpenPrForFindingKey([], k), null, "empty open-PR list never dedups (fail toward building)");
// Fail-direction: an empty/malformed key must NEVER dedup (never silently drop a real fix).
assert.equal(isMeaningfulFindingKey("::"), false, "a bare '::' key is not meaningful");
assert.equal(isMeaningfulFindingKey(""), false, "an empty key is not meaningful");
assert.equal(isMeaningfulFindingKey(k), true, "a real convId::dimension key is meaningful");
assert.equal(findOpenPrForFindingKey(openPrs, "::"), null, "a malformed key never dedups");
// Source-guards: open-pr and review --ship skip duplicates and stamp the marker.
assert.match(src, /sub === "check-open-pr"/, "exposes a read-only check-open-pr triage subcommand");
assert.match(src, /skipIfDuplicateOpenPr\(flag\("finding-key"\)\)/, "open-pr/review skip when an open PR already covers the finding");
assert.match(src, /withFindingKeyMarker\(/, "the PR body is stamped with the finding-key marker for later dedup");
assert.match(src, /process\.exit\(3\)/, "a duplicate-skip uses a distinct exit code (3)");


// --- Merged-PR finding dedup (Joe, 2026-07-02: "double work in two different routines"): a
//     finding whose key sits in a RECENTLY-MERGED PR is a stale echo awaiting report refresh —
//     covered, not rebuildable. Windowed + fail-toward-building on any uncertainty. ---
{
  const { findMergedPrForFindingKey, findingKeyMarker } = await import("../services/api/src/domain/loopPrDedup.ts");
  const NOW = Date.parse("2026-07-02T12:00:00.000Z");
  const key = "+15551234567::human_correction_material";
  const freshMerged = [{ number: 148, body: `fix\n${findingKeyMarker(key)}`, mergedAt: "2026-07-01T12:00:00.000Z" }];
  assert.ok(findMergedPrForFindingKey(freshMerged, key, { nowMs: NOW })?.number === 148, "a fresh merged PR covers its finding key");
  const oldMerged = [{ number: 90, body: `fix\n${findingKeyMarker(key)}`, mergedAt: "2026-06-01T12:00:00.000Z" }];
  assert.equal(findMergedPrForFindingKey(oldMerged, key, { nowMs: NOW }), null, "a merge outside the window never dedups");
  const noDate = [{ number: 91, body: `fix\n${findingKeyMarker(key)}` }];
  assert.equal(findMergedPrForFindingKey(noDate, key, { nowMs: NOW }), null, "missing mergedAt cannot prove recency → keep building");
  assert.equal(findMergedPrForFindingKey(freshMerged, "::", { nowMs: NOW }), null, "meaningless key never dedups");
  const fs2 = await import("node:fs");
  const runner = fs2.readFileSync("scripts/act_runner.ts", "utf8");
  assert.ok(/findMergedPrForFindingKey\(listRecentlyMergedLoopPrs\(\)/.test(runner), "act_runner consults merged PRs in check-open-pr AND the build path");
  assert.ok(/process\.exit\(4\)/.test(runner), "merged coverage exits with its own distinct code (4)");
}

console.log("PASS act runner eval — PR-only (never merges), refuses main, gate-enforced; prep brief carries the parser-first contract; cross-routine PR dedup (marker + skip); list/prep run.");
