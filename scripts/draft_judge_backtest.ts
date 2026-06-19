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
import fs from "node:fs";
import { judgeDraftQualityWithLLM } from "../services/api/src/domain/llmDraft.ts";

const PATH = process.env.BACKTEST_CONVERSATIONS_PATH || "data/conversations.json";
const SAMPLE = Math.max(1, Number(process.env.BACKTEST_SAMPLE || 150));

type Msg = { direction: "in" | "out"; body?: string; provider?: string; at?: string };
type Conv = { id?: string; leadKey?: string; lead?: any; messages?: Msg[] };

function loadConversations(p: string): Conv[] {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.conversations)) return raw.conversations;
  if (raw && typeof raw === "object") return Object.values(raw) as Conv[];
  return [];
}

const norm = (s: string) =>
  String(s ?? "").toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s]/g, "").trim();

function similar(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length > 12 && (na.includes(nb) || nb.includes(na))) return true;
  const sa = new Set(na.split(" "));
  const sb = new Set(nb.split(" "));
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const jac = inter / (sa.size + sb.size - inter);
  // 0.45 captures lightly-edited sends (still a good-draft proxy); a full rewrite scores lower and
  // is correctly excluded (it means the draft was NOT good).
  return jac >= 0.45;
}

const isCustomerOutboundSent = (m: Msg) =>
  m.direction === "out" && (m.provider === "human" || m.provider === "twilio" || m.provider === "sendgrid");

// --- Build approved reply-draft candidates. ---
type Candidate = { convId: string; leadKey?: string; lead?: any; inbound: string; draft: string; channel: "sms" | "email"; history: { direction: "in" | "out"; body: string }[] };
const candidates: Candidate[] = [];

for (const conv of loadConversations(PATH)) {
  const msgs = (conv.messages ?? []).filter(m => m && (m.direction === "in" || m.direction === "out"));
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.provider !== "draft_ai" || m.direction !== "out") continue;
    const draft = String(m.body ?? "").trim();
    if (!draft) continue;
    // The customer turn this draft replied to (most recent inbound before it).
    let inbound = "";
    for (let j = i - 1; j >= 0; j--) {
      if (msgs[j].direction === "in" && String(msgs[j].body ?? "").trim()) {
        inbound = String(msgs[j].body ?? "").trim();
        break;
      }
    }
    if (!inbound) continue; // cadence / proactive draft — not the draft-quality judge's domain
    // Was it SENT? next customer-facing outbound that matches the draft.
    let approved = false;
    for (let k = i + 1; k < msgs.length; k++) {
      if (msgs[k].direction === "in") break; // a new customer turn — stop looking
      if (isCustomerOutboundSent(msgs[k]) && similar(draft, String(msgs[k].body ?? ""))) {
        approved = true;
        break;
      }
    }
    if (!approved) continue;
    const channel: "sms" | "email" = m.provider === "sendgrid" || /@/.test(String(conv.leadKey ?? "")) ? "email" : "sms";
    const history = msgs
      .slice(Math.max(0, i - 8), i)
      .map(h => ({ direction: h.direction, body: String(h.body ?? "") }))
      .filter(h => h.body.trim());
    candidates.push({ convId: String(conv.id ?? ""), leadKey: conv.leadKey, lead: conv.lead, inbound, draft, channel, history });
  }
}

// Deterministic spread sample (stride) so we cover the whole corpus, not just the first convs.
const stride = Math.max(1, Math.floor(candidates.length / SAMPLE));
const sampled = candidates.filter((_, idx) => idx % stride === 0).slice(0, SAMPLE);

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
