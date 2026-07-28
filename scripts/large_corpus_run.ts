/**
 * Large-corpus test — STEP 2 runner (Joe 2026-07-28; docs/large_corpus_test_spec.md).
 *
 * The periodic health run: sample N real inbound messages, run the LIVE comprehension parser, then
 * JUDGE the low-confidence reads (an intent-verdict LLM judge) so raw uncertainty doesn't over-report —
 * only judge-CONFIRMED "miss"es count. Emits a tracked SCORECARD (comprehension %, confirmed-miss rate,
 * cost) + a BASELINE DIFF vs the previous run (regressions pop). Read-only: no sends, no store writes.
 *
 * Modes:  --mode nightly (default, N=1000)  |  --mode full (N=5000)  |  --n <count> to override.
 * Run (on the box):
 *   CONVERSATIONS_DB_PATH=.../conversations.json OPENAI_USAGE_LOG_PATH=/tmp/lc_usage.jsonl \
 *   LARGE_CORPUS_REPORT_DIR=.../reports/large_corpus LLM_ENABLED=1 npx tsx scripts/large_corpus_run.ts --mode nightly
 */
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim().length < 20) {
  console.error("OPENAI_API_KEY missing; set a real key and re-run.");
  process.exit(1);
}
process.env.LLM_ENABLED = "1";
process.env.LLM_TURN_UNDERSTANDING_PARSER_ENABLED = "1";
const usageLog = process.env.OPENAI_USAGE_LOG_PATH || "/tmp/lc_usage.jsonl";
process.env.OPENAI_USAGE_LOG_PATH = usageLog;
try {
  fs.rmSync(usageLog, { force: true });
} catch {}

const arg = (k: string) => {
  const eq = process.argv.find(a => a.startsWith(`${k}=`))?.split("=")[1];
  if (eq !== undefined) return eq;
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const mode = (arg("--mode") ?? "nightly").toLowerCase();
const N = Number(arg("--n") ?? (mode === "full" ? 5000 : 1000));
const CONCURRENCY = Number(process.env.LARGE_CORPUS_CONCURRENCY ?? 8);
const JUDGE_CAP = Number(process.env.LARGE_CORPUS_JUDGE_CAP ?? 120); // cap judge calls (cost) on the candidates
const convPath = process.env.CONVERSATIONS_DB_PATH || "services/api/data/conversations.json";
const reportDir = process.env.LARGE_CORPUS_REPORT_DIR || "reports/large_corpus";
const runAt = process.env.LARGE_CORPUS_RUN_AT || new Date().toISOString();

const { parseTurnUnderstandingWithLLM } = await import("../services/api/src/domain/llmDraft.ts");
const openai = new OpenAI({ apiKey });
const judgeModel = process.env.OPENAI_MODEL || "gpt-5-mini";

// --- corpus sampling (shared shape with the pilot) ---
type Turn = { text: string; history: { direction: "in" | "out"; body: string }[]; lead: any };
function isJunkInbound(t: string): boolean {
  const s = t.trim();
  if (s.length < 2) return true;
  if (/^(ok|okay|k|thanks|thank you|thx|yes|no|yep|nope|👍|👌|sounds good)\.?$/i.test(s)) return true;
  if (/WEB LEAD \(ADF\)|WEB TEXT WIDGET|Call initiated to|Voicemail|voice mail|Agent:|forwarded to voice/i.test(s)) return true;
  if (/thank you for calling|you'?ve reached|business office mailbox|party'?s extension|enter it at any time|press \d|at the tone|leave a (?:detailed )?message|call transcript|Customer: (?:Thank you|You'?ve reached|Your call)/i.test(s)) return true;
  return false;
}
function loadTurns(): Turn[] {
  const raw = JSON.parse(fs.readFileSync(convPath, "utf8"));
  const arr: any[] = Array.isArray(raw) ? raw : raw.conversations ?? Object.values(raw);
  const out: Turn[] = [];
  for (const c of arr) {
    const msgs: any[] = Array.isArray(c?.messages) ? c.messages : [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const dir = String(m?.direction ?? m?.role ?? "");
      const text = String(m?.text ?? m?.body ?? "").trim();
      if (dir !== "in" || isJunkInbound(text)) continue;
      const history = msgs
        .slice(Math.max(0, i - 6), i)
        .map(h => ({ direction: (String(h?.direction ?? "") === "in" ? "in" : "out") as "in" | "out", body: String(h?.text ?? h?.body ?? "") }))
        .filter(h => h.body.trim());
      out.push({ text, history, lead: c?.lead ?? null });
    }
  }
  return out;
}
function sample<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  const step = xs.length / n;
  const picked: T[] = [];
  for (let i = 0; i < n; i++) picked.push(xs[Math.floor(i * step)]);
  return picked;
}
async function pool<T, R>(items: T[], concurrency: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) || 1 }, async () => {
      while (idx < items.length) {
        const my = idx++;
        results[my] = await fn(items[my], my);
      }
    })
  );
  return results;
}
function readCost(): { calls: number; costUsd: number } {
  const acc = { calls: 0, costUsd: 0 };
  try {
    for (const ln of fs.readFileSync(usageLog, "utf8").split("\n").filter(Boolean)) {
      try {
        const r = JSON.parse(ln);
        acc.calls++;
        acc.costUsd += Number(r.estimatedCostUsd ?? 0);
      } catch {}
    }
  } catch {}
  return acc;
}

