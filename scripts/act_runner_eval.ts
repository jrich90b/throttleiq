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
import { execFileSync, spawnSync } from "node:child_process";
import {
  findingKeyMarker,
  findOpenPrForFindingKey,
  isMeaningfulFindingKey
} from "../services/api/src/domain/loopPrDedup.ts";
import { unknownFlags } from "./actRunnerCliArgs.ts";

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
    /--charter must be a rule id like C3\.2 or C1\.2a, or NS for the North star/.test(src),
    "a bogus citation still hard-errors, and the message names both accepted forms"
  );
  // LETTERED SUB-RULES, executed against the real charter. C1.2a and C1.4a exist and were REJECTED by
  // the id pattern, which pushed a change implementing one toward citing its parent — a stretched
  // citation, the exact thing the Tier-2a bar refuses. C1.2 ("keep the intro") and C1.2a ("…but only
  // on a first touch") are close to opposite, so the parent is not a safe stand-in for the child.
  const ID_RE = /^C\d+\.\d+[a-z]?$/;
  for (const id of ["C3.2", "C1.2", "C1.2a", "C1.4a"]) {
    assert.ok(ID_RE.test(id), `${id} must be a citable rule id`);
  }
  for (const bogus of ["C1", "1.2a", "C1.2ab", "NS2", ""]) {
    assert.equal(ID_RE.test(bogus), false, `"${bogus}" must not pass as a rule id`);
  }
  assert.ok(
    /\/\^C\\d\+\\\.\\d\+\[a-z\]\?\$\//.test(src),
    "the id pattern in act_runner.ts is the lettered one — a sub-rule must be citable in its own right"
  );
  // …and the EXCERPT terminator carries the letter too. This assertion is the WIRING half: the
  // executed check below re-implements the cut, so on its own it stays green while act_runner's own
  // terminator is reverted (measured — that sabotage passed until this line existed).
  assert.ok(
    src.includes("/^- \\*\\*C\\d+\\.\\d+[a-z]?\\*\\*/"),
    "act_runner's excerpt terminator recognises a lettered bullet — else a parent citation swallows its child"
  );
  {
    // The EXCERPT boundary, executed over the real charter: a parent's excerpt must STOP at its
    // lettered child, or citing C1.2 quietly hands the reviewer C1.2a's text too and the citation
    // reads wider than the rule cited.
    const md = fs.readFileSync("docs/policy_charter.md", "utf8").split(/\r?\n/);
    const cut = (id: string) => {
      const start = md.findIndex(l => l.includes(`**${id}**`));
      assert.ok(start >= 0, `${id} is still in the charter`);
      const out = [md[start]];
      for (let i = start + 1; i < md.length; i += 1) {
        if (/^- \*\*C\d+\.\d+[a-z]?\*\*/.test(md[i]) || /^#{1,3} /.test(md[i]) || /^---/.test(md[i])) break;
        out.push(md[i]);
      }
      return out.join("\n");
    };
    const parent = cut("C1.2");
    const child = cut("C1.2a");
    assert.ok(!parent.includes("C1.2a"), "the C1.2 excerpt must NOT swallow its lettered child");
    assert.ok(child.includes("never introduce again"), "C1.2a resolves to its own text");
    assert.ok(!child.includes("**C1.3**"), "the C1.2a excerpt stops before the next rule");
  }
  // --- NOTIFY-AFTER MUST SURVIVE A MERGE THAT SUCCEEDED BUT EXITED NON-ZERO -------------------
  // Measured 2026-08-21 on PR #785: `gh pr merge --squash --delete-branch` merged, then died on
  // "fatal: 'main' is already used by worktree" — true of EVERY worktree-based routine run. The
  // throw skipped the Tier-2a notify, so a charter-covered change reached main with Joe never told.
  // Notify-after IS the delegation: a merge he is not told about is an unsupervised merge.
  assert.ok(
    src.includes('execFileSync("gh", ["pr", "view", url, "--json", "state", "--jq", ".state"]'),
    "a failed merge asks GitHub what actually happened instead of trusting gh's exit code"
  );
  assert.ok(
    src.includes('if (state !== "MERGED")'),
    "…and only a genuinely unmerged PR escalates — a merged-then-crashed run still reaches the notify"
  );
  {
    // The ORDER is the load-bearing part: the recovery must sit between the merge attempt and the
    // notify, or the notify is still unreachable when gh throws.
    const shipBlock = src.slice(src.indexOf("if (gate.ship) {"), src.indexOf("// Escalation: the gate held this"));
    const iMerge = shipBlock.indexOf('["pr", "merge", "--squash"');
    const iRecover = shipBlock.indexOf('if (state !== "MERGED")');
    const iNotify = shipBlock.indexOf("if (charterCitation) {");
    assert.ok(iMerge >= 0 && iRecover > iMerge, "the merge-outcome recheck comes after the merge attempt");
    assert.ok(iNotify > iRecover, "the Tier-2a notify comes after the recheck — it must be reachable when gh throws");
    assert.ok(
      shipBlock.slice(iMerge, iRecover).includes("catch (err)"),
      "the merge call is inside a catch — an uncaught throw is what skipped the notify"
    );
  }
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

// --- THE FEED YOU ASKED FOR IS THE FEED YOU GET (2026-08-21). ------------------------------------
// The loop's SKILL downloads the box's work order to /tmp, filters it, then reads the selection with
// `act_runner list --in /tmp/next.json`. `act_runner` had no `--in`, and `flag()` is an argv.indexOf
// lookup, so the flag was silently DROPPED and `list` served this checkout's own
// reports/anomaly_loop/next.json — last written 2026-08-09. For twelve days that printed a frozen
// selection of 14 work orders while the live queue held 60. Nothing errored, nothing was broken, and
// nothing ever said which file it was reading.
//
// EXECUTED, not source-pinned (SKILL trap 3): every assertion below runs the CLI, because the whole
// defect was a code path that ran perfectly and read the wrong file. Clock-safe: fixture stamps are
// built relative to `now`.
{
  const NOW = Date.now();
  const isoDaysAgo = (d: number) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();
  const isoHoursAgo = (h: number) => new Date(NOW - h * 60 * 60 * 1000).toISOString();
  const order = (convId: string, detail: string) => ({
    convId,
    leadKey: convId,
    dimension: "open_critic_finding",
    category: "discovery",
    severity: "P2",
    tier: 2,
    action: "escalate",
    detail
  });

  const feedTmp = fs.mkdtempSync(path.join(os.tmpdir(), "act-feed-"));
  // The frozen local report root — the 8/09 file, twelve days old.
  const frozenRoot = path.join(feedTmp, "report-root");
  fs.mkdirSync(path.join(frozenRoot, "anomaly_loop"), { recursive: true });
  const frozenPath = path.join(frozenRoot, "anomaly_loop", "next.json");
  fs.writeFileSync(
    frozenPath,
    JSON.stringify({ generatedAt: isoDaysAgo(12), workOrders: [order("+19990000001", "STALE — the frozen local feed")] })
  );
  // The fresh feed the run just downloaded from the box.
  const freshPath = path.join(feedTmp, "fresh-next.json");
  fs.writeFileSync(
    freshPath,
    JSON.stringify({ generatedAt: isoHoursAgo(1), workOrders: [order("+19990000002", "FRESH — downloaded from the box")] })
  );

  const run = (args: string[]) =>
    spawnSync("npx", ["tsx", "scripts/act_runner.ts", ...args], {
      encoding: "utf8",
      env: { ...process.env, REPORT_ROOT: frozenRoot, CONVERSATIONS_DB_PATH: "" }
    });

  // 1. THE FINDING ITSELF: --in is honoured, and does NOT fall back to the report root.
  const withIn = run(["list", "--in", freshPath]);
  assert.equal(withIn.status, 0, "list --in exits clean");
  assert.ok(withIn.stdout.includes("+19990000002::open_critic_finding"), "list --in reads the file it was handed");
  assert.ok(
    !withIn.stdout.includes("+19990000001"),
    "list --in must NOT serve the report root's frozen feed — this is the twelve-day defect"
  );
  assert.ok(withIn.stdout.includes(freshPath), "list NAMES the file it read, so a wrong one is visible");
  assert.ok(
    !`${withIn.stdout}${withIn.stderr}`.includes("THIS WORK ORDER FILE IS STALE"),
    "a fresh feed stays quiet — the banner appearing must always mean something"
  );

  // 2. No --in: behaviour is exactly as before (the report root), and the age is now STATED.
  const noIn = run(["list"]);
  assert.equal(noIn.status, 0, "list with no --in still exits clean");
  assert.ok(noIn.stdout.includes("+19990000001"), "with no --in the report root is still the source");
  assert.ok(noIn.stderr.includes("THIS WORK ORDER FILE IS STALE"), "a twelve-day-old feed says so, loudly");
  assert.ok(noIn.stderr.includes("12 DAYS ago"), "the banner states the age in days, not a bare timestamp");
  assert.ok(noIn.stderr.includes(frozenPath), "the banner names the exact file, so the reader can check it");
  assert.ok(
    noIn.stdout.includes("open_critic_finding"),
    "staleness WARNS and never suppresses — an old feed is still the best evidence available"
  );

  // 2b. An UNDATABLE feed reports stale, not fresh — the fail direction this module claims. A file
  //     whose age cannot be established is exactly the file that turns out to be from last week,
  //     and every work order written before the provenance stamp existed lands in this branch.
  const undatablePath = path.join(feedTmp, "undatable-next.json");
  fs.writeFileSync(undatablePath, JSON.stringify({ workOrders: [order("+19990000003", "no generatedAt at all")] }));
  const undatable = run(["list", "--in", undatablePath]);
  assert.equal(undatable.status, 0, "an undatable feed still lists its work orders");
  assert.ok(
    undatable.stderr.includes("age cannot be established"),
    "a feed with no usable generatedAt reads STALE, never fresh"
  );
  assert.ok(undatable.stdout.includes("+19990000003"), "an undatable feed is warned about, never suppressed");

  // 3. An unknown flag is REFUSED, never ignored. This is the root cause, not the symptom.
  const bogus = run(["list", "--nope", "x"]);
  assert.equal(bogus.status, 2, "an unknown flag exits non-zero instead of running on");
  assert.ok(bogus.stderr.includes("UNKNOWN FLAG"), "the refusal says what is wrong");
  assert.ok(bogus.stderr.includes("--nope"), "the refusal names the offending flag");
  assert.ok(bogus.stderr.includes("--in <value>"), "the refusal lists what the subcommand does accept");

  // A subcommand that does not read the feed says so rather than accepting a meaningless --in.
  const disposeWithIn = run(["dispose", "--key", "+1555::x", "--as", "fixed", "--in", freshPath]);
  assert.equal(disposeWithIn.status, 2, "dispose refuses --in");
  assert.ok(
    disposeWithIn.stderr.includes("only list and prep read the work order feed"),
    "the refusal explains which subcommands accept --in"
  );
  assert.ok(
    !fs.existsSync(path.join(frozenRoot, "anomaly_loop", "dispositions.json")),
    "the flag check runs BEFORE any subcommand side effect — a refused dispose writes nothing"
  );

  // 4. prep honours --in too (it reads the same feed and briefs off it).
  const prepIn = run(["prep", "--top", "--in", freshPath]);
  assert.equal(prepIn.status, 0, "prep --in exits clean");
  assert.ok(prepIn.stdout.includes(freshPath), "prep names the file it read");
  assert.ok(
    fs.existsSync(path.join(frozenRoot, "act", "brief-_19990000002_open_critic_finding.md")),
    "prep briefs the FRESH feed's work order, not the frozen root's"
  );

  // 5. The pure matcher: a flag VALUE that looks like a flag is not misread as one.
  assert.deepEqual(unknownFlags(["dispose", "--note", "--not-a-flag", "--as", "fixed"], "dispose"), [], "a value is never read as a flag");
  assert.deepEqual(unknownFlags(["list", "--in", "/tmp/f.json"], "list"), [], "a known flag with a value is accepted");
  assert.deepEqual(unknownFlags(["list", "--in", "/tmp/f.json", "--bogus"], "list"), ["--bogus"], "one unknown flag reports once");
  assert.deepEqual(unknownFlags(["list", "--bogus", "--in", "/tmp/f.json"], "list"), ["--bogus"], "an unknown flag does not swallow the next real one");
  assert.deepEqual(
    unknownFlags(["list", "--bogus", "--alsobogus"], "list"),
    ["--bogus", "--alsobogus"],
    "an unknown flag never hides a SECOND one — the arity guard only skips a token that is not itself a flag"
  );
  assert.deepEqual(unknownFlags(["review", "--ship", "--title", "t", "--charter", "C1.2"], "review"), [], "every real review flag is declared");
  assert.deepEqual(unknownFlags(["open-pr", "--title", "t", "--finding-key", "a::b", "--eval-verified"], "open-pr"), [], "every real open-pr flag is declared");
  assert.deepEqual(unknownFlags(["nonsense", "--whatever"], "nonsense"), [], "an unknown SUBCOMMAND falls through to the usage banner, not a flag error");

  fs.rmSync(feedTmp, { recursive: true, force: true });
}

console.log("PASS act runner eval — PR-only (never merges), refuses main, gate-enforced; prep brief carries the parser-first contract; cross-routine PR dedup (marker + skip, and an unverifiable ledger reports UNKNOWN instead of a false NONE); NS citation resolves the bounded North-star section and buys no gate relief; list/prep run; --in is honoured, an unknown flag is refused, and the feed's own age is stated.");
