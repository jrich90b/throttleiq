/**
 * Turn-Understanding shadow BACKFILL (2026-06-15) — a "larger shadow run" without
 * waiting for live traffic.
 *
 * The live shadow only sees real-time turns (~25 in 3 days). This batch-replays the
 * consolidated understanding pass (parseTurnUnderstandingWithLLM) over HISTORICAL
 * customer turns in the store and measures, at scale, how often it resolves
 * something the deterministic layer would miss — i.e. the whack-a-mole rate,
 * quantified. Analysis tool, read-only, no sends/no store writes.
 *
 * Faithful baseline (no index.ts deps, so no collision with concurrent work):
 *   - MODEL: for each model the LLM extracts, ask catalogModelMentionMatchesText
 *     (the real catalog matcher) whether it's textually present. If NOT, the LLM
 *     resolved it from spelling/context — a deterministic miss (the mole).
 *   - SCHEDULE: parseRequestedDayTime/parseRequestedDateOnly (the real parsers).
 *   - OWNED bike: the deterministic layer has none; any LLM owned/trade surface is
 *     net-new context (precision caveat: can fire on bare acks — reported separately).
 *
 * Usage:
 *   LLM_ENABLED=1 LLM_TURN_UNDERSTANDING_PARSER_ENABLED=1 \
 *     npx tsx scripts/turn_understanding_shadow_backfill.ts [--conversations P] [--max N] [--concurrency K]
 */
import fs from "node:fs";
import path from "node:path";

import OpenAI from "openai";

import { parseTurnUnderstandingWithLLM } from "../services/api/src/domain/llmDraft.ts";
import { catalogModelMentionMatchesText } from "../services/api/src/domain/workflowRegressionGuards.ts";
import { parseRequestedDateOnly, parseRequestedDayTime } from "../services/api/src/domain/conversationStore.ts";

const CUST_IN = new Set(["twilio", "web_widget"]);

function arg(name: string, fb: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fb;
}

function detSchedulePresent(text: string): boolean {
  const t = text.toLowerCase();
  try {
    if (parseRequestedDayTime(t, "America/New_York")) return true;
    if (parseRequestedDateOnly(t, "America/New_York")) return true;
  } catch {
    /* ignore */
  }
  return false;
}

// --judge: label each disagreement as a GENUINE win vs context-attachment noise.
// "Net win" = the LLM's extraction is correct AND relevant to THIS turn (not a
// stale model pulled from the thread onto a bare ack). Converts the gross
// disagreement rate into the actionable consolidation win.
const judgeClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["correct", "relevant", "why"],
  properties: {
    correct: { type: "boolean" },
    relevant: { type: "boolean" },
    why: { type: "string" }
  }
} as const;

async function judgeMole(
  turn: { text: string; history: { direction: "in" | "out"; body: string }[] },
  extracted: { models: string[]; owned: string | null; scheduleDay: string | null }
): Promise<{ correct: boolean; relevant: boolean } | null> {
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const reasoning = /^gpt-5/i.test(model) ? { reasoning: { effort: "minimal" as const } } : {};
  const hist = turn.history.slice(-6).map(h => `${h.direction === "in" ? "Customer" : "Agent"}: ${h.body.replace(/\s+/g, " ").trim()}`).join("\n");
  const prompt = [
    "You QA an NLU extraction for a Harley dealership text agent. Decide if the extraction is",
    "CORRECT (matches what the customer actually means) and RELEVANT to acting on THEIR LATEST",
    "message specifically. A model pulled from earlier in the thread onto a turn that doesn't",
    "need one (e.g. 'okay nice', 'thank you') is correct-context but NOT relevant (relevant=false).",
    "A slang/shorthand/typo model the customer named on this turn ('23 lrs', '21 SGS', 'tri glide')",
    "is correct AND relevant. An owned/trade bike correctly separated from a requested one is correct.",
    "",
    hist ? `Conversation so far:\n${hist}` : "Conversation so far: (none)",
    `Customer's latest message: ${turn.text}`,
    `Extracted -> requested models: ${JSON.stringify(extracted.models)}; owned/trade: ${extracted.owned ?? "none"}; schedule day: ${extracted.scheduleDay ?? "none"}`,
    "",
    "Return JSON: correct (bool), relevant (bool, is this extraction needed to act on the latest message), why (one line)."
  ].join("\n");
  try {
    const resp: any = await judgeClient.responses.parse({
      model,
      input: prompt,
      ...reasoning,
      max_output_tokens: 500,
      text: { format: { type: "json_schema", name: "mole_correctness", schema: JUDGE_SCHEMA, strict: true } }
    });
    const p = resp?.output_parsed;
    if (!p) return null;
    return { correct: !!p.correct, relevant: !!p.relevant };
  } catch {
    return null;
  }
}