// --- the intent-verdict judge (only on low-confidence candidates; caps cost) ---
async function judge(t: Turn, read: { intent: string | null; confidence: number }): Promise<{ verdict: string; correctIntent: string; reason: string } | null> {
  const hist = t.history.slice(-4).map(h => `${h.direction}: ${h.body}`).join("\n");
  const prompt = [
    "You audit a Harley-Davidson dealership's intent reader. Given the customer's latest text (and recent",
    "thread), decide whether the system's PRIMARY-INTENT read is CORRECT, a real MISS, or genuinely AMBIGUOUS.",
    "Intents: pricing, scheduling, callback, availability, finance, trade, test_ride, service, parts, optout, smalltalk, other, none.",
    "MISS only when a CLEAR intent was read wrong or dropped. A vague fragment/one-word reply that no human",
    "could confidently route is AMBIGUOUS, not a miss. A correct low-confidence read is CORRECT.",
    "",
    hist ? `Recent thread:\n${hist}` : "Recent thread: (none)",
    `Customer text: ${t.text}`,
    `System read: primaryIntent=${read.intent ?? "none"} (confidence ${read.confidence.toFixed(2)})`,
    "",
    'Return only JSON: {"verdict":"correct|miss|ambiguous","correctIntent":"<the right intent>","reason":"<short>"}'
  ].join("\n");
  try {
    const resp = await openai.responses.create({
      model: judgeModel,
      input: prompt,
      // gpt-5 models are reasoning models — without minimal effort the reasoning eats the output budget
      // and the response comes back empty (mirrors the parsers' optionalReasoning).
      ...(/^gpt-5/i.test(judgeModel) ? { reasoning: { effort: "minimal" as const } } : {}),
      max_output_tokens: 400,
      text: {
        format: {
          type: "json_schema",
          name: "intent_verdict",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["verdict", "correctIntent", "reason"],
            properties: {
              verdict: { type: "string", enum: ["correct", "miss", "ambiguous"] },
              correctIntent: { type: "string" },
              reason: { type: "string" }
            }
          }
        }
      }
    });
    const parsed = (resp as any).output_parsed ?? JSON.parse((resp as any).output_text ?? "{}");
    return parsed?.verdict ? parsed : null;
  } catch {
    return null;
  }
}

