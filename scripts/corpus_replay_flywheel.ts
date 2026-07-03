/**
 * Corpus replay flywheel (Joe-approved 2026-07-02) — the offline readiness loop.
 *
 * Live traffic exposes ~10-25 actionable turns/day; the release gate crawls at that rate. This
 * flywheel replays a CORPUS of real inbound turns through the CURRENT code (the sandboxed
 * inbound_shadow_replay harness — no sends, snapshot store), judges every produced draft with
 * the intent-handled LLM judge (the fluent-but-wrong-intent net), diffs per-turn results
 * against the previous baseline (regressions pop instantly), and emits findings in the
 * OutcomeAnomaly shape so the existing tiered loop can fix them.
 *
 *   replay cohort → judge drafts → score turns → diff baseline → findings + scoreboard
 *
 * Read-only by construction: consumes a replay report produced against a snapshot; never
 * touches the live store, never sends. LLM cost is capped by --max-judge.
 *
 * Usage:
 *   npx tsx scripts/corpus_replay_flywheel.ts --replay-json <inbound-shadow-*.json> [--out-dir DIR] [--max-judge N]
 *   npx tsx scripts/corpus_replay_flywheel.ts --self-test        # pure scaffolding, no network
 *
 * Thresholds the loop drives toward (tracked in summary.json):
 *   T1 criticals === 0 on a full sweep; T2 passRate >= 0.90 twice consecutively;
 *   T3 regressions === 0 twice consecutively.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildIntentJudgePrompt,
  isNonActionableInbound,
  realJudge,
  type IntentJudgeCandidate,
  type IntentVerdict
} from "./intent_handled_audit.ts";

export type ReplayRow = {
  id?: string;
  conversationId: string;
  leadKey?: string;
  customerName?: string;
  messageId?: string;
  messageIndex?: number;
  messageAt?: string;
  provider?: string;
  body: string;
  draft: string | null;
  verdict: "candidate_safe" | "review" | "expected_no_response" | "no_response" | "error";
  reviewReasons?: string[];
  error?: string;
};

export type TurnScore = {
  turnKey: string;
  conversationId: string;
  pass: boolean;
  critical: boolean;
  verdict: ReplayRow["verdict"];
  reviewReasons: string[];
  judge?: IntentVerdict | null;
  body: string;
  draft: string | null;
};

export function turnKeyOf(row: Pick<ReplayRow, "conversationId" | "messageId" | "messageIndex" | "body">): string {
  const anchor =
    String(row.messageId ?? "").trim() ||
    (Number.isFinite(row.messageIndex) ? `idx${row.messageIndex}` : "") ||
    String(row.body ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  return `${String(row.conversationId ?? "").trim()}::${anchor}`;
}

/** A row worth spending a judge call on: it produced a draft on an actionable inbound. */
export function isJudgeWorthy(row: ReplayRow): boolean {
  if (!row.draft || !String(row.draft).trim()) return false;
  if (row.verdict !== "candidate_safe" && row.verdict !== "review") return false;
  return !isNonActionableInbound(String(row.body ?? ""));
}

/**
 * Fold a replay verdict + optional judge verdict into pass/critical. Fail-direction: anything
 * ambiguous scores as FAIL (the loop investigates), but only judge-major and hard errors are
 * CRITICAL (the T1 gate) — deterministic review reasons alone are reviewable, not release-blocking.
 */
export function scoreTurn(row: ReplayRow, judge: IntentVerdict | null | undefined): TurnScore {
  const reviewReasons = (row.reviewReasons ?? []).filter(Boolean);
  const judgedMajor = judge ? !judge.addressed && judge.severity === "major" : false;
  const judgedMinor = judge ? !judge.addressed && judge.severity === "minor" : false;
  const hardError = row.verdict === "error";
  const unexpectedSilence = row.verdict === "no_response";
  const pass =
    !hardError &&
    !unexpectedSilence &&
    !judgedMajor &&
    !judgedMinor &&
    (row.verdict === "candidate_safe" || row.verdict === "expected_no_response");
  return {
    turnKey: turnKeyOf(row),
    conversationId: row.conversationId,
    pass,
    critical: judgedMajor || hardError,
    verdict: row.verdict,
    reviewReasons,
    judge: judge ?? null,
    body: String(row.body ?? "").replace(/\s+/g, " ").slice(0, 200),
    draft: row.draft ? String(row.draft).replace(/\s+/g, " ").slice(0, 200) : null
  };
}

export type BaselineEntry = { pass: boolean; critical: boolean; at: string };
export type Baseline = Record<string, BaselineEntry>;

/** Turns that PASSED in the previous baseline and FAIL now — the regression set. */
export function diffAgainstBaseline(scores: TurnScore[], baseline: Baseline | null | undefined): TurnScore[] {
  if (!baseline) return [];
  return scores.filter(s => baseline[s.turnKey]?.pass === true && !s.pass);
}

