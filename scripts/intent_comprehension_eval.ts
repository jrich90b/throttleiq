/**
 * Intent-comprehension scorecard (ci:eval).
 *
 * A standing, adversarial red-team of the live turn-understanding parser
 * (`parseTurnUnderstandingWithLLM`) — the piece that reads what a customer MEANS
 * from one text. It exists to turn "the parser sometimes misunderstands intent"
 * from a gut feeling into a tracked number that trends run-over-run and catches
 * regressions before they ship. Every case is a realistic-but-hard customer
 * text (slang models, typos, multi-intent, service-vs-sales, opt-out slang,
 * relevance traps) that a keyword matcher could never handle.
 *
 * Two tiers, mirroring the AGENTS.md fail-direction law:
 *   - CRITICAL (0 tolerance): the fail-SAFE invariants. Over-attaching a model
 *     the customer didn't ask for, missing an opt-out, or turning a SERVICE
 *     complaint into a SALES lead are the dangerous failure directions — any
 *     miss reds the gate.
 *   - SCORED (floor with a small tolerance): model-resolution / extraction
 *     niceties. These are stochastic at the margin, so a single flake is
 *     absorbed (SCORED_TOLERANCE), but a real comprehension regression breaks
 *     several at once and trips the floor. The whole eval is ALSO wrapped by
 *     retry_llm_eval.sh in package.json (one whole-suite retry on failure).
 *
 * Portability: universal — every case uses generic Harley model names, no
 * dealer-specific facts, so the eval_suite manifest guard classifies it
 * `universal` (works for dealer #2 unchanged).
 *
 * Run standalone: set a real OPENAI_API_KEY, then
 *   LLM_ENABLED=1 LLM_TURN_UNDERSTANDING_PARSER_ENABLED=1 npx tsx scripts/intent_comprehension_eval.ts
 */

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey || apiKey.trim().length < 20 || apiKey.trim() === "...") {
  console.error("OPENAI_API_KEY missing or placeholder; set a real key and re-run.");
  process.exit(1);
}
process.env.LLM_ENABLED = "1";
process.env.LLM_TURN_UNDERSTANDING_PARSER_ENABLED = "1";

const { parseTurnUnderstandingWithLLM } = await import("../services/api/src/domain/llmDraft.ts");

// How many SCORED misses to absorb as LLM nondeterminism before the gate reds.
// Every scored case passes 3/3 standalone; a real regression breaks 2+ at once.
const SCORED_TOLERANCE = 1;

type H = { direction: "in" | "out"; body: string }[];
type Tier = "critical" | "scored";
type Case = {
  id: string;
  cat: string;
  tier: Tier;
  text: string;
  history?: H;
  // returns a failure message, or null when the parse is acceptable
  check: (p: any) => string | null;
};

const families = (p: any): string[] =>
  (p?.requestedModels ?? []).map((m: any) => String(m?.family ?? "").toLowerCase());
const owned = (p: any): string => String(p?.ownedOrTradeModel?.family ?? "").toLowerCase();
const hasSchedule = (p: any): boolean => {
  const s = p?.requestedSchedule;
  return !!(s && (s.dayLabel || s.timeText || s.isCommitment));
};
const wantFamily = (p: any, needle: string): string | null =>
  families(p).some(f => f.includes(needle.toLowerCase()))
    ? null
    : `expected a requested model containing "${needle}", got ${JSON.stringify(p?.requestedModels ?? [])}`;
const wantNoModels = (p: any): string | null =>
  families(p).length === 0
    ? null
    : `expected NO requested model (relevance/over-attach guard), got ${JSON.stringify(p?.requestedModels ?? [])}`;

