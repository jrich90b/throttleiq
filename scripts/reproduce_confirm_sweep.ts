/**
 * Auto-reproduce sweep (Joe, 2026-07-24: "run the triage in the routines so we don't have to
 * burn down the report").
 *
 * A bounded box sweep that BEHAVIORALLY confirms which of the top-ranked codeable findings still
 * reproduce on the CURRENTLY-DEPLOYED code, so the classify step (anomaly_loop_detect.ts) can drop
 * the ones that don't — instead of a human hand-re-replaying candidate turns each run.
 *
 * Pipeline (mirrors corpus_replay_nightly.ts + the flywheel's confirm-on-refail block):
 *   1. Read the prior work order (reports/anomaly_loop/next.json), pick the top-N eligible +
 *      pinned findings (selectReproduceCandidates — corpus_replay_judge_fail / human_correction_
 *      material only, each carrying a resolvable convId + pinned msg id).
 *   2. Snapshot the store locally (cp — PII never leaves the box) and, for REPRODUCE_CONFIRM_
 *      SAMPLES independent passes, batch-replay those convs' last inbound against the deployed
 *      dist (inbound_shadow_replay --last-turn-only --conv …). No tsc on the box; the deploy
 *      already ships services/api/dist.
 *   3. Judge + score each replayed draft with the SAME functions the flywheel uses (realJudge →
 *      scoreTurn → adjustScore). A finding is "confirmed stale" ONLY when every sample found the
 *      pinned turn, matched its messageId, and PASSED (decideConfirmedStale).
 *   4. Write reports/reproduce_confirm/latest.json = { generatedAt, commit: <HEAD>, confirmed[] }.
 *      detect consumes it under a freshness + commit-binding guard (parseReproduceConfirmPayload).
 *
 * FAIL-DIRECTION (surface, never hide): a finding is added to `confirmed` ONLY on clean, matched,
 * passing samples. Any replay error, missing case, verdict "error", judge null/throw, messageId
 * mismatch, or missing dist → the finding is simply absent from `confirmed` → it keeps surfacing.
 * Because a PASS here SUPPRESSES, we require >=2 samples so one lucky judge roll can't hide a live
 * miss.
 *
 * Run (box cron): LLM_ENABLED=1 DATA_DIR=… REPORT_ROOT=… npm run reproduce_confirm_sweep
 * Self-test (pure, no LLM/replay): npx tsx scripts/reproduce_confirm_sweep.ts --self-test
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  selectReproduceCandidates,
  decideConfirmedStale,
  type ReproduceCandidate,
  type ReproduceSample
} from "../services/api/src/domain/reproduceConfirm.ts";
import {
  isJudgeWorthy,
  scoreTurn,
  adjustScore,
  type ReplayRow
} from "./corpus_replay_flywheel.ts";
import { realJudge, type IntentJudgeCandidate, type IntentVerdict } from "./intent_handled_audit.ts";

type ReplayCase = {
  conversationId?: string;
  messageId?: string | null;
  messageAt?: string | null;
  body?: string | null;
  draft?: string | null;
  verdict?: ReplayRow["verdict"];
  reviewReasons?: string[];
  router?: any;
  sourceConversationMode?: string | null;
};

// --- Pure helpers (exercised by --self-test) -------------------------------------------------

/** Build a flywheel ReplayRow from an inbound_shadow_replay case. */
export function replayRowFromCase(c: ReplayCase): ReplayRow {
  return {
    conversationId: String(c.conversationId ?? ""),
    messageId: c.messageId ?? undefined,
    messageAt: c.messageAt ?? undefined,
    body: String(c.body ?? ""),
    draft: c.draft ?? null,
    verdict: (c.verdict ?? "error") as ReplayRow["verdict"],
    reviewReasons: Array.isArray(c.reviewReasons) ? c.reviewReasons : [],
    router: c.router ?? null,
    sourceConversationMode: c.sourceConversationMode ?? null
  };
}

/** The replay case for a candidate conv (the last-inbound case for that conversation), or null. */
export function caseForCandidate(cases: ReplayCase[], candidate: ReproduceCandidate): ReplayCase | null {
  return cases.find(c => String(c.conversationId ?? "") === candidate.convId) ?? null;
}

