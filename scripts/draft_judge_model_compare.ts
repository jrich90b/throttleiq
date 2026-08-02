/**
 * Draft-judge MODEL COMPARISON — the same judgment, three judges, on drafts staff actually sent.
 *
 * Joe, 2026-08-02: "What is the most powerful model we can use as the judge?" — then his own
 * research cut the other way (Claude 3 Opus was NOT worth it over 3.5 Sonnet as a judge), and our
 * 7/31 measurement agreed in spirit (gpt-5 beat gpt-5-mini on nothing). So instead of arguing
 * tiers, this runs the EXACT production judgment (the real prompt builder + schema from
 * draftQualityJudgePrompt.ts — never a hand-copy, the PR #432 lesson) across:
 *
 *   incumbent  gpt-5-mini      (what production runs today, via judgeDraftQualityWithLLM)
 *   challenger claude-sonnet-5 (the tier Joe's research favors for chat judging)
 *   challenger claude-opus-5   (the top tier, as the control on that claim)
 *
 * over the SAME approved-draft corpus as draft_judge_backtest.ts (shared builder), split by LANE —
 * because the email/ADF lane writes ~48% of drafts and today calls no judge at all, so its numbers
 * are the ones an email-lane shadow would see.
 *
 * READ-ONLY and offline: nothing here holds, regenerates, or texts anything. Costs ~$1-3 per run.
 *
 * Run (on the box):
 *   set -a; . <runtime>/api.env; set +a
 *   LLM_ENABLED=1 BACKTEST_CONVERSATIONS_PATH=<runtime>/data/conversations.json \
 *     COMPARE_SAMPLE=80 COMPARE_OUT=/tmp/judge_model_compare.json \
 *     npx tsx scripts/draft_judge_model_compare.ts
 */
import fs from "node:fs";
import { judgeDraftQualityWithLLM } from "../services/api/src/domain/llmDraft.ts";
import {
  DRAFT_QUALITY_JUDGE_JSON_SCHEMA,
  buildDraftQualityJudgePrompt,
  coerceDraftQualityOverall
} from "../services/api/src/domain/draftQualityJudgePrompt.ts";
import {
  anthropicMessagesRequest,
  extractAnthropicToolInput
} from "../services/api/src/domain/anthropicRequest.ts";
import {
  buildApprovedDraftCandidates,
  loadBacktestConversations,
  strideSample,
  type BacktestCandidate
} from "./draft_judge_backtest_corpus.ts";

const PATH = process.env.BACKTEST_CONVERSATIONS_PATH || "data/conversations.json";
const SAMPLE = Math.max(1, Number(process.env.COMPARE_SAMPLE || 80));
const OUT = process.env.COMPARE_OUT || "";
const CLAUDE_MODELS = (process.env.COMPARE_CLAUDE_MODELS || "claude-sonnet-5,claude-opus-5")
  .split(",")
  .map(m => m.trim())
  .filter(Boolean);

type ArmVerdict = {
  overall: "good" | "needs_regenerate" | "hold" | null;
  confidence: number | null;
  reason: string | null;
  ms: number;
};

async function runClaudeArm(model: string, c: BacktestCandidate): Promise<ArmVerdict> {
  const prompt = buildDraftQualityJudgePrompt({
    draft: c.draft,
    inbound: c.inbound,
    // The production judge's exact window policy: last 8, "direction: body".
    historyLines: c.history.slice(-8).map(h => `${h.direction}: ${h.body}`),
    leadModel: c.lead?.vehicle?.model ?? c.lead?.vehicle?.description ?? null,
    leadSource: c.lead?.source ?? null,
    channel: c.channel
  });
  const t = Date.now();
  const r = await anthropicMessagesRequest({
    apiKey: String(process.env.ANTHROPIC_API_KEY ?? ""),
    model,
    maxTokens: 400,
    temperature: 0,
    toolName: "draft_quality_judge",
    inputSchema: DRAFT_QUALITY_JUDGE_JSON_SCHEMA,
    messages: [{ role: "user", content: prompt }]
  });
  const ms = Date.now() - t;
  const p = r.ok ? extractAnthropicToolInput(r.data, "draft_quality_judge") : null;
  if (!p) return { overall: null, confidence: null, reason: r.ok ? "no tool_use" : `HTTP ${r.status}`, ms };
  return {
    overall: coerceDraftQualityOverall(p.overall),
    confidence: typeof p.confidence === "number" ? Math.max(0, Math.min(1, p.confidence)) : null,
    reason: typeof p.reason === "string" ? p.reason.slice(0, 240) : null,
    ms
  };
}

async function runIncumbentArm(c: BacktestCandidate): Promise<ArmVerdict> {
  const t = Date.now();
  const v = await judgeDraftQualityWithLLM({
    draft: c.draft,
    inbound: c.inbound,
    history: c.history,
    lead: c.lead,
    channel: c.channel
  });
  const ms = Date.now() - t;
  if (!v) return { overall: null, confidence: null, reason: "judge returned null", ms };
  return { overall: v.overall, confidence: v.confidence ?? null, reason: v.reason ?? null, ms };
}

const candidates = buildApprovedDraftCandidates(loadBacktestConversations(PATH));
const sampled = strideSample(candidates, SAMPLE);
const lanes = { email_adf: sampled.filter(c => c.lane === "email_adf").length, sms: sampled.filter(c => c.lane === "sms").length };
console.log(
  `Approved reply-drafts: ${candidates.length}; sampling ${sampled.length} (email_adf ${lanes.email_adf} / sms ${lanes.sms}).`
);
console.log(`Arms: gpt-5-mini (incumbent) + ${CLAUDE_MODELS.join(" + ")}\n`);
if (!sampled.length) {
  console.log("No approved reply-drafts — check BACKTEST_CONVERSATIONS_PATH.");
  process.exit(0);
}

