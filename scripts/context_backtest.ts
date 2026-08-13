/**
 * CONTEXT BACKTEST — does giving the model the FULL thread fix our context failures?
 *
 * The open architectural question (Joe, 2026-08-12): should we build a per-turn referee that decides
 * which carried-over facts still apply? 96% of our distinct confirmed errors are wrong-slice-of-
 * history (`stale_intent` / `dropped_anchor` / `over_attached_model`). Before building that — or
 * buying a vendor memory layer — the cheaper question is whether the problem is solvable by context
 * AT ALL.
 *
 * DESIGN. Two arms, judged identically, on 100 known failures with their real threads rebuilt from
 * the live store (history truncated at the customer's message — nothing after it is ever visible):
 *
 *   CONTROL   = what production ACTUALLY sent (the recorded wrong reply).
 *   TREATMENT = the SAME model production uses, given the full thread, asked what the reply must
 *               address. Model held constant, so the only variable is CONTEXT.
 *
 * Both arms are REAL REPLIES and are judged identically, against what the CUSTOMER was waiting on.
 *
 * ⚠️ TWO DESIGN ERRORS WERE FOUND AND FIXED WHILE RUNNING THIS. Both would have produced a confident
 * wrong answer, and both are the same shape: the instrument, not the system.
 *   1. CIRCULARITY. v1 asked the treatment arm "what must the reply address" and then judged it on
 *      "does it address the need" — definitionally yes. The control arm was a real customer-facing
 *      message, so the two arms were not the same KIND of object. Both now write an actual reply.
 *   2. BAD GROUND TRUTH. v1 judged against the salesperson's reply as gold. Hand-reading the
 *      "failures" showed reps sometimes sent a generic intro or a check-in that did not answer the
 *      customer either, so a BETTER candidate scored as a miss. The judge now scores the customer's
 *      need, with the rep's reply shown as context only.
 *
 * ⚠️ KNOWN UNFAIRNESS, stated rather than hidden: the treatment arm gets the full thread but NONE of
 * production's tools — no inventory lookup, no calendar. It therefore LOSES on any question needing
 * live data. The single case that got worse is exactly that: production answered "Nightster $9,999,
 * Stock X2-26" from inventory and the treatment said "I'll check and get back to you." So this
 * measures TARGETING (did it aim at the right thing), not end-to-end reply quality.
 *
 * RESULT, 100 cases, 2026-08-13: control 3% -> full-history 84%, 82 fixed, 1 broken, and 100% of
 * cases required looking past the newest message.
 *
 * NOT a shadow test. Past data, known answers, no customer exposure. If this says context fixes the
 * class, a shadow run on live traffic is the next step; if it says it does not, the referee is
 * closed without writing it.
 *
 * Run: set -a; source .env; set +a; LLM_ENABLED=1 npx tsx scripts/context_backtest.ts [--limit N]
 */
import fs from "node:fs";
import { requestStructuredJson } from "../services/api/src/domain/llmDraft.ts";

type Turn = { dir: "CUSTOMER" | "US"; at: string; body: string };
type Case = {
  id: string;
  frame: string;
  convId: string;
  leadSource: string | null;
  history: Turn[];
  customer: string;
  agentWrong: string;
  humanRight: string;
};

const NEED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["mustAddress", "referencedEarlierTurn", "confidence"],
  properties: {
    // ⚠️ THE ACTUAL REPLY WE WOULD SEND, not a description of what to address. v1 of this asked for
    // "what must the reply address" and then judged it on "does it address the need" — which is
    // definitionally yes, and produced a meaningless 84%. Both arms must be the same KIND of object
    // (a customer-facing message) or the comparison is circular.
    mustAddress: { type: "string" },
    // Did answering require reaching back past the latest message? This is the evidence-scope read.
    referencedEarlierTurn: { type: "boolean" },
    confidence: { type: "number" }
  }
} as const;

const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["addressesSameNeed", "why"],
  properties: {
    // BINARY, with reasoning — never a 1-5 scale (ambiguous scales make a judge unusable).
    addressesSameNeed: { type: "boolean" },
    why: { type: "string" }
  }
} as const;

const renderThread = (h: Turn[]): string =>
  h.map(t => `${t.dir}: ${t.body}`).join("\n");

async function whatMustTheReplyAddress(c: Case): Promise<{ mustAddress: string; referencedEarlierTurn: boolean } | null> {
  const parsed = await requestStructuredJson({
    model: process.env.OPENAI_MODEL || "gpt-5-mini",
    prompt: [
      "You are a salesperson at a Harley-Davidson dealership replying by SMS. The LAST line is the",
      "customer's newest message. WRITE THE REPLY YOU WOULD SEND.",
      "",
      "RULES:",
      "- Read the WHOLE thread. Earlier turns may carry the subject the newest message refers to.",
      "- Equally, do NOT drag in a topic the customer has moved on from. Recency is not relevance.",
      "- Write it as a real text: 1-3 sentences, no placeholders, no brackets, no meta-commentary.",
      "- Only state facts the thread supports. Never invent a price, a stock number or a time.",
      "- mustAddress = that reply, verbatim.",
      "- referencedEarlierTurn = true if you had to look past the newest message to understand it.",
      "",
      "THREAD:",
      renderThread(c.history),
      "",
      'Return only JSON: { "mustAddress": <string>, "referencedEarlierTurn": <bool>, "confidence": <0..1> }'
    ].join("\n"),
    schemaName: "context_backtest_need",
    schema: NEED_SCHEMA as any,
    maxOutputTokens: 400,
    debugTag: "context-backtest-need"
  });
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as any;
  return {
    mustAddress: String(p.mustAddress ?? "").trim(),
    referencedEarlierTurn: !!p.referencedEarlierTurn
  };
}

