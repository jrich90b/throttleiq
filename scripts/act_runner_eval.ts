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
  assert.ok(
    (runner.match(/findMergedPrForFindingKey\(ledger\.mergedPrs/g) ?? []).length >= 2,
    "act_runner consults merged PRs in check-open-pr AND the build path"
  );
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

// --- "Could not look" must never be reported as "looked and found nothing" (measured 2026-08-03).
//     The loop runner ran check-open-pr ON THE BOX, where every other STEP-2 command runs and where
//     `gh` is not installed. The gh reader failed to [], and the runner turned that [] into
//     `NONE — no open or recently-merged PR covers "+17162605541::human_correction_material"` at
//     exit 0 — while PR #488 carried exactly that marker (the same key answered EXISTS #488 on the
//     Mac a minute later). A NONE that a routine cannot distinguish from a real absence is how two
//     routines build the same fix, which is the thing ROUTINE_CONTRACT.md's dedup-first step exists
//     to stop. The asymmetry pinned below is the fix: a POSITIVE match is proof from any source, an
//     ABSENCE is only provable from a live, complete gh read. ---
{
  const { readLoopPrLedger } = await import("./loopPrLedger.ts");
  const key = "+15551234567::human_correction_material";

  // A directory whose `gh` always fails, prepended to PATH: node/npx keep working, gh does not —
  // exactly the box's shape (gh absent) without needing the box.
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "act-runner-eval-nogh-"));
  fs.writeFileSync(path.join(fakeBin, "gh"), "#!/bin/sh\nexit 1\n");
  fs.chmodSync(path.join(fakeBin, "gh"), 0o755);
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "act-runner-eval-root-"));
  const realPath = process.env.PATH ?? "";
  const noGhPath = `${fakeBin}${path.delimiter}${realPath}`;

  process.env.PATH = noGhPath;
  try {
    // 1. No gh, no exported ledger — the read must ADMIT it saw nothing, not report an empty world.
    const blind = readLoopPrLedger({ reportRoot: emptyRoot });
    assert.equal(blind.source, "unavailable", "no gh + no export => source 'unavailable'");
    assert.equal(blind.canProveAbsence, false, "a read that could not look can never prove an absence");

    // 2. A fresh exported ledger CARRYING the key still proves coverage — a snapshot can miss a PR,
    //    never invent one, so a positive match is trustworthy from any source.
    const fileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "act-runner-eval-ledger-"));
    fs.mkdirSync(path.join(fileRoot, "anomaly_loop"), { recursive: true });
    fs.writeFileSync(
      path.join(fileRoot, "anomaly_loop", "pr_ledger.json"),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        openPrs: [{ number: 488, title: "Loop fix", body: `fix\n${findingKeyMarker(key)}` }],
        mergedPrs: []
      })
    );
    const fromFile = readLoopPrLedger({ reportRoot: fileRoot });
    assert.equal(fromFile.source, "file", "gh-less host falls back to the exported pr_ledger.json");
    assert.equal(
      findOpenPrForFindingKey(fromFile.openPrs, key)?.number,
      488,
      "a file-sourced ledger still MATCHES a covered key (positive match is proof from any source)"
    );
    // ...but its silence is not proof: the export is written daily and freshness-guarded at 3 days,
    // so it can be perfectly "fresh" and still predate the PR being asked about (the 8/3 box copy
    // was generated 8/2 14:39, ~29h before PR #488 opened).
    assert.equal(
      fromFile.canProveAbsence,
      false,
      "a snapshot cannot see PRs opened since it was written => it can match, but never prove absence"
    );

    // 3. End-to-end: the CLI a routine actually calls must exit 5 / UNKNOWN here — never 0 / NONE.
    let code = 0;
    let stdout = "";
    try {
      stdout = execFileSync("npx", ["tsx", "scripts/act_runner.ts", "check-open-pr", "--key", key], {
        encoding: "utf8",
        env: { ...process.env, PATH: noGhPath, REPORT_ROOT: emptyRoot }
      });
    } catch (err: any) {
      code = typeof err?.status === "number" ? err.status : -1;
      stdout = String(err?.stdout ?? "");
    }
    assert.equal(code, 5, "check-open-pr on a gh-less host exits 5 (cannot verify), not 0 (clear to build)");
    assert.match(stdout, /UNKNOWN/, "it says UNKNOWN out loud");
    assert.ok(!/^NONE/m.test(stdout), "it never prints the confident NONE it cannot support");
    fs.rmSync(fileRoot, { recursive: true, force: true });
  } finally {
    process.env.PATH = realPath;
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }

  // The BUILD path keeps the opposite fail-direction on purpose — an unverifiable ledger must never
  // block a real fix — but it may not pass silently, or a duplicate PR is filed with no trace of why.
  assert.ok(/DEDUP UNVERIFIED/.test(src), "the build path warns loudly when coverage could not be verified");
  assert.ok(/Building anyway/.test(src), "...and still builds (never drop a fix we can't prove is covered)");
}