const CASES: Case[] = [
  // ---------- CRITICAL: fail-safe invariants (0 tolerance) ----------
  {
    id: "relevance_bare_thanks", cat: "relevance-trap", tier: "critical",
    text: "thanks man appreciate it",
    history: [{ direction: "out", body: "That Breakout just came in, want to see it?" }],
    check: wantNoModels // must NOT glue the thread's Breakout onto a bare thank-you
  },
  {
    id: "relevance_reaction", cat: "relevance-trap", tier: "critical",
    text: "man that thing is gorgeous",
    history: [{ direction: "out", body: "Here are photos of the Road Glide." }],
    check: wantNoModels // a reaction is not a fresh request
  },
  {
    id: "relevance_signoff_no_phantom_schedule", cat: "relevance-trap", tier: "critical",
    text: "perfect see you then",
    history: [{ direction: "out", body: "You're all set for Saturday at 2." }],
    check: p => (hasSchedule(p) ? `phantom schedule captured on a sign-off: ${JSON.stringify(p?.requestedSchedule)}` : null)
  },
  {
    id: "service_not_sales", cat: "service-vs-sales", tier: "critical",
    text: "my street glide is making a clunking noise when i shift, can someone look at it",
    check: p => wantNoModels(p) // a service complaint must NOT become a requested sales model
  },
  {
    id: "opt_out_take_me_off", cat: "opt-out", tier: "critical",
    text: "please take me off your list",
    check: p => (p?.flags?.isOptOut ? null : `opt-out not flagged (isOptOut=${p?.flags?.isOptOut})`)
  },
  {
    id: "opt_out_informal", cat: "opt-out", tier: "critical",
    text: "quit hitting me up",
    check: p => (p?.flags?.isOptOut ? null : `informal opt-out not flagged (isOptOut=${p?.flags?.isOptOut})`)
  },

  // ---------- SCORED: model-resolution / extraction niceties ----------
  {
    id: "slang_tri_glide", cat: "slang-model", tier: "scored",
    text: "wife wants a tri glide ultra, got one on the floor?",
    check: p => wantFamily(p, "tri glide")
  },
  {
    id: "slang_anniversary_softail", cat: "slang-model", tier: "scored",
    text: "any of the 115 anniversary softails left",
    check: p => (families(p).some(f => f.includes("softail") || f.includes("anniversary"))
      ? null : `expected a Softail/Anniversary model, got ${JSON.stringify(p?.requestedModels ?? [])}`)
  },
  {
    id: "typo_road_glide", cat: "typo", tier: "scored",
    text: "do u have a roadglid speical in stock",
    check: p => wantFamily(p, "road glide")
  },
  {
    id: "typo_heritage", cat: "typo", tier: "scored",
    text: "lookin at the heritage clasic softtail",
    check: p => wantFamily(p, "heritage")
  },
  {
    id: "multi_intent_trade_plus_visit", cat: "multi-intent", tier: "scored",
    text: "whats my 19 street bob worth on trade and can i swing by saturday to look at a road glide",
    check: p => {
      const m = wantFamily(p, "road glide");
      if (m) return m;
      if (!owned(p).includes("street bob")) return `owned/trade bike should be Street Bob, got "${owned(p)}"`;
      return null;
    }
  },
  {
    id: "price_question_with_model", cat: "pricing", tier: "scored",
    text: "whats the out the door on the street glide",
    check: p => {
      const m = wantFamily(p, "street glide");
      if (m) return m;
      if (p?.primaryIntent !== "pricing") return `intent should be pricing, got ${p?.primaryIntent}`;
      return null;
    }
  },
  {
    id: "finance_payments_model", cat: "finance", tier: "scored",
    text: "what would payments run me a month on a new softail",
    check: p => wantFamily(p, "softail")
  },
  {
    id: "negation_interest_shift", cat: "negation", tier: "scored",
    text: "not really feeling the road glide anymore, more of a fat boy guy now",
    check: p => {
      const m = wantFamily(p, "fat boy");
      if (m) return m;
      if (families(p).some(f => f.includes("road glide")))
        return "dropped Road Glide must NOT be a requested model after the customer moved off it";
      return null;
    }
  },
  {
    id: "schedule_after_work", cat: "scheduling", tier: "scored",
    text: "could do after work friday like 5:30",
    history: [{ direction: "out", body: "What day and time works?" }],
    check: p => (hasSchedule(p) ? null : `expected a captured schedule, got ${JSON.stringify(p?.requestedSchedule)}`)
  },
  {
    id: "schedule_vague_next_week", cat: "scheduling", tier: "scored",
    text: "maybe sometime next week if i get a chance",
    check: p => (hasSchedule(p) || p?.primaryIntent === "scheduling"
      ? null : `expected a soft scheduling read, got intent=${p?.primaryIntent} schedule=${JSON.stringify(p?.requestedSchedule)}`)
  },
  {
    id: "non_motorcycle_trade", cat: "non-moto", tier: "scored",
    text: "can i trade my f150 toward a bike",
    check: p => wantNoModels(p) // an F-150 is not a Harley model to request
  },
  {
    id: "apparel_not_a_bike", cat: "non-moto", tier: "scored",
    text: "do you carry womens riding jackets in xl",
    check: p => wantNoModels(p)
  },
  {
    id: "wrong_number", cat: "wrong-number", tier: "scored",
    text: "you got the wrong person I never asked about a bike",
    check: p => (p?.flags?.isWrongNumber ? null : `wrong-number not flagged (isWrongNumber=${p?.flags?.isWrongNumber})`)
  }
];

