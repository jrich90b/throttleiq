/**
 * Context-fidelity ENFORCEMENT backtest — measure the FALSE-HOLD rate before proposing the live
 * cutover that folds the context-fidelity scorer into the draft HOLD gate.
 *
 * Premise (same as draft_judge_backtest): a draft staff actually SENT (the next human/twilio/
 * sendgrid outbound closely matches the agent's draft_ai) is a proxy for a GOOD draft. We replay
 * scoreContextFidelityWithLLM over those approved drafts — with the SAME anchor the live runtime
 * would have — and count how many the live trigger (verdict=out_of_context + severity=major +
 * confidence>=0.8) would HOLD. A hold on an approved draft is a CANDIDATE false hold (eyeball the
 * spot-checks: some are real catches staff let through).
 *
 * Read-only. Run on the box against the runtime store:
 *   CONVERSATIONS_DB_PATH=/home/ubuntu/leadrider-runtime/americanharley/data/conversations.json \
 *     LLM_ENABLED=1 BACKTEST_SAMPLE=200 npx tsx scripts/context_fidelity_backtest.ts
 */
import fs from "node:fs";
import { scoreContextFidelityWithLLM } from "../services/api/src/domain/llmDraft.ts";

const PATH = process.env.CONVERSATIONS_DB_PATH || "data/conversations.json";
const SAMPLE = Math.max(1, Number(process.env.BACKTEST_SAMPLE || 200));
const SINCE_HOURS = Number(process.env.SINCE_HOURS || 0); // 0 = whole corpus

type Msg = { direction?: string; body?: string; provider?: string; at?: string; createdAt?: string };
type Conv = { id?: string; leadKey?: string; lead?: any; classification?: any; appointment?: any; dialogState?: any; channel?: string; messages?: Msg[] };

function loadConversations(p: string): Conv[] {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.conversations)) return raw.conversations;
  if (raw && typeof raw === "object") return Object.values(raw) as Conv[];
  return [];
}

const norm = (s: string) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s]/g, "").trim();
function similar(a: string, b: string): boolean {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length > 12 && (na.includes(nb) || nb.includes(na))) return true;
  const sa = new Set(na.split(" ")), sb = new Set(nb.split(" "));
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter) >= 0.45;
}
const isSent = (m: Msg) =>
  m.direction === "out" && (m.provider === "human" || m.provider === "twilio" || m.provider === "sendgrid");

type Cand = { convId: string; inbound: string; draft: string; history: { direction: "in" | "out"; body: string }[]; anchor: any; channel: "sms" | "email" };
const cands: Cand[] = [];

for (const conv of loadConversations(PATH)) {
  const msgs = (conv.messages ?? []).filter(m => m && (m.direction === "in" || m.direction === "out"));
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.provider !== "draft_ai" || m.direction !== "out") continue;
    const draft = String(m.body ?? "").trim();
    if (!draft) continue;
    if (SINCE_HOURS > 0) {
      const t = Date.parse(String(m.at ?? m.createdAt ?? ""));
      if (Number.isFinite(t) && t < Date.now() - SINCE_HOURS * 3600 * 1000) continue;
    }
    let inbound = "";
    for (let j = i - 1; j >= 0; j--) {
      if (msgs[j].direction === "in" && String(msgs[j].body ?? "").trim()) { inbound = String(msgs[j].body).trim(); break; }
    }
    if (!inbound) continue;
    let approved = false;
    for (let k = i + 1; k < msgs.length; k++) {
      if (msgs[k].direction === "in") break;
      if (isSent(msgs[k]) && similar(draft, String(msgs[k].body ?? ""))) { approved = true; break; }
    }
    if (!approved) continue;
    const history = msgs.slice(Math.max(0, i - 8), i).map(h => ({ direction: h.direction as "in" | "out", body: String(h.body ?? "") })).filter(h => h.body.trim());
    const anchor = {
      modelOfRecord: conv?.lead?.vehicle?.model ?? conv?.lead?.vehicle?.description ?? null,
      leadType: [conv?.classification?.bucket, conv?.classification?.cta].filter(Boolean).join("/") || null,
      appointmentBooked: !!conv?.appointment?.bookedEventId,
      dialogState: conv?.dialogState?.name ?? null
    };
    cands.push({ convId: String(conv.id ?? conv.leadKey ?? ""), inbound, draft, history, anchor, channel: conv?.channel === "email" ? "email" : "sms" });
  }
}

const stride = Math.max(1, Math.floor(cands.length / SAMPLE));
const sampled = cands.filter((_, idx) => idx % stride === 0).slice(0, SAMPLE);
console.log(`Approved reply-drafts found: ${cands.length}; sampling ${sampled.length} (stride ${stride}).`);
if (!sampled.length) { console.log("No approved reply-drafts — check CONVERSATIONS_DB_PATH."); process.exit(0); }

let judged = 0, ooc = 0, oocMajor = 0, wouldHold = 0;
const byFrame: Record<string, number> = {};
const examples: { convId: string; inbound: string; draft: string; frame: string; reason?: string; conf?: number }[] = [];

for (const c of sampled) {
  const r = await scoreContextFidelityWithLLM({ draft: c.draft, inbound: c.inbound, history: c.history, anchor: c.anchor, channel: c.channel });
  if (!r) continue;
  judged++;
  byFrame[r.frame] = (byFrame[r.frame] ?? 0) + 1;
  if (r.verdict === "out_of_context") { ooc++; if (r.severity === "major") oocMajor++; }
  const conf = typeof r.confidence === "number" ? r.confidence : 0;
  if (r.verdict === "out_of_context" && r.severity === "major" && conf >= 0.8) {
    wouldHold++;
    if (examples.length < 25) examples.push({ convId: c.convId, inbound: c.inbound.slice(0, 140), draft: c.draft.slice(0, 180), frame: r.frame, reason: r.reason, conf });
  }
}

const pct = (n: number) => (judged ? ((100 * n) / judged).toFixed(1) + "%" : "—");
console.log(`\n===== Context-fidelity ENFORCEMENT backtest (approved/human-sent drafts = GOOD proxy) =====`);
console.log(`Judged: ${judged}/${sampled.length}`);
console.log(`byFrame: ${JSON.stringify(byFrame)}`);
console.log(`out_of_context: ${ooc} (${pct(ooc)}); of which major: ${oocMajor} (${pct(oocMajor)})`);
console.log(`\nLIVE-GATE TRIGGER (out_of_context + major + confidence>=0.8):`);
console.log(`  would HOLD an APPROVED draft: ${wouldHold} (${pct(wouldHold)})  <-- candidate FALSE-HOLD rate`);
console.log(`\nSpot-check would-hold examples (eyeball: scorer wrong = false hold, OR staff sent a bad draft = real catch):`);
for (const e of examples) {
  console.log(`\n  [${e.convId}] frame=${e.frame} conf=${e.conf}`);
  console.log(`   customer: ${e.inbound}`);
  console.log(`   sent draft: ${e.draft}`);
  console.log(`   why: ${e.reason}`);
}
console.log(`\n(Low would-HOLD% on approved drafts = safe to enforce. Some 'false holds' are real misses staff let through — those make enforcement MORE valuable, not less.)`);