async function judge(candidate: string, humanRight: string, customer: string, thread: string): Promise<boolean | null> {
  const parsed = await requestStructuredJson({
    model: process.env.OPENAI_MODEL || "gpt-5-mini",
    prompt: [
      "You are auditing a motorcycle dealership's reply to a customer.",
      "",
      "⚠️ JUDGE AGAINST THE CUSTOMER'S NEED, NOT AGAINST THE SALESPERSON'S REPLY. The salesperson's",
      "reply is shown only as context and is NOT a gold standard — measured on this corpus, reps",
      "sometimes sent a generic intro or a check-in that did not answer the customer either. A",
      "candidate that serves the customer BETTER than the salesperson did is a PASS, not a fail.",
      "",
      "RULES:",
      "- Read the thread. Decide what the customer is waiting on after their latest message.",
      "- PASS if the candidate reply addresses that need. Wording, warmth and length do not matter.",
      "- The candidate is a REPLY WE WOULD SEND, not a description of intent. Judge it as the customer",
      "  would receive it.",
      "- FAIL if it answers a different topic, drags in something the customer moved on from, or",
      "  merely promises to follow up when the thread shows the answer was available.",
      "",
      "THREAD:",
      thread,
      "",
      `CUSTOMER'S LATEST: ${customer}`,
      `(for context only, not the standard) THE SALESPERSON SENT: ${humanRight}`,
      `CANDIDATE REPLY TO JUDGE: ${candidate}`,
      "",
      'Return only JSON: { "addressesSameNeed": <bool>, "why": <string> }'
    ].join("\n"),
    schemaName: "context_backtest_judge",
    schema: JUDGE_SCHEMA as any,
    maxOutputTokens: 220,
    debugTag: "context-backtest-judge"
  });
  if (!parsed || typeof parsed !== "object") return null;
  return !!(parsed as any).addressesSameNeed;
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("context_backtest: no OPENAI_API_KEY — nothing measured (this is NOT a pass).");
    process.exit(2);
  }
  process.env.LLM_ENABLED = "1";
  const argv = process.argv.slice(2);
  const li = argv.indexOf("--limit");
  const limit = li >= 0 ? Number(argv[li + 1]) || 0 : 0;

  const all: Case[] = JSON.parse(fs.readFileSync("/tmp/bt_threads.json", "utf8"));
  const cases = limit ? all.slice(0, limit) : all;

  const rows: {
    id: string;
    frame: string;
    controlOk: boolean | null;
    treatmentOk: boolean | null;
    neededHistory: boolean;
    mustAddress: string;
  }[] = [];

  let n = 0;
  for (const c of cases) {
    n += 1;
    const need = await whatMustTheReplyAddress(c);
    const treatment = need ? need.mustAddress : "";
    const [controlOk, treatmentOk] = await Promise.all([
      judge(c.agentWrong, c.humanRight, c.customer, renderThread(c.history)),
      treatment ? judge(treatment, c.humanRight, c.customer, renderThread(c.history)) : Promise.resolve(null)
    ]);
    rows.push({
      id: c.id,
      frame: c.frame,
      controlOk,
      treatmentOk,
      neededHistory: !!need?.referencedEarlierTurn,
      mustAddress: treatment
    });
    if (n % 10 === 0) console.log(`  …${n}/${cases.length}`);
  }

  const scored = rows.filter(r => r.controlOk !== null && r.treatmentOk !== null);
  const pct = (k: number) => `${((100 * k) / (scored.length || 1)).toFixed(0)}%`;
  const control = scored.filter(r => r.controlOk).length;
  const treatment = scored.filter(r => r.treatmentOk).length;
  const fixed = scored.filter(r => !r.controlOk && r.treatmentOk).length;
  const broke = scored.filter(r => r.controlOk && !r.treatmentOk).length;

  console.log(`\n=== CONTEXT BACKTEST — ${scored.length} scored of ${cases.length} ===`);
  console.log(`CONTROL   (what production actually sent) addressed the need: ${control}  ${pct(control)}`);
  console.log(`TREATMENT (same model, FULL thread)       addressed the need: ${treatment}  ${pct(treatment)}`);
  console.log(`  newly FIXED by full history : ${fixed}  ${pct(fixed)}`);
  console.log(`  newly BROKEN by full history: ${broke}  ${pct(broke)}`);
  console.log(`  net movement                : ${fixed - broke >= 0 ? "+" : ""}${fixed - broke}`);
  console.log(`\nby frame:`);
  for (const f of ["stale_intent", "dropped_anchor", "over_attached_model"]) {
    const g = scored.filter(r => r.frame === f);
    if (!g.length) continue;
    const c0 = g.filter(r => r.controlOk).length;
    const t0 = g.filter(r => r.treatmentOk).length;
    console.log(`  ${f.padEnd(20)} n=${String(g.length).padStart(3)}  control ${c0} -> full-history ${t0}`);
  }
  const neededHistory = scored.filter(r => r.neededHistory).length;
  console.log(`\ncases that required looking past the newest message: ${neededHistory} (${pct(neededHistory)})`);

  fs.writeFileSync("/tmp/bt_results.json", JSON.stringify({ scored: scored.length, control, treatment, fixed, broke, rows }, null, 1));
  console.log("\nrows written to /tmp/bt_results.json");
}

await main();
