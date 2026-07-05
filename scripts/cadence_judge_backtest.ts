/**
 * Cadence-quality judge BACKTEST — measure the suppress rate + sample false-positives before flipping
 * the cadence-quality judge from SHADOW to ENFORCE.
 *
 * Unlike the draft-quality backtest, "the message was sent" is NOT a good-proxy here — the whole point
 * is that many proactive cadence touches that DID send were low-value repeats. So this measures the
 * SUPPRESS RATE over real proactive sends and prints the suppressions for human eyeballing: at
 * confidence >= FLOOR, what fraction would we hold back, and are those genuinely low-value (right) or
 * fine messages (false suppress)?
 *
 * PROACTIVE send = an outbound the agent sent unprompted — the chronologically-previous message is also
 * an outbound (the agent reaching out again with no customer reply in between). Reply-drafts (preceded
 * by a customer inbound) are excluded — they're the draft/no-response judges' domain, not cadence.
 *
 * Read-only. Run:
 *   LLM_ENABLED=1 BACKTEST_CONVERSATIONS_PATH=/tmp/cad_bt/conversations.json \
 *     BACKTEST_WINDOW_DAYS=45 BACKTEST_SAMPLE=150 BACKTEST_FLOOR=0.9 \
 *     npx tsx scripts/cadence_judge_backtest.ts
 */
import fs from "node:fs";
import { judgeCadenceQualityWithLLM } from "../services/api/src/domain/llmDraft.ts";

const PATH = process.env.BACKTEST_CONVERSATIONS_PATH || "data/conversations.json";
const SAMPLE = Math.max(1, Number(process.env.BACKTEST_SAMPLE || 150));
const WINDOW_DAYS = Math.max(1, Number(process.env.BACKTEST_WINDOW_DAYS || 45));
const FLOOR = Number(process.env.BACKTEST_FLOOR || 0.9);
const MIN_DAYS = Math.max(1, Number(process.env.BACKTEST_MIN_DAYS_SINCE_INBOUND || 2));
const NOW = Date.now();
const windowMs = WINDOW_DAYS * 86_400_000;

type Msg = { direction: "in" | "out"; body?: string; provider?: string; at?: string };
type Conv = { id?: string; leadKey?: string; lead?: any; followUpCadence?: any; messages?: Msg[] };

function loadConversations(p: string): Conv[] {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.conversations)) return raw.conversations;
  if (raw && typeof raw === "object") return Object.values(raw) as Conv[];
  return [];
}

const isSent = (m: Msg) => m.direction === "out" && (m.provider === "human" || m.provider === "twilio" || m.provider === "sendgrid");

type Candidate = {
  convId: string;
  lead?: any;
  message: string;
  channel: "sms" | "email";
  cadenceKind: string | null;
  daysSinceLastInbound: number | null;
  history: { direction: "in" | "out"; body: string }[];
};
const candidates: Candidate[] = [];

for (const conv of loadConversations(PATH)) {
  const msgs = (conv.messages ?? []).filter(m => m && (m.direction === "in" || m.direction === "out") && String(m.body ?? "").trim());
  for (let i = 1; i < msgs.length; i++) {
    const m = msgs[i];
    if (!isSent(m)) continue; // only real sends (a proactive cadence touch that actually went out)
    const atMs = Date.parse(String(m.at ?? ""));
    if (!Number.isFinite(atMs) || NOW - atMs > windowMs) continue; // window
    // PROACTIVE: the immediately-preceding message is an outbound (agent reaching out with no customer
    // reply in between). A send preceded by a customer inbound is a REPLY, not a cadence touch.
    if (msgs[i - 1].direction !== "out") continue;
    const message = String(m.body ?? "").trim();
    if (!message) continue;
    // Skip system/marketing/opt-out artifacts that aren't conversational cadence touches.
    if (/^reply stop|unsubscribe|^call initiated|^customer:/i.test(message)) continue;
    // daysSinceLastInbound AT SEND TIME (the most recent inbound before this send).
    let lastInboundMs = NaN;
    for (let j = i - 1; j >= 0; j--) {
      if (msgs[j].direction === "in") { lastInboundMs = Date.parse(String(msgs[j].at ?? "")); break; }
    }
    const daysSinceLastInbound = Number.isFinite(lastInboundMs) ? Math.max(0, Math.floor((atMs - lastInboundMs) / 86_400_000)) : null;
    // A genuine PROACTIVE cadence touch lands DAYS after the customer's last contact. Same-day sends
    // (daysSinceInbound 0) are agent replies/confirmations that merely follow another outbound — the
    // runtime cadence gate never judges those, so excluding them avoids mislabeling replies as cadence.
    if (daysSinceLastInbound === null || daysSinceLastInbound < MIN_DAYS) continue;
    const channel: "sms" | "email" = m.provider === "sendgrid" || /@/.test(String(conv.leadKey ?? "")) ? "email" : "sms";
    const history = msgs.slice(Math.max(0, i - 8), i).map(h => ({ direction: h.direction, body: String(h.body ?? "") }));
    candidates.push({
      convId: String(conv.id ?? ""),
      lead: conv.lead,
      message,
      channel,
      cadenceKind: conv.followUpCadence?.kind ?? null,
      daysSinceLastInbound,
      history
    });
  }
}