// ---------------------------------------------------------------------------
// THE MERGE FREEZE IS ENFORCED WHERE MERGES HAPPEN (2026-08-04).
//
// A release gate held the freeze, spent 45 minutes proving `2395262b`, and failed at the deploy
// step because PR #537 landed underneath it — opened and merged two seconds apart, by the
// loop-runner, through THIS runner's `--ship` path. The rule existed only as prose in
// ROUTINE_CONTRACT.md and not one routine's SKILL.md even mentioned `merge_freeze`.
//
// These assertions are about the DECISION and the CONTRACT, not the prose: the runner must consult
// the freeze before merging, must fail OPEN on anything that is not an explicit freeze, and must
// leave the PR open rather than dropping the work.
// ---------------------------------------------------------------------------
{
  const { evaluateMergeFreeze, readMergeFreezeStatus } = await import(
    "../services/api/src/domain/mergeFreeze.ts"
  );
  const now = Date.parse("2026-08-04T23:01:00.000Z");
  const fresh = (over: Record<string, unknown> = {}) => ({
    owner: "release-gate",
    at: "2026-08-04T22:55:00.000Z",
    reason: "full release gate + golden corpus",
    ...over
  });

  // THE INCIDENT: a live gate freeze must stop the merge.
  assert.equal(
    evaluateMergeFreeze(fresh(), { nowMs: now }).frozen,
    true,
    "a freeze taken 6 minutes ago is live — this is the #537 moment, and the merge must not happen"
  );

  // FAIL OPEN on everything that is not an explicit, live freeze. Each of these must MERGE.
  for (const [label, raw] of [
    ["no freeze record at all", null],
    ["undefined record", undefined],
    ["a non-object record", "frozen!"],
    ["a record with no owner", fresh({ owner: "" })],
    ["a record with an unreadable timestamp", fresh({ at: "not-a-date" })],
    ["an EXPIRED freeze (91 minutes old)", fresh({ at: "2026-08-04T21:30:00.000Z" })]
  ] as const) {
    assert.equal(
      evaluateMergeFreeze(raw as unknown, { nowMs: now }).frozen,
      false,
      `fail-open: ${label} must NOT block a merge — a stuck freeze halting every routine is the worse failure`
    );
  }


  // THE READ ITSELF, not just the judgement. An earlier cut of this eval tested only
  // `evaluateMergeFreeze` while the fail-open promise lived in a wrapper around it — a sabotage
  // that made a MISSING record read as FROZEN sailed straight through. Drive the real reader.
  {
    const live = readMergeFreezeStatus({
      dir: "/anything",
      nowMs: now,
      exists: () => true,
      readFile: () => JSON.stringify(fresh())
    });
    assert.equal(live.frozen, true, "the reader reports a live freeze from disk");

    for (const [label, opts] of [
      ["the freeze directory/file does not exist", { exists: () => false, readFile: () => "" }],
      ["the record is corrupt JSON", { exists: () => true, readFile: () => "{not json" }],
      ["the record is empty", { exists: () => true, readFile: () => "" }],
      [
        "reading it throws (permissions, races)",
        {
          exists: () => true,
          readFile: () => {
            throw new Error("EACCES");
          }
        }
      ],
      [
        "the existence check itself throws",
        {
          exists: () => {
            throw new Error("EACCES");
          },
          readFile: () => ""
        }
      ],
      [
        "the freeze has expired",
        { exists: () => true, readFile: () => JSON.stringify(fresh({ at: "2026-08-04T21:30:00.000Z" })) }
      ]
    ] as const) {
      assert.equal(
        readMergeFreezeStatus({ dir: "/anything", nowMs: now, ...(opts as any) }).frozen,
        false,
        `reader fails OPEN: ${label} must not block a merge`
      );
    }
  }

  // The runner must actually consult it at the merge, and hold the PR open rather than drop it.
  const src = fs.readFileSync(new URL("./act_runner.ts", import.meta.url), "utf8");
  assert.ok(
    /if \(gate\.ship && isMergeFrozen\(\)\)/.test(src),
    "the freeze is checked on the ship path, BEFORE the merge"
  );
  const shipIdx = src.indexOf("gate.ship && isMergeFrozen()");
  const mergeIdx = src.indexOf('execFileSync("gh", ["pr", "merge"');
  assert.ok(
    shipIdx > 0 && mergeIdx > shipIdx,
    "the check must come BEFORE the merge call, not after it"
  );
  assert.ok(
    /HELD BY MERGE FREEZE/.test(src) && /process\.exit\(ACT_EXIT_MERGE_FROZEN\)/.test(src),
    "a frozen ship reports itself and exits on its own code, so a caller can tell it apart from a failure"
  );
  // Read from source, never imported: act_runner.ts runs its CLI on import (no entry guard).
  const exitCode = /export const ACT_EXIT_MERGE_FROZEN = (\d+);/.exec(src)?.[1];
  assert.equal(exitCode, "6", "the held-by-freeze exit code is stable for callers");
  assert.ok(
    !/pr", "merge"[\s\S]{0,400}isMergeFrozen/.test(src),
    "there is no second, unchecked merge path"
  );
  // Only ONE place merges — if a second one appears it must be checked too.
  assert.equal(
    (src.match(/"pr", "merge"/g) ?? []).length,
    1,
    "exactly one merge call site; a new one needs its own freeze check"
  );
}

console.log("PASS act runner eval — PR-only (never merges), refuses main, gate-enforced; prep brief carries the parser-first contract; cross-routine PR dedup (marker + skip, and an unverifiable ledger reports UNKNOWN instead of a false NONE); NS citation resolves the bounded North-star section and buys no gate relief; list/prep run.");
