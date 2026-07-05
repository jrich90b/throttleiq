/**
 * FULL genuine-error sweep (read-only) — score EVERY takeover (no sampling) with the context-fidelity
 * scorer to get the exact genuine-error rate, the per-MECHANISM volume (so we prioritize the right
 * fix), the PR1-fixable share, and the complete PII-scrubbed gold-pair corpus (measurement corpus +
 * golden set seed). Verbatim sends scored as the rubber-stamp control.
 *
 *   CONVERSATIONS_DB_PATH=... LLM_ENABLED=1 npx tsx scripts/genuine_error_full_sweep.ts
 */
import fs from "node:fs";
import { scoreContextFidelityWithLLM } from "../services/api/src/domain/llmDraft.ts";

const PATH = process.env.CONVERSATIONS_DB_PATH || "data/conversations.json";
const OUT = process.env.GOLD_OUT || "/tmp/gold_corpus.json";
const CONCURRENCY = Number(process.env.CONCURRENCY || 10);

type Msg = { direction?: string; body?: string; provider?: string };
function load(p: string): any[] { const raw = JSON.parse(fs.readFileSync(p, "utf8")); return Array.isArray(raw) ? raw : raw?.conversations ?? Object.values(raw); }
const norm = (s: string) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s]/g, "").trim();
function jac(a: string, b: string): number { const na = norm(a), nb = norm(b); if (!na || !nb) return 0; if (na === nb) return 1; const sa = new Set(na.split(" ")), sb = new Set(nb.split(" ")); let x = 0; for (const w of sa) if (sb.has(w)) x++; return x / (sa.size + sb.size - x); }
const isSent = (m: Msg) => m.direction === "out" && (m.provider === "human" || m.provider === "twilio" || m.provider === "sendgrid");
function scrub(s: string): string {
  return String(s ?? "").replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[EMAIL]").replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[PHONE]").replace(/\b\d{10,}\b/g, "[PHONE]").replace(/^(Name|Email|Phone|Customer|Contact)\s*:.*$/gim, "$1: [REDACTED]").trim();
}
function isPlaceholder(label?: string | null): boolean { if (!label) return true; const t = label.trim().toLowerCase(); if (!t || ["null", "n/a", "na", "unknown", "tbd"].includes(t)) return true; if (t === "other" || /\bother\b/.test(t) || /\bfull\s*line(up)?\b/.test(t)) return true; if (/^harley[-\s]?davidson$/.test(t) || t === "harley") return true; return false; }

// Mechanism attribution on the DRAFT text (what KIND of deflection/error).
const FALLBACK_SIG = /happy to help with pricing or a model comparison|compare models if that|quick model comparison, just say the word/i;
function mechanism(draft: string): string {
  if (FALLBACK_SIG.test(draft)) return "uniqueness_fallback_model";
  if (/which\s+(?:\w+\s+)?model|model are you (?:interested|leaning|looking)|exact bike you (?:want|wanted)/i.test(draft)) return "deflect_which_model_other";
  if (/i.ll (?:check|review|look)[^.]{0,48}(?:follow up|get back|circle back)/i.test(draft)) return "check_and_follow_up";
  if (/^\s*(?:thanks for the update|got it|sounds good)\.?\s*$/i.test(draft)) return "thanks_deadend";
  if (/i.ll (?:check|confirm)[^.]{0,40}(?:hours|times|availability)/i.test(draft)) return "hours_or_times_deflection";
  return "other";
}

