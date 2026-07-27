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
// The scored pool now holds ~3 inherently-stochastic edge cases (trade+spec combo,
// the "catch the tech" ETA question, a slang variant) each ~10-15% flaky, so two can
// coincide in one run. Tolerance 2 (floor ~88%) absorbs that without leaning on the
// retry wrapper; a REAL regression breaks a whole category (3+) and/or trips a CRITICAL
// (0-tolerance), which is the actual safety gate. Raised 1->2 on 7/27 when hole #3
// fixtures grew the pool.
const SCORED_TOLERANCE = 2;

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
// Concrete model families the parser must NOT fabricate from a bare engine/platform/tier spec.
const CONCRETE_MODELS = /(street glide|road glide|road king|fat boy|fat bob|ultra limited|low rider|softail|heritage|sportster|pan america|tri glide|breakout|nightster|street bob|electra glide)/i;
// A bare engine/displacement/platform ref ("117", "M8", "CVO") must not resolve to a concrete
// model the customer never named. Allow the spec token itself; forbid any hallucinated concrete
// model absent from the text (that is the dangerous "invented a bike" direction).
const noHallucinatedModel = (p: any, text: string): string | null => {
  for (const f of families(p)) {
    const m = f.match(CONCRETE_MODELS);
    if (m && !new RegExp(m[0].replace(/\s+/g, "\\s*"), "i").test(text))
      return `hallucinated concrete model "${f}" not named in the text (bare spec must stay empty), got ${JSON.stringify(p?.requestedModels ?? [])}`;
  }
  return null;
};

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
  // ---------- CRITICAL: en-route ETA / sign-off must NOT create a phantom schedule (hole #3) ----------
  // Fixtures are real leaking texts from the 1000-text stress run (~50 phantom_schedule cases). The
  // parser was grabbing an ETA/delay ("running 15 late", "be there in 20") or an already-booked time
  // ("still coming for the 3pm") as a NEW appointment. Fixed 7/27; all verified 5/5 stable NULL.
  {
    // Re-promoted to CRITICAL (was removed in #300 while it flaked ~25%; the hole-#3 fix makes it reliable).
    id: "relevance_signoff_no_phantom_schedule", cat: "relevance-trap", tier: "critical",
    text: "perfect see you then",
    history: [{ direction: "out", body: "You're all set for Saturday at 2." }],
    check: p => (hasSchedule(p) ? `phantom schedule captured on a sign-off: ${JSON.stringify(p?.requestedSchedule)}` : null)
  },
  {
    id: "eta_delay_still_ok", cat: "eta-schedule", tier: "critical",
    text: "vp but running 15 mins late, en la 105 heading there, still ok?",
    check: p => (hasSchedule(p) ? `phantom schedule from an ETA/delay: ${JSON.stringify(p?.requestedSchedule)}` : null)
  },
  {
    // SCORED (not critical): the "...catch the tech before he leaves?" question about an existing
    // plan occasionally (~15%) still tempts a schedule read — tracked, not 0-tolerance.
    id: "eta_catch_tech", cat: "eta-schedule", tier: "scored",
    text: "runin 20 mins, boss traffic on 35 — still good to catch the tech before he leaves?",
    check: p => (hasSchedule(p) ? `phantom schedule from an ETA: ${JSON.stringify(p?.requestedSchedule)}` : null)
  },
  {
    id: "eta_still_coming_existing", cat: "eta-schedule", tier: "critical",
    text: "stuck in meeting, gonna be +20 min. still coming for the 21 sgs but might park in lot 3",
    check: p => (hasSchedule(p) ? `phantom schedule on a 'still coming for existing appt' note: ${JSON.stringify(p?.requestedSchedule)}` : null)
  },
  {
    // REGRESSION guard: a REAL proposed time must STILL be captured (don't over-suppress).
    id: "real_proposal_still_captured", cat: "eta-schedule", tier: "scored",
    text: "can i come by saturday at 2 to see it?",
    check: p => (hasSchedule(p) ? null : `a real proposed time must be captured, got ${JSON.stringify(p?.requestedSchedule)}`)
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
  },

  // ---------- CRITICAL: engine/platform/tier spec must NOT hallucinate a model ----------
  // Fixtures are the real failing texts from the 1000-text stress run (7/26): a bare "117"/"114"/"M8"/"CVO"
  // made the parser invent Street Glide / Road Glide / Fat Boy the customer never named — the worst
  // ("invented a bike") direction. Fail-safe target: no fabricated concrete model (agent asks which model).
  {
    id: "spec_bare_117_price", cat: "engine-spec", tier: "critical",
    text: "wuts yr best cash price on a new 2024 117? in city delivery?",
    check: p => noHallucinatedModel(p, "wuts yr best cash price on a new 2024 117? in city delivery?")
  },
  {
    id: "spec_cvo_and_114", cat: "engine-spec", tier: "critical",
    text: "if i come now can u run numbers on a cvo and a 114? also trade value for my fxrt?",
    check: p => noHallucinatedModel(p, "if i come now can u run numbers on a cvo and a 114? also trade value for my fxrt?")
  },
  {
    // SCORED (not critical): this combines a bare spec ("114") WITH a trade-in — it straddles hole #1
    // and hole #2 (trade disentangle), and the "hold the 114" phrasing occasionally still tempts a
    // model guess (~12%). Tracked here; promote to critical once the hole-#2 fix firms it up.
    id: "spec_hold_114_trade", cat: "engine-spec", tier: "scored",
    text: "how much u giving for a 2017 trade-in, can u hold the 114 till i come by this afternoon & what paperwork i need? thx",
    check: p => noHallucinatedModel(p, "how much u giving for a 2017 trade-in, can u hold the 114 till i come by this afternoon & what paperwork i need? thx")
  },
  {
    // Guard against OVER-correction: when a specific model IS named alongside the spec, still capture it.
    id: "spec_resolved_by_context", cat: "engine-spec", tier: "scored",
    text: "can u hold the 117 street glide till saturday?",
    check: p => wantFamily(p, "street glide")
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