type Turn = { convId: string; leadKey: string; text: string; history: { direction: "in" | "out"; body: string }[]; lead: any };

function collectTurns(convs: any[], max: number): Turn[] {
  const out: Turn[] = [];
  for (const conv of convs) {
    const msgs = (conv?.messages ?? []).filter((m: any) => String(m?.body ?? "").trim());
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m?.direction !== "in" || !CUST_IN.has(m?.provider)) continue;
      const text = String(m.body).trim();
      if (text.split(/\s+/).length < 2) continue; // skip bare one-word acks for signal density
      const history = msgs
        .slice(Math.max(0, i - 10), i)
        .map((h: any) => ({ direction: h.direction === "in" ? "in" : "out", body: String(h.body ?? "") }));
      out.push({ convId: String(conv?.id ?? ""), leadKey: String(conv?.leadKey ?? ""), text, history, lead: conv?.lead });
    }
  }
  // even sampling across the corpus when capped
  if (out.length <= max) return out;
  const step = out.length / max;
  const sampled: Turn[] = [];
  for (let i = 0; i < max; i++) sampled.push(out[Math.floor(i * step)]);
  return sampled;
}

async function pool<T, R>(items: T[], k: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const res: R[] = new Array(items.length);
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(k, items.length) }, async () => {
      while (idx < items.length) {
        const cur = idx++;
        res[cur] = await fn(items[cur]);
      }
    })
  );
  return res;
}

