/**
 * Draft-quality judge BACKTEST — measure the false-positive rate before flipping STEP 2 live.
 *
 * Premise: a draft the staff actually SENT (the next human/twilio outbound closely matches the
 * agent's draft_ai) is a proxy for a GOOD draft. We replay judgeDraftQualityWithLLM over those
 * approved reply-drafts and measure how often it would HOLD / REGENERATE them — i.e. the rate at
 * which the live gate would block a draft a human was happy to send. The `hold` class (wrong-answer
 * / fabrication / unsafe) is the narrow first-flip slice, so we break it out separately.
 *
 * Read-only. Run:
 *   LLM_ENABLED=1 BACKTEST_CONVERSATIONS_PATH=/tmp/lr_backtest/conversations.json \
 *     BACKTEST_SAMPLE=150 npx tsx scripts/draft_judge_backtest.ts
 */
import { judgeDraftQualityWithLLM } from "../services/api/src/domain/llmDraft.ts";
import {
  buildApprovedDraftCandidates,
  loadBacktestConversations,
  strideSample
} from "./draft_judge_backtest_corpus.ts";

const PATH = process.env.BACKTEST_CONVERSATIONS_PATH || "data/conversations.json";
const SAMPLE = Math.max(1, Number(process.env.BACKTEST_SAMPLE || 150));

// Candidate extraction lives in draft_judge_backtest_corpus.ts, shared with the model-comparison
// backtest so both grade the IDENTICAL candidate set.
const candidates = buildApprovedDraftCandidates(loadBacktestConversations(PATH));
const sampled = strideSample(candidates, SAMPLE);
const stride = Math.max(1, Math.floor(candidates.length / SAMPLE));

console.log(`Approved reply-drafts found: ${candidates.length}; sampling ${sampled.length} (stride ${stride}).`);
if (!sampled.length) {
  console.log("No approved reply-drafts to backtest — check BACKTEST_CONVERSATIONS_PATH.");
  process.exit(0);
}

let judged = 0;
const tally = { good: 0, needs_regenerate: 0, hold: 0 } as Record<string, number>;
let holdHiConf = 0; // hold + confidence >= 0.8 (the live gate's actual trigger)
let regenHiConf = 0;
const axisFail = { intent: 0, tone: 0, disposition: 0, safety: 0 };
const holdExamples: { convId: string; inbound: string; draft: string; reason?: string; confidence?: number }[] = [];

for (const c of sampled) {
  const v = await judgeDraftQualityWithLLM({ draft: c.draft, inbound: c.inbound, history: c.history, lead: c.lead, channel: c.channel });
  if (!v) continue;
  judged++;
  tally[v.overall] = (tally[v.overall] ?? 0) + 1;
  if (!v.intentOk) axisFail.intent++;
  if (!v.toneOk) axisFail.tone++;
  if (!v.dispositionOk) axisFail.disposition++;
  if (!v.safetyOk) axisFail.safety++;
  const conf = typeof v.confidence === "number" ? v.confidence : 0;
  if (v.overall === "hold" && conf >= 0.8) {
    holdHiConf++;
    if (holdExamples.length < 30) holdExamples.push({ convId: c.convId, inbound: c.inbound.slice(0, 120), draft: c.draft.slice(0, 160), reason: v.reason, confidence: v.confidence });
  }
  if (v.overall === "needs_regenerate" && conf >= 0.8) regenHiConf++;
}

const pct = (n: number) => (judged ? ((100 * n) / judged).toFixed(1) + "%" : "—");
console.log("\n===== Draft-quality judge backtest (approved = human-sent drafts = proxy for GOOD) =====");
console.log(`Judged: ${judged}/${sampled.length}`);
console.log(`  overall good:            ${tally.good} (${pct(tally.good)})`);
console.log(`  overall needs_regenerate:${tally.needs_regenerate} (${pct(tally.needs_regenerate)})`);
console.log(`  overall hold:            ${tally.hold} (${pct(tally.hold)})`);
console.log(`\nLIVE-GATE TRIGGER (confidence >= 0.8):`);
console.log(`  would HOLD (hold-class):      ${holdHiConf} (${pct(holdHiConf)})  <-- narrow first-flip FALSE-POSITIVE rate`);
console.log(`  would REGENERATE:             ${regenHiConf} (${pct(regenHiConf)})`);
console.log(`  would BLOCK total (hold+regen): ${holdHiConf + regenHiConf} (${pct(holdHiConf + regenHiConf)})  <-- if we flip BOTH classes`);
console.log(`\nAxis fails on approved drafts: intent ${pct(axisFail.intent)}, tone ${pct(axisFail.tone)}, disposition ${pct(axisFail.disposition)}, safety ${pct(axisFail.safety)}`);
console.log(`\nSpot-check — approved drafts the gate WOULD HOLD (eyeball: judge wrong, or staff sent a bad draft?):`);
for (const e of holdExamples) {
  console.log(`\n  [${e.convId}] conf=${e.confidence}`);
  console.log(`   customer: ${e.inbound}`);
  console.log(`   sent draft: ${e.draft}`);
  console.log(`   judge: ${e.reason}`);
}
console.log("\n(High good% + low hold% on approved drafts = safe to flip the hold-class. Eyeball the spot-checks: some 'false holds' are real catches staff let through.)");
