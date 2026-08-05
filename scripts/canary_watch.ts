/**
 * canary_watch — watch a deploy, and say plainly whether it hurt anyone.
 *
 * Joe, 2026-08-01: "Is there a way to continuously work without me approving PRs."
 *
 * This is the other half of that answer. `decision_equivalence` proves a change is safe to ship;
 * this checks whether it WAS, by comparing what the agent actually did to customers before and
 * after. Autonomy is not made safe by a gate in front — it is made safe by being reversible with
 * detection behind. See services/api/src/domain/canaryHealth.ts for the reasoning and fail
 * direction.
 *
 * SHADOW BY DEFAULT. `judge` prints the verdict and, when something regressed, the exact rollback
 * commands, and stops there. `judge --act` carries the rollback out — that is the readiness loop's
 * delegated deploy authority (Joe, 2026-08-01: hands-off), never something a bare run does by
 * accident. The rollback is a `git revert` of the one commit, NOT a checkout of an older tree, so
 * anything merged after the bad deploy survives it.
 *
 * THE HALF THAT WAS MISSING UNTIL 2026-08-02. `baseline`/`check` take file paths, and every run
 * pointed them at /tmp — so a baseline captured at deploy time was gone before its window closed,
 * and NO deploy was ever actually judged. The canary watched, and then forgot. `arm`/`judge`/
 * `status` are the same machinery with somewhere durable to keep the answer, which is what makes
 * the loop's rate limit real: no second BEHAVIOUR deploy until the previous one comes back HEALTHY.
 *
 *   # at deploy time
 *   REPORT_ROOT=... CONVERSATIONS_DB_PATH=/tmp/c.json npx tsx scripts/canary_watch.ts arm
 *   # once the window (default 48h — this store sends ~26/day) has elapsed
 *   REPORT_ROOT=... CONVERSATIONS_DB_PATH=/tmp/c.json npx tsx scripts/canary_watch.ts judge [--act]
 *   # "may another behaviour deploy go out?" — exit 0 = yes, anything else = no
 *   REPORT_ROOT=... npx tsx scripts/canary_watch.ts status
 *
 * The one-shot file forms are kept for ad-hoc use:
 *   npx tsx scripts/canary_watch.ts baseline --out /tmp/canary.json
 *   npx tsx scripts/canary_watch.ts check --baseline /tmp/canary.json
 *
 * NEVER point CONVERSATIONS_DB_PATH at the live store: copy it, read the copy, delete the copy. It
 * is customer PII.
 *
 * EXIT CODES: 0 healthy · 1 regressed · 2 unknown/blocked. UNKNOWN is deliberately NOT 0 — a run
 * that concluded nothing must never be scriptable as success.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  computeCanaryCounters,
  decideCanaryVerdict,
  detectRunaway,
  detectStaleStore,
  detectJudgeStoreMismatch,
  isPoisonedMeasurement,
  findDeadCounters,
  newestOutboundAtMs,
  typicalPeakOutboundPerHour,
  buildRevertPlan,
  decideCanaryGate,
  measureCanarySlice,
  hourOfDayExpectedShare,
  decideCanaryProgress,
  DEFAULT_CANARY_THRESHOLDS,
  DEFAULT_CANARY_PROGRESS,
  type CanaryCounters,
  type CanaryVerdict,
  type CanaryMeasurement,
  CANARY_JUDGE_RULE_VERSION,
  type CanaryProgressConfig
} from "../services/api/src/domain/canaryHealth.ts";

type BaselineFile = {
  takenAtMs: number;
  windowMs: number;
  deployedSha: string;
  counters: CanaryCounters;
  /** The store's own busiest hour, so the fast tripwire scales with the dealership. */
  typicalPeakOutboundPerHour: number;
  /**
   * WHICH store this was measured against. Recorded because the 2026-08-02 canary armed on an
   * all-zero baseline and nothing in the file said where those zeros came from — it had read the
   * stale base store. Provenance turns "the counters look wrong" into a one-look diagnosis.
   */
  storePath?: string;
  storeConversations?: number;
  storeNewestOutboundMs?: number | null;
  /**
   * PROGRESSIVE MEASUREMENT (2026-08-03). Present => this canary is measured as a series of short
   * slices under a run-length rule (canaryHealth.decideCanaryProgress), and `windowMs` is only the
   * BASELINE lookback. ABSENT => a legacy one-shot before/after canary, judged the old way.
   * The legacy path is kept deliberately: a canary armed before this shipped is live on the box
   * right now, and a rework that stranded it would be the same class of bug it is fixing.
   */
  progress?: CanaryProgressConfig;
  measurements?: CanaryMeasurement[];
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// -------------------------------------------------------------------------------------------------
// THE CANARY'S MEMORY.
//
// `baseline`/`check` take file paths, and every run so far pointed them at /tmp — so a baseline
// captured at deploy time was gone before its window closed and NO deploy was ever actually judged.
// `arm`/`judge`/`status` are the same machinery with somewhere durable to keep the answer:
//
//   <report root>/canary/pending.json    the deploy currently being watched (absent = none)
//   <report root>/canary/history.jsonl   one line per judged deploy, append-only
//
// Report root follows the same env var the other reports use, so on the box this lands beside them.
// -------------------------------------------------------------------------------------------------
function canaryDir(): string {
  const root =
    arg("report-root") || process.env.REPORT_ROOT || path.resolve("reports");
  return path.join(root, "canary");
}
const pendingPath = () => path.join(canaryDir(), "pending.json");
const historyPath = () => path.join(canaryDir(), "history.jsonl");