export function mergeBaseline(prev: Baseline | null | undefined, scores: TurnScore[], atIso: string): Baseline {
  const next: Baseline = { ...(prev ?? {}) };
  for (const s of scores) next[s.turnKey] = { pass: s.pass, critical: s.critical, at: atIso };
  return next;
}

export type FlywheelFinding = {
  convId: string;
  leadKey: string;
  dimension: "corpus_replay_regression" | "corpus_replay_judge_fail" | "corpus_replay_error";
  severity: "P1" | "P2";
  healed: false;
  occurredAt: string;
  category: "reply";
  detail: string;
};

export function buildFindings(scores: TurnScore[], regressions: TurnScore[], atIso: string): FlywheelFinding[] {
  const regressionKeys = new Set(regressions.map(r => r.turnKey));
  const out: FlywheelFinding[] = [];
  for (const s of scores) {
    if (s.pass) continue;
    const isRegression = regressionKeys.has(s.turnKey);
    const dimension: FlywheelFinding["dimension"] =
      s.verdict === "error" ? "corpus_replay_error" : isRegression ? "corpus_replay_regression" : "corpus_replay_judge_fail";
    const why = s.judge && !s.judge.addressed ? `${s.judge.customerAsk} — ${s.judge.why}` : s.reviewReasons.join("; ") || s.verdict;
    out.push({
      convId: s.conversationId,
      leadKey: s.conversationId,
      dimension,
      severity: s.critical || isRegression ? "P1" : "P2",
      healed: false,
      occurredAt: atIso,
      category: "reply",
      detail: `[replay ${s.turnKey}] customer: "${s.body}" → draft: "${s.draft ?? "(none)"}" — ${why}`.slice(0, 480)
    });
  }
  return out;
}

