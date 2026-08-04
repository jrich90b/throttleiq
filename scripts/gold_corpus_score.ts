/**
 * Gold-corpus scorer — produces THE NUMBER: what share of real customer turns does the agent answer
 * as well as the salesperson who actually answered them?
 *
 * Joe, 2026-08-04: the suite could say "these 392 specific things have not regressed" but never
 * "the agent is X% right and trending up." The golden corpus existed and had no consumer. This is
 * the consumer.
 *
 * HOW: take the EVAL split of the harvested corpus (`splitFor`, a stable 20% hold-out — the train
 * side is what few-shots may draw from, so scoring on it would be marking our own homework), replay
 * the composer on each customer turn with the thread as it stood at that moment, and ask a judge
 * whether the agent's reply accomplishes what the human's reply accomplished. Majority of 3,
 * because judge verdicts are only 55-74% self-agreeing.
 *
 * READ-ONLY on conversations. Writes one report. Not in `ci:eval` — it costs real LLM calls and
 * minutes; `gold_corpus_score_eval.ts` is the cheap in-suite guard that reads what this produces.
 *
 * Run (box):
 *   cd /home/ubuntu/leadrider-api/americanharley && set -a; . /home/ubuntu/leadrider-runtime/americanharley/api.env; set +a; \
 *     LLM_ENABLED=1 REPORT_ROOT=/home/ubuntu/leadrider-runtime/americanharley/reports \
 *     CONVERSATIONS_DB_PATH=/home/ubuntu/leadrider-runtime/americanharley/data/conversations.json \
 *     npx tsx scripts/gold_corpus_score.ts
 */
import fs from "node:fs";
import path from "node:path";
import { pairKey, splitFor } from "../services/api/src/domain/goldCorpusHarvest.js";
import {
  GOLD_EQUIVALENCE_JSON_SCHEMA,
  buildGoldEquivalencePrompt,
  selectScoreableEvalItems,
  summarizeGoldScore,
  tallyVotes,
  type GoldExample,
  type GoldItemVerdict
} from "../services/api/src/domain/goldCorpusScore.js";
import { generateDraftWithLLM, requestStructuredJson } from "../services/api/src/domain/llmDraft.js";
import { resolveReportDir } from "../services/api/src/domain/reportPaths.js";

const SAMPLES = Number(process.env.GOLD_SCORE_SAMPLES ?? 3);
const LIMIT = Number(process.env.GOLD_SCORE_LIMIT ?? 0); // 0 = all eval-split items
const EVAL_FRACTION = Number(process.env.GOLD_SCORE_EVAL_FRACTION ?? 0.2);

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

const goldDir = resolveReportDir("gold_examples", "GOLD_EXAMPLES_DIR");
const goldFile = process.env.GOLD_EXAMPLES_FILE || path.join(goldDir, "gold_examples_candidates.json");
const outDir = resolveReportDir("gold_score", "GOLD_SCORE_DIR");

const all = readJson<GoldExample[]>(goldFile, []);
if (!Array.isArray(all) || !all.length) {
  console.error(`gold_corpus_score: no examples at ${goldFile} — nothing to score.`);
  process.exit(2);
}

// The EVAL split only, via the pure selector so the rule is pinned by CALLING it rather than by
// grepping this file. `pairKey` is the same dedup key the harvester uses, so an example keeps its
// side of the split forever — a corpus that grew since the last run does not reshuffle the hold-out.
const evalItems = selectScoreableEvalItems(
  all,
  key => splitFor(key, EVAL_FRACTION),
  ex => pairKey(String(ex.convId ?? ""), String(ex.reply ?? ""))
);
const items = LIMIT > 0 ? evalItems.slice(0, LIMIT) : evalItems;

console.log(
  `gold_corpus_score: ${all.length} harvested, ${evalItems.length} in the eval hold-out, scoring ${items.length} @ ${SAMPLES} vote(s) each`
);

