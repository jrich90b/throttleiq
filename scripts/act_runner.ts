/**
 * ACT runner (PR-only) — the last step of the self-healing loop (docs/autonomous_coding_loop.md).
 *
 * DETECT writes reports/anomaly_loop/next.json and the digest surfaces it; this turns a chosen finding into
 * an approvable GitHub PR. It handles the DETERMINISTIC scaffolding — select the work order, assemble a
 * self-contained fix brief, enforce the gates, open a PR (NEVER merge). The PATCH itself is written by the
 * coding agent (Claude) between `prep` and `open-pr`, because a correct parser-first fix needs judgment a
 * script can't supply. Nothing auto-merges: you approve by reviewing + merging the PR; reject = close it.
 *
 * Subcommands:
 *   list [--in <path>]           — print the current work orders (id = convId::dimension). `--in`
 *                                  reads a work order file you downloaded (e.g. the box's, filtered
 *                                  through loop_pr_ledger_filter) instead of this checkout's under
 *                                  REPORT_ROOT. `list` and `prep` always NAME the file they read and
 *                                  its age; an unknown flag is REFUSED, never ignored — see
 *                                  scripts/actRunnerCliArgs.ts for why both of those are load-bearing.
 *   dispose --key <k> --as <d>   — record a finding as dealt with (fixed | stale-echo | no-action |
 *                                  joe-ruled) in reports/anomaly_loop/dispositions.json, so
 *                                  anomaly_loop_detect suppresses that key permanently. The single
 *                                  writer every routine calls (ROUTINE_CONTRACT.md "Staleness").
 *   prep --id <key> | --top      — write reports/act/brief-<key>.md (finding + conv + actions + the
 *                                  parser-first contract + suggested branch/PR), for the coding agent to implement
 *   open-pr --title <t> [--eval-verified]
 *                                — on a feature branch with commits ahead of main, run the gates
 *                                  (tsc always; ci:eval unless --eval-verified) then `gh pr create` (no merge)
 *
 * Run: npx tsx scripts/act_runner.ts <subcommand> [flags]
 *   (prep can load the conversation for context via CONVERSATIONS_DB_PATH; optional.)
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  findingKeyMarker,
  findMergedPrForFindingKey,
  findOpenPrForFindingKey,
  isMeaningfulFindingKey
} from "../services/api/src/domain/loopPrDedup.ts";
import {
  CODE_STATE_DISPOSITIONS,
  DISPOSITIONS,
  isDisposition,
  parseDispositionLedgerPayload,
  partitionByDispositions,
  serializeDispositionLedger,
  upsertDisposition,
  type DispositionRecord
} from "../services/api/src/domain/dispositionLedger.ts";
import { isReportGradeStale, refreshSupersededGrades } from "../services/api/src/domain/anomalyClassifier.ts";
import { readLoopPrLedger } from "./loopPrLedger.ts";
import { formatStaleDetectorFeedBanner, type DetectorFeedSource } from "./detectorFeedFreshness.ts";
import {
  formatStaleWorkOrderBanner,
  formatUnknownFlagError,
  resolveWorkOrderPath,
  unknownFlags
} from "./actRunnerCliArgs.ts";
import os from "node:os";
import {
  DEFAULT_MERGE_FREEZE_MAX_AGE_MINUTES,
  describeMergeFreeze,
  readMergeFreezeStatus,
  type MergeFreezeStatus
} from "../services/api/src/domain/mergeFreeze.ts";

/** `--ship` was told to merge, but a release gate holds the freeze. The PR stays OPEN. */
export const ACT_EXIT_MERGE_FROZEN = 6;

/**
 * THE MERGE FREEZE, ENFORCED WHERE MERGES ACTUALLY HAPPEN.
 *
 * On 2026-08-04 a release gate held the freeze, spent 45 minutes proving `2395262b`, and failed at
 * the deploy step because PR #537 had landed underneath it — merged two seconds after it was
 * opened, by the loop-runner, through THIS function. The freeze rule existed; it lived only as
 * prose in ROUTINE_CONTRACT.md, and NOT ONE routine's SKILL.md so much as mentioned `merge_freeze`.
 * A rule that every run has to remember is a rule that eventually nobody runs.
 *
 * So the check moves to the one line that does the merging. Every routine that ships through
 * `act_runner review --ship` now respects the freeze for free, whatever its own instructions say.
 *
 * FAIL-DIRECTION, and it is the same asymmetry the freeze module itself is built on: this can only
 * ever STOP a merge by positively reading "frozen". A missing record, a corrupt one, an expired
 * one, or ANY error at all reads as NOT frozen and the merge proceeds. A stuck freeze that silently
 * halted every routine's ability to land work would be far worse than one deploy shipping on a
 * slightly-moved main.
 */
function currentMergeFreeze(): MergeFreezeStatus {
  return readMergeFreezeStatus({
    dir: process.env.MERGE_FREEZE_DIR || path.join(os.tmpdir(), "throttleiq-merge-freeze"),
    nowMs: Date.now(),
    maxAgeMinutes: Number(
      process.env.MERGE_FREEZE_MAX_AGE_MIN ?? DEFAULT_MERGE_FREEZE_MAX_AGE_MINUTES
    )
  });
}

