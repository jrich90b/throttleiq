/**
 * Model-deflection fixture harvest (read-only) for PR1 "answer-don't-deflect: model-known case".
 * Splits production drafts on the PR1 axis, PII-scrubbed:
 *   FAILURE (pillar 2): the draft ASKS for the model ("which model?", "the exact bike you want")
 *                       while the anchor ALREADY HAS a model-of-record -> the bug (asked despite knowing).
 *   SATISFIED (pillar 1): draft asks for the model but anchor has NO model -> CORRECT deflection (keep);
 *                         plus drafts that referenced the anchor model -> correct answers (keep).
 * Pillars 3 (edge) + 4 (adversarial) are hand-authored separately.
 *
 * Run on the box:
 *   CONVERSATIONS_DB_PATH=... npx tsx scripts/model_deflection_harvest.ts
 */
import fs from "node:fs";

const PATH = process.env.CONVERSATIONS_DB_PATH || "data/conversations.json";

type Msg = { direction?: string; body?: string; provider?: string };
type Conv = { id?: string; leadKey?: string; lead?: any; classification?: any; appointment?: any; dialogState?: any; messages?: Msg[] };

function load(p: string): Conv[] {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.conversations)) return raw.conversations;
  if (raw && typeof raw === "object") return Object.values(raw) as Conv[];
  return [];
}

// --- PII scrub: redact phones, emails, and ADF Name/Email/Phone field lines. ---
function scrub(s: string): string {
  return String(s ?? "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[EMAIL]")
    .replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[PHONE]")
    .replace(/\b\d{10,}\b/g, "[PHONE]")
    .replace(/^(Name|Email|Phone|Customer|Contact)\s*:.*$/gim, "$1: [REDACTED]")
    .trim();
}

const ASKS_FOR_MODEL = /which\s+(?:\w+\s+)?model|what\s+(?:\w+\s+)?model|exact bike you (?:want|wanted)|model are you (?:interested|looking|leaning)|which\s+(?:bike|unit)\s+(?:are|were) you/i;
const REFERENCES_MODEL = (draft: string, model: string) => model.length > 2 && new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(draft);

const isSent = (m: Msg) => m.direction === "out" && (m.provider === "human" || m.provider === "twilio" || m.provider === "sendgrid");

type Row = { id: string; anchorModel: string; customer: string; draft: string; humanSent: string | null };
const failures: Row[] = []; // asks for model AND anchor has a model (the bug)
const correctDeflect: Row[] = []; // asks for model AND anchor has NO model (keep)
const correctAnswer: Row[] = []; // references the anchor model (keep)
let totalDraftsWithModelAsk = 0;
let n = 0;

for (const conv of load(PATH)) {
  n++;
  const msgs = (conv.messages ?? []).filter(m => m && (m.direction === "in" || m.direction === "out"));
  const anchorModel = String(conv?.lead?.vehicle?.model ?? conv?.lead?.vehicle?.description ?? "").trim();
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.provider !== "draft_ai" || m.direction !== "out") continue;
    const draft = String(m.body ?? "").trim();
    if (!draft) continue;
    let customer = "";
    for (let p = i - 1; p >= 0; p--) {
      if (msgs[p].direction === "in" && String(msgs[p].body ?? "").trim()) { customer = String(msgs[p].body).trim(); break; }
    }
    let humanSent: string | null = null;
    for (let k = i + 1; k < msgs.length; k++) {
      if (msgs[k].direction === "in") break;
      if (isSent(msgs[k])) { humanSent = String(msgs[k].body ?? "").trim(); break; }
    }
    const id = `lead_${n}`;
    const asks = ASKS_FOR_MODEL.test(draft);
    if (asks) {
      totalDraftsWithModelAsk++;
      const row: Row = { id, anchorModel: scrub(anchorModel), customer: scrub(customer).slice(0, 180), draft: scrub(draft).slice(0, 200), humanSent: humanSent ? scrub(humanSent).slice(0, 200) : null };
      if (anchorModel) failures.push(row);
      else correctDeflect.push(row);
    } else if (anchorModel && REFERENCES_MODEL(draft, anchorModel)) {
      correctAnswer.push({ id, anchorModel: scrub(anchorModel), customer: scrub(customer).slice(0, 140), draft: scrub(draft).slice(0, 160), humanSent: null });
    }
  }
}

const pick = <T,>(a: T[], k: number) => { const s = Math.max(1, Math.floor(a.length / k)); return a.filter((_, i) => i % s === 0).slice(0, k); };
console.log(`\n===== Model-deflection harvest (PII-scrubbed) =====`);
console.log(`Drafts that ASK for the model: ${totalDraftsWithModelAsk}`);
console.log(`  FAILURE (asked despite anchor HAVING a model)  [pillar 2, fix]:     ${failures.length}`);
console.log(`  SATISFIED-deflect (asked, anchor has NO model) [pillar 1, keep]:    ${correctDeflect.length}`);
console.log(`  SATISFIED-answer (draft references anchor model)[pillar 1, keep]:   ${correctAnswer.length}`);
console.log(`\n--- pillar 2 FAILURE samples (asked despite knowing the model) ---`);
for (const r of pick(failures, 10)) {
  console.log(`\n  [${r.id}] anchorModel="${r.anchorModel}"`);
  console.log(`   customer:   ${r.customer}`);
  console.log(`   agent(bug): ${r.draft}`);
  if (r.humanSent) console.log(`   human:      ${r.humanSent}`);
}
console.log(`\n--- pillar 1 SATISFIED-deflect samples (NO anchor model -> asking is CORRECT, must keep) ---`);
for (const r of pick(correctDeflect, 6)) {
  console.log(`\n  [${r.id}] anchorModel="(none)"`);
  console.log(`   customer: ${r.customer}`);
  console.log(`   agent(ok):${r.draft}`);
}
