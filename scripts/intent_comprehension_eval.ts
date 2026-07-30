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

const { parseTurnUnderstandingWithLLM, applyTurnUnderstandingEtaGuard, applyTurnUnderstandingBookedSignoffGuard, turnModelEvidenceInText } = await import("../services/api/src/domain/llmDraft.ts");

// ---- Deterministic pin of the model-evidence guard (no LLM) ----
// Drops fabricated models (the LLM's "hold the 117 -> Street Glide" prior) while keeping every
// legitimate evidence path: exact/one-word names, slang aliases (#288 map), factory codes,
// agent-context, and typo fuzz — with the claimed-alias safeguard (fat bob never evidences Fat Boy).
{
  const mustDrop: Array<[string, string]> = [
    ["hold the 117 till sat?", "Street Glide"],
    ["pls dont sell it im on my way", "Street Glide"],
    ["that cvo i saw, price?", "Street Glide"],
    ["wanna try the 2023 fat bob", "Fat Boy"]
  ];
  const mustKeep: Array<[string, string]> = [
    ["can you lmk when you get the 23 lrs?", "Low Rider S"],
    ["keep that 21 SGS under wraps", "Street Glide"],
    ["is the streetglide still there", "Street Glide"],
    ["got a 2016 fxlrs to trade", "Low Rider S"],
    ["so that 117 is for sale? \n we've got the new 117 cvo street glide on the floor", "Street Glide"],
    ["do u have a roadglid speical", "Road Glide"],
    ["price on the ultra limted?", "Ultra Limited"]
  ];
  for (const [t, f] of mustDrop) {
    if (turnModelEvidenceInText(t, f)) { console.error(`evidence guard FAILED to drop fabrication: "${t}" -> ${f}`); process.exit(1); }
  }
  for (const [t, f] of mustKeep) {
    if (!turnModelEvidenceInText(t, f)) { console.error(`evidence guard WRONGLY dropped: "${t}" -> ${f}`); process.exit(1); }
  }
}