function isMergeFrozen(): boolean {
  return currentMergeFreeze().frozen === true;
}

const argv = process.argv.slice(2);
const sub = argv[0];
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);

// REFUSE AN UNKNOWN FLAG (2026-08-21). `flag()` is an argv.indexOf lookup: a flag this script does
// not implement is neither honoured nor refused, it just vanishes. The SKILL's prescribed read —
// `act_runner list --in /tmp/next.json` — vanished that way for twelve days while `list` served a
// frozen 8/09 file from the report root. See scripts/actRunnerCliArgs.ts for the full account.
const unrecognised = unknownFlags(argv, sub);
if (unrecognised.length) {
  console.error(formatUnknownFlagError(String(sub), unrecognised));
  process.exit(2);
}

const reportRoot = process.env.REPORT_ROOT || path.resolve("reports");
const defaultNextPath = path.join(reportRoot, "anomaly_loop", "next.json");
// `--in <path>` reads a work order file the caller downloaded (the box's, filtered through
// loop_pr_ledger_filter) instead of this checkout's. Absent, behaviour is exactly as before.
const resolvedFeed = resolveWorkOrderPath({ inFlag: flag("in"), defaultPath: defaultNextPath });
const nextPath = resolvedFeed.path;
const keyOf = (w: any) => `${w?.convId ?? ""}::${w?.dimension ?? ""}`;

// READ-TIME GRADE STALENESS (2026-07-31). next.json is generated once and read for hours by four
// routines; a deploy in between silently invalidates every verdict in it, yet the file still says
// `gradeSuperseded: false`. So we recompute against the commit deployed RIGHT NOW — same resolver
// as anomaly_loop_detect (git rev-parse HEAD in the deploy checkout), same fail-direction: if we
// cannot resolve it, nothing is demoted.
function currentDeployedCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// The disposition ledger has the SAME generation-vs-read problem. DETECT applies it when it
// builds next.json; every disposition recorded afterwards has no effect until DETECT runs again.
// 2026-07-31: the 13:10 tick disposed 08610167776 and +16785960725 as fixed, yet at 14:39 both
// were still the top Tier-1 work orders in the 08:55 feed — the next tick re-investigated findings
// this routine had already closed 90 minutes earlier. So re-apply the ledger at read time, through
// the very same pure function DETECT uses (one code path ⇒ identical semantics, including the
// regression-of-disposed fail-safe: a NEW occurrence after the fix boundary still comes back).
function applyLedgerAtReadTime(orders: any[]): { kept: any[]; suppressed: number; regressions: number } {
  const ledgerPath = path.join(reportRoot, "anomaly_loop", "dispositions.json");
  if (!fs.existsSync(ledgerPath)) return { kept: orders, suppressed: 0, regressions: 0 };
  let ledger: Map<string, DispositionRecord> | null = null;
  try {
    ledger = parseDispositionLedgerPayload(JSON.parse(fs.readFileSync(ledgerPath, "utf8")));
  } catch {
    // An unreadable ledger must suppress NOTHING — never hide work on a parse error.
    return { kept: orders, suppressed: 0, regressions: 0 };
  }
  if (!ledger) return { kept: orders, suppressed: 0, regressions: 0 };
  const part = partitionByDispositions(orders, { ledger });
  // Regressions are real signal, not noise — they stay in the queue, flagged.
  const revived = part.regressions.map(r => ({ ...(r.anomaly as any), regressionOfDisposed: true }));
  return { kept: [...part.kept, ...revived], suppressed: part.suppressed.length, regressions: revived.length };
}

function loadReport(): {
  payload: any;
  orders: any[];
  stale: boolean;
  deployedNow: string | null;
  disposedNow: number;
  regressions: number;
} {
  if (!fs.existsSync(nextPath)) {
    console.error(`No work order at ${nextPath} — run anomaly_loop_detect first.`);
    process.exit(2);
  }
  const payload = JSON.parse(fs.readFileSync(nextPath, "utf8"));
  const deployedNow = currentDeployedCommit();
  const stale = isReportGradeStale({
    reportDeployedCommit: payload?.deployedCommit,
    currentDeployedCommit: deployedNow
  });
  const ledgered = applyLedgerAtReadTime(Array.isArray(payload?.workOrders) ? payload.workOrders : []);
  const orders = refreshSupersededGrades(ledgered.kept, deployedNow);
  return {
    payload,
    orders,
    stale,
    deployedNow,
    disposedNow: ledgered.suppressed,
    regressions: ledgered.regressions
  };
}

// Were the DETECTORS alive when this work order was built? `generatedAt` says when the file was
// written, never whether its inputs ran (measured 2026-08-18: four of nine feeds, including the
// primary one, were a day stale because the 08:50-08:54 crons died inside a deploy's npm install —
// and `list` printed a clean queue). This must run BEFORE the empty-queue early exit, or the one
// case it exists for prints "the loop is healthy" and returns. Warn only; never suppress or reorder.
// WHICH FILE, AND HOW OLD (2026-08-21). `warnIfDetectorFeedsStale` asks whether the DETECTORS ran;
// this asks whether the file in front of you is from today, and names it. Both are needed and they
// fail independently: on 8/21 the detector feeds were healthy and the work order file being read
// was twelve days old, so the detector banner stayed quiet and correct while the queue was fiction.
// Must run BEFORE the empty-queue early exit, for the same reason the detector banner does.
function announceWorkOrderFeed(report: { payload: any }): void {
  const banner = formatStaleWorkOrderBanner({
    path: nextPath,
    source: resolvedFeed.source,
    generatedAt: report?.payload?.generatedAt,
    nowMs: Date.now()
  });
  if (banner) console.warn(banner);
  else console.log(`feed: ${nextPath} (generated ${report?.payload?.generatedAt ?? "?"})`);
}