type Cand = { convId: string; inbound: string; draft: string; human: string; anchor: any; history: any[]; channel: "sms" | "email"; bucket: "takeover" | "verbatim" };
const cands: Cand[] = [];
for (const conv of load(PATH)) {
  const msgs = (conv.messages ?? []).filter((m: Msg) => m && (m.direction === "in" || m.direction === "out"));
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.provider !== "draft_ai" || m.direction !== "out") continue;
    const draft = String(m.body ?? "").trim(); if (!draft) continue;
    let sent: string | null = null;
    for (let k = i + 1; k < msgs.length; k++) { if (msgs[k].direction === "in") break; if (isSent(msgs[k])) { sent = String(msgs[k].body ?? "").trim(); break; } }
    if (sent === null) continue;
    const j = jac(draft, sent);
    const bucket = j >= 0.6 ? "verbatim" : j >= 0.3 ? null : "takeover";
    if (!bucket) continue;
    let inbound = "";
    for (let p = i - 1; p >= 0; p--) { if (msgs[p].direction === "in" && String(msgs[p].body ?? "").trim()) { inbound = String(msgs[p].body).trim(); break; } }
    if (!inbound) continue;
    const anchor = { modelOfRecord: conv?.lead?.vehicle?.model ?? conv?.lead?.vehicle?.description ?? null, leadType: [conv?.classification?.bucket, conv?.classification?.cta].filter(Boolean).join("/") || null, appointmentBooked: !!conv?.appointment?.bookedEventId, dialogState: conv?.dialogState?.name ?? null };
    const history = msgs.slice(Math.max(0, i - 8), i).map((h: Msg) => ({ direction: h.direction, body: String(h.body ?? "") })).filter((h: any) => h.body.trim());
    cands.push({ convId: String(conv.id ?? conv.leadKey ?? ""), inbound, draft, human: sent, anchor, history, channel: conv?.channel === "email" ? "email" : "sms", bucket });
  }
}
const takeovers = cands.filter(c => c.bucket === "takeover");
const verbatims = cands.filter(c => c.bucket === "verbatim");
console.log(`Scoring ALL: ${takeovers.length} takeovers + ${verbatims.length} verbatim (concurrency ${CONCURRENCY})...`);

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let idx = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (idx < items.length) { const c = idx++; try { out[c] = await fn(items[c], c); } catch { out[c] = null as any; } } }));
  return out;
}
const score = (c: Cand) => scoreContextFidelityWithLLM({ draft: c.draft, inbound: c.inbound, history: c.history, anchor: c.anchor, channel: c.channel });

const tScores = await pool(takeovers, CONCURRENCY, score);
let tJudged = 0, tOOC = 0, tMajor = 0;
const byMech: Record<string, number> = {}, byFrame: Record<string, number> = {};
let pr1Fixable = 0;
const gold: any[] = [];
takeovers.forEach((c, k) => {
  const r = tScores[k]; if (!r) return; tJudged++;
  if (r.verdict !== "out_of_context") return;
  tOOC++; if (r.severity === "major") tMajor++;
  const mech = mechanism(c.draft);
  byMech[mech] = (byMech[mech] ?? 0) + 1;
  byFrame[r.frame] = (byFrame[r.frame] ?? 0) + 1;
  const fixable = mech === "uniqueness_fallback_model" && !isPlaceholder(c.anchor?.modelOfRecord);
  if (fixable) pr1Fixable++;
  gold.push({ convId: scrub(c.convId), mechanism: mech, frame: r.frame, severity: r.severity, pr1Fixable: fixable, anchorModel: scrub(String(c.anchor?.modelOfRecord ?? "")), customer: scrub(c.inbound).slice(0, 220), agentWrong: scrub(c.draft).slice(0, 260), humanRight: scrub(c.human).slice(0, 260), steering: r.steering ?? null });
});

const vScores = await pool(verbatims, CONCURRENCY, score);
let vJudged = 0, vOOC = 0;
verbatims.forEach((_, k) => { const r = vScores[k]; if (!r) return; vJudged++; if (r.verdict === "out_of_context") vOOC++; });

fs.writeFileSync(OUT, JSON.stringify(gold, null, 2));
const pc = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(1) + "%" : "—");
console.log(`\n===== FULL genuine-error sweep (ALL past conversations) =====`);
console.log(`Takeovers scored: ${tJudged}/${takeovers.length}`);
console.log(`  GENUINE errors (out_of_context): ${tOOC} (${pc(tOOC, tJudged)}); major ${tMajor} (${pc(tMajor, tJudged)})`);
console.log(`\nGenuine errors by MECHANISM (volume -> prioritization):`);
for (const [m, n] of Object.entries(byMech).sort((a, b) => b[1] - a[1])) console.log(`  ${m}: ${n} (${pc(n, tOOC)})`);
console.log(`\nGenuine errors by frame: ${JSON.stringify(byFrame)}`);
console.log(`\nPR1-fixable (uniqueness_fallback_model + specific anchor): ${pr1Fixable} (${pc(pr1Fixable, tOOC)} of genuine errors)`);
console.log(`\nVERBATIM control: ${vOOC}/${vJudged} flagged out_of_context (${pc(vOOC, vJudged)} rubber-stamp leak)`);
console.log(`\nFull scrubbed gold corpus (${gold.length} pairs) -> ${OUT}`);