const stride = Math.max(1, Math.floor(candidates.length / SAMPLE));
const sampled = candidates.filter((_, idx) => idx % stride === 0).slice(0, SAMPLE);
console.log(`Proactive sends in the last ${WINDOW_DAYS}d: ${candidates.length}; sampling ${sampled.length} (stride ${stride}); floor ${FLOOR}.`);
if (!sampled.length) { console.log("No proactive sends to backtest."); process.exit(0); }

let judged = 0;
const tally: Record<string, number> = {};
let suppressOrHold = 0;
let suppressHiConf = 0;
const hiConfExamples: { convId: string; msg: string; reason?: string; conf?: number; kind: string | null; days: number | null }[] = [];

for (const c of sampled) {
  const v = await judgeCadenceQualityWithLLM({
    message: c.message,
    channel: c.channel,
    cadenceKind: c.cadenceKind,
    history: c.history,
    lead: c.lead,
    daysSinceLastInbound: c.daysSinceLastInbound
  });
  if (!v) continue;
  judged++;
  const overall = String(v.overall ?? "?");
  tally[overall] = (tally[overall] ?? 0) + 1;
  const conf = typeof v.confidence === "number" ? v.confidence : 0;
  if (overall === "suppress" || overall === "hold") {
    suppressOrHold++;
    if (conf >= FLOOR) {
      suppressHiConf++;
      if (hiConfExamples.length < 40) hiConfExamples.push({ convId: c.convId, msg: c.message.slice(0, 160), reason: v.reason, conf: v.confidence, kind: c.cadenceKind, days: c.daysSinceLastInbound });
    }
  }
}

const pct = (n: number) => (judged ? ((100 * n) / judged).toFixed(1) + "%" : "—");
console.log("\n===== Cadence-quality judge backtest (proactive sends; no good-proxy — eyeball the suppressions) =====");
console.log(`Judged: ${judged}/${sampled.length}`);
for (const [k, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  overall ${k}: ${n} (${pct(n)})`);
console.log(`\nENFORCE TRIGGER:`);
console.log(`  suppress/hold (any conf):   ${suppressOrHold} (${pct(suppressOrHold)})`);
console.log(`  suppress/hold conf >= ${FLOOR}:  ${suppressHiConf} (${pct(suppressHiConf)})  <-- the daily volume the gate would hold back`);
console.log(`\nSpot-check — proactive sends the gate WOULD SUPPRESS at conf >= ${FLOOR} (eyeball: genuinely low-value, or a fine message wrongly held?):`);
for (const e of hiConfExamples) {
  console.log(`\n  [${e.convId}] conf=${e.conf} kind=${e.kind} daysSinceInbound=${e.days}`);
  console.log(`   msg:   ${e.msg}`);
  console.log(`   judge: ${e.reason}`);
}
console.log(`\n(Low suppress% + clearly-low-value spot-checks = safe to enforce at the floor. A 'wrong' suppression = a concrete, useful message held back.)`);
