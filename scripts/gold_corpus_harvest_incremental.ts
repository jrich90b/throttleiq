/**
 * Gold-corpus INCREMENTAL harvest (nightly). Finds takeovers NOT yet seen, scores them with the
 * context-fidelity scorer, and appends the scorer-confirmed ones (regex-scrubbed) to a GITIGNORED
 * JSONL store. Never commits. Promotion into the committed corpus is a separate approve-first step
 * (which runs the heavier LLM-NER pass). Reuses the same takeover detection as the full sweep.
 *
 * Bootstrap once so the existing 219-pair corpus isn't re-harvested:
 *   CONVERSATIONS_DB_PATH=... npx tsx scripts/gold_corpus_harvest_incremental.ts --init
 * Then nightly (after context_fidelity:audit + drift_monitor:run):
 *   CONVERSATIONS_DB_PATH=... LLM_ENABLED=1 npx tsx scripts/gold_corpus_harvest_incremental.ts
 */
import fs from "node:fs";
import path from "node:path";
import { scoreContextFidelityWithLLM } from "../services/api/src/domain/llmDraft.ts";
import { pairKey, splitFor, shouldHarvestPair, scrubText } from "../services/api/src/domain/goldCorpusHarvest.ts";

const INIT = process.argv.includes("--init");
const PATH = process.env.CONVERSATIONS_DB_PATH || "data/conversations.json";
const ROOT = process.env.REPORT_ROOT || "data/gold_corpus";
const STORE = process.env.GOLD_STORE || path.join(ROOT, "incremental.jsonl");
const STATE = process.env.GOLD_STATE || path.join(ROOT, "harvest_state.json");
const CAP = Number(process.env.HARVEST_CAP || 50);
const SEEN_CAP = 20000;
const CONCURRENCY = 6;

type Msg = { direction?: string; body?: string; provider?: string; at?: string; createdAt?: string };
function load(p: string): any[] { const raw = JSON.parse(fs.readFileSync(p, "utf8")); return Array.isArray(raw) ? raw : raw?.conversations ?? Object.values(raw); }
const normJ = (s: string) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s]/g, "").trim();
function jac(a: string, b: string): number { const na = normJ(a), nb = normJ(b); if (!na || !nb) return 0; if (na === nb) return 1; const sa = new Set(na.split(" ")), sb = new Set(nb.split(" ")); let x = 0; for (const w of sa) if (sb.has(w)) x++; return x / (sa.size + sb.size - x); }
const isSent = (m: Msg) => m.direction === "out" && (m.provider === "human" || m.provider === "twilio" || m.provider === "sendgrid");

type Cand = { convId: string; key: string; inbound: string; draft: string; human: string; anchorModel: string; anchor: any; history: any[]; channel: "sms" | "email" };
const cands: Cand[] = [];
for (const conv of load(PATH)) {
  const convId = String(conv?.id ?? conv?.leadKey ?? "");
  const msgs = (conv.messages ?? []).filter((m: Msg) => m && (m.direction === "in" || m.direction === "out"));
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.provider !== "draft_ai" || m.direction !== "out") continue;
    const draft = String(m.body ?? "").trim(); if (!draft) continue;
    let sent: string | null = null;
    for (let k = i + 1; k < msgs.length; k++) { if (msgs[k].direction === "in") break; if (isSent(msgs[k])) { sent = String(msgs[k].body ?? "").trim(); break; } }
    if (sent === null || jac(draft, sent) >= 0.3) continue; // takeover only
    let inbound = "";
    for (let p = i - 1; p >= 0; p--) { if (msgs[p].direction === "in" && String(msgs[p].body ?? "").trim()) { inbound = String(msgs[p].body).trim(); break; } }
    if (!inbound) continue;
    const anchorModel = String(conv?.lead?.vehicle?.model ?? conv?.lead?.vehicle?.description ?? "").trim();
    const anchor = { modelOfRecord: anchorModel || null, leadType: [conv?.classification?.bucket, conv?.classification?.cta].filter(Boolean).join("/") || null, appointmentBooked: !!conv?.appointment?.bookedEventId, dialogState: conv?.dialogState?.name ?? null };
    const history = msgs.slice(Math.max(0, i - 8), i).map((h: Msg) => ({ direction: h.direction, body: String(h.body ?? "") })).filter((h: any) => h.body.trim());
    cands.push({ convId, key: pairKey(convId, draft), inbound, draft, human: sent, anchorModel, anchor, history, channel: conv?.channel === "email" ? "email" : "sms" });
  }
}

const state: { lastRunAt: string | null; seenKeys: string[] } = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { lastRunAt: null, seenKeys: [] };
const seen = new Set(state.seenKeys);
const fresh = cands.filter(c => !seen.has(c.key));

function writeState(extraKeys: string[]) {
  const merged = [...state.seenKeys, ...extraKeys];
  const trimmed = merged.slice(-SEEN_CAP);
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({ lastRunAt: new Date().toISOString(), seenKeys: trimmed }, null, 2));
}

if (INIT) {
  // Watermark only: mark everything present now as seen, emit nothing (the past lives in the 219 corpus).
  writeState(cands.map(c => c.key));
  console.log(`gold_corpus harvest --init: watermarked ${cands.length} existing takeovers as seen (no pairs emitted). State -> ${STATE}`);
  process.exit(0);
}

const batch = fresh.slice(0, CAP);
console.log(`gold_corpus harvest: ${fresh.length} unseen takeovers (capping at ${CAP}); scoring ${batch.length}...`);

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let idx = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (idx < items.length) { const c = idx++; try { out[c] = await fn(items[c]); } catch { out[c] = null as any; } } }));
  return out;
}
const scores = await pool(batch, CONCURRENCY, c => scoreContextFidelityWithLLM({ draft: c.draft, inbound: c.inbound, history: c.history, anchor: c.anchor, channel: c.channel }));

const now = new Date().toISOString();
const records: string[] = [];
batch.forEach((c, k) => {
  const r = scores[k];
  if (!shouldHarvestPair(r)) return;
  records.push(JSON.stringify({
    id: c.key, harvestedAt: now, split: splitFor(c.key), frame: r!.frame, severity: r!.severity, confidence: r!.confidence ?? null,
    anchorModel: scrubText(c.anchorModel), customer: scrubText(c.inbound).slice(0, 400), agentWrong: scrubText(c.draft).slice(0, 400), humanRight: scrubText(c.human).slice(0, 400), steering: r!.steering ?? null
  }));
});

if (records.length) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.appendFileSync(STORE, records.join("\n") + "\n");
}
writeState(batch.map(c => c.key)); // mark ALL scored (even non-errors) as seen so we never re-score them
console.log(`gold_corpus harvest: appended ${records.length} new confirmed pairs (of ${batch.length} scored) -> ${STORE}`);