type Row = {
  convId: string;
  lane: BacktestCandidate["lane"];
  inbound: string;
  draft: string;
  arms: Record<string, ArmVerdict>;
};
const rows: Row[] = [];

for (let i = 0; i < sampled.length; i++) {
  const c = sampled[i];
  // The three arms run concurrently per candidate; candidates run serially to be kind to both
  // providers' rate limits. Wall clock ≈ n × slowest arm.
  const [inc, ...claude] = await Promise.all([
    runIncumbentArm(c),
    ...CLAUDE_MODELS.map(m => runClaudeArm(m, c))
  ]);
  const arms: Record<string, ArmVerdict> = { "gpt-5-mini": inc };
  CLAUDE_MODELS.forEach((m, k) => (arms[m] = claude[k]));
  rows.push({ convId: c.convId, lane: c.lane, inbound: c.inbound.slice(0, 160), draft: c.draft.slice(0, 220), arms });
  if ((i + 1) % 10 === 0) console.log(`  ...${i + 1}/${sampled.length}`);
}

const ARMS = ["gpt-5-mini", ...CLAUDE_MODELS];
const pct = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(1) + "%" : "—");

console.log("\n===== Verdict distribution per judge (all lanes) =====");
console.log("arm".padEnd(18), "n".padStart(4), "good".padStart(12), "regen".padStart(12), "hold".padStart(12), "block".padStart(12), "p50ms".padStart(7), "p95ms".padStart(7));
for (const arm of ARMS) {
  const vs = rows.map(r => r.arms[arm]).filter(v => v.overall !== null);
  const n = vs.length;
  const g = vs.filter(v => v.overall === "good").length;
  const rg = vs.filter(v => v.overall === "needs_regenerate").length;
  const h = vs.filter(v => v.overall === "hold").length;
  const times = vs.map(v => v.ms).sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length * 0.5)] ?? 0;
  const p95 = times[Math.floor(times.length * 0.95)] ?? 0;
  console.log(
    arm.padEnd(18),
    String(n).padStart(4),
    `${g} (${pct(g, n)})`.padStart(12),
    `${rg} (${pct(rg, n)})`.padStart(12),
    `${h} (${pct(h, n)})`.padStart(12),
    `${rg + h} (${pct(rg + h, n)})`.padStart(12),
    String(p50).padStart(7),
    String(p95).padStart(7)
  );
}

console.log("\n===== Per lane (the email_adf column is what an email-lane shadow would see) =====");
for (const lane of ["email_adf", "sms"] as const) {
  console.log(`\n  lane=${lane}`);
  for (const arm of ARMS) {
    const vs = rows.filter(r => r.lane === lane).map(r => r.arms[arm]).filter(v => v.overall !== null);
    const n = vs.length;
    const g = vs.filter(v => v.overall === "good").length;
    const h = vs.filter(v => v.overall === "hold").length;
    const rg = vs.filter(v => v.overall === "needs_regenerate").length;
    console.log(`    ${arm.padEnd(18)} n=${String(n).padStart(3)}  good ${pct(g, n).padStart(6)}  regen ${pct(rg, n).padStart(6)}  hold ${pct(h, n).padStart(6)}`);
  }
}

console.log("\n===== Agreement with the incumbent (null on either side = no comparison, never agreement) =====");
for (const arm of CLAUDE_MODELS) {
  let agree = 0, disagree = 0, noComp = 0, harsher = 0, softer = 0;
  const rank = { good: 0, needs_regenerate: 1, hold: 2 } as Record<string, number>;
  for (const r of rows) {
    const a = r.arms["gpt-5-mini"].overall;
    const b = r.arms[arm].overall;
    if (a === null || b === null) { noComp++; continue; }
    if (a === b) agree++;
    else {
      disagree++;
      if (rank[b] > rank[a]) harsher++;
      else softer++;
    }
  }
  console.log(`  ${arm.padEnd(18)} agree ${agree}  disagree ${disagree} (harsher ${harsher} / softer ${softer})  no-comparison ${noComp}`);
}

console.log("\n===== Disagreements worth reading (incumbent said good, a challenger said hold — or the reverse) =====");
let shown = 0;
for (const r of rows) {
  const inc = r.arms["gpt-5-mini"];
  for (const arm of CLAUDE_MODELS) {
    const ch = r.arms[arm];
    if (inc.overall === null || ch.overall === null) continue;
    const bigGap =
      (inc.overall === "good" && ch.overall === "hold") || (inc.overall === "hold" && ch.overall === "good");
    if (!bigGap || shown >= 12) continue;
    shown++;
    console.log(`\n  [${r.convId}] lane=${r.lane}`);
    console.log(`   customer: ${r.inbound}`);
    console.log(`   draft:    ${r.draft.slice(0, 160)}`);
    console.log(`   gpt-5-mini: ${inc.overall} (${inc.confidence ?? "-"}) — ${String(inc.reason ?? "").slice(0, 140)}`);
    console.log(`   ${arm}: ${ch.overall} (${ch.confidence ?? "-"}) — ${String(ch.reason ?? "").slice(0, 140)}`);
  }
}
if (!shown) console.log("  (none — no good↔hold flips between incumbent and challengers)");

if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), sample: sampled.length, lanes, rows }, null, 2));
  console.log(`\nFull rows written: ${OUT}`);
}
console.log(
  "\n(Reading guide: on THIS corpus 'block rate' is judge-vs-staff DISAGREEMENT, not error — the 8/2 spot-checks showed staff approve real defects. What separates the arms is whether their extra flags are defects you agree with when you read them, and what latency/cost buys it.)"
);
