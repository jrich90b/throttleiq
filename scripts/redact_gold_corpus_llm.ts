/**
 * LLM-NER redaction pass over the golden corpus — catches residual person-names that regex misses,
 * before the corpus is committed permanently. Strict: redact ONLY person names; keep everything else
 * (model names, dates, times, prices, URLs, dealer name, existing [REDACTED]/[EMAIL]/[PHONE]) verbatim.
 * Fail-safe: if the model returns something implausible (empty / far shorter), keep the regex version.
 *
 *   set -a; source .env; set +a
 *   FILE=scripts/fixtures/genuine_error_gold_corpus.json npx tsx scripts/redact_gold_corpus_llm.ts
 */
import fs from "node:fs";
import OpenAI from "openai";

const FILE = process.env.FILE || "scripts/fixtures/genuine_error_gold_corpus.json";
const MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { customer: { type: "string" }, agentWrong: { type: "string" }, humanRight: { type: "string" } },
  required: ["customer", "agentWrong", "humanRight"]
};

const PROMPT = (p: any) =>
  [
    "Redact PERSON NAMES (first or last names of customers or staff) by replacing each with the literal token [NAME].",
    "Keep EVERYTHING ELSE byte-for-byte identical: motorcycle model names (Road Glide, Fat Bob, Street Glide Limited, etc.), dates, times, prices, dollar amounts, URLs, the dealer name 'American Harley-Davidson', and any existing [REDACTED]/[EMAIL]/[PHONE]/[NAME] tokens. Do NOT paraphrase, summarize, fix grammar, or add words. Do NOT redact place/city names, days, months, or brand names.",
    "Return the three fields with names redacted.",
    `customer: ${JSON.stringify(p.customer)}`,
    `agentWrong: ${JSON.stringify(p.agentWrong)}`,
    `humanRight: ${JSON.stringify(p.humanRight)}`
  ].join("\n");

async function redactOne(p: any): Promise<{ customer: string; agentWrong: string; humanRight: string } | null> {
  try {
    const resp: any = await client.responses.parse({
      model: MODEL,
      input: PROMPT(p),
      max_output_tokens: 1500,
      text: { format: { type: "json_schema", name: "redacted_pair", schema: SCHEMA, strict: true } }
    });
    const out = resp?.output_parsed;
    if (!out || typeof out !== "object") return null;
    // fail-safe: each field must be plausibly intact (not emptied/truncated)
    for (const k of ["customer", "agentWrong", "humanRight"] as const) {
      const orig = String(p[k] ?? ""), got = String(out[k] ?? "");
      if (orig.length > 0 && got.length < Math.max(3, orig.length * 0.5)) return null;
    }
    return out;
  } catch {
    return null;
  }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let idx = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (idx < items.length) { const c = idx++; out[c] = await fn(items[c], c); } }));
  return out;
}

const doc = JSON.parse(fs.readFileSync(FILE, "utf8"));
const pairs = doc.pairs as any[];
console.log(`LLM-NER redacting ${pairs.length} pairs with ${MODEL} (concurrency ${CONCURRENCY})...`);
const results = await pool(pairs, CONCURRENCY, (p) => redactOne(p));
let changed = 0, failsafe = 0;
results.forEach((r, i) => {
  if (!r) { failsafe++; return; }
  const before = `${pairs[i].customer}|${pairs[i].agentWrong}|${pairs[i].humanRight}`;
  pairs[i].customer = r.customer; pairs[i].agentWrong = r.agentWrong; pairs[i].humanRight = r.humanRight;
  if (`${r.customer}|${r.agentWrong}|${r.humanRight}` !== before) changed++;
});
doc.meta.pii = "Two-pass redaction: regex (emails/phones/ADF fields/greeting+vocative+intro+self-ID names/staff names) THEN an LLM-NER pass (gpt-5-mini) over every pair to catch residual free-text person-names. Conv ids dropped + re-indexed. Strongly anonymized; not a legal guarantee.";
doc.meta.llmNerPass = { model: MODEL, pairs: pairs.length, changed, failsafeKeptRegex: failsafe };
fs.writeFileSync(FILE, JSON.stringify(doc, null, 2));
console.log(`Done: ${changed} pairs altered by LLM-NER, ${failsafe} kept regex-version (fail-safe). -> ${FILE}`);