export type FlywheelSummary = {
  generatedAt: string;
  replaySource: string;
  totalTurns: number;
  judged: number;
  judgeSkippedByCap: number;
  passed: number;
  failed: number;
  criticals: number;
  regressions: number;
  passRate: number;
  thresholds: { t1_criticals_zero: boolean; t2_pass_rate_ge_090: boolean; t3_regressions_zero: boolean };
};

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const replayJson = flag("replay-json");
  const outDir = path.resolve(flag("out-dir") ?? "reports/corpus_replay");
  const maxJudge = Math.max(0, Number(flag("max-judge") ?? 400) || 400);
  if (!replayJson) {
    console.error("corpus_replay_flywheel requires --replay-json <inbound-shadow-*.json> (or --self-test)");
    process.exit(2);
  }
  if (process.env.LLM_ENABLED !== "1" || !process.env.OPENAI_API_KEY) {
    console.error("flywheel needs LLM_ENABLED=1 and OPENAI_API_KEY for judging.");
    process.exit(2);
  }

  const report = JSON.parse(fs.readFileSync(replayJson, "utf8"));
  const rows: ReplayRow[] = Array.isArray(report?.cases) ? report.cases : [];
  const atIso = new Date().toISOString();

  // Judge (cost-capped). One intent-handled call per judge-worthy row.
  const judgeWorthy = rows.filter(isJudgeWorthy);
  const toJudge = judgeWorthy.slice(0, maxJudge);
  const verdicts = new Map<string, IntentVerdict | null>();
  let judged = 0;
  for (const row of toJudge) {
    const candidate: IntentJudgeCandidate = {
      convId: row.conversationId,
      at: row.messageAt ?? atIso,
      inboundText: row.body,
      replyText: String(row.draft ?? ""),
      replyKind: "draft",
      context: []
    };
    try {
      verdicts.set(turnKeyOf(row), await realJudge(candidate));
      judged += 1;
    } catch (err: any) {
      console.warn(`[flywheel] judge failed for ${turnKeyOf(row)}: ${err?.message ?? err}`);
      verdicts.set(turnKeyOf(row), null);
    }
  }

  const scores = rows.map(row => scoreTurn(row, verdicts.get(turnKeyOf(row))));
  const baselinePath = path.join(outDir, "baseline.json");
  const prevBaseline: Baseline | null = fs.existsSync(baselinePath)
    ? JSON.parse(fs.readFileSync(baselinePath, "utf8"))
    : null;
  const regressions = diffAgainstBaseline(scores, prevBaseline);
  const findings = buildFindings(scores, regressions, atIso);

  const failed = scores.filter(s => !s.pass);
  const summary: FlywheelSummary = {
    generatedAt: atIso,
    replaySource: replayJson,
    totalTurns: scores.length,
    judged,
    judgeSkippedByCap: Math.max(0, judgeWorthy.length - toJudge.length),
    passed: scores.length - failed.length,
    failed: failed.length,
    criticals: scores.filter(s => s.critical).length,
    regressions: regressions.length,
    passRate: scores.length ? Math.round(((scores.length - failed.length) / scores.length) * 1000) / 1000 : 1,
    thresholds: {
      t1_criticals_zero: scores.every(s => !s.critical),
      t2_pass_rate_ge_090: scores.length > 0 && (scores.length - failed.length) / scores.length >= 0.9,
      t3_regressions_zero: regressions.length === 0
    }
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(baselinePath, `${JSON.stringify(mergeBaseline(prevBaseline, scores, atIso), null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "latest.json"), `${JSON.stringify({ generatedAt: atIso, anomalies: findings }, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "scores.json"), `${JSON.stringify(scores, null, 2)}\n`);
  console.log(
    `flywheel: ${summary.totalTurns} turns, ${summary.judged} judged (${summary.judgeSkippedByCap} over cap), ` +
      `pass ${summary.passed}/${summary.totalTurns} (${(summary.passRate * 100).toFixed(1)}%), ` +
      `criticals ${summary.criticals}, regressions ${summary.regressions} — ` +
      `T1:${summary.thresholds.t1_criticals_zero ? "PASS" : "fail"} T2:${summary.thresholds.t2_pass_rate_ge_090 ? "PASS" : "fail"} T3:${summary.thresholds.t3_regressions_zero ? "PASS" : "fail"}`
  );
}

function selfTest() {
  const assert = (cond: boolean, label: string) => {
    if (!cond) {
      console.error(`SELF-TEST FAIL: ${label}`);
      process.exit(1);
    }
  };
  const mk = (over: Partial<ReplayRow>): ReplayRow => ({
    conversationId: "+15550001111",
    messageId: "SM1",
    body: "is the low rider st still available?",
    draft: "Yes — the 2026 Low Rider ST is in stock. Want photos?",
    verdict: "candidate_safe",
    reviewReasons: [],
    ...over
  });

  // turn keys are stable and anchored
  assert(turnKeyOf(mk({})) === "+15550001111::SM1", "turn key anchors on messageId");
  assert(turnKeyOf(mk({ messageId: undefined, messageIndex: 4 })) === "+15550001111::idx4", "falls back to index");

  // judge-worthiness
  assert(isJudgeWorthy(mk({})), "actionable draft row is judge-worthy");
  assert(!isJudgeWorthy(mk({ body: "ok" })), "bare ack is not judge-worthy");
  assert(!isJudgeWorthy(mk({ draft: null, verdict: "expected_no_response" })), "no-draft rows are not judged");

  // scoring
  const passScore = scoreTurn(mk({}), { addressed: true, customerAsk: "availability", why: "answered", severity: "none" });
  assert(passScore.pass && !passScore.critical, "addressed candidate_safe passes");
  const major = scoreTurn(mk({}), { addressed: false, customerAsk: "availability", why: "answered wrong thing", severity: "major" });
  assert(!major.pass && major.critical, "judge-major fails AND is critical (T1)");
  const minor = scoreTurn(mk({}), { addressed: false, customerAsk: "availability", why: "partially", severity: "minor" });
  assert(!minor.pass && !minor.critical, "judge-minor fails but is not critical");
  const err = scoreTurn(mk({ verdict: "error", draft: null }), null);
  assert(!err.pass && err.critical, "replay error is critical");
  const silent = scoreTurn(mk({ verdict: "no_response", draft: null }), null);
  assert(!silent.pass && !silent.critical, "unexpected silence fails, not critical");
  const review = scoreTurn(mk({ verdict: "review", reviewReasons: ["price claim"] }), null);
  assert(!review.pass && !review.critical, "unjudged review rows fail toward investigation");

  // baseline diff — only pass→fail counts as regression
  const base: Baseline = { [turnKeyOf(mk({}))]: { pass: true, critical: false, at: "t0" } };
  assert(diffAgainstBaseline([major], base).length === 1, "pass→fail is a regression");
  assert(diffAgainstBaseline([passScore], base).length === 0, "pass→pass is not");
  assert(diffAgainstBaseline([major], { [turnKeyOf(mk({}))]: { pass: false, critical: false, at: "t0" } }).length === 0, "fail→fail is not a regression");
  assert(diffAgainstBaseline([major], null).length === 0, "no baseline → no regressions (first run)");

  // findings shape for the next.json fold
  const findings = buildFindings([major, passScore], [major], "2026-07-02T23:00:00.000Z");
  assert(findings.length === 1, "only failures emit findings");
  assert(findings[0].dimension === "corpus_replay_regression" && findings[0].severity === "P1", "regressions are P1");
  assert(!!findings[0].occurredAt && findings[0].category === "reply", "findings carry occurredAt + category");

  // prompt builder reachable (shared with the nightly audit — same judging semantics)
  assert(buildIntentJudgePrompt({ convId: "x", at: "t", inboundText: "hi", replyText: "hey", replyKind: "draft", context: [] }).length > 50, "judge prompt builder shared");

  console.log("corpus replay flywheel self-test OK (scoring, baseline diff, findings shape, judge gating)");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (process.argv.includes("--self-test")) {
    selfTest();
  } else {
    main().catch(err => {
      console.error(err?.stack ?? err?.message ?? err);
      process.exit(1);
    });
  }
}
