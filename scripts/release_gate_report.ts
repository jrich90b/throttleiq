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
};

const DEFAULT_THRESHOLDS: Thresholds = {
  toneRespondedPassRateMin: num(process.env.RELEASE_GATE_TONE_PASS_MIN, 85),
  toneMissingMax: num(process.env.RELEASE_GATE_TONE_MISSING_MAX, 1),
  charterViolationRateMax: num(process.env.RELEASE_GATE_CHARTER_RATE_MAX, 5),
  templateSourcedViolationsMax: 0,
  repeatsMax: 0,
  personaReintrosMax: 0,
  freshStuckActionableMax: 0,
  outcomeQaP1Max: 0
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

  const metrics: Record<string, number | null> = {
    toneRespondedPassRate: tonePass,
    toneMissingResponses: toneMissing,
    charterViolationRate: typeof charterRate === "number" ? charterRate : null,
    charterViolations: num(charter?.violationCount),
    templateSourcedViolations: templateSourced,
    repeats,
    personaReintros,
    freshStuckActionable,
    outcomeQaP1
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
    sinceHours: 24,
    nowMs: Date.parse("2026-06-20T08:15:00.000Z")
  });
  assertOk(cleanDay.clean, `clean day should pass, failures: ${cleanDay.failures.join("; ")}`);

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