function warnIfDetectorFeedsStale(report: { payload: any }): void {
  const sources: DetectorFeedSource[] = Array.isArray(report?.payload?.feedSources) ? report.payload.feedSources : [];
  if (!sources.length) return; // a feed written before this provenance existed — nothing to claim
  const banner = formatStaleDetectorFeedBanner({
    sources,
    staleSources: sources.filter(s => s?.stale),
    oldestAgeHours: report?.payload?.oldestFeedAgeHours ?? null,
    staleHours: report?.payload?.feedStaleHours ?? 26
  });
  if (banner) console.warn(banner);
}

// Loud, unmissable banner: a caller acting on a pre-deploy verdict is about to rebuild something
// that may already have shipped (2026-07-31: the top three Tier-1 orders were fixed by #378 four
// hours before this feed was read). We warn and demote — never suppress.
function warnIfReportStale(report: {
  payload: any;
  orders: any[];
  stale: boolean;
  deployedNow: string | null;
  disposedNow: number;
  regressions: number;
}): void {
  if (report.disposedNow) {
    console.warn(
      `\n.. ${report.disposedNow} work order(s) were disposed AFTER this feed was generated — dropped at read time ` +
        `(they are already dealt with).${report.regressions ? ` ${report.regressions} kept as regression-of-disposed.` : ""}`
    );
  }
  if (!report.stale) return;
  const short = (c: unknown) => String(c ?? "?").slice(0, 8);
  const supersededCount = report.orders.filter(o => o?.gradeSuperseded).length;
  console.warn(
    `\n!! GRADES ARE PRE-DEPLOY — this feed was generated against ${short(report.payload?.deployedCommit)} ` +
      `(at ${report.payload?.generatedAt ?? "?"}), but ${short(report.deployedNow)} is deployed now.\n` +
      `   ${supersededCount} of ${report.orders.length} work order(s) carry a verdict about code that is no longer running,\n` +
      `   and they have been ranked BELOW findings measured against the running build (nothing was dropped).\n` +
      `   REPRODUCE against current code before building a fix — the deploy in between may already have fixed it.\n`
  );
}


function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

// Cross-routine dedup: the gh `pr list` readers live in scripts/loopPrLedger.ts
// (shared with anomaly_loop_detect + loop_pr_ledger_filter). Both fail toward
// building the PR on any gh error, never toward silently dropping a fix.

// If a finding key is supplied and an OPEN PR already carries it, this is a
// duplicate — skip (exit 3, distinct from success/usage/escalate) so the caller
// moves on instead of filing a second PR for the same finding.
function skipIfDuplicateOpenPr(findingKey: string | undefined): void {
  if (!findingKey || !isMeaningfulFindingKey(findingKey)) return;
  const ledger = readLoopPrLedger({ reportRoot });
  const existing =
    findOpenPrForFindingKey(ledger.openPrs, findingKey) ??
    findMergedPrForFindingKey(ledger.mergedPrs, findingKey);
  if (existing) {
    console.log(`DUPLICATE: open PR #${existing.number} already covers "${findingKey}" — skipping (no new PR).`);
    process.exit(3);
  }
  // Fail-direction here is unchanged and deliberate: an unverifiable ledger must never BLOCK a
  // fix. But it must not pass silently either, or a duplicate PR gets filed with no trace of why
  // the dedup missed it. Warn and continue.
  if (!ledger.canProveAbsence) {
    console.warn(
      `!! DEDUP UNVERIFIED for "${findingKey}" — ${ledger.detail}.\n` +
        `   Building anyway (never drop a fix we can't prove is covered), but this PR may duplicate another routine's.`
    );
  }
}

// Append the machine-readable finding-key marker so a later run (any routine) can
// detect this PR already covers the finding.
function withFindingKeyMarker(body: string, findingKey: string | undefined): string {
  if (!findingKey || !isMeaningfulFindingKey(findingKey)) return body;
  return `${body}\n${findingKeyMarker(findingKey)}\n`;
}

