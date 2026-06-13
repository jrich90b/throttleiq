/**
 * Release gate — dealer-rollout readiness scorecard (Joe, 2026-06-11).
 *
 * Snapshots today's quality metrics into a dated JSONL history, evaluates the
 * day against rollout thresholds, and reports the consecutive-clean-day
 * streak. Verdict is READY when the streak reaches RELEASE_GATE_STREAK_DAYS
 * (default 7) consecutive clean days.
 *
 * Inputs (under REPORT_ROOT, same layout the agent manager reads):
 *   tone_quality/tone_quality_summary.json
 *   voice_charter/voice_charter_summary.json
 *   outcome_qa/outcome_qa_report.json
 *   route watchdog json (--route-watchdog or latest in feedback_loop_logs)
 *
 * Usage:
 *   npx tsx scripts/release_gate_report.ts [--report-root DIR] [--route-watchdog PATH]
 *   npx tsx scripts/release_gate_report.ts --self-test
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type DayRow = {
  date: string;
  generatedAt: string;
  metrics: Record<string, number | null>;
  failures: string[];
  clean: boolean;
};

type Thresholds = {
  toneRespondedPassRateMin: number;
  toneMissingMax: number;
  charterViolationRateMax: number;
  templateSourcedViolationsMax: number;
  repeatsMax: number;
  personaReintrosMax: number;
  freshStuckActionableMax: number;
  outcomeQaP1Max: number;
  cadenceFarFutureRecentMax: number;
  cadenceStalledRecentMax: number;
  apptOutcomeMissingRecentMax: number;
  draftUnactionedRecentMax: number;
  agentDraftSlowOver5minMax: number;
  ownedBikeOfferedMax: number;
};

const DEFAULT_THRESHOLDS: Thresholds = {
  toneRespondedPassRateMin: num(process.env.RELEASE_GATE_TONE_PASS_MIN, 85),
  toneMissingMax: num(process.env.RELEASE_GATE_TONE_MISSING_MAX, 1),
  charterViolationRateMax: num(process.env.RELEASE_GATE_CHARTER_RATE_MAX, 5),
  templateSourcedViolationsMax: 0,
  repeatsMax: 0,
  personaReintrosMax: 0,
  freshStuckActionableMax: 0,
  outcomeQaP1Max: 0,
  // Deterministic-action checks (agent_actions_audit) — "recent" counts only,
  // so legacy debt ages out instead of permanently dirtying the gate.
  cadenceFarFutureRecentMax: num(process.env.RELEASE_GATE_CADENCE_FAR_FUTURE_MAX, 0),
  cadenceStalledRecentMax: num(process.env.RELEASE_GATE_CADENCE_STALLED_MAX, 0),
  apptOutcomeMissingRecentMax: num(process.env.RELEASE_GATE_APPT_OUTCOME_MISSING_MAX, 0),
  draftUnactionedRecentMax: num(process.env.RELEASE_GATE_DRAFT_UNACTIONED_MAX, 2),
  // Agent draft speed is graded (real-time webhook drafts that took >5 min are
  // an agent/infra problem). Effective customer-facing latency is reported but
  // NOT graded — it is the Suggest-mode staffing lever, not an agent fault.
  agentDraftSlowOver5minMax: num(process.env.RELEASE_GATE_AGENT_DRAFT_SLOW_MAX, 1),
  // Offering the customer's own bike is a zero-tolerance answer-correctness
  // miss. requested_day_reasked stays reported-only until its precision rises.
  ownedBikeOfferedMax: num(process.env.RELEASE_GATE_OWNED_BIKE_OFFERED_MAX, 0)
};

const STREAK_TARGET = Math.max(1, num(process.env.RELEASE_GATE_STREAK_DAYS, 7));
const TEMPLATE_SOURCED_CHECKS = new Set(["banned_phrase", "doubled_article", "bare_check_in"]);

function num(input: unknown, fallback = 0): number {
  const n = Number(input);
  return Number.isFinite(n) ? n : fallback;
}

function readJson(filePath: string): any {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function latestMatchingFile(dir: string, matcher: (name: string) => boolean): string | null {
  if (!fs.existsSync(dir)) return null;
  const rows = fs
    .readdirSync(dir)
    .filter(matcher)
    .map(name => {
      const full = path.join(dir, name);
      return { full, mtimeMs: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return rows[0]?.full ?? null;
}

export function buildDayRow(args: {
  date: string;
  toneSummary: any;
  charterSummary: any;
  outcomeQaReport: any;
  routeWatchdog: any;
  actionsSummary?: any;
  latencySummary?: any;
  correctnessSummary?: any;
  sinceHours: number;
  thresholds?: Thresholds;
  nowMs?: number;
}): DayRow {
  const t = args.thresholds ?? DEFAULT_THRESHOLDS;
  const nowMs = args.nowMs ?? Date.now();
  const tone = args.toneSummary ?? {};
  const charter = args.charterSummary?.summary ?? {};

  const hasToneData = num(tone?.totalInboundTurns) > 0 || num(tone?.respondedTurns) > 0;
  const tonePass = hasToneData
    ? tone?.respondedPassRate != null
      ? num(tone.respondedPassRate, 100)
      : num(tone?.passRate, 100)
    : null;
  const toneMissing = hasToneData ? num(tone?.missingResponseCount) : 0;

  const byCheck: Array<{ check: string; count: number }> = Array.isArray(charter?.byCheck)
    ? charter.byCheck
    : [];
  const templateSourced = byCheck
    .filter(row => TEMPLATE_SOURCED_CHECKS.has(String(row?.check ?? "")))
    .reduce((sum, row) => sum + num(row?.count), 0);
  const personaReintros = byCheck
    .filter(row => String(row?.check ?? "") === "persona_reintro")
    .reduce((sum, row) => sum + num(row?.count), 0);
  const charterRate = charter?.violationRate ?? null;
  const repeats = num(charter?.repeatCount);

  const watchdogRows: any[] = Array.isArray(args.routeWatchdog?.stuckTurns?.rows)
    ? args.routeWatchdog.stuckTurns.rows
    : [];
  const windowMs = Math.max(1, args.sinceHours) * 60 * 60 * 1000;
  const freshStuckActionable = watchdogRows.filter(row => {
    const mode = String(row?.followUp?.mode ?? "").trim().toLowerCase();
    const actionable = !mode || mode === "active";
    if (!actionable) return false;
    const atMs = Date.parse(String(row?.lastInbound?.at ?? ""));
    return Number.isFinite(atMs) && nowMs - atMs <= windowMs;
  }).length;

  const outcomeFindings: any[] = Array.isArray(args.outcomeQaReport?.findings)
    ? args.outcomeQaReport.findings
    : [];
  const outcomeQaP1 = outcomeFindings.filter(row => String(row?.severity ?? "") === "P1").length;

  const actionsByCheck: Array<{ check: string; total: number; recent: number }> = Array.isArray(
    args.actionsSummary?.summary?.byCheck
  )
    ? args.actionsSummary.summary.byCheck
    : [];
  const actionRecent = (check: string): number | null => {
    if (!args.actionsSummary) return null;
    const row = actionsByCheck.find(r => String(r?.check ?? "") === check);
    return row ? num(row.recent) : 0;
  };
  const cadenceFarFutureRecent = actionRecent("cadence_far_future");
  const cadenceStalledRecent = actionRecent("cadence_stalled");
  const apptOutcomeMissingRecent = actionRecent("appointment_outcome_missing");
  const draftUnactionedRecent = actionRecent("draft_unactioned");
  const watchOrphanedTotal = args.actionsSummary
    ? num(actionsByCheck.find(r => String(r?.check ?? "") === "watch_orphaned")?.total)
    : null;

  // Answer correctness: owned-bike-offered is graded (zero-false-positive, the
  // Todd Herian class); requested-day-reasked is reported until its precision
  // is higher (some conversational text trips the date parser).
  const correctnessByCheck: Array<{ check: string; total: number; recent: number }> = Array.isArray(
    args.correctnessSummary?.summary?.byCheck
  )
    ? args.correctnessSummary.summary.byCheck
    : [];
  const correctnessRecent = (check: string): number | null => {
    if (!args.correctnessSummary) return null;
    const row = correctnessByCheck.find(r => String(r?.check ?? "") === check);
    return row ? num(row.recent) : 0;
  };
  const ownedBikeOfferedRecent = correctnessRecent("owned_bike_offered");
  const requestedDayReaskedRecent = correctnessRecent("requested_day_reasked");

  // Response latency: agent draft speed is graded (the agent's job); effective
  // customer-facing latency is reported as the ops number (staff/Suggest lever).
  const latency = args.latencySummary?.summary ?? null;
  const agentDraftSlow = latency ? num(latency.agentDraft?.slowOver5minCount) : null;
  const agentDraftMedianMin = latency && latency.agentDraft?.medianMin != null ? num(latency.agentDraft.medianMin) : null;
  const effectiveMedianMin = latency && latency.effective?.medianMin != null ? num(latency.effective.medianMin) : null;
  const effectiveUnder5minPct = latency && latency.effective?.under5minPct != null ? num(latency.effective.under5minPct) : null;
  const effectiveOver1hPct = latency && latency.effective?.over1hPct != null ? num(latency.effective.over1hPct) : null;

  const metrics: Record<string, number | null> = {
    toneRespondedPassRate: tonePass,
    toneMissingResponses: toneMissing,
    charterViolationRate: typeof charterRate === "number" ? charterRate : null,
    charterViolations: num(charter?.violationCount),
    templateSourcedViolations: templateSourced,
    repeats,
    personaReintros,
    freshStuckActionable,
    outcomeQaP1,
    cadenceFarFutureRecent,
    cadenceStalledRecent,
    apptOutcomeMissingRecent,
    draftUnactionedRecent,
    watchOrphanedTotal,
    agentDraftSlowOver5min: agentDraftSlow,
    agentDraftMedianMin,
    effectiveResponseMedianMin: effectiveMedianMin,
    effectiveUnder5minPct,
    effectiveOver1hPct,
    ownedBikeOfferedRecent,
    requestedDayReaskedRecent
  };

  const failures: string[] = [];
  if (tonePass != null && tonePass < t.toneRespondedPassRateMin) {
    failures.push(`tone pass ${tonePass} < ${t.toneRespondedPassRateMin}`);
  }
  if (toneMissing > t.toneMissingMax) {
    failures.push(`tone missing ${toneMissing} > ${t.toneMissingMax}`);
  }
  if (typeof charterRate === "number" && charterRate > t.charterViolationRateMax) {
    failures.push(`charter rate ${charterRate}% > ${t.charterViolationRateMax}%`);
  }
  if (templateSourced > t.templateSourcedViolationsMax) {
    failures.push(`template-sourced charter violations ${templateSourced} > ${t.templateSourcedViolationsMax}`);
  }
  if (repeats > t.repeatsMax) failures.push(`repeat sends ${repeats} > ${t.repeatsMax}`);
  if (personaReintros > t.personaReintrosMax) {
    failures.push(`persona reintroductions ${personaReintros} > ${t.personaReintrosMax}`);
  }
  if (freshStuckActionable > t.freshStuckActionableMax) {
    failures.push(`fresh stuck actionable turns ${freshStuckActionable} > ${t.freshStuckActionableMax}`);
  }
  if (outcomeQaP1 > t.outcomeQaP1Max) failures.push(`outcome QA P1 ${outcomeQaP1} > ${t.outcomeQaP1Max}`);
  if (cadenceFarFutureRecent != null && cadenceFarFutureRecent > t.cadenceFarFutureRecentMax) {
    failures.push(`cadence far-future parks ${cadenceFarFutureRecent} > ${t.cadenceFarFutureRecentMax}`);
  }
  if (cadenceStalledRecent != null && cadenceStalledRecent > t.cadenceStalledRecentMax) {
    failures.push(`cadence stalled ${cadenceStalledRecent} > ${t.cadenceStalledRecentMax}`);
  }
  if (apptOutcomeMissingRecent != null && apptOutcomeMissingRecent > t.apptOutcomeMissingRecentMax) {
    failures.push(`appointment outcomes missing ${apptOutcomeMissingRecent} > ${t.apptOutcomeMissingRecentMax}`);
  }
  if (draftUnactionedRecent != null && draftUnactionedRecent > t.draftUnactionedRecentMax) {
    failures.push(`unactioned drafts ${draftUnactionedRecent} > ${t.draftUnactionedRecentMax}`);
  }
  if (agentDraftSlow != null && agentDraftSlow > t.agentDraftSlowOver5minMax) {
    failures.push(`slow agent drafts (>5min) ${agentDraftSlow} > ${t.agentDraftSlowOver5minMax}`);
  }
  if (ownedBikeOfferedRecent != null && ownedBikeOfferedRecent > t.ownedBikeOfferedMax) {
    failures.push(`agent offered the customer's own bike ${ownedBikeOfferedRecent} > ${t.ownedBikeOfferedMax}`);
  }

  return {
    date: args.date,
    generatedAt: new Date(nowMs).toISOString(),
    metrics,
    failures,
    clean: failures.length === 0
  };
}

export function upsertDayRow(rows: DayRow[], row: DayRow): DayRow[] {
  const out = rows.filter(r => r.date !== row.date);
  out.push(row);
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

export function cleanStreak(rows: DayRow[]): number {
  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!rows[i].clean) break;
    streak++;
  }
  return streak;
}

function selfTest() {
  const assertOk = (cond: boolean, label: string) => {
    if (!cond) {
      console.error(`SELF-TEST FAIL: ${label}`);
      process.exit(1);
    }
  };
  const mk = (date: string, clean: boolean): DayRow => ({
    date,
    generatedAt: `${date}T08:20:00.000Z`,
    metrics: {},
    failures: clean ? [] : ["x"],
    clean
  });

  const cleanDay = buildDayRow({
    date: "2026-06-20",
    toneSummary: { totalInboundTurns: 12, respondedTurns: 11, respondedPassRate: 92, missingResponseCount: 1 },
    charterSummary: { summary: { violationCount: 1, violationRate: 4, repeatCount: 0, byCheck: [{ check: "em_dash_overuse", count: 1 }] } },
    outcomeQaReport: { findings: [] },
    routeWatchdog: { stuckTurns: { rows: [
      { followUp: { mode: "manual_handoff" }, lastInbound: { at: "2026-06-20T01:00:00.000Z" } },
      { followUp: { mode: "active" }, lastInbound: { at: "2026-05-01T00:00:00.000Z" } }
    ] } },
    actionsSummary: { summary: { byCheck: [
      { check: "cadence_far_future", total: 3, recent: 0 },
      { check: "cadence_stalled", total: 0, recent: 0 },
      { check: "watch_orphaned", total: 13, recent: 9 },
      { check: "appointment_outcome_missing", total: 14, recent: 0 },
      { check: "draft_unactioned", total: 20, recent: 2 }
    ] } },
    // Agent drafts fast (0/1 slow); effective latency is ugly (3h median, 64%
    // over 1h) but must NOT fail the gate — it is the ops/Suggest lever.
    latencySummary: { summary: {
      agentDraft: { medianMin: 0.5, p90Min: 17, slowOver5minCount: 0, turnsWithoutRealtimeDraft: 39 },
      effective: { medianMin: 186, p90Min: 3600, under5minPct: 15, over1hPct: 64 }
    } },
    // requested_day_reasked is reported but must NOT gate the day.
    correctnessSummary: { summary: { byCheck: [
      { check: "owned_bike_offered", total: 1, recent: 0 },
      { check: "requested_day_reasked", total: 4, recent: 3 }
    ] } },
    sinceHours: 24,
    nowMs: Date.parse("2026-06-20T08:15:00.000Z")
  });
  assertOk(cleanDay.clean, `clean day should pass, failures: ${cleanDay.failures.join("; ")}`);
  assertOk(
    cleanDay.metrics.requestedDayReaskedRecent === 3,
    "requested_day_reasked is reported but never gates the day"
  );

  const ownedBikeDay = buildDayRow({
    date: "2026-06-20",
    toneSummary: { totalInboundTurns: 12, respondedTurns: 11, respondedPassRate: 92, missingResponseCount: 1 },
    charterSummary: { summary: { violationCount: 0, violationRate: 0, repeatCount: 0, byCheck: [] } },
    outcomeQaReport: { findings: [] },
    routeWatchdog: { stuckTurns: { rows: [] } },
    correctnessSummary: { summary: { byCheck: [{ check: "owned_bike_offered", total: 1, recent: 1 }] } },
    sinceHours: 24,
    nowMs: Date.parse("2026-06-20T08:15:00.000Z")
  });
  assertOk(
    !ownedBikeDay.clean && ownedBikeDay.failures.some(f => f.includes("own bike")),
    `offering the customer's own bike must fail the gate, got: ${ownedBikeDay.failures.join("; ")}`
  );
  assertOk(
    cleanDay.metrics.watchOrphanedTotal === 13,
    "watch orphans reported as informational metric, never a failure"
  );
  assertOk(
    cleanDay.metrics.effectiveResponseMedianMin === 186 && cleanDay.metrics.effectiveOver1hPct === 64,
    "effective latency is reported as a metric but never gates the day"
  );

  const slowDrafts = buildDayRow({
    date: "2026-06-20",
    toneSummary: { totalInboundTurns: 12, respondedTurns: 11, respondedPassRate: 92, missingResponseCount: 1 },
    charterSummary: { summary: { violationCount: 0, violationRate: 0, repeatCount: 0, byCheck: [] } },
    outcomeQaReport: { findings: [] },
    routeWatchdog: { stuckTurns: { rows: [] } },
    latencySummary: { summary: {
      agentDraft: { medianMin: 8, p90Min: 20, slowOver5minCount: 4, turnsWithoutRealtimeDraft: 2 },
      effective: { medianMin: 9, p90Min: 25, under5minPct: 40, over1hPct: 5 }
    } },
    sinceHours: 24,
    nowMs: Date.parse("2026-06-20T08:15:00.000Z")
  });
  assertOk(
    !slowDrafts.clean && slowDrafts.failures.some(f => f.includes("slow agent drafts")),
    `slow real-time agent drafts must fail the gate, got: ${slowDrafts.failures.join("; ")}`
  );

  const dirtyActions = buildDayRow({
    date: "2026-06-20",
    toneSummary: { totalInboundTurns: 12, respondedTurns: 11, respondedPassRate: 92, missingResponseCount: 1 },
    charterSummary: { summary: { violationCount: 0, violationRate: 0, repeatCount: 0, byCheck: [] } },
    outcomeQaReport: { findings: [] },
    routeWatchdog: { stuckTurns: { rows: [] } },
    actionsSummary: { summary: { byCheck: [
      { check: "cadence_far_future", total: 5, recent: 2 },
      { check: "cadence_stalled", total: 1, recent: 1 },
      { check: "appointment_outcome_missing", total: 16, recent: 2 },
      { check: "draft_unactioned", total: 26, recent: 6 }
    ] } },
    sinceHours: 24,
    nowMs: Date.parse("2026-06-20T08:15:00.000Z")
  });
  assertOk(!dirtyActions.clean, "recent action failures dirty the day");
  assertOk(
    dirtyActions.failures.some(f => f.includes("cadence far-future")) &&
      dirtyActions.failures.some(f => f.includes("cadence stalled")) &&
      dirtyActions.failures.some(f => f.includes("appointment outcomes missing")) &&
      dirtyActions.failures.some(f => f.includes("unactioned drafts")),
    `action failures named, got: ${dirtyActions.failures.join("; ")}`
  );

  const noActionsData = buildDayRow({
    date: "2026-06-20",
    toneSummary: { totalInboundTurns: 12, respondedTurns: 11, respondedPassRate: 92, missingResponseCount: 1 },
    charterSummary: { summary: { violationCount: 0, violationRate: 0, repeatCount: 0, byCheck: [] } },
    outcomeQaReport: { findings: [] },
    routeWatchdog: { stuckTurns: { rows: [] } },
    sinceHours: 24,
    nowMs: Date.parse("2026-06-20T08:15:00.000Z")
  });
  assertOk(
    noActionsData.clean && noActionsData.metrics.cadenceFarFutureRecent === null,
    "missing actions summary degrades to null metrics, not failures"
  );

  const dirtyDay = buildDayRow({
    date: "2026-06-20",
    toneSummary: { totalInboundTurns: 12, respondedTurns: 10, respondedPassRate: 57, missingResponseCount: 7 },
    charterSummary: { summary: { violationCount: 9, violationRate: 24, repeatCount: 2, byCheck: [
      { check: "banned_phrase", count: 3 },
      { check: "persona_reintro", count: 1 }
    ] } },
    outcomeQaReport: { findings: [{ severity: "P1" }] },
    routeWatchdog: { stuckTurns: { rows: [
      { followUp: { mode: "active" }, lastInbound: { at: "2026-06-20T01:00:00.000Z" } },
      { followUp: {}, lastInbound: { at: "2026-06-19T22:00:00.000Z" } }
    ] } },
    sinceHours: 24,
    nowMs: Date.parse("2026-06-20T08:15:00.000Z")
  });
  assertOk(!dirtyDay.clean, "dirty day should fail");
  assertOk(dirtyDay.metrics.freshStuckActionable === 2, "fresh stuck actionable counts active+modeless recent rows");
  assertOk(dirtyDay.metrics.personaReintros === 1, "persona reintro counted");
  assertOk(dirtyDay.metrics.templateSourcedViolations === 3, "template-sourced counted");
  assertOk(dirtyDay.failures.length >= 6, `dirty day lists failures, got: ${dirtyDay.failures.join("; ")}`);

  let rows: DayRow[] = [];
  for (const [d, c] of [["2026-06-14", false], ["2026-06-15", true], ["2026-06-16", true]] as const) {
    rows = upsertDayRow(rows, mk(d, c));
  }
  assertOk(cleanStreak(rows) === 2, "streak counts from latest backward");
  rows = upsertDayRow(rows, mk("2026-06-16", false));
  assertOk(rows.length === 3 && cleanStreak(rows) === 0, "same-date upsert replaces and breaks streak");

  console.log("PASS release gate self-test");
}

function main() {
  const args = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--self-test") {
      selfTest();
      return;
    }
    if (argv[i].startsWith("--")) args.set(argv[i], argv[i + 1] ?? "");
  }

  const reportRoot = args.get("--report-root") || process.env.REPORT_ROOT || path.resolve(process.cwd(), "reports");
  const outDir = args.get("--out-dir") || process.env.RELEASE_GATE_OUT_DIR || path.join(reportRoot, "release_gate");
  const sinceHours = num(args.get("--since-hours") || process.env.RELEASE_GATE_SINCE_HOURS, 24);

  const toneSummary = readJson(path.join(reportRoot, "tone_quality", "tone_quality_summary.json"));
  const charterSummary = readJson(path.join(reportRoot, "voice_charter", "voice_charter_summary.json"));
  const outcomeQaReport = readJson(path.join(reportRoot, "outcome_qa", "outcome_qa_report.json"));
  const actionsSummary = readJson(path.join(reportRoot, "actions_audit", "actions_audit_summary.json"));
  const latencySummary = readJson(path.join(reportRoot, "response_latency", "response_latency_summary.json"));
  const correctnessSummary = readJson(path.join(reportRoot, "answer_correctness", "answer_correctness_summary.json"));
  const watchdogPath =
    args.get("--route-watchdog") ||
    process.env.RELEASE_GATE_ROUTE_WATCHDOG_PATH ||
    latestMatchingFile(path.join(reportRoot, "feedback_loop_logs"), name => /^route_watchdog_.*\.json$/i.test(name)) ||
    path.join(reportRoot, "route_watchdog.json");
  const routeWatchdog = readJson(watchdogPath);

  const date = new Date().toISOString().slice(0, 10);
  const row = buildDayRow({
    date,
    toneSummary,
    charterSummary,
    outcomeQaReport,
    routeWatchdog,
    actionsSummary,
    latencySummary,
    correctnessSummary,
    sinceHours
  });

  fs.mkdirSync(outDir, { recursive: true });
  const historyPath = path.join(outDir, "daily_scorecard.jsonl");
  const existing: DayRow[] = fs.existsSync(historyPath)
    ? fs
        .readFileSync(historyPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(line => {
          try {
            return JSON.parse(line) as DayRow;
          } catch {
            return null;
          }
        })
        .filter((r): r is DayRow => !!r)
    : [];
  const rows = upsertDayRow(existing, row);
  fs.writeFileSync(historyPath, rows.map(r => JSON.stringify(r)).join("\n") + "\n");

  const streak = cleanStreak(rows);
  const verdict = streak >= STREAK_TARGET ? "READY" : "NOT_READY";
  const report = {
    generatedAt: row.generatedAt,
    verdict,
    cleanStreakDays: streak,
    streakTarget: STREAK_TARGET,
    today: row,
    thresholds: DEFAULT_THRESHOLDS,
    source: { reportRoot, watchdogPath },
    recentDays: rows.slice(-14)
  };
  fs.writeFileSync(path.join(outDir, "release_gate_report.json"), JSON.stringify(report, null, 2));

  const md = [
    "# Release Gate (dealer rollout readiness)",
    "",
    `Generated: ${row.generatedAt}`,
    `Verdict: **${verdict}** — ${streak}/${STREAK_TARGET} consecutive clean days`,
    "",
    `## Today (${row.date}): ${row.clean ? "CLEAN" : "DIRTY"}`,
    ...(row.failures.length ? row.failures.map(f => `- FAIL: ${f}`) : ["- all checks passed"]),
    "",
    "## Metrics",
    ...Object.entries(row.metrics).map(([k, v]) => `- ${k}: ${v ?? "n/a"}`),
    "",
    "## Last 14 days",
    ...rows.slice(-14).map(r => `- ${r.date}: ${r.clean ? "clean" : `DIRTY (${r.failures.length} failure(s))`}`)
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "release_gate_report.md"), md + "\n");

  console.log(
    JSON.stringify({ ok: true, verdict, cleanStreakDays: streak, today: row.clean ? "clean" : "dirty", outDir })
  );
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) main();