// ---- Deterministic pin of the ETA hygiene guard (no LLM) ----
// The guard blanks a delay-shaped schedule the parser stochastically emits on en-route texts
// ("15 mins late" / "+20 min" / "be there in 20" with no day) and must NEVER blank a real
// proposal (a day, a clock time, or a day-part). Runs before the LLM cases; fails hard.
{
  const sched = (dayLabel: string | null, timeText: string | null, isCommitment = false) =>
    ({ dayLabel, timeText, window: "unknown" as const, isCommitment, isEvent: false });
  const mustBlank: Array<[string | null, string | null]> = [
    [null, "15 mins late"], [null, "+20 min"], [null, "be there in 20"],
    [null, "like 10-15 mins"], [null, "20 min behind"], [null, "in 20"]
  ];
  const mustKeep: Array<[string | null, string | null]> = [
    ["Saturday", null], ["Saturday", "2"], [null, "around 10am"], [null, "5:30"],
    [null, "afternoon"], [null, "tonight"], ["tomorrow", "15 mins late"] // a day always wins
  ];
  for (const [d, t] of mustBlank) {
    if (applyTurnUnderstandingEtaGuard(sched(d, t)) !== null) {
      console.error(`ETA guard FAILED to blank a delay-shaped schedule: day=${d} time=${t}`);
      process.exit(1);
    }
  }
  for (const [d, t] of mustKeep) {
    if (applyTurnUnderstandingEtaGuard(sched(d, t, true)) === null) {
      console.error(`ETA guard WRONGLY blanked a real proposal: day=${d} time=${t}`);
      process.exit(1);
    }
  }

  // Booked-sign-off guard. The ETA guard cannot reach this case (it returns early on any named
  // day), and the prompt already carries the exact exchange as a few-shot yet still echoes it
  // ~1 run in 3. The offer-vs-already-booked distinction lives in OUR message, so that is what
  // this reads. Joe, 2026-07-30: an accepted OFFER must still become a booking.
  const booked = sched("Saturday", "2", true);
  const agent = (body: string) => [{ direction: "out" as const, body }];
  const blanks: Array<[string, string]> = [
    ["perfect see you then", "Great, you're all set for Saturday at 2."],
    ["Perfect. See you then.", "You're all set for Saturday at 2."],
    ["sounds good", "Got you down for Saturday at 2."],
    ["ok great thanks", "You're booked for Saturday at 2."]
  ];
  for (const [text, agentBody] of blanks) {
    if (applyTurnUnderstandingBookedSignoffGuard(booked, { text, history: agent(agentBody) }) !== null) {
      console.error(`booked-sign-off guard FAILED to blank an echoed schedule: "${text}" after "${agentBody}"`);
      process.exit(1);
    }
  }
  // MUST KEEP — accepting an OFFER is a real booking, and so is any turn where the customer
  // names a day/time themselves. These are the regressions the guard must never cause.
  const keeps: Array<[string, string | null]> = [
    ["perfect see you then", "Does Saturday at 2 work for you?"], // an offer, not a confirmation
    ["perfect see you then", "I can have our sales team meet you Saturday. Mornings or afternoons?"],
    ["saturday at 2 works", "You're all set for Saturday at 2."], // customer named it themselves
    ["can we do 4pm instead", "You're all set for Saturday at 2."], // a reschedule is a new request
    ["how about tomorrow", "You're all set for Saturday at 2."],
    ["perfect see you then", null] // no agent history at all => never blank on a guess
  ];
  for (const [text, agentBody] of keeps) {
    const history = agentBody === null ? undefined : agent(agentBody);
    if (applyTurnUnderstandingBookedSignoffGuard(booked, { text, history }) === null) {
      console.error(`booked-sign-off guard WRONGLY blanked a real schedule: "${text}" after "${agentBody}"`);
      process.exit(1);
    }
  }
  if (applyTurnUnderstandingBookedSignoffGuard(null, { text: "hi", history: agent("You're all set.") }) !== null) {
    console.error("booked-sign-off guard must pass null through unchanged");
    process.exit(1);
  }
}

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
  // Soft-edge cases the trigger-coverage net surfaced (Joe 2026-07-28): the older orchestrateInbound
  // path mislabels these (GENERAL / a trade-appraisal misroute), but the LIVE turn-understanding
  // parser reads them right. Locked in here so that correct comprehension can't regress — and so the
  // de-tangle fix (route the reply through this parser here) is verifiable when done.
  {
    id: "soft_test_ride_take_it_for_a_spin", cat: "scheduling", tier: "scored",
    text: "I'd love to take it for a spin this weekend",
    history: [{ direction: "out", body: "The 2021 Street Glide is in stock. Want to come see it?" }],
    check: p =>
      p?.primaryIntent === "test_ride" || p?.primaryIntent === "scheduling" || hasSchedule(p)
        ? null
        : `"take it for a spin" should read as a test ride, got ${p?.primaryIntent}`
  },
  {
    id: "soft_pricing_how_much_you_looking_to_get", cat: "pricing", tier: "scored",
    text: "how much you looking to get for it",
    history: [{ direction: "out", body: "The 2021 Street Glide is in stock. Want to come see it?" }],
    check: p =>
      p?.primaryIntent === "pricing"
        ? null
        : `customer asking OUR asking price must read as pricing (not trade/appraisal), got ${p?.primaryIntent}`
  },
  // Confirmed misses surfaced by the large-corpus STEP-2 run (2026-07-28) + fixed via parser few-shots.
  {
    id: "corpus_finance_docs", cat: "finance", tier: "scored",
    text: "Hey Scott I have both our pay stubs and proof of address",
    history: [{ direction: "out", body: "To get you pre-approved I just need pay stubs and proof of address." }],
    check: p => (p?.primaryIntent === "finance" ? null : `submitting credit-app docs must read as finance, got ${p?.primaryIntent}`)
  },
  {
    id: "corpus_price_negotiation", cat: "pricing", tier: "scored",
    text: "How bout 30...",
    history: [{ direction: "out", body: "The 2022 Street Glide is listed at $28,995." }, { direction: "in", body: "whats your best price" }],
    check: p => (p?.primaryIntent === "pricing" ? null : `a price negotiation must read as pricing (not scheduling), got ${p?.primaryIntent}`)
  },
  {
    id: "corpus_followup_prompt", cat: "scheduling", tier: "scored",
    text: "Hi Thanks for the follow up that never happened",
    history: [{ direction: "out", body: "I'll follow up with you about setting up a time to come in." }],
    check: p => (p?.primaryIntent === "scheduling" ? null : `prompting for a promised follow-up must read as scheduling, got ${p?.primaryIntent}`)
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
  },

  // ---------- requested_spec capture (hole #1 round 2) ----------
  // The 2nd 1000-text net showed #300's fail-safe over-corrected: bare specs were DROPPED entirely,
  // losing real hold/notify/pickup requests (missed_model 52->130, 65% engine-spec). The requestedSpec
  // slot is the middle path: no fabricated model AND the actionable reference is kept.
  {
    // The run-3 pronoun fabrication: no bike named at all — nothing may be invented.
    id: "spec_no_pronoun_fabrication", cat: "spec-capture", tier: "critical",
    text: "stuck in traffic, about 25 min out — pls dont sell it yet im on my way",
    check: p => noHallucinatedModel(p, "stuck in traffic, about 25 min out — pls dont sell it yet im on my way")
  },
  {
    id: "spec_captured_hold_notify", cat: "spec-capture", tier: "critical",
    text: "can u put that m8 on hold? and text me if any cvo 117s show up",
    check: p => {
      const s = String(p?.requestedSpec?.specText ?? "").toLowerCase();
      if (!(s.includes("m8") || s.includes("117") || s.includes("cvo")))
        return `actionable spec dropped — requestedSpec empty (got ${JSON.stringify(p?.requestedSpec)})`;
      return noHallucinatedModel(p, "can u put that m8 on hold? and text me if any cvo 117s show up");
    }
  },
  {
    id: "spec_captured_pickup_eta", cat: "spec-capture", tier: "scored",
    text: "running like 20 min behind, stuck in traffic. still coming for the 117 pick up so dont sell it.",
    check: p => {
      const s = String(p?.requestedSpec?.specText ?? "").toLowerCase();
      if (!s.includes("117")) return `the 117 pickup reference was dropped (requestedSpec=${JSON.stringify(p?.requestedSpec)})`;
      if (hasSchedule(p)) return `phantom schedule from the ETA: ${JSON.stringify(p?.requestedSchedule)}`;
      return null;
    }
  },
  {
    // Agent offered the specific bike; customer refers back by spec — resolve to the offered bike (or at least keep the spec).
    id: "spec_ctx_agent_offer", cat: "spec-capture", tier: "scored",
    text: "so that 117 is for sale here or u talking about the display at the rally?",
    history: [{ direction: "out", body: "we've got the new 117 cvo on the showroom floor if you wanna come look" }],
    check: p => {
      const s = String(p?.requestedSpec?.specText ?? "").toLowerCase();
      if (families(p).length > 0 || s.includes("117")) return null;
      return `follow-up about the offered 117 lost both model and spec (models=${JSON.stringify(p?.requestedModels)}, spec=${JSON.stringify(p?.requestedSpec)})`;
    }
  },

  // ---------- trade vs buy vs "changed my mind" (hole #2) ----------
  // Fixtures are the real failing texts from the 1000-text stress run (owned_as_requested + trade over_attach).
  // CRITICAL = the dangerous directions: the TRADE bike must never be pitched back as a bike-to-buy, and the
  // customer's OWNED bike must never land in requested_models.
  {
    id: "trade_not_requested", cat: "trade-disentangle", tier: "critical",
    text: "price on the 21 sgs? also wanna trade my softail, when can i swing by to see both?",
    check: p => (families(p).some(f => f.includes("softail"))
      ? `the trade bike (Softail) leaked into requested_models: ${JSON.stringify(p?.requestedModels ?? [])}`
      : (owned(p).includes("softail") ? null : `Softail should be the owned/trade bike, got owned="${owned(p)}"`))
  },
  {
    id: "owned_not_requested", cat: "trade-disentangle", tier: "critical",
    text: "can u give me cash value on my 2016 street glide? also whats final price on that 117?",
    check: p => (families(p).some(f => f.includes("street glide"))
      ? `the customer's OWNED Street Glide leaked into requested_models: ${JSON.stringify(p?.requestedModels ?? [])}`
      : (owned(p).includes("street glide") ? null : `their 2016 Street Glide should be owned/trade, got owned="${owned(p)}"`))
  },
  {
    // "what's my X worth" — a trade valuation of their OWN bike must not duplicate X into requested_models.
    id: "trade_valuation_owned_only", cat: "trade-disentangle", tier: "scored",
    text: "whats my 21 sgs worth on trade",
    check: p => (families(p).length === 0 && owned(p).includes("street glide"))
      ? null : `trade valuation should be owned-only, got requested=${JSON.stringify(p?.requestedModels ?? [])} owned="${owned(p)}"`
  },
  {
    // Change of mind: a DROPPED bike must not be recorded as owned; the NEW bike is what they want.
    id: "rescind_new_want", cat: "trade-disentangle", tier: "scored",
    text: "honestly not the fatbob now — change of plans, maybe the low rider s instead? whatd you say total was?",
    check: p => (families(p).some(f => f.includes("low rider")) && !owned(p).includes("fat bob"))
      ? null : `dropped Fat Bob should not be owned & Low Rider S should be requested, got requested=${JSON.stringify(p?.requestedModels ?? [])} owned="${owned(p)}"`
  },
  {
    id: "rescind_not_owned", cat: "trade-disentangle", tier: "scored",
    text: "actually not the fxlr anymore, think i want the tri glide now. sorry for flip flopping lol",
    check: p => (families(p).some(f => f.includes("tri glide")) && !owned(p).includes("low rider"))
      ? null : `dropped fxlr should not be owned & Tri Glide should be requested, got requested=${JSON.stringify(p?.requestedModels ?? [])} owned="${owned(p)}"`
  },
  {
    // REGRESSION guard: a normal owned+want message must still split correctly (don't over-suppress requested).
    id: "trade_split_regression", cat: "trade-disentangle", tier: "scored",
    text: "trading my ultra limited, want to look at a road glide",
    check: p => (families(p).some(f => f.includes("road glide")) && owned(p).includes("ultra limited"))
      ? null : `must split Ultra Limited=owned / Road Glide=requested, got requested=${JSON.stringify(p?.requestedModels ?? [])} owned="${owned(p)}"`
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