// Read-only triage helper: does an open PR already cover this finding key?
if (sub === "check-open-pr") {
  const key = flag("key");
  if (!key) {
    console.error("check-open-pr requires --key <convId::dimension>");
    process.exit(2);
  }
  // A POSITIVE match is proof from any source — an old snapshot can miss a PR, never invent one.
  const ledger = readLoopPrLedger({ reportRoot });
  const existing = findOpenPrForFindingKey(ledger.openPrs, key);
  if (existing) {
    console.log(`EXISTS #${existing.number} — open PR already covers "${key}"`);
    process.exit(3);
  }
  // A recently-MERGED PR covering the key means the fix already landed and the finding is a
  // stale echo awaiting its report refresh — report as covered (exit 4) so routines stop
  // re-investigating fixes that shipped (the "double work in two routines" class).
  const merged = findMergedPrForFindingKey(ledger.mergedPrs, key);
  if (merged) {
    console.log(`MERGED #${merged.number} — fix already merged (${merged.mergedAt ?? "recent"}) for "${key}"; stale echo, do not rebuild`);
    process.exit(4);
  }
  // An ABSENCE is only provable from a complete, current view. Without one, say so (exit 5) —
  // NEVER print the confident "NONE" that a caller reads as "clear to build". Measured 2026-08-03:
  // run on the box (no gh), this said NONE for a key PR #488 was carrying, and the same key said
  // EXISTS #488 on the Mac. UNKNOWN is never a pass — re-run where gh is authed.
  if (!ledger.canProveAbsence) {
    console.log(
      `UNKNOWN — cannot verify coverage of "${key}": ${ledger.detail}.\n` +
        `   Re-run this check on a gh-authed host (the routine's Mac tree) before treating the finding as unclaimed.`
    );
    process.exit(5);
  }
  console.log(`NONE — no open or recently-merged PR covers "${key}"`);
  process.exit(0);
}

// Record a DISPOSITION so this finding never surfaces again (Joe, 2026-07-30: "it should know what is
// stale/already fixed and not show up again"). Every routine writes through here so the ledger has one
// shape; anomaly_loop_detect suppresses disposed keys permanently.
//
// The ledger is BOX-SIDE (detect runs there), so a routine on the Mac disposes over ssh against the
// deploy checkout, which already tracks origin/main:
//   ssh lightsail '/bin/bash -lc "cd /home/ubuntu/leadrider-api/americanharley && \
//     REPORT_ROOT=/home/ubuntu/leadrider-runtime/americanharley/reports \
//     npx tsx scripts/act_runner.ts dispose --key \"<convId>::<dimension>\" --as fixed --by <routine>"'
if (sub === "dispose") {
  const key = flag("key");
  const as = flag("as");
  if (!key || !isMeaningfulFindingKey(key)) {
    console.error('dispose requires --key <convId::dimension>');
    process.exit(2);
  }
  if (!isDisposition(as)) {
    console.error(`dispose requires --as <${DISPOSITIONS.join(" | ")}>`);
    process.exit(2);
  }
  const ledgerPath = path.join(reportRoot, "anomaly_loop", "dispositions.json");
  let existing: DispositionRecord[] = [];
  if (fs.existsSync(ledgerPath)) {
    try {
      const parsed = parseDispositionLedgerPayload(JSON.parse(fs.readFileSync(ledgerPath, "utf8")));
      if (parsed) existing = [...parsed.values()];
    } catch {
      // A corrupt ledger must not silently become an EMPTY one — that would un-suppress every
      // disposition ever recorded. Refuse to write and let a human look.
      console.error(`Refusing to write: ${ledgerPath} exists but could not be parsed. Fix or move it first.`);
      process.exit(2);
    }
  }
  const records = upsertDisposition(existing, {
    key,
    disposition: as,
    at: new Date().toISOString(),
    by: flag("by") || process.env.ROUTINE_NAME || "unknown",
    deployTs: flag("deploy-ts") ?? null,
    note: flag("note") ?? null
  });
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify(serializeDispositionLedger(records), null, 2));
  const written = records.find(r => r.key === key)!;
  console.log(`DISPOSED "${key}" as ${written.disposition} (by ${written.by}) → ${ledgerPath} (${records.length} record(s))`);
  console.log(
    CODE_STATE_DISPOSITIONS.has(written.disposition)
      ? `   code-state disposition: an occurrence after ${written.deployTs ?? written.at} will resurface as regression-of-disposed`
      : `   policy disposition: this key is suppressed permanently (not a defect)`
  );
  process.exit(0);
}

if (sub === "list") {
  const report = loadReport();
  const orders = report.orders;
  announceWorkOrderFeed(report);
  warnIfDetectorFeedsStale(report);
  if (!orders.length) {
    console.log("No work orders — the loop is healthy (stop:true).");
    process.exit(0);
  }
  warnIfReportStale(report);
  console.log(`${orders.length} work order(s) (Tier 2 first; superseded grades last):\n`);
  for (const w of orders) {
    const stale = w?.gradeSuperseded ? "  [GRADE SUPERSEDED — reproduce first]" : "";
    console.log(`  [T${w.tier} ${w.action}] ${w.dimension}  (${w.severity})${stale}`);
    console.log(`     id: ${keyOf(w)}`);
    console.log(`     ${String(w.detail ?? "").trim()}\n`);
  }
  process.exit(0);
}