async function main() {
  const conversationsPath =
    arg("--conversations", "") ||
    process.env.CONVERSATIONS_DB_PATH ||
    (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "conversations.json") : path.resolve(process.cwd(), "services", "api", "data", "conversations.json"));
  const max = Number(arg("--max", "300")) || 300;
  const concurrency = Number(arg("--concurrency", "8")) || 8;
  const JUDGE = process.argv.includes("--judge");
  const outDir = arg("--out-dir", "") || path.resolve(process.cwd(), "reports", "turn_understanding_shadow");

  const raw = JSON.parse(fs.readFileSync(conversationsPath, "utf8"));
  const convs: any[] = Array.isArray(raw?.conversations) ? raw.conversations : [];
  const turns = collectTurns(convs, max);
  console.log(`[backfill] ${turns.length} turns selected (concurrency ${concurrency}); calling the understanding pass...`);

  let processed = 0, parserNull = 0;
  let modelResolvedFromContext = 0, ownedSurfaced = 0, scheduleOnlyLlm = 0, anyMole = 0;
  const samples: any[] = [];
  const moleTurns: { t: Turn; extracted: { models: string[]; owned: string | null; scheduleDay: string | null } }[] = [];

  const results = await pool(turns, concurrency, async t => {
    const parsed = await parseTurnUnderstandingWithLLM({ text: t.text, history: t.history, lead: t.lead }).catch(() => null);
    return { t, parsed };
  });

  for (const { t, parsed } of results) {
    processed++;
    if (!parsed) { parserNull++; continue; }
    const llmModels = (parsed.requestedModels ?? []).map((m: any) => String(m.family || "").trim()).filter(Boolean);
    // models the catalog matcher would NOT find in the raw text => context/spelling resolution
    const contextModels = llmModels.filter(fam => !catalogModelMentionMatchesText(t.text, fam));
    const owned = String(parsed.ownedOrTradeModel?.family ?? "").trim();
    const llmSchedule = !!(parsed.requestedSchedule && String(parsed.requestedSchedule.dayLabel ?? parsed.requestedSchedule.day_label ?? "").trim());
    const detSched = detSchedulePresent(t.text);

    const moleModel = contextModels.length > 0;
    const moleOwned = !!owned;
    const moleSched = llmSchedule && !detSched;
    if (moleModel) modelResolvedFromContext++;
    if (moleOwned) ownedSurfaced++;
    if (moleSched) scheduleOnlyLlm++;
    if (moleModel || moleSched) {
      anyMole++; // owned excluded from headline (precision caveat)
      moleTurns.push({ t, extracted: { models: contextModels, owned: owned || null, scheduleDay: moleSched ? "yes" : null } });
    }

    if ((moleModel || moleSched) && samples.length < 15) {
      samples.push({ convId: t.convId, text: t.text.slice(0, 90), llmModels, contextModels, owned: owned || null, llmSchedule, detSched });
    }
  }

  // Correctness pass: label each disagreement genuine-win vs context-noise.
  let netWin = 0, netJudged = 0;
  if (JUDGE && moleTurns.length) {
    console.log(`[backfill] --judge: labeling ${moleTurns.length} disagreements for correctness...`);
    const verdicts = await pool(moleTurns, concurrency, m => judgeMole(m.t, m.extracted));
    for (const v of verdicts) {
      if (!v) continue;
      netJudged++;
      if (v.correct && v.relevant) netWin++;
    }
  }

  const judged = processed - parserNull;
  const pct = (n: number) => (judged ? Math.round((n / judged) * 1000) / 10 : 0);
  const report = {
    generatedAt: new Date().toISOString(),
    source: { conversationsPath, turnsSelected: turns.length, processed, parserNull, judged },
    rates: {
      modelResolvedFromContextPct: pct(modelResolvedFromContext),
      scheduleOnlyLlmPct: pct(scheduleOnlyLlm),
      ownedSurfacedPct_caveat: pct(ownedSurfaced),
      anyModelOrSchedMolePct: pct(anyMole)
    },
    counts: { modelResolvedFromContext, scheduleOnlyLlm, ownedSurfaced, anyMole, judged },
    netWin: JUDGE
      ? {
          // genuine wins (correct + relevant) as a share of ALL turns = the actionable
          // consolidation win; and as a share of the gross disagreements = signal precision.
          netWinCount: netWin,
          netWinPctOfTurns: pct(netWin),
          netWinPctOfMoles: netJudged ? Math.round((netWin / netJudged) * 1000) / 10 : 0,
          molesJudged: netJudged
        }
      : null,
    samples
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "shadow_backfill_summary.json"), JSON.stringify(report, null, 2) + "\n");

  console.log(`\n=== Turn-Understanding shadow backfill (${judged} turns judged) ===`);
  console.log(`MODEL resolved from context/spelling (det would miss): ${modelResolvedFromContext} (${report.rates.modelResolvedFromContextPct}%)`);
  console.log(`SCHEDULE only the LLM caught (det missed):             ${scheduleOnlyLlm} (${report.rates.scheduleOnlyLlmPct}%)`);
  console.log(`OWNED bike surfaced (no det equivalent; precision caveat): ${ownedSurfaced} (${report.rates.ownedSurfacedPct_caveat}%)`);
  console.log(`ANY model/schedule mole (GROSS whack-a-mole rate):     ${anyMole} (${report.rates.anyModelOrSchedMolePct}%)`);
  if (report.netWin) {
    console.log(`NET WIN (correct + relevant, judged): ${report.netWin.netWinCount}/${report.netWin.molesJudged} moles real` +
      ` => ${report.netWin.netWinPctOfTurns}% of ALL turns are a genuine resolution det would miss` +
      ` (${report.netWin.netWinPctOfMoles}% of the gross signal is a real win)`);
  }
  if (parserNull) console.log(`(parser returned null on ${parserNull} turns — check LLM_ENABLED/parser flag)`);
  console.log("\n-- samples (LLM resolved, det would miss) --");
  for (const s of samples) console.log(`  "${s.text}" | llm:${JSON.stringify(s.llmModels)} ctx:${JSON.stringify(s.contextModels)}${s.owned ? ` owned:${s.owned}` : ""}${s.llmSchedule && !s.detSched ? " sched:llm-only" : ""}`);
  console.log(`\nreport: ${path.join(outDir, "shadow_backfill_summary.json")}`);
}

main();