// Thread context as it stood at that moment — the composer is graded with what it would really have had.
const convPath = process.env.CONVERSATIONS_DB_PATH || "";
const convs: any[] = (() => {
  const raw = readJson<any>(convPath, []);
  return Array.isArray(raw) ? raw : Array.isArray(raw?.conversations) ? raw.conversations : [];
})();
const convById = new Map<string, any>();
for (const c of convs) for (const k of [c?.id, c?.leadKey]) if (k) convById.set(String(k), c);

function historyBefore(convId: string | null | undefined, at: string | null | undefined, limit = 8) {
  const c = convId ? convById.get(String(convId)) : null;
  const msgs: any[] = Array.isArray(c?.messages) ? c.messages : [];
  return msgs
    .filter(m => String(m?.body ?? "").trim() && (!at || String(m?.at ?? "") < String(at)))
    .slice(-limit)
    .map(m => ({ direction: m.direction === "in" ? ("in" as const) : ("out" as const), body: String(m.body) }));
}

async function judgeOnce(inbound: string, humanReply: string, agentReply: string): Promise<boolean | null> {
  try {
    const parsed: any = await requestStructuredJson({
      model: process.env.OPENAI_GOLD_SCORE_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini",
      prompt: buildGoldEquivalencePrompt({ inbound, humanReply, agentReply }),
      schemaName: "gold_equivalence",
      schema: GOLD_EQUIVALENCE_JSON_SCHEMA
    });
    return typeof parsed?.correct === "boolean" ? parsed.correct : null;
  } catch {
    return null; // an unparseable verdict counts as NOT correct via tallyVotes — pessimistic on purpose
  }
}

const verdicts: GoldItemVerdict[] = [];
for (const [i, ex] of items.entries()) {
  const inbound = String(ex.inbound ?? "").trim();
  const humanReply = String(ex.reply ?? "").trim();
  const key = pairKey(String(ex.convId ?? ""), humanReply);

  let agentReply = "";
  try {
    agentReply = String(
      (await generateDraftWithLLM({
        channel: "sms",
        leadKey: String(ex.convId ?? ""),
        lead: (convById.get(String(ex.convId ?? ""))?.lead ?? null) as any,
        inquiry: inbound,
        history: historyBefore(ex.convId, ex.at)
      } as any)) ?? ""
    ).trim();
  } catch (err: any) {
    console.warn(`  [${i + 1}/${items.length}] compose failed: ${err?.message ?? err}`);
  }

  if (!agentReply) {
    // No draft at all is a miss, not a skip: silence where a human replied is the failure mode the
    // wrongful-silence work exists for, and dropping it would flatter the score.
    verdicts.push({ key, convId: ex.convId ?? null, tier: ex.tier ?? null, correct: false, votes: [], why: "agent produced no reply" });
    continue;
  }

  const votes = await Promise.all(Array.from({ length: SAMPLES }, () => judgeOnce(inbound, humanReply, agentReply)));
  const correct = tallyVotes(votes);
  verdicts.push({
    key,
    convId: ex.convId ?? null,
    tier: ex.tier ?? null,
    correct,
    votes: votes.filter((v): v is boolean => typeof v === "boolean"),
    why: correct ? "matches the human outcome" : "diverges from the human outcome"
  });
  if ((i + 1) % 10 === 0) console.log(`  scored ${i + 1}/${items.length}…`);
}

const summary = summarizeGoldScore(verdicts);
const report = {
  generatedAt: new Date().toISOString(),
  source: { goldFile, harvested: all.length, evalSplit: evalItems.length, samples: SAMPLES, evalFraction: EVAL_FRACTION },
  summary,
  items: verdicts
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "gold_score_summary.json"), `${JSON.stringify({ generatedAt: report.generatedAt, source: report.source, summary }, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, "gold_score_report.json"), `${JSON.stringify(report, null, 2)}\n`);

console.log("");
console.log(`GOLD SCORE: ${summary.score}%  (${summary.correct}/${summary.scored})`);
for (const [tier, s] of Object.entries(summary.byTier)) {
  console.log(`  ${tier}: ${s.correct}/${s.scored}`);
}
console.log(`report -> ${outDir}`);
