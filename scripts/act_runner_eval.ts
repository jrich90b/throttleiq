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
// Notification is best-effort in BOTH directions (email + the durable PR-comment fallback):
// a failure never changes the gate outcome.
assert.ok(/Notification email failed \(non-fatal\)/.test(src), "an email failure never changes the gate outcome (best-effort)");
assert.ok(/PR comment failed \(non-fatal\)/.test(src), "a PR-comment failure never changes the gate outcome (best-effort)");
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

  // The reviewed diff must be taken against the REMOTE base. Local `main` goes stale as soon as
  // another author merges, and a stale base hands the reviewer other people's already-merged
  // commits as if they were part of this change (observed on PR #336: the review spent its
  // concerns on an unrelated documentPhotoCaptures change).
  assert.ok(
    /execFileSync\("git", \["fetch", "-q", "origin", "main"\]/.test(runner),
    "act_runner refreshes origin/main before computing the reviewed diff"
  );
  assert.ok(
    /"origin\/main", "main"/.test(runner),
    "origin/main is the PREFERRED diff base, with the local ref only as a fallback"
  );
  assert.ok(
    /\$\{base\}\.\.\.HEAD/.test(runner),
    "the diff is three-dot against the resolved base (merge-base), not a raw two-dot compare"
  );
  assert.ok(
    /WARNING: reviewed diff is against the LOCAL main ref/.test(runner),
    "falling back to the stale local ref is announced, never silent"
  );
  assert.ok(
    !/execFileSync\("git", \["diff", "main\.\.\.HEAD"\]/.test(runner),
    "the old unconditional local-main diff is gone"
  );
}

// --- Tier-2a citations: rule ids AND the `NS` North-star citation (Joe, 2026-07-30). ---
// `NS` is the escape hatch for a change that serves the stated goal but matches no rule id. It is the
// WEAKEST citation, so the things worth pinning are: it is accepted at all, it resolves the WHOLE
// North-star section (goal + the five tests, not just the heading), and it buys NO gate relief.
{
  assert.ok(
    /const isNorthStar = charterId === "NS"/.test(src),
    "--charter accepts the literal NS alongside C<n>.<m> rule ids"
  );
  assert.ok(
    /--charter must be a rule id like C3\.2, or NS for the North star/.test(src),
    "a bogus citation still hard-errors, and the message names both accepted forms"
  );
  assert.ok(
    /\/\^## North star\\b\/\.test\(l\)/.test(src),
    "NS resolves against the charter's '## North star' section heading"
  );
  // The rule-id resolver stops at ANY heading (`^#{1,3} `); NS must NOT, or the excerpt would be cut
  // at the '### The bar, as five tests' subsection and the reviewer would never see the targets.
  assert.ok(
    /if \(isNorthStar\) \{[\s\S]*?if \(\/\^## \/\.test\(lines\[i\]\)\) break;/.test(src),
    "the NS excerpt terminates at the next H2 — subsections stay INSIDE the excerpt"
  );
  assert.ok(
    /requireCharterCovered: !!charterCitation/.test(src),
    "NS is gated exactly like a rule id — coverage is still required, it is not a bypass"
  );

  // Pin the DATA the resolver depends on: the charter must actually carry a North-star section with a
  // following H2, else NS would silently excerpt to end-of-file.
  const charterMd = fs.readFileSync("docs/policy_charter.md", "utf8").split(/\r?\n/);
  const nsStart = charterMd.findIndex(l => /^## North star\b/.test(l));
  assert.ok(nsStart >= 0, "docs/policy_charter.md still has a '## North star' section for NS to cite");
  const excerpt: string[] = [charterMd[nsStart]];
  for (let i = nsStart + 1; i < charterMd.length; i += 1) {
    if (/^## /.test(charterMd[i])) break;
    excerpt.push(charterMd[i]);
  }
  assert.ok(
    excerpt.length < charterMd.length - nsStart,
    "the North-star section is followed by another H2 — the NS excerpt is bounded, not the whole file"
  );
  const nsText = excerpt.join("\n");
  assert.match(nsText, /READINESS BAR/, "the NS excerpt carries the goal itself (the readiness bar)");
  assert.match(nsText, /Stranger test/i, "the NS excerpt carries the five tests, not just the heading");
  assert.ok(
    !/^- \*\*C\d+\.\d+\*\*/m.test(nsText),
    "the NS excerpt stops before the numbered rule sections (it cites the goal, not a rule)"
  );
}

console.log("PASS act runner eval — PR-only (never merges), refuses main, gate-enforced; prep brief carries the parser-first contract; cross-routine PR dedup (marker + skip); NS citation resolves the bounded North-star section and buys no gate relief; list/prep run.");