/** Prior-message context for the judge (oldest→newest "in/out: body"), like the flywheel's contextFor. */
export function buildJudgeContext(
  messages: Array<{ direction?: string; body?: string; at?: string; createdAt?: string }>,
  cutIso: string | null | undefined
): string[] {
  const cutMs = Date.parse(String(cutIso ?? ""));
  const prior = (messages ?? []).filter(m => {
    const t = Date.parse(String(m?.at ?? m?.createdAt ?? ""));
    return Number.isFinite(t) && Number.isFinite(cutMs) ? t < cutMs : false;
  });
  return prior.slice(-6).map(m => `${m?.direction === "in" ? "in" : "out"}: ${String(m?.body ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
}

/**
 * Fold a replayed case + judge verdict into one sample outcome for a candidate. `found` = a case
 * for this conv came back; `messageIdMatch` = its pinned turn is the finding's turn (guards against
 * the conversation having moved to a newer last inbound); `pass` = scoreTurn+adjustScore.pass.
 */
export function sampleOutcome(
  candidate: ReproduceCandidate,
  c: ReplayCase | null,
  judge: IntentVerdict | null
): ReproduceSample {
  if (!c) return { found: false, pass: false, messageIdMatch: false };
  const row = replayRowFromCase(c);
  const messageIdMatch = String(c.messageId ?? "") === candidate.pinnedMessageId;
  const scored = adjustScore(scoreTurn(row, judge), row);
  return { found: true, pass: !!scored.pass, messageIdMatch };
}

// --- Self-test -------------------------------------------------------------------------------

if (process.argv.includes("--self-test")) {
  const assert = await import("node:assert/strict");
  const cand: ReproduceCandidate = { convId: "+1", dimension: "corpus_replay_judge_fail", key: "+1::corpus_replay_judge_fail", pinnedMessageId: "msg_a_1" };
  // No case → not found.
  assert.default.deepEqual(sampleOutcome(cand, null, null), { found: false, pass: false, messageIdMatch: false });
  // Case with matching messageId + a safe addressed draft → pass, match.
  const okCase: ReplayCase = { conversationId: "+1", messageId: "msg_a_1", messageAt: "2026-07-01T00:00:00Z", body: "do you have it?", draft: "Yes, in stock.", verdict: "candidate_safe", reviewReasons: [] };
  const okSample = sampleOutcome(cand, okCase, { addressed: true, customerAsk: "availability", why: "", severity: "none" });
  assert.default.equal(okSample.found, true);
  assert.default.equal(okSample.messageIdMatch, true);
  assert.default.equal(okSample.pass, true);
  // Judge major → still reproduces (no pass).
  const badSample = sampleOutcome(cand, okCase, { addressed: false, customerAsk: "availability", why: "ignored", severity: "major" });
  assert.default.equal(badSample.pass, false);
  // Newer last inbound than the finding's turn → messageId mismatch (won't confirm).
  const movedSample = sampleOutcome(cand, { ...okCase, messageId: "msg_b_2" }, { addressed: true, customerAsk: "x", why: "", severity: "none" });
  assert.default.equal(movedSample.messageIdMatch, false);
  // caseForCandidate picks by conversationId.
  assert.default.equal(caseForCandidate([okCase], cand)?.messageId, "msg_a_1");
  assert.default.equal(caseForCandidate([], cand), null);
  // buildJudgeContext keeps only prior messages, oldest→newest.
  const ctx = buildJudgeContext(
    [
      { direction: "out", body: "hi", at: "2026-06-30T00:00:00Z" },
      { direction: "in", body: "do you have it?", at: "2026-07-01T00:00:00Z" },
      { direction: "out", body: "future", at: "2026-07-02T00:00:00Z" }
    ],
    "2026-07-01T00:00:00Z"
  );
  assert.default.deepEqual(ctx, ["out: hi"]);
  // decideConfirmedStale integration: two clean matched passes → stale.
  assert.default.equal(decideConfirmedStale([okSample, okSample], { requiredSamples: 2 }), true);
  assert.default.equal(decideConfirmedStale([okSample, badSample], { requiredSamples: 2 }), false);
  console.log("PASS reproduce_confirm_sweep self-test — row build + case match + context + sample fold + confirm gate");
  process.exit(0);
}

// --- Live sweep (box) ------------------------------------------------------------------------

const reportRoot = String(process.env.REPORT_ROOT ?? "").trim();
if (!reportRoot) {
  console.error("REPORT_ROOT is required.");
  process.exit(2);
}
const dataDir =
  String(process.env.DATA_DIR ?? "").trim() ||
  (process.env.CONVERSATIONS_DB_PATH ? path.dirname(String(process.env.CONVERSATIONS_DB_PATH)) : "");
const maxCandidates = Math.max(1, Number(process.env.REPRODUCE_CONFIRM_MAX ?? 8) || 8);
const samples = Math.max(1, Number(process.env.REPRODUCE_CONFIRM_SAMPLES ?? 2) || 2);
const outDir = path.join(reportRoot, "reproduce_confirm");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "latest.json");

// Fail-safe: never HIDE a finding on an incomplete run. On any pre-flight problem we write an
// EMPTY confirmed list (suppress nothing) rather than leaving a stale file in place.
function writeEmpty(reason: string, commit: string) {
  fs.writeFileSync(
    outPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), commit, confirmed: [], note: reason, sampled: 0, replayed: 0 }, null, 2)
  );
  console.log(`[reproduce-confirm] ${reason} — wrote empty confirmed list (suppress nothing).`);
}

function headCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const commit = headCommit();

if (process.env.LLM_ENABLED !== "1" || !process.env.OPENAI_API_KEY) {
  writeEmpty("LLM disabled or OPENAI_API_KEY unset", commit);
  process.exit(0);
}
if (!dataDir || !fs.existsSync(path.join(dataDir, "conversations.json"))) {
  writeEmpty(`no store at ${dataDir}/conversations.json`, commit);
  process.exit(0);
}
if (!fs.existsSync(path.join(process.cwd(), "services/api/dist/index.js"))) {
  writeEmpty("services/api/dist/index.js missing (deploy ships dist) — cannot replay", commit);
  process.exit(0);
}

const nextPath = path.join(reportRoot, "anomaly_loop", "next.json");
if (!fs.existsSync(nextPath)) {
  writeEmpty(`no work order at ${nextPath}`, commit);
  process.exit(0);
}
const workOrders: any[] = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(nextPath, "utf8"));
    return Array.isArray(j?.workOrders) ? j.workOrders : [];
  } catch {
    return [];
  }
})();

const candidates = selectReproduceCandidates(workOrders, { max: maxCandidates });
if (!candidates.length) {
  writeEmpty("no eligible + pinned candidates in the work order", commit);
  process.exit(0);
}
console.log(`[reproduce-confirm] ${candidates.length} candidate(s), ${samples} sample(s) each, commit ${commit.slice(0, 8)}`);

// Snapshot the store locally (PII stays on the box).
const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), "reproduce-confirm-snap-"));
fs.copyFileSync(path.join(dataDir, "conversations.json"), path.join(snapDir, "conversations.json"));
for (const extra of ["inventory_snapshot.json", "todos.json", "events.json"]) {
  const src = path.join(dataDir, extra);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(snapDir, extra));
}
const messagesByConv = new Map<string, Array<{ direction?: string; body?: string; at?: string; createdAt?: string }>>();
try {
  const snap = JSON.parse(fs.readFileSync(path.join(snapDir, "conversations.json"), "utf8"));
  const list: any[] = Array.isArray(snap) ? snap : snap?.conversations ?? [];
  for (const c of list) messagesByConv.set(String(c?.id ?? ""), Array.isArray(c?.messages) ? c.messages : []);
} catch {
  /* context is best-effort; the judge still runs on inbound+draft */
}

const convIds = [...new Set(candidates.map(c => c.convId))];
const replayOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "reproduce-confirm-out-"));

function runReplaySample(): ReplayCase[] {
  const before = new Set(fs.readdirSync(replayOutDir));
  execFileSync(
    "npx",
    [
      "tsx",
      "scripts/inbound_shadow_replay.ts",
      "--data-dir",
      snapDir,
      "--since-days",
      "3650",
      "--limit",
      String(convIds.length),
      "--last-turn-only",
      "--conv",
      convIds.join(","),
      "--out-dir",
      replayOutDir
    ],
    { stdio: ["ignore", "ignore", "inherit"] }
  );
  const newest = fs
    .readdirSync(replayOutDir)
    .filter(f => f.startsWith("inbound-shadow-") && f.endsWith(".json") && !before.has(f))
    .sort()
    .pop();
  if (!newest) return [];
  try {
    const rep = JSON.parse(fs.readFileSync(path.join(replayOutDir, newest), "utf8"));
    return Array.isArray(rep?.cases) ? rep.cases : [];
  } catch {
    return [];
  }
}

// Judge cache keyed by turnKey + draft (unchanged drafts across samples are free).
const judgeCachePath = path.join(outDir, "judge_cache.json");
const judgeCache: Record<string, IntentVerdict | null> = fs.existsSync(judgeCachePath)
  ? (() => { try { return JSON.parse(fs.readFileSync(judgeCachePath, "utf8")); } catch { return {}; } })()
  : {};
async function judgeCase(c: ReplayCase): Promise<IntentVerdict | null> {
  const row = replayRowFromCase(c);
  if (!isJudgeWorthy(row)) return null; // no draft / expected-silence → scoreTurn handles null
  const ck = `${row.conversationId}::${row.messageId ?? ""}##${String(row.draft ?? "").replace(/\s+/g, " ").trim().slice(0, 300)}`;
  if (ck in judgeCache) return judgeCache[ck];
  const candidateInput: IntentJudgeCandidate = {
    convId: row.conversationId,
    at: String(row.messageAt ?? new Date().toISOString()),
    inboundText: row.body,
    replyText: String(row.draft ?? ""),
    replyKind: "draft",
    context: buildJudgeContext(messagesByConv.get(row.conversationId) ?? [], row.messageAt)
  };
  try {
    const v = await realJudge(candidateInput);
    judgeCache[ck] = v;
    return v;
  } catch (err: any) {
    console.warn(`[reproduce-confirm] judge failed for ${row.conversationId}: ${err?.message ?? err}`);
    return null; // judge error → no pass this sample → finding surfaces (fail-safe)
  }
}

const samplesByKey = new Map<string, ReproduceSample[]>();
for (const cand of candidates) samplesByKey.set(cand.key, []);

let replayedTotal = 0;
for (let s = 0; s < samples; s += 1) {
  let cases: ReplayCase[] = [];
  try {
    cases = runReplaySample();
  } catch (err: any) {
    console.warn(`[reproduce-confirm] replay sample ${s + 1} failed: ${err?.message ?? err}`);
    cases = []; // whole-sample failure → every candidate records a not-found sample → none confirmed
  }
  replayedTotal += cases.length;
  for (const cand of candidates) {
    const c = caseForCandidate(cases, cand);
    const judge = c && String(c.verdict ?? "") !== "error" ? await judgeCase(c) : null;
    samplesByKey.get(cand.key)!.push(sampleOutcome(cand, c, judge));
  }
}
fs.writeFileSync(judgeCachePath, `${JSON.stringify(judgeCache)}\n`);

const confirmed = candidates
  .filter(cand => decideConfirmedStale(samplesByKey.get(cand.key) ?? [], { requiredSamples: samples }))
  .map(cand => ({ convId: cand.convId, dimension: cand.dimension, key: cand.key, verdict: "no_longer_reproduces" as const }));

fs.writeFileSync(
  outPath,
  JSON.stringify(
    { generatedAt: new Date().toISOString(), commit, confirmed, sampled: candidates.length, samples, replayed: replayedTotal },
    null,
    2
  )
);

// Best-effort cleanup of the local snapshots.
try { fs.rmSync(snapDir, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(replayOutDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(
  `[reproduce-confirm] ${confirmed.length}/${candidates.length} confirmed stale (no longer reproduce) on commit ${commit.slice(0, 8)}:`
);
for (const c of confirmed) console.log(`   - ${c.key}`);
console.log(`Wrote ${outPath}`);