if (sub === "prep") {
  const report = loadReport();
  const orders = report.orders;
  announceWorkOrderFeed(report);
  warnIfDetectorFeedsStale(report);
  warnIfReportStale(report);
  const id = flag("id");
  const wo = id ? orders.find(w => keyOf(w) === id) : (has("top") ? orders[0] : undefined);
  if (!wo) {
    console.error(id ? `No work order with id ${id}` : "Pass --id <key> or --top. Run `list` to see ids.");
    process.exit(2);
  }
  // Optional conversation context (read-only). For box findings, point CONVERSATIONS_DB_PATH at a copy.
  let thread = "(conversation not available locally — pull it from the box store for full context)";
  let actions = "(unavailable)";
  try {
    const dbPath = process.env.CONVERSATIONS_DB_PATH;
    if (dbPath && fs.existsSync(dbPath)) {
      const raw = JSON.parse(fs.readFileSync(dbPath, "utf8"));
      const convs: any[] = Array.isArray(raw?.conversations) ? raw.conversations : [];
      const conv = convs.find(c => String(c?.id ?? "") === String(wo.convId));
      if (conv) {
        const msgs = Array.isArray(conv.messages) ? conv.messages : [];
        thread = msgs
          .filter((m: any) => (m?.direction === "in" || m?.direction === "out") && String(m?.body ?? "").trim())
          .slice(-14)
          .map((m: any) => `${m.direction}: ${String(m.body).trim()}`)
          .join("\n");
        // summarizeTurnActions lives in the feed module.
        const mod: any = await import("../services/api/src/domain/conversationOutcomeAudit.ts");
        if (mod?.summarizeTurnActions) actions = JSON.stringify(mod.summarizeTurnActions(conv, []), null, 2);
      }
    }
  } catch {
    /* context is best-effort */
  }
  const key = keyOf(wo);
  const safe = key.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  const branch = `fix/loop-${safe}`.slice(0, 60);
  // A pre-deploy verdict goes into the brief the coding agent reads, not just the console it may
  // never see — building against a superseded grade is how the loop rebuilds an already-shipped fix.
  const staleBanner = wo?.gradeSuperseded
    ? `> **⚠ GRADE SUPERSEDED — REPRODUCE BEFORE BUILDING.** This finding was graded against ` +
      `\`${String(wo.gradedAtCommit ?? "?").slice(0, 8)}\`, but \`${String(report.deployedNow ?? "?").slice(0, 8)}\` ` +
      `is deployed now. A commit in between may already have fixed it. Confirm the bug still reproduces on ` +
      `CURRENT main first; if it does not, dispose it (\`act_runner dispose --key "${key}" --as fixed ` +
      `--deploy-ts <iso>\`) and stop — do NOT write a patch.\n\n`
    : "";
  const brief = `# Loop fix brief — ${wo.dimension} (${key})

${staleBanner}**Tier ${wo.tier} · ${wo.action} · ${wo.severity}** — ${wo.category}

## Finding
${String(wo.detail ?? "").trim()}

## Lead
convId: ${wo.convId}   leadKey: ${wo.leadKey}

## Agent actions this turn
\`\`\`json
${actions}
\`\`\`

## Conversation (recent)
${thread}

## Fix contract (LAW — AGENTS.md / CLAUDE.md)
- COMPREHEND, never regex: customer intent → a typed LLM parser, not keywords.
- Centralize the decision in routeStateReducer (a decide*Turn), applied in BOTH /webhooks/twilio
  AND /conversations/:id/regenerate (route parity). No inline parser||regex precedence gates.
- Deterministic ONLY for safety/compliance gates, structured extraction, side-effects, invariant guards.
- Add a deterministic eval wired into ci:eval. Gates must be green (tsc + ci:eval).
- This is a loop-driven change → it ships as a PR you review + merge (PR-only; nothing auto-merges).

## Suggested workflow
\`\`\`
git checkout -b ${branch}
#  ... coding agent implements the parser-first fix + eval on this branch, commits ...
set -a; source .env; set +a && npm run ci:eval        # gates
npx tsx scripts/act_runner.ts open-pr --title "Loop fix: ${wo.dimension}" --eval-verified
\`\`\`
`;
  const outDir = path.join(reportRoot, "act");
  fs.mkdirSync(outDir, { recursive: true });
  const briefPath = path.join(outDir, `brief-${safe}.md`);
  fs.writeFileSync(briefPath, brief);
  console.log(`Fix brief written: ${briefPath}`);
  console.log(`Suggested branch: ${branch}`);
  console.log(`\n${brief}`);
  process.exit(0);
}

if (sub === "open-pr") {
  const title = flag("title");
  if (!title) {
    console.error("open-pr requires --title");
    process.exit(2);
  }
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "main") {
    console.error("Refusing to open a PR from main — do the fix on a feature branch.");
    process.exit(2);
  }
  const ahead = git(["rev-list", "--count", "main..HEAD"]);
  if (Number(ahead) <= 0) {
    console.error("No commits ahead of main on this branch — nothing to PR.");
    process.exit(2);
  }
  // Cross-routine dedup: if another routine already filed an open PR for this
  // finding, skip before spending the gates.
  skipIfDuplicateOpenPr(flag("finding-key"));
  // GATE: tsc always; ci:eval unless the caller asserts it just passed on this branch.
  console.log("Running tsc…");
  execFileSync("node", ["../../node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--noEmit"], {
    cwd: path.resolve("services/api"),
    stdio: "inherit"
  });
  if (!has("eval-verified")) {
    console.log("Running ci:eval (pass --eval-verified to skip if you just ran it)…");
    execFileSync("npm", ["run", "ci:eval"], { stdio: "inherit" });
  } else {
    console.log("Skipping ci:eval (--eval-verified asserted green on this branch).");
  }
  // Push the branch + open the PR (NO merge).
  git(["push", "-u", "origin", branch]);
  const briefDir = path.join(reportRoot, "act");
  const briefFile = fs.existsSync(briefDir)
    ? fs.readdirSync(briefDir).map(f => path.join(briefDir, f)).sort().pop()
    : undefined;
  const body = withFindingKeyMarker(
    (briefFile && fs.existsSync(briefFile) ? fs.readFileSync(briefFile, "utf8") : `Loop-driven fix: ${title}`) +
      "\n\n— Opened by the self-healing loop ACT runner (PR-only; review + merge to approve).\n",
    flag("finding-key")
  );
  const url = execFileSync(
    "gh",
    ["pr", "create", "--base", "main", "--head", branch, "--title", title, "--body", body],
    { encoding: "utf8" }
  ).trim();
  console.log(`PR opened (NOT merged): ${url}`);
  process.exit(0);
}

