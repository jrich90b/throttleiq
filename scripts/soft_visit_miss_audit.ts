/**
 * Soft-visit-miss audit — catches the blind spot the other routines miss.
 *
 * A customer commits to coming in on a day/event ("Ok I will be there for the taste of
 * country pre party on Saturday") but the system never set the soft-visit cadence window
 * (conv.scheduleSoft is null) — so the lead stays on a generic cadence and nobody knows the
 * soft-visit detection missed. The intent_handled judge can't see this: when staff override
 * the weak draft (Stone -> "awesome!" for Todd Herian Ref 11438), the miss leaves no trace,
 * and an active-cadence lead never looks stuck. This audit judges the STATE — "the customer
 * committed to a visit but we didn't handle it" — independent of the draft outcome, so a
 * novel soft-visit phrasing the parser misses surfaces as a parser-fixture candidate instead
 * of slipping silently (the reservation/[[reservation-intent-and-detection-gap]] class).
 *
 * Deterministic ci:eval gate via `--self-test` (pure scaffolding + a stub judge, no network).
 * Real run uses an LLM judge against the live store.
 *
 *   npx tsx scripts/soft_visit_miss_audit.ts --self-test
 *   DATA_DIR=... npx tsx scripts/soft_visit_miss_audit.ts [--since-hours N] [--max N]
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CUST_IN = new Set(["twilio", "web_widget"]);

// CANDIDATE PRE-FILTER ONLY (not an intent decision — the LLM judge is authoritative). Kept
// broad so a real commitment is never pre-dropped; precision comes from the judge.
const VISIT_HINT =
  /\b(be there|i'?ll be|we'?ll be|stop(?:ping)? by|swing by|see you|coming in|come in|come down|head (?:over|down)|saturday|sunday|monday|tuesday|wednesday|thursday|friday|tomorrow|this (?:weekend|sat|sun|mon|tue|wed|thu|fri))\b/i;

export type SoftVisitCandidate = { convId: string; leadKey: string; name: string; at: string; inboundText: string };
export type SoftVisitVerdict = { isVisitCommitment: boolean; day: string; why: string };
export type SoftVisitFinding = SoftVisitCandidate & { verdict: SoftVisitVerdict };
export type JudgeFn = (c: SoftVisitCandidate) => Promise<SoftVisitVerdict | null>;

function msgTime(m: any): number { const t = Date.parse(String(m?.at ?? "")); return Number.isFinite(t) ? t : 0; }

// Candidate = OPEN conv, NO soft-visit state yet (scheduleSoft null), NO booked appointment,
// and a recent customer inbound that looks visit-ish (pre-filter). The judge confirms intent.
export function selectSoftVisitMissCandidates(
  convs: any[],
  opts: { windowStartMs: number; maxCandidates?: number }
): { candidates: SoftVisitCandidate[]; eligibleTotal: number } {
  const max = opts.maxCandidates ?? 150;
  const out: SoftVisitCandidate[] = [];
  let eligibleTotal = 0;
  for (const c of convs ?? []) {
    if (c?.closedAt || c?.closedReason || c?.sale?.soldAt) continue;
    if (c?.scheduleSoft) continue; // already handled as a soft visit
    if (c?.appointment?.bookedEventId) continue; // a real appointment supersedes
    const msgs: any[] = Array.isArray(c?.messages) ? c.messages : [];
    let hit: any = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.direction !== "in" || !CUST_IN.has(m?.provider)) continue;
      if (msgTime(m) < opts.windowStartMs) break;
      const body = String(m?.body ?? "").trim();
      if (body && VISIT_HINT.test(body)) { hit = m; break; }
    }
    if (!hit) continue;
    eligibleTotal++;
    const lead = c?.lead ?? {};
    out.push({
      convId: String(c?.id ?? ""),
      leadKey: String(c?.leadKey ?? ""),
      name: [lead.firstName, lead.lastName].map((v: any) => String(v ?? "").trim()).filter(Boolean).join(" ") || String(c?.id ?? ""),
      at: String(hit?.at ?? ""),
      inboundText: String(hit?.body ?? "").trim()
    });
  }
  if (out.length <= max) return { candidates: out, eligibleTotal };
  const step = out.length / max;
  const sampled: SoftVisitCandidate[] = [];
  for (let i = 0; i < max; i++) sampled.push(out[Math.floor(i * step)]);
  return { candidates: sampled, eligibleTotal };
}

export function buildSoftVisitJudgePrompt(c: SoftVisitCandidate): string {
  return [
    "You QA a Harley dealership text agent. Decide if the customer's message is a SOFT VISIT",
    "COMMITMENT: they state they WILL come in / stop by on a specific day or at an event, WITHOUT",
    "booking an exact appointment time. ARE commitments: 'Ok I will be there Saturday', 'I'll swing",
    "by this weekend', 'see you Sunday', 'coming in tomorrow to look'. NOT commitments: a question",
    "('are you open Saturday?'), a tentative maybe ('might come by'), a decline ('can't make it'), a",
    "PAST visit ('I came in yesterday'), or an immediate arrival ('be there in 10 min').",
    "",
    `Customer message: ${c.inboundText}`,
    "",
    'Return JSON: is_visit_commitment (bool), day (the day/event committed to, or ""), why (one line).'
  ].join("\n");
}

export function summarizeFindings(findings: SoftVisitFinding[]) {
  const misses = findings.filter(f => f.verdict.isVisitCommitment);
  return { total: misses.length, convsAffected: new Set(misses.map(f => f.convId)).size };
}

const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_visit_commitment", "day", "why"],
  properties: { is_visit_commitment: { type: "boolean" }, day: { type: "string" }, why: { type: "string" } }
} as const;

async function realJudge(c: SoftVisitCandidate): Promise<SoftVisitVerdict | null> {
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const reasoning = /^gpt-5/i.test(model) ? { reasoning: { effort: "minimal" as const } } : {};
  try {
    const resp: any = await client.responses.parse({
      model,
      input: buildSoftVisitJudgePrompt(c),
      ...reasoning,
      max_output_tokens: 500,
      text: { format: { type: "json_schema", name: "soft_visit_miss_judge", schema: JUDGE_SCHEMA, strict: true } }
    });
    const p = resp?.output_parsed;
    if (!p || typeof p !== "object") return null;
    return { isVisitCommitment: !!p.is_visit_commitment, day: String(p.day ?? ""), why: String(p.why ?? "") };
  } catch (err: any) {
    console.warn("[soft-visit-miss] judge failed:", err?.message ?? err);
    return null;
  }
}

export async function runSoftVisitMissAudit(
  convs: any[],
  opts: { windowStartMs: number; maxCandidates: number; judge: JudgeFn }
): Promise<{ findings: SoftVisitFinding[]; eligibleTotal: number; capped: boolean }> {
  const { candidates, eligibleTotal } = selectSoftVisitMissCandidates(convs, {
    windowStartMs: opts.windowStartMs,
    maxCandidates: opts.maxCandidates
  });
  const findings: SoftVisitFinding[] = [];
  for (const c of candidates) {
    const verdict = await opts.judge(c);
    if (verdict && verdict.isVisitCommitment) findings.push({ ...c, verdict });
  }
  return { findings, eligibleTotal, capped: eligibleTotal > candidates.length };
}

function selfTest() {
  const assert = (cond: boolean, label: string) => { if (!cond) { console.error(`SELF-TEST FAIL: ${label}`); process.exit(1); } };
  const base = "2026-06-15T12:00:00.000Z";
  const t = (m: number) => new Date(Date.parse(base) + m * 60000).toISOString();
  const convs = [
    { id: "todd", leadKey: "+15673079691", lead: { firstName: "Todd" }, messages: [
      { direction: "in", provider: "twilio", at: t(0), body: "Ok I will be there for the taste of country pre party on Saturday" }
    ] }, // MISS: committed, scheduleSoft null
    { id: "handled", leadKey: "+1", lead: { firstName: "A" }, scheduleSoft: { windowLabel: "Saturday" }, messages: [
      { direction: "in", provider: "twilio", at: t(0), body: "I'll be there Saturday" }
    ] }, // already handled -> not a candidate
    { id: "question", leadKey: "+2", lead: { firstName: "B" }, messages: [
      { direction: "in", provider: "twilio", at: t(0), body: "are you open Saturday?" }
    ] }, // visit-ish hint but the judge will say not a commitment -> not a miss
    { id: "booked", leadKey: "+3", lead: { firstName: "C" }, appointment: { bookedEventId: "evt" }, messages: [
      { direction: "in", provider: "twilio", at: t(0), body: "see you Saturday" }
    ] }, // booked appt supersedes -> not a candidate
    { id: "nohint", leadKey: "+4", lead: { firstName: "D" }, messages: [
      { direction: "in", provider: "twilio", at: t(0), body: "whats the price on the road glide" }
    ] } // no visit hint -> not a candidate
  ];
  const { candidates, eligibleTotal } = selectSoftVisitMissCandidates(convs, { windowStartMs: Date.parse(base) - 1000 });
  const ids = candidates.map(c => c.convId).sort();
  assert(JSON.stringify(ids) === JSON.stringify(["question", "todd"]), `candidates should be [question, todd], got ${JSON.stringify(ids)}`);
  assert(eligibleTotal === 2, `eligibleTotal should be 2, got ${eligibleTotal}`);
  assert(buildSoftVisitJudgePrompt(candidates.find(c => c.convId === "todd")!).includes("taste of country"), "prompt carries the inbound");

  // Stub judge: a non-question commitment is flagged; the question is not.
  const stubJudge: JudgeFn = async c => ({
    isVisitCommitment: /will be there|i'?ll be|see you|coming in/i.test(c.inboundText) && !c.inboundText.trim().endsWith("?"),
    day: "saturday",
    why: "stub"
  });
  return { candidates, stubJudge };
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (n: string, fb: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : fb; };
  if (argv.includes("--self-test")) {
    const { candidates, stubJudge } = selfTest();
    const findings: SoftVisitFinding[] = [];
    for (const c of candidates) { const v = await stubJudge(c); if (v && v.isVisitCommitment) findings.push({ ...c, verdict: v }); }
    const s = summarizeFindings(findings);
    if (!(s.total === 1 && findings.length === 1 && findings[0].convId === "todd")) {
      console.error("SELF-TEST FAIL: stub run should flag exactly todd, got", JSON.stringify(findings.map(f => f.convId)));
      process.exit(1);
    }
    console.log("PASS soft-visit-miss audit self-test");
    return;
  }
  const conversationsPath =
    arg("--conversations", "") ||
    process.env.CONVERSATIONS_DB_PATH ||
    (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "conversations.json") : path.resolve(process.cwd(), "services", "api", "data", "conversations.json"));
  if (!fs.existsSync(conversationsPath)) { console.error(`Conversations file not found: ${conversationsPath}`); process.exit(1); }
  const raw = JSON.parse(fs.readFileSync(conversationsPath, "utf8"));
  const convs: any[] = Array.isArray(raw?.conversations) ? raw.conversations : Array.isArray(raw) ? raw : [];
  const sinceHours = Number(arg("--since-hours", process.env.SOFT_VISIT_MISS_SINCE_HOURS || "168")) || 168;
  const windowStartMs = Date.now() - sinceHours * 3600_000;
  const maxCandidates = Number(arg("--max", "150")) || 150;
  const outDir = arg("--out-dir", "") || process.env.SOFT_VISIT_MISS_OUT_DIR || path.resolve(process.cwd(), "reports", "soft_visit_miss");
  const { findings, eligibleTotal, capped } = await runSoftVisitMissAudit(convs, { windowStartMs, maxCandidates, judge: realJudge });
  const summary = summarizeFindings(findings);
  const report = { generatedAt: new Date().toISOString(), source: { conversationsPath, sinceHours, eligibleTotal, capped }, summary, findings };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "soft_visit_miss_summary.json"), JSON.stringify({ ...report, findings: undefined }, null, 2));
  fs.writeFileSync(path.join(outDir, "soft_visit_miss_findings.json"), JSON.stringify(report, null, 2));
  console.log(`soft-visit-miss audit: ${summary.total} missed soft-visit commitment(s) across ${summary.convsAffected} conv(s) (eligible ${eligibleTotal}); report at ${outDir}`);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) main();