type Result = { c: Case; fail: string | null };

async function main() {
  const results: Result[] = await Promise.all(
    CASES.map(async c => {
      try {
        const parse = await parseTurnUnderstandingWithLLM({ text: c.text, history: c.history });
        if (!parse) return { c, fail: "parser returned null (LLM disabled or empty)" };
        return { c, fail: c.check(parse) };
      } catch (e: any) {
        return { c, fail: `threw: ${String(e?.message ?? e)}` };
      }
    })
  );

  const criticalFails = results.filter(r => r.c.tier === "critical" && r.fail);
  const scoredResults = results.filter(r => r.c.tier === "scored");
  const scoredFails = scoredResults.filter(r => r.fail);
  const criticalTotal = results.filter(r => r.c.tier === "critical").length;
  const scoredTotal = scoredResults.length;

  // Scorecard (this is the trend artifact — grep ci:eval logs for "intent-comprehension").
  console.log("\n=== intent-comprehension scorecard ===");
  const byCat = new Map<string, { pass: number; total: number }>();
  for (const r of results) {
    const e = byCat.get(r.c.cat) ?? { pass: 0, total: 0 };
    e.total += 1;
    if (!r.fail) e.pass += 1;
    byCat.set(r.c.cat, e);
  }
  for (const [cat, e] of [...byCat.entries()].sort()) {
    console.log(`  ${e.pass}/${e.total}  ${cat}`);
  }
  console.log(
    `  CRITICAL ${criticalTotal - criticalFails.length}/${criticalTotal} | ` +
    `SCORED ${scoredTotal - scoredFails.length}/${scoredTotal} (tolerate ${SCORED_TOLERANCE})`
  );

  for (const r of results.filter(x => x.fail)) {
    console.log(`  ${r.c.tier === "critical" ? "CRITICAL-MISS" : "scored-miss"} [${r.c.id}] "${r.c.text}"\n     -> ${r.fail}`);
  }

  const problems: string[] = [];
  if (criticalFails.length > 0) {
    problems.push(`${criticalFails.length} CRITICAL fail-safe invariant(s) broke (0 tolerated): ${criticalFails.map(r => r.c.id).join(", ")}`);
  }
  if (scoredFails.length > SCORED_TOLERANCE) {
    problems.push(`${scoredFails.length} scored misses exceed tolerance ${SCORED_TOLERANCE}: ${scoredFails.map(r => r.c.id).join(", ")}`);
  }

  if (problems.length) {
    console.error("\nintent-comprehension eval FAILED:");
    for (const p of problems) console.error("  - " + p);
    process.exit(1);
  }
  console.log("\nintent-comprehension eval PASSED");
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