function readPending(): BaselineFile | null {
  const p = pendingPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    // A corrupt pending file must NOT read as "nothing pending" — that would open the gate.
    console.error(`canary_watch: ${p} is unreadable. Treating it as an OPEN canary, not a clear one.`);
    return { takenAtMs: 0, windowMs: Number.MAX_SAFE_INTEGER, deployedSha: "", counters: {} as CanaryCounters, typicalPeakOutboundPerHour: 0 };
  }
}

function lastJudgedStatus(): CanaryVerdict["status"] | null {
  const p = historyPath();
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const row = JSON.parse(lines[i]);
      if (row?.status) return row.status;
    } catch {
      /* skip a torn line and keep looking back */
    }
  }
  return null;
}

function appendHistory(row: Record<string, unknown>): void {
  fs.mkdirSync(canaryDir(), { recursive: true });
  fs.appendFileSync(historyPath(), `${JSON.stringify(row)}\n`);
}

/** The store path the last loadConversations() actually resolved — recorded into the baseline. */
let resolvedStorePath = "";

function loadConversations(): any[] {
  const dbPath =
    process.env.CONVERSATIONS_DB_PATH ||
    (process.env.DATA_DIR
      ? path.join(process.env.DATA_DIR, "conversations.json")
      : path.resolve("services/api/data/conversations.json"));
  resolvedStorePath = dbPath;
  if (!fs.existsSync(dbPath)) {
    console.error(`canary_watch: conversations store not found at ${dbPath}`);
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const convs: any[] = Array.isArray(raw) ? raw : (raw?.conversations ?? []);
  if (!convs.length) {
    // Fail closed: an empty store cannot clear a deploy.
    console.error("canary_watch: the store is empty — a canary that measured nothing proves nothing");
    process.exit(2);
  }
  return convs;
}

/**
 * Load the store for JUDGING — and refuse if it is not the store this canary was armed against.
 *
 * `arm` has had a wrong-store guard since 2026-08-03; judging had none, and judging is where the
 * store path actually gets lost (the documented `judge`/`status` invocations omitted
 * CONVERSATIONS_DB_PATH entirely, so they read the repo checkout's May seed store). Slices are
 * idempotent by index, so each mis-measured slice is burned permanently — see
 * canaryHealth.detectJudgeStoreMismatch.
 */
function loadConversationsForJudging(baseline: BaselineFile): any[] {
  const conversations = loadConversations();
  const mismatch = detectJudgeStoreMismatch({
    currentStoreNewestOutboundMs: newestOutboundAtMs(conversations),
    currentStoreConversations: conversations.length,
    baselineStoreNewestOutboundMs: baseline.storeNewestOutboundMs,
    baselineStoreConversations: baseline.storeConversations,
    baselineTakenAtMs: baseline.takenAtMs
  });
  if (mismatch.wrong) {
    console.error(
      `canary_watch: refusing to JUDGE against ${resolvedStorePath}\n` +
        `  ${mismatch.reason}.\n` +
        `  ${conversations.length} conversations here; the baseline was armed against ` +
        `${baseline.storeConversations ?? "(unrecorded)"} at ${baseline.storePath ?? "(unrecorded)"}.\n` +
        "  Nothing was measured and nothing was recorded — a slice is measured ONCE, so a slice read\n" +
        "  from the wrong store would be burned forever.\n" +
        "  Copy the DEALER's store and point CONVERSATIONS_DB_PATH at the copy, e.g.\n" +
        "    cp <runtime>/<dealer>/data/conversations.json /tmp/canary-src.json\n" +
        "    CONVERSATIONS_DB_PATH=/tmp/canary-src.json npx tsx scripts/canary_watch.ts judge\n" +
        "    rm -f /tmp/canary-src.json"
    );
    process.exit(2);
  }
  return conversations;
}

function currentSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const nowMs = (() => {
  const override = arg("now");
  if (!override) return Date.now();
  const t = Date.parse(override);
  if (!Number.isFinite(t)) {
    console.error(`canary_watch: --now "${override}" is not a valid ISO timestamp`);
    process.exit(2);
  }
  return t;
})();

const mode = process.argv[2];

/** Capture the "before" counters. Shared by `baseline` (file out) and `arm` (durable). */
function captureBaseline(hours: number): BaselineFile {
  const windowMs = Math.max(1, hours) * 3_600_000;
  const conversations = loadConversations();

  // FAIL CLOSED on broken instrumentation. A counter reading zero across the whole store is not a
  // quiet period, it is a counter wired to the wrong field — which is exactly how the first version
  // of this tool shipped counting nothing while passing its own tests.
  const dead = findDeadCounters(conversations);
  if (dead.length) {
    console.error(
      `canary_watch: these counters read ZERO across the ENTIRE store: ${dead.join(", ")}.\n` +
        "  That is unwired instrumentation, not a quiet period. A baseline built on dead counters\n" +
        "  would clear any deploy. Fix the projection in domain/canaryHealth.ts before using this."
    );
    process.exit(2);
  }

  // WRONG-STORE GUARD. findDeadCounters above only sees LIFETIME totals, so the stale base store
  // (frozen 2026-06-16, 3,720 lifetime sends, zero since) sails straight through it and produces a
  // baseline of zeros — which is precisely what was armed on 2026-08-02. A store whose newest
  // activity predates the window we are about to measure is the wrong store, not a quiet one.
  const newestOutboundMs = newestOutboundAtMs(conversations);
  const staleness = detectStaleStore({ newestOutboundMs, nowMs, windowMs });
  if (staleness.stale) {
    console.error(
      `canary_watch: refusing to build a baseline from ${resolvedStorePath}\n` +
        `  ${staleness.reason}.\n` +
        `  ${conversations.length} conversations, newest outbound ${
          newestOutboundMs ? new Date(newestOutboundMs).toISOString() : "(none)"
        }.\n` +
        "  Point CONVERSATIONS_DB_PATH at the DEALER's store (a copy of\n" +
        "  <runtime>/<dealer>/data/conversations.json), not the base runtime store."
    );
    process.exit(2);
  }

  return {
    takenAtMs: nowMs,
    windowMs,
    deployedSha: arg("sha") ?? currentSha(),
    counters: computeCanaryCounters(conversations, { startMs: nowMs - windowMs, endMs: nowMs }),
    typicalPeakOutboundPerHour: typicalPeakOutboundPerHour(conversations),
    storePath: resolvedStorePath,
    storeConversations: conversations.length,
    storeNewestOutboundMs: newestOutboundMs
  };
}

if (mode === "baseline") {
  const out = arg("out");
  if (!out) {
    console.error("canary_watch baseline --out <file> [--hours N] [--now <iso>]");
    process.exit(2);
  }
  // 48h, not 6: this store sends ~26 customer messages a DAY (36 over 48h, 10 over a quiet 24h), so
  // anything shorter routinely falls under the 20-send floor and abstains. Measured, not assumed.
  const hours = Number(arg("hours") ?? 48) || 48;
  const payload = captureBaseline(hours);
  const counters = payload.counters;
  fs.writeFileSync(out, JSON.stringify(payload, null, 2));
  console.log(
    `canary baseline over the ${hours}h before the deploy -> ${out}\n` +
      `  in=${counters.inboundFromCustomer} sends=${counters.outboundToCustomer} drafts=${counters.draftsProduced} ` +
      `closed=${counters.conversationsClosed} held=${counters.draftsHeld} ` +
      `convs=${counters.activeConversations} · typical busy hour=${payload.typicalPeakOutboundPerHour}/h`
  );
  if (counters.outboundToCustomer < DEFAULT_CANARY_THRESHOLDS.minBaselineOutbound) {
    console.log(
      "  NOTE: too quiet to judge a deploy against " +
        `(${counters.outboundToCustomer} < ${DEFAULT_CANARY_THRESHOLDS.minBaselineOutbound} sends). ` +
        "The slow check will return UNKNOWN — widen --hours. The fast runaway tripwire still works."
    );
  }
  process.exit(0);
}

/**
 * Judge a captured baseline against what has happened since, and PRINT the comparison.
 * Returns null when the window has not elapsed — not-yet-ready is never a verdict.
 */
/**
 * PROGRESSIVE ADVANCE — measure every slice that has fully elapsed and is not already recorded,
 * then apply the run-length rule. Returns null while still watching (pending stays put).
 *
 * Idempotent by slice index, so it does not matter whether this runs once a day or every hour:
 * a slice is measured exactly once, and re-running only picks up newly-elapsed ones.
 */
function advanceCanary(baseline: BaselineFile): { verdict: CanaryVerdict | null; measurements: CanaryMeasurement[] } {
  const config = baseline.progress ?? DEFAULT_CANARY_PROGRESS;
  const measurements = [...(baseline.measurements ?? [])];
  const conversations = loadConversationsForJudging(baseline);
  const peak = baseline.typicalPeakOutboundPerHour ?? typicalPeakOutboundPerHour(conversations);

  const sliceWindow = (i: number) => ({
    startMs: baseline.takenAtMs + i * config.intervalMs,
    endMs: baseline.takenAtMs + i * config.intervalMs + config.intervalMs
  });
  const measureSlice = (i: number): CanaryMeasurement => {
    const { startMs, endMs } = sliceWindow(i);
    const sliceCounters = computeCanaryCounters(conversations, { startMs, endMs });
    const runaway = detectRunaway(sliceCounters.outboundToCustomer, config.intervalMs, peak);
    const m = measureCanarySlice({
      baselineCounters: baseline.counters,
      baselineWindowMs: baseline.windowMs,
      sliceCounters,
      sliceWindowMs: config.intervalMs,
      runaway,
      // Project against this dealer's own daily rhythm so an overnight slice is not asked to match
      // a working-day baseline. Never raises the expectation — see measureCanarySlice.
      hourOfDayShare: hourOfDayExpectedShare({
        conversations,
        baselineWindow: { startMs: baseline.takenAtMs - baseline.windowMs, endMs: baseline.takenAtMs },
        sliceWindow: { startMs, endMs }
      })
    });
    return {
      atMs: nowMs,
      sliceStartMs: startMs,
      sliceEndMs: endMs,
      counters: sliceCounters,
      status: m.status,
      ...(m.fatal ? { fatal: true } : {}),
      reason: m.reason,
      ruleVersion: CANARY_JUDGE_RULE_VERSION
    };
  };

  // HEAL slices that were recorded against a wrong store before the guard above existed: all-zero
  // and inconclusive, over a window the (now validated) store shows was busy. Re-measured IN PLACE,
  // never dropped — dropping would shift every later slice onto someone else's window.
  let healed = 0;
  for (let i = 0; i < measurements.length; i++) {
    const { startMs, endMs } = sliceWindow(i);
    const truthCounters = computeCanaryCounters(conversations, { startMs, endMs });
    if (!isPoisonedMeasurement({ status: measurements[i].status, counters: measurements[i].counters, truthCounters }))
      continue;
    measurements[i] = measureSlice(i);
    healed++;
  }
  if (healed) {
    console.log(
      `canary: re-measured ${healed} slice(s) that had recorded ZERO events over a window the store ` +
        "shows was busy — they were judged against the wrong store, so they were never evidence.\n"
    );
  }

  // Measure each fully-elapsed slice we have not recorded yet.
  for (let i = measurements.length; i < config.count; i++) {
    if (nowMs < sliceWindow(i).endMs) break; // not finished; a partial slice reads as a collapse
    measurements.push(measureSlice(i));
  }

  const progress = decideCanaryProgress({ measurements, config });
  const sha = baseline.deployedSha.slice(0, 8) || "(unrecorded)";
  console.log(
    `canary progress — sha ${sha} · baseline ${Math.round(baseline.windowMs / 3_600_000)}h ` +
      `· slices ${Math.round(config.intervalMs / 3_600_000)}h x${config.count} ` +
      `· tolerate ${config.failureLimit} fail, promote on ${config.consecutiveSuccessLimit} clean`
  );
  for (const m of measurements) {
    const when = new Date(m.sliceStartMs).toISOString().slice(5, 16).replace("T", " ");
    console.log(
      `  ${String(m.status).padEnd(12)} ${when}  in=${m.counters.inboundFromCustomer} ` +
        `sends=${m.counters.outboundToCustomer} drafts=${m.counters.draftsProduced} ` +
        `convs=${m.counters.activeConversations}  — ${m.reason}`
    );
  }
  console.log(`  => ${progress.status.toUpperCase()}: ${progress.reason}\n`);

  if (progress.status === "watching") return { verdict: null, measurements };

  const verdict: CanaryVerdict = {
    status: progress.status,
    breaches:
      progress.status === "regressed"
        ? measurements.filter(m => m.status === "fail").flatMap(m => [
            {
              metric: "slice" as any,
              kind: (m.fatal ? "runaway" : "increase") as any,
              baseline: 0,
              current: m.counters.outboundToCustomer,
              limit: config.failureLimit,
              detail: `slice ${new Date(m.sliceStartMs).toISOString()} — ${m.reason}`
            }
          ])
        : [],
    blockers: progress.status === "unknown" ? [progress.reason] : [],
    reason: progress.reason
  };
  return { verdict, measurements };
}

function judgeBaseline(baseline: BaselineFile): CanaryVerdict | null {
  const watchEndMs = baseline.takenAtMs + baseline.windowMs;

  // Judging a half-elapsed window would compare a partial period against a full one and invent a
  // "collapse" every time. Not yet ready is UNKNOWN, never healthy.
  if (nowMs < watchEndMs) {
    const minsLeft = Math.ceil((watchEndMs - nowMs) / 60_000);
    console.log(
      `canary: UNKNOWN — the watch window has not elapsed (${minsLeft} min left).\n` +
        "  A partial window compared against a full one reads as a collapse. Re-run later."
    );
    return null;
  }

  const conversations = loadConversationsForJudging(baseline);
  const current = computeCanaryCounters(conversations, {
    startMs: baseline.takenAtMs,
    endMs: watchEndMs
  });
  const runaway = detectRunaway(
    current.outboundToCustomer,
    baseline.windowMs,
    baseline.typicalPeakOutboundPerHour ?? typicalPeakOutboundPerHour(conversations)
  );
  const verdict = decideCanaryVerdict(baseline.counters, current, DEFAULT_CANARY_THRESHOLDS, runaway);

  const row = (label: string, c: CanaryCounters) =>
    `  ${label.padEnd(7)} in=${c.inboundFromCustomer} sends=${c.outboundToCustomer} drafts=${c.draftsProduced} ` +
    `closed=${c.conversationsClosed} held=${c.draftsHeld} convs=${c.activeConversations}`;
  console.log(
    `canary check — ${baseline.windowMs / 3_600_000}h window, sha ${baseline.deployedSha.slice(0, 8) || "(unrecorded)"}` +
      ` · ${runaway.perHour}/h vs runaway ceiling ${runaway.limit}/h`
  );
  console.log(row("before", baseline.counters));
  console.log(row("after", current));
  console.log();

  if (verdict.status === "unknown") {
    console.log("canary: UNKNOWN — this is NOT a clean bill of health.");
    for (const b of verdict.blockers) console.log(`  - ${b}`);
  } else if (verdict.status === "regressed") {
    console.log("canary: REGRESSED — the deploy moved guarded counters past their limits:");
    for (const b of verdict.breaches) console.log(`  - [${b.kind}] ${b.detail}`);
  } else {
    console.log(`canary: HEALTHY — ${verdict.reason}`);
  }
  return verdict;
}

if (mode === "check") {
  const baselinePath = arg("baseline");
  if (!baselinePath || !fs.existsSync(baselinePath)) {
    console.error("canary_watch check --baseline <file> [--now <iso>]");
    process.exit(2);
  }
  const baseline: BaselineFile = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const verdict = judgeBaseline(baseline);
  if (!verdict) process.exit(2);
  if (verdict.status === "unknown") process.exit(2);
  if (verdict.status === "regressed") {
    console.log("\nROLLBACK PLAN (shadow mode — NOT executed):");
    for (const line of buildRevertPlan(verdict, baseline.deployedSha)) console.log(`  ${line}`);
    process.exit(1);
  }
  process.exit(0);
}

// -------------------------------------------------------------------------------------------------
// arm — capture the baseline AND remember it, so something can come back and judge this deploy.
// -------------------------------------------------------------------------------------------------
if (mode === "arm") {
  const existing = readPending();
  if (existing && !flag("replace")) {
    // NOT a failure, and deliberately NOT phrased with the gate's reason any more: since 2026-08-03
    // an open canary no longer blocks deploys, so `decideCanaryGate` returning "may deploy" here
    // would read as a contradiction. One watch at a time still holds for the WATCH itself — the
    // daily judge clears the pending one, and the next deploy after that arms fresh.
    const endMs = Number(existing.takenAtMs) + Number(existing.windowMs);
    const ready = endMs - nowMs <= 0;
    console.error(
      `canary_watch arm: a canary is already being watched on ${existing.deployedSha.slice(0, 8) || "(unrecorded)"}` +
        `${ready ? " and is READY TO JUDGE" : ` (${Math.ceil((endMs - nowMs) / 60_000)} min left)`}.\n` +
        "  Not arming a second one — that would discard the only record of what the previous deploy\n" +
        "  was measured against. Run `canary_watch judge` to close it out, or pass --replace.\n" +
        "  The deploy itself is NOT blocked by this; only a REGRESSED verdict blocks."
    );
    process.exit(2);
  }
  // THE BASELINE IS NOW A LONG LOOKBACK, decoupled from how long we wait for a verdict.
  // Before 2026-08-03 one `--hours` did both jobs, so clearing the 20-send floor and answering
  // quickly were in direct conflict and neither worked. 14 days here is ~360 sends — far above any
  // floor — while the verdict still arrives in ~24h via the slice schedule below.
  const baselineHours = Number(arg("baseline-hours") ?? arg("hours") ?? 336) || 336;
  const progress: CanaryProgressConfig = {
    intervalMs: (Number(arg("interval-hours") ?? 0) || DEFAULT_CANARY_PROGRESS.intervalMs / 3_600_000) * 3_600_000,
    count: Number(arg("count") ?? 0) || DEFAULT_CANARY_PROGRESS.count,
    failureLimit: Number(arg("failure-limit") ?? NaN) >= 0 ? Number(arg("failure-limit")) : DEFAULT_CANARY_PROGRESS.failureLimit,
    consecutiveSuccessLimit: Number(arg("promote-after") ?? 0) || DEFAULT_CANARY_PROGRESS.consecutiveSuccessLimit
  };
  const payload: BaselineFile = { ...captureBaseline(baselineHours), progress, measurements: [] };
  fs.mkdirSync(canaryDir(), { recursive: true });
  fs.writeFileSync(pendingPath(), JSON.stringify(payload, null, 2));
  const c = payload.counters;
  const sliceH = progress.intervalMs / 3_600_000;
  console.log(
    `canary ARMED on ${payload.deployedSha.slice(0, 8) || "(unrecorded)"} -> ${pendingPath()}\n` +
      `  baseline ${baselineHours}h: in=${c.inboundFromCustomer} sends=${c.outboundToCustomer} drafts=${c.draftsProduced} ` +
      `closed=${c.conversationsClosed} held=${c.draftsHeld} convs=${c.activeConversations} ` +
      `· typical busy hour=${payload.typicalPeakOutboundPerHour}/h\n` +
      `  watch: ${sliceH}h slices x${progress.count} (max ${sliceH * progress.count}h) · ` +
      `tolerate ${progress.failureLimit} failed · promote after ${progress.consecutiveSuccessLimit} consecutive clean ` +
      `(~${sliceH * progress.consecutiveSuccessLimit}h)\n` +
      `  expected per slice: ~${(c.outboundToCustomer * (sliceH / baselineHours)).toFixed(1)} sends`
  );
  if (c.outboundToCustomer < DEFAULT_CANARY_THRESHOLDS.minBaselineOutbound) {
    console.log(
      `  NOTE: the BASELINE is thin (${c.outboundToCustomer} < ${DEFAULT_CANARY_THRESHOLDS.minBaselineOutbound} sends) — ` +
        "widen --baseline-hours. Slices will read inconclusive until it can support a ratio."
    );
  }
  process.exit(0);
}

// -------------------------------------------------------------------------------------------------
// judge — the half that never existed. Read the pending canary, decide, RECORD the verdict, and on
// REGRESSED either print the rollback (default) or carry it out (--act).
// -------------------------------------------------------------------------------------------------
if (mode === "judge") {
  const baseline = readPending();
  if (!baseline) {
    console.error("canary_watch judge: nothing is pending — no deploy is being watched.");
    process.exit(2);
  }
  // Progressive canaries advance slice-by-slice; legacy ones (armed before 2026-08-03) keep the
  // old one-shot path so a canary already in flight still concludes.
  let verdict: CanaryVerdict | null;
  if (baseline.measurements) {
    const advanced = advanceCanary(baseline);
    // Persist the slices measured this run either way, so the work is never redone and a
    // long-running watch survives restarts.
    fs.writeFileSync(
      pendingPath(),
      JSON.stringify({ ...baseline, measurements: advanced.measurements }, null, 2)
    );
    if (!advanced.verdict) process.exit(2); // still watching; pending stays put
    verdict = advanced.verdict;
  } else {
    verdict = judgeBaseline(baseline);
    if (!verdict) process.exit(2); // window still open; pending stays exactly where it is
  }

  appendHistory({
    judgedAtMs: nowMs,
    judgedAtIso: new Date(nowMs).toISOString(),
    deployedSha: baseline.deployedSha,
    windowHours: baseline.windowMs / 3_600_000,
    status: verdict.status,
    reason: verdict.reason,
    breaches: verdict.breaches,
    blockers: verdict.blockers,
    reverted: false
  });

  if (verdict.status === "healthy") {
    // Only a HEALTHY verdict clears the deck for the next behaviour deploy.
    fs.rmSync(pendingPath(), { force: true });
    console.log("\ncanary: recorded HEALTHY — the gate is open for the next behaviour deploy.");
    process.exit(0);
  }

  if (verdict.status === "unknown") {
    // Deliberately KEEPS pending: an unjudged deploy stays unjudged, and the gate stays shut.
    console.log(
      "\ncanary: recorded UNKNOWN. The pending canary is KEPT — a run that concluded nothing must\n" +
        "  not clear the gate. Widen the window or wait for more traffic, then judge again."
    );
    process.exit(2);
  }

  // REGRESSED.
  const plan = buildRevertPlan(verdict, baseline.deployedSha);
  if (!flag("act")) {
    console.log("\nROLLBACK PLAN (shadow — NOT executed; pass --act to carry it out):");
    for (const line of plan) console.log(`  ${line}`);
    process.exit(1);
  }

  console.log("\nROLLBACK — executing (--act):");
  const sha = String(baseline.deployedSha ?? "").trim();
  if (!sha) {
    console.error("  BLOCKED: the deployed commit was not recorded — there is nothing to revert.");
    process.exit(1);
  }
  // `git revert` of the one commit, NOT a checkout of an older tree: anything merged after this
  // deploy belongs to someone else and must survive the rollback.
  const run = (cmd: string, args: string[]) => {
    console.log(`  $ ${cmd} ${args.join(" ")}`);
    execFileSync(cmd, args, { stdio: "inherit" });
  };
  try {
    run("git", ["revert", "--no-edit", sha]);
    run("git", ["push", "origin", "HEAD"]);
    run("npm", ["run", "deploy:api"]);
  } catch (err) {
    console.error(`  ROLLBACK FAILED: ${(err as Error)?.message ?? err}`);
    console.error("  The pending canary is KEPT so this stays visible. Carry out the plan by hand.");
    process.exit(1);
  }
  appendHistory({
    judgedAtMs: nowMs,
    judgedAtIso: new Date(nowMs).toISOString(),
    deployedSha: sha,
    status: "regressed",
    reason: "auto-reverted",
    reverted: true
  });
  fs.rmSync(pendingPath(), { force: true });
  console.log("\ncanary: REGRESSED and REVERTED. The revert is live.");
  process.exit(1);
}

// -------------------------------------------------------------------------------------------------
// status — "may another behaviour deploy go out?" The one question the readiness loop asks.
// EXIT 0 = yes. Anything else = no. Silence is never a yes.
// -------------------------------------------------------------------------------------------------
if (mode === "status") {
  const gate = decideCanaryGate({
    pending: readPending(),
    lastVerdictStatus: lastJudgedStatus(),
    nowMs
  });
  console.log(
    JSON.stringify(
      {
        mayDeployBehaviour: gate.mayDeployBehaviour,
        pendingReady: gate.pendingReady,
        minutesRemaining: gate.minutesRemaining,
        reason: gate.reason
      },
      null,
      2
    )
  );
  process.exit(gate.mayDeployBehaviour ? 0 : 2);
}

console.error(
  "Usage: canary_watch.ts <arm [--hours N] | judge [--act] | status | baseline --out <f> | check --baseline <f>> [--now <iso>] [--report-root DIR]"
);
process.exit(2);
