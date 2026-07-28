/**
 * Large-corpus test — PILOT (Joe 2026-07-28, STEP 1 of docs/large_corpus_test_spec.md).
 *
 * Samples N REAL inbound customer messages, runs the LIVE comprehension parser
 * (parseTurnUnderstandingWithLLM) through the current code, and reports a scorecard PLUS the MEASURED
 * runtime, LLM-call count, tokens, and REAL cost (read from the OpenAI usage log this run writes) — so
 * we can size the nightly-slice (~1,000) and monthly-full (5,000) runs from real numbers instead of a
 * guess. Read-only: no sends, no store writes. This is the harness the STEP-2 runs extend with the
 * trigger-net checks + the corpus-replay judge.
 *
 * Run (on the box, where the real corpus + key live):
 *   CONVERSATIONS_DB_PATH=/home/ubuntu/leadrider-runtime/americanharley/data/conversations.json \
 *   OPENAI_USAGE_LOG_PATH=/tmp/pilot_usage.jsonl LLM_ENABLED=1 npx tsx scripts/large_corpus_pilot.ts --n 200
 */
import fs from "node:fs";

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim().length < 20) {
  console.error("OPENAI_API_KEY missing; set a real key and re-run.");
  process.exit(1);
}
process.env.LLM_ENABLED = "1";
process.env.LLM_TURN_UNDERSTANDING_PARSER_ENABLED = "1";
// Isolate this run's usage accounting so we can sum REAL cost.
const usageLog = process.env.OPENAI_USAGE_LOG_PATH || "/tmp/pilot_usage.jsonl";
process.env.OPENAI_USAGE_LOG_PATH = usageLog;
try {
  fs.rmSync(usageLog, { force: true });
} catch {}

const argN = Number((process.argv.find(a => a.startsWith("--n="))?.split("=")[1]) ?? process.argv[process.argv.indexOf("--n") + 1]);
const N = Number.isFinite(argN) && argN > 0 ? Math.floor(argN) : 200;
const CONCURRENCY = Number(process.env.PILOT_CONCURRENCY ?? 8);
const convPath = process.env.CONVERSATIONS_DB_PATH || "services/api/data/conversations.json";

const { parseTurnUnderstandingWithLLM } = await import("../services/api/src/domain/llmDraft.ts");

// --- Sample real inbound customer messages (with lead + short history for context). ---
type Turn = { text: string; history: { direction: "in" | "out"; body: string }[]; lead: any };
function isJunkInbound(t: string): boolean {
  const s = t.trim();
  if (s.length < 2) return true;
  if (/^(ok|okay|k|thanks|thank you|thx|yes|no|yep|nope|👍|👌|sounds good)\.?$/i.test(s)) return true;
  if (/WEB LEAD \(ADF\)|WEB TEXT WIDGET|Call initiated to|Voicemail|voice mail|Agent:|forwarded to voice/i.test(s)) return true;
  // Voicemail / IVR / call-transcript system captures (not real customer messages) — surfaced as noise
  // in the pilot findings; exclude so they don't pollute the comprehension score.
  if (
    /thank you for calling|you'?ve reached|business office mailbox|party'?s extension|enter it at any time|press \d|at the tone|leave a (?:detailed )?message|call transcript|Customer: (?:Thank you|You'?ve reached|Your call)/i.test(
      s
    )
  ) {
    return true;
  }
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
  // Deterministic evenly-spaced sample (no Math.random — reproducible).
  if (xs.length <= n) return xs;
  const step = xs.length / n;
  const picked: T[] = [];
  for (let i = 0; i < n; i++) picked.push(xs[Math.floor(i * step)]);
  return picked;
}

async function pool<T, R>(items: T[], concurrency: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (idx < items.length) {
        const my = idx++;
        results[my] = await fn(items[my]);
      }
    })
  );
  return results;
}

function readUsage(): { calls: number; inputTokens: number; outputTokens: number; costUsd: number } {
  const acc = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  try {
    const lines = fs.readFileSync(usageLog, "utf8").split("\n").filter(Boolean);
    for (const ln of lines) {
      try {
        const r = JSON.parse(ln);
        acc.calls++;
        acc.inputTokens += Number(r.inputTokens ?? 0);
        acc.outputTokens += Number(r.outputTokens ?? 0);
        acc.costUsd += Number(r.estimatedCostUsd ?? 0);
      } catch {}
    }
  } catch {}
  return acc;
}