if (sub === "review") {
  // Cross-model PRE-SHIP review: an INDEPENDENT model (Claude) reviews the branch diff against the finding
  // + the law BEFORE it ships. With --ship: open a PR, and merge it ONLY if the review approves (clean +
  // gates green); otherwise leave the PR open and ESCALATE. Without --ship: advisory (print the verdict).
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "main") {
    console.error("Refusing to review/ship from main — work on a feature branch.");
    process.exit(2);
  }
  const ahead = git(["rev-list", "--count", "main..HEAD"]);
  if (Number(ahead) <= 0) {
    console.error("No commits ahead of main — nothing to review.");
    process.exit(2);
  }
  // Cross-routine dedup: skip if another routine already filed an open PR for this
  // finding (before spending the gates + the cross-model review).
  if (has("ship")) skipIfDuplicateOpenPr(flag("finding-key"));
  // Gates feed the gate decision (a review can't approve over red gates).
  let evalsGreen = false;
  try {
    console.log("Running tsc…");
    execFileSync("node", ["../../node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--noEmit"], { cwd: path.resolve("services/api"), stdio: "inherit" });
    if (has("eval-verified")) {
      console.log("ci:eval asserted green (--eval-verified).");
      evalsGreen = true;
    } else {
      console.log("Running ci:eval…");
      execFileSync("npm", ["run", "ci:eval"], { stdio: "inherit" });
      evalsGreen = true;
    }
  } catch {
    evalsGreen = false;
  }

  // Review the change against the REMOTE base, not the local `main` ref.
  // Local `main` goes stale the moment another author merges (2026-07-29, PR #336): the branch was
  // cut from a newer origin/main than the local ref, so `git diff main...HEAD` handed the reviewer
  // two unrelated already-merged commits as if they were part of this change — it spent its review
  // budget and its "concerns" on someone else's code. GitHub computes the PR diff against the remote
  // base, so the merge stayed clean; only the REVIEW was polluted. Fetch, then diff against
  // origin/main; fall back to the local ref only if the fetch/diff fails.
  const diff = (() => {
    for (const base of ["origin/main", "main"]) {
      try {
        if (base === "origin/main") execFileSync("git", ["fetch", "-q", "origin", "main"], { stdio: "ignore" });
        const out = execFileSync("git", ["diff", `${base}...HEAD`], { encoding: "utf8" });
        if (base === "main") console.warn("[act_runner] WARNING: reviewed diff is against the LOCAL main ref (origin/main unavailable) — it may include other authors' merged commits");
        return out;
      } catch {
        // try the next base
      }
    }
    return "";
  })();
  const title = flag("title") || git(["log", "-1", "--pretty=%s"]);
  const briefDir = path.join(reportRoot, "act");
  const briefFile = fs.existsSync(briefDir) ? fs.readdirSync(briefDir).map(f => path.join(briefDir, f)).sort().pop() : undefined;
  const finding = flag("finding") || (briefFile && fs.existsSync(briefFile) ? fs.readFileSync(briefFile, "utf8").slice(0, 2000) : title);

  // Tier-2a delegation (Joe, 2026-07-30): --charter <rule-id> claims the change implements a rule
  // Joe already made in docs/policy_charter.md. The cited rule's VERBATIM text goes to the reviewer,
  // which must confirm coverage (charter_covered) before an auto-merge is allowed. A bogus/missing
  // rule id is a hard error — a citation that can't be read can't be judged.
  // `NS` is the one non-rule citation (charter "Standing improvement authority", Joe 2026-07-30):
  // a change with no covering rule id that clearly serves the North star. It resolves to the whole
  // North-star SECTION and is judged by the same adversarial coverage bar — a stretched alignment
  // claim must fail exactly like a stretched rule citation. It does NOT widen what may auto-merge:
  // the always-Tier-2b list is unchanged, and a clean approve is still required.
  const charterId = flag("charter");
  const charterCitation = (() => {
    if (!charterId) return null;
    const isNorthStar = charterId === "NS";
    // Lettered sub-rules are real and were uncitable: the charter carries C1.2a and C1.4a, and both
    // were rejected here, which pushed a change that implements one toward citing its PARENT — a
    // stretched citation, exactly what the Tier-2a bar exists to refuse. C1.2 ("keep the intro") and
    // C1.2a ("…but only on a first touch") are close to opposite, so the parent is not a safe stand-in.
    if (!isNorthStar && !/^C\d+\.\d+[a-z]?$/.test(charterId)) {
      console.error(`--charter must be a rule id like C3.2 or C1.2a, or NS for the North star (got "${charterId}")`);
      process.exit(2);
    }
    const charterPath = "docs/policy_charter.md";
    if (!fs.existsSync(charterPath)) {
      console.error(`--charter given but ${charterPath} does not exist`);
      process.exit(2);
    }
    const lines = fs.readFileSync(charterPath, "utf8").split(/\r?\n/);
    if (isNorthStar) {
      // The North star is a SECTION, not a bullet: take it whole, up to the next H2, so the
      // reviewer sees the goal AND the five tests it is scored by.
      const start = lines.findIndex(l => /^## North star\b/.test(l));
      if (start < 0) {
        console.error(`--charter NS: no "## North star" section found in ${charterPath}`);
        process.exit(2);
      }
      const excerpt: string[] = [lines[start]];
      for (let i = start + 1; i < lines.length; i += 1) {
        if (/^## /.test(lines[i])) break;
        excerpt.push(lines[i]);
      }
      return { id: "NS", excerpt: excerpt.join("\n").trim() };
    }
    const start = lines.findIndex(l => l.includes(`**${charterId}**`));
    if (start < 0) {
      console.error(`--charter ${charterId}: rule not found in ${charterPath}`);
      process.exit(2);
    }
    const excerpt: string[] = [lines[start]];
    for (let i = start + 1; i < lines.length; i += 1) {
      const l = lines[i];
      // A lettered sub-rule ENDS the parent's excerpt too — without this, citing C1.2 quietly hands
      // the reviewer C1.2a's text as well, so the citation reads wider than the rule being cited.
      if (/^- \*\*C\d+\.\d+[a-z]?\*\*/.test(l) || /^#{1,3} /.test(l) || /^---/.test(l)) break;
      excerpt.push(l);
    }
    return { id: charterId, excerpt: excerpt.join("\n").trim() };
  })();
  if (charterCitation) console.log(`Charter citation: ${charterCitation.id} — coverage will be judged adversarially.`);

  const { reviewLoopFixWithLLM, decidePreShipGate } = await import("../services/api/src/domain/preShipReview.ts");
  const review = await reviewLoopFixWithLLM({ title, finding, diff, evalsGreen, charterCitation });
  const gate = decidePreShipGate(review, { evalsGreen, requireCharterCovered: !!charterCitation });

  // Always show WHICH checks failed — the reviewer's prose is best-effort, this is not.
  const { summarizePreShipHold } = await import("../services/api/src/domain/preShipReview.ts");
  const failedChecks = review ? summarizePreShipHold(review) : "";
  const renderReviewForPr = (r: NonNullable<typeof review>): string =>
    [
      `verdict=**${r.verdict}** risk=${r.risk} onTarget=${r.onTarget} lawOk=${r.lawOk} blocking=${r.blocking} customerFacing=${r.customerFacing}${charterCitation ? ` charterCovered(${charterCitation.id})=${r.charterCovered}` : ""}`,
      `reasons: ${r.reasons ?? "_(none given by the reviewer)_"}`,
      `concerns: ${r.concerns ?? "_(none given by the reviewer)_"}`,
      failedChecks ? `failed checks: ${failedChecks}` : ""
    ]
      .filter(Boolean)
      .join("\n\n");

  console.log("\n=== CROSS-MODEL PRE-SHIP REVIEW ===");
  if (review) {
    console.log(`verdict=${review.verdict} risk=${review.risk} onTarget=${review.onTarget} lawOk=${review.lawOk} blocking=${review.blocking} customerFacing=${review.customerFacing}${charterCitation ? ` charterCovered(${charterCitation.id})=${review.charterCovered}` : ""}`);
    console.log(`reasons: ${review.reasons ?? "(none given)"}`);
    console.log(`concerns: ${review.concerns ?? "(none given)"}`);
    if (failedChecks) console.log(`failed checks: ${failedChecks}`);
  } else {
    console.log("no independent review available (no ANTHROPIC_API_KEY / disabled)");
  }
  console.log(`\nGATE: ${gate.ship ? "SHIP" : gate.escalate ? "ESCALATE" : "BLOCKED"} — ${gate.reason}`);

  if (!has("ship")) {
    console.log("\n(advisory only — pass --ship to open a PR and merge on a clean approve)");
    process.exit(gate.ship ? 0 : 1);
  }

  // --ship: always leave an auditable PR; merge only on a clean approve.
  if (!flag("title")) {
    console.error("--ship requires --title");
    process.exit(2);
  }
  git(["push", "-u", "origin", branch]);
  const body = withFindingKeyMarker(
    (briefFile && fs.existsSync(briefFile) ? fs.readFileSync(briefFile, "utf8") : `Loop-driven fix: ${title}`) +
      `\n\n## Cross-model pre-ship review\n${review ? renderReviewForPr(review) : "no independent review available"}\n\nGate: **${gate.ship ? "SHIP" : "ESCALATE"}** — ${gate.reason}\n— self-healing loop ACT runner.\n`,
    flag("finding-key")
  );
  const url = execFileSync("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", String(title), "--body", body], { encoding: "utf8" }).trim();
  console.log(`PR opened: ${url}`);

  // Best-effort notification with a DURABLE fallback. The 2026-07-29 gap: with no SENDGRID key the
  // notice was silently skipped, so a hold reached no one until the daily digest. Now: email when
  // configured, and ALWAYS leave a PR comment (visible in GitHub notifications either way). A
  // notification failure never changes the gate outcome.
  const notifyOperator = async (subject: string, text: string) => {
    try {
      execFileSync("gh", ["pr", "comment", url, "--body", `**${subject}**\n\n${text}`], { stdio: "ignore" });
      console.log("PR comment posted (durable notification).");
    } catch (err: any) {
      console.log(`PR comment failed (non-fatal): ${err?.message ?? String(err)}`);
    }
    try {
      const apiKey = process.env.SENDGRID_API_KEY;
      if (apiKey) {
        const { sendEmail } = await import("../services/api/src/domain/emailSender.ts");
        const to = (process.env.LOOP_DIGEST_EMAIL || "integrations@leadrider.ai").trim();
        const from = (process.env.SENDGRID_FROM_EMAIL || "support@leadrider.ai").trim();
        await sendEmail({ to, from, subject, text });
        console.log(`Emailed ${to}.`);
      } else {
        console.log("SENDGRID_API_KEY not set — no email (the PR comment above is the notification).");
      }
    } catch (err: any) {
      console.log(`Notification email failed (non-fatal): ${err?.message ?? String(err)}`);
    }
  };

  if (gate.ship && isMergeFrozen()) {
    // A release gate is mid-proof. The PR is built, reviewed and green — it just does not land
    // now. Leaving it OPEN is the whole point: the next tick merges it against a settled main.
    console.log(
      `\nHELD BY MERGE FREEZE — not merged.\n` +
        `  ${describeMergeFreeze(currentMergeFreeze())}\n` +
        `  The PR is open and reviewed: ${url}\n` +
        `  Nothing is lost; a later run merges it once the gate releases.`
    );
    process.exit(ACT_EXIT_MERGE_FROZEN);
  }

  if (gate.ship) {
    execFileSync("gh", ["pr", "merge", "--squash", "--delete-branch", url], { stdio: "inherit" });
    console.log(`MERGED (squash). Deploy next to take it live.`);
    // Tier-2a notify-AFTER (Joe, 2026-07-30): a charter-covered merge tells Joe what changed, in
    // plain English, with the citation and the revert path — he holds the veto, not the pen.
    if (charterCitation) {
      await notifyOperator(
        `loop merged a charter-covered change — ${title}`,
        [
          charterCitation.id === "NS"
            ? `The self-healing loop merged this WITHOUT pre-approval under the Tier-2a delegation. It cited NO specific rule — only that the change serves the North star (your stated goal), and the reviewer agreed.`
            : `The self-healing loop merged this WITHOUT pre-approval under the Tier-2a delegation (charter rule ${charterCitation.id}).`,
          ``,
          `PR: ${url}`,
          `What changed: ${cleanForNotify(review?.reasons) || String(title)}`,
          charterCitation.id === "NS"
            ? `Cited: the charter's North star section (no rule id) — the weakest citation, so read this one closely.`
            : `Cited rule: ${charterCitation.excerpt.split("\n")[0]}`,
          `Reviewer confirmed coverage; gates were green.`,
          ``,
          `To undo: revert the PR from GitHub (Revert button) — a veto also demotes this category back to ask-first.`
        ].join("\n")
      );
    }
    process.exit(0);
  }
  // Escalation: the gate held this for a human → notify IMMEDIATELY (not just the daily digest).
  await notifyOperator(
    `agent-watch: a fix needs your review — ${title}`,
    `The self-healing loop opened a fix but the cross-model pre-ship gate did NOT auto-merge it — it needs your review.\n\nPR: ${url}\nGate: ${gate.reason}\n\nReview + merge to approve, or close to reject. (You're getting this immediately, on top of the daily digest.)`
  );
  console.log(`ESCALATED — PR left OPEN for a human: ${url}`);
  process.exit(1);
}

/** Strip markdown noise from reviewer prose for the plain-English notification. */
function cleanForNotify(text: string | null | undefined): string {
  return String(text ?? "").replace(/[`*_]/g, "").trim().slice(0, 600);
}

console.error("Usage: act_runner.ts <list [--in <work-order.json>] | prep --id <key>|--top [--in <work-order.json>] | check-open-pr --key <convId::dimension> | dispose --key <convId::dimension> --as <fixed|stale-echo|no-action|joe-ruled> [--by <routine>] [--deploy-ts <iso>] [--note <s>] | open-pr --title <t> [--finding-key <k>] [--eval-verified] | review [--ship --title <t>] [--finding-key <k>] [--eval-verified] [--finding <s>] [--charter <rule-id, e.g. C3.2, or NS for the North star when no rule covers it — Tier-2a: auto-merge only if the reviewer confirms the citation covers the change; notify-after>]>");
process.exit(2);