async function run() {
  const all = loadTurns();
  const turns = sample(all, N);
  console.log(`Large-corpus run [${mode}]: ${turns.length} real messages (of ${all.length}) | concurrency ${CONCURRENCY} | judge cap ${JUDGE_CAP}`);
  const started = Date.now();
  const reads = await pool(turns, CONCURRENCY, async t => {
    try {
      const r: any = await parseTurnUnderstandingWithLLM({ text: t.text, history: t.history, lead: t.lead });
      return { ok: !!r, intent: r?.primaryIntent ?? null, confidence: Number(r?.confidence ?? 0), turn: t };
    } catch {
      return { ok: false, intent: null, confidence: 0, turn: t };
    }
  });

  const confident = reads.filter(r => r.ok && r.intent && r.intent !== "none" && r.confidence >= 0.7).length;
  const byIntent: Record<string, number> = {};
  for (const r of reads) if (r.ok && r.intent) byIntent[r.intent] = (byIntent[r.intent] ?? 0) + 1;

  // Judge the low-confidence candidates (capped) → confirmed misses only.
  const candidates = reads.filter(r => !r.ok || !r.intent || r.intent === "none" || r.confidence < 0.7);
  const judged = sample(candidates, JUDGE_CAP);
  const verdicts = await pool(judged, CONCURRENCY, async r => ({ r, v: await judge(r.turn, { intent: r.intent, confidence: r.confidence }) }));
  const confirmedMisses = verdicts.filter(x => x.v?.verdict === "miss");
  const judgedCount = verdicts.filter(x => x.v).length;
  // Extrapolate the confirmed-miss rate from the judged sample to all candidates.
  const missRateInCandidates = judgedCount ? confirmedMisses.length / judgedCount : 0;
  const estConfirmedMisses = Math.round(missRateInCandidates * candidates.length);

  const elapsedMs = Date.now() - started;
  const cost = readCost();
  const scorecard = {
    at: runAt,
    mode,
    messages: turns.length,
    corpusAvailable: all.length,
    comprehensionConfidentPct: +((100 * confident) / turns.length).toFixed(1),
    candidateLowConfidence: candidates.length,
    judged: judgedCount,
    confirmedMissesInSample: confirmedMisses.length,
    confirmedMissRatePct: +(100 * missRateInCandidates).toFixed(1),
    estConfirmedMissesTotal: estConfirmedMisses,
    intentMix: byIntent,
    costUsd: +cost.costUsd.toFixed(4),
    llmCalls: cost.calls,
    runtimeSec: +(elapsedMs / 1000).toFixed(1),
    topMisses: confirmedMisses.slice(0, 15).map(x => ({ text: String(x.r.turn.text).replace(/\s+/g, " ").slice(0, 140), read: x.r.intent, shouldBe: x.v?.correctIntent, reason: x.v?.reason }))
  };

  // Baseline diff vs the most recent prior scorecard.
  fs.mkdirSync(reportDir, { recursive: true });
  const priors = fs
    .readdirSync(reportDir)
    .filter(f => /^large_corpus_.*\.json$/.test(f))
    .sort();
  const baseline = priors.length ? JSON.parse(fs.readFileSync(path.join(reportDir, priors[priors.length - 1]), "utf8")) : null;
  const diff = baseline
    ? {
        comprehensionDelta: +(scorecard.comprehensionConfidentPct - baseline.comprehensionConfidentPct).toFixed(1),
        confirmedMissRateDelta: +(scorecard.confirmedMissRatePct - (baseline.confirmedMissRatePct ?? 0)).toFixed(1),
        regression: scorecard.comprehensionConfidentPct < baseline.comprehensionConfidentPct - 3 || scorecard.confirmedMissRatePct > (baseline.confirmedMissRatePct ?? 0) + 3
      }
    : null;

  const outFile = path.join(reportDir, `large_corpus_${runAt.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ ...scorecard, baselineDiff: diff }, null, 2));

  console.log("\n=== LARGE-CORPUS SCORECARD ===");
  console.log(`comprehension confident: ${scorecard.comprehensionConfidentPct}%`);
  console.log(`low-confidence candidates: ${scorecard.candidateLowConfidence} | judged ${judgedCount} => ${confirmedMisses.length} confirmed miss (${scorecard.confirmedMissRatePct}% of candidates, ~${estConfirmedMisses} across all)`);
  console.log(`intent mix: ${JSON.stringify(byIntent)}`);
  console.log(`cost: $${scorecard.costUsd} | ${cost.calls} calls | ${scorecard.runtimeSec}s`);
  if (diff) console.log(`baseline diff: comprehension ${diff.comprehensionDelta >= 0 ? "+" : ""}${diff.comprehensionDelta}pp | miss-rate ${diff.confirmedMissRateDelta >= 0 ? "+" : ""}${diff.confirmedMissRateDelta}pp | REGRESSION=${diff.regression}`);
  else console.log("baseline diff: (first run — no baseline)");
  console.log("--- top confirmed misses ---");
  for (const m of scorecard.topMisses) console.log(`  [${m.read} -> ${m.shouldBe}] ${m.text}  (${m.reason})`);
  console.log(`\n(scorecard written to ${outFile})`);
}

await run();