async function run() {
  const all = loadTurns();
  const turns = sample(all, N);
  console.log(`Large-corpus PILOT: ${turns.length} real inbound messages (from ${all.length} available) | concurrency ${CONCURRENCY}`);
  const started = Date.now();
  const reads = await pool(turns, CONCURRENCY, async t => {
    try {
      const r: any = await parseTurnUnderstandingWithLLM({ text: t.text, history: t.history, lead: t.lead });
      return { ok: !!r, intent: r?.primaryIntent ?? null, confidence: Number(r?.confidence ?? 0), text: t.text };
    } catch {
      return { ok: false, intent: null, confidence: 0, text: t.text };
    }
  });
  const elapsedMs = Date.now() - started;
  const usage = readUsage();

  const parsedOk = reads.filter(r => r.ok).length;
  const confident = reads.filter(r => r.ok && r.intent && r.intent !== "none" && r.confidence >= 0.7).length;
  const byIntent: Record<string, number> = {};
  for (const r of reads) if (r.ok && r.intent) byIntent[r.intent] = (byIntent[r.intent] ?? 0) + 1;

  const costPer = usage.costUsd / Math.max(1, turns.length);
  const secPer = elapsedMs / 1000 / Math.max(1, turns.length);
  const fmt$ = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

  console.log("\n=== PILOT SCORECARD ===");
  console.log(`messages:            ${turns.length}`);
  console.log(`parsed OK:           ${parsedOk}/${turns.length} (${((100 * parsedOk) / turns.length).toFixed(1)}%)`);
  console.log(`confident read:      ${confident}/${turns.length} (${((100 * confident) / turns.length).toFixed(1)}%)  [primaryIntent set, conf >= 0.7]`);
  console.log(`intent mix:          ${JSON.stringify(byIntent)}`);
  console.log("--- measured cost/runtime (comprehension pass, 1 LLM call/msg) ---");
  console.log(`LLM calls:           ${usage.calls}`);
  console.log(`tokens:              ${usage.inputTokens} in / ${usage.outputTokens} out`);
  console.log(`REAL cost:           ${fmt$(usage.costUsd)}  (${fmt$(costPer)}/msg)`);
  console.log(`runtime:             ${(elapsedMs / 1000).toFixed(1)}s  (${secPer.toFixed(2)}s/msg)`);
  console.log("--- extrapolation (comprehension pass only; the full run adds trigger checks + a judge, ~2-3x) ---");
  console.log(`nightly slice 1,000: ~${fmt$(costPer * 1000)}  ~${((secPer * 1000) / 60).toFixed(1)} min`);
  console.log(`monthly full 5,000:  ~${fmt$(costPer * 5000)}  ~${((secPer * 5000) / 60).toFixed(1)} min`);
  console.log("========================\n");

  // FINDINGS: the low-confidence / no-intent reads — candidate comprehension misses to eyeball
  // (many are correctly-uncertain small talk; the real fixes are clear messages read wrong).
  const findings = reads
    .filter(r => !r.ok || !r.intent || r.intent === "none" || r.confidence < 0.7)
    .sort((a, b) => a.confidence - b.confidence);
  console.log(`=== FINDINGS: ${findings.length} low-confidence/no-intent reads (candidate misses) ===`);
  for (const f of findings.slice(0, 40)) {
    console.log(`  [${f.intent ?? "PARSE_FAIL"} @${f.confidence.toFixed(2)}] ${String(f.text).replace(/\s+/g, " ").slice(0, 130)}`);
  }
  const findingsPath = process.env.PILOT_FINDINGS_PATH || "/tmp/pilot_findings.jsonl";
  try {
    fs.writeFileSync(findingsPath, findings.map(f => JSON.stringify({ intent: f.intent, confidence: f.confidence, text: f.text })).join("\n") + "\n");
    console.log(`\n(full findings written to ${findingsPath})`);
  } catch {}
}

await run();
