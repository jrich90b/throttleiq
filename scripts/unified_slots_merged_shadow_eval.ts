/**
 * unified_slots_merged_shadow:eval — pins the parser-consolidation shadow slice
 * (merged 3-in-1 unified slot parser, docs/comprehension_consolidation_plan.md).
 *
 * Deterministic, no LLM calls. Pins:
 *  1. The shared post-parse guard rails (normalize*LLMOutput) — the fail-safe
 *     clamps both the legacy 3-call path and the merged 1-call path run.
 *  2. combineUnifiedSlotParse — the single combiner both paths share.
 *  3. diffUnifiedSlotParse — the shadow comparator (what counts as a
 *     disagreement is itself pinned, so the shadow report is trustworthy).
 *  4. A prompt-mirror tripwire: the merged parser carries a COPY of the legacy
 *     rules until cutover — sentinel rule lines must appear in BOTH prompts.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// The module instantiates an OpenAI client at import; a dummy key keeps this
// eval runnable standalone. No API call is ever made here.
process.env.OPENAI_API_KEY ||= "test-key-not-used";

const {
  normalizeSemanticSlotLLMOutput,
  normalizeTradePayoffLLMOutput,
  normalizeTradeTargetLLMOutput,
  combineUnifiedSlotParse,
  diffUnifiedSlotParse
} = await import("../services/api/src/domain/llmDraft.ts");

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`FAIL ${name}: ${err?.message ?? err}`);
  }
}

// ── 1. trade-payoff guard rails ─────────────────────────────────────────────
check("payoff: explicit no-lien text overrides an LLM has_lien", () => {
  const out = normalizeTradePayoffLLMOutput(
    { payoff_status: "has_lien", needs_lien_holder_info: true, provides_lien_holder_info: false, confidence: 0.9 },
    "No lien no payoff. I own it and have the title."
  );
  assert.equal(out.payoffStatus, "no_lien");
  assert.equal(out.needsLienHolderInfo, false);
  assert.equal(out.providesLienHolderInfo, false);
});

check("payoff: 'still owe' clamps unknown → has_lien", () => {
  const out = normalizeTradePayoffLLMOutput(
    { payoff_status: "unknown", needs_lien_holder_info: false, provides_lien_holder_info: false, confidence: 0.6 },
    "I still owe on it through Eaglemark."
  );
  assert.equal(out.payoffStatus, "has_lien");
});

check("payoff: asking for the lien holder address sets needs info", () => {
  const out = normalizeTradePayoffLLMOutput(
    { payoff_status: "unknown", needs_lien_holder_info: false, provides_lien_holder_info: false, confidence: 0.5 },
    "Do you have the lien holder address?"
  );
  assert.equal(out.payoffStatus, "has_lien");
  assert.equal(out.needsLienHolderInfo, true);
  assert.equal(out.providesLienHolderInfo, false);
});

check("payoff: unrelated message passes through unknown", () => {
  const out = normalizeTradePayoffLLMOutput(
    { payoff_status: "unknown", needs_lien_holder_info: false, provides_lien_holder_info: false, confidence: 0.9 },
    "I can come by Friday afternoon to look at it."
  );
  assert.equal(out.payoffStatus, "unknown");
});

// ── 2. trade-target guard rails ─────────────────────────────────────────────
check("target: concrete 7k target is kept", () => {
  const out = normalizeTradeTargetLLMOutput(
    { has_target_value: true, amount: 7000, raw_text: "close to 7k", confidence: 0.9 },
    "am i anywhere close to 7k for my bike"
  );
  assert.equal(out.hasTargetValue, true);
  assert.equal(out.amount, 7000);
});

check("target: LLM hallucinated amount with no digits in text is rejected", () => {
  const out = normalizeTradeTargetLLMOutput(
    { has_target_value: true, amount: 5000, raw_text: "top dollar", confidence: 0.8 },
    "what can you give me for my bike?"
  );
  assert.equal(out.hasTargetValue, false);
  assert.equal(out.amount, null);
});

// ── 3. semantic-slot guard rails ────────────────────────────────────────────
const semanticCtx = { text: "", history: [] as string[], lead: undefined };

check("semantic: stock question with LLM set_watch overshoot clamps to none", () => {
  const out = normalizeSemanticSlotLLMOutput(
    {
      watch_action: "set_watch",
      watch: { model: "Street Glide", year: "", year_min: 0, year_max: 0, color: "black", condition: "unknown", min_price: 0, max_price: 0, monthly_budget: 0, down_payment: 0 },
      department_intent: "none",
      contact_preference_intent: "none",
      media_intent: "none",
      service_records_intent: false,
      confidence: 0.9
    },
    { ...semanticCtx, text: "do you have any black street glides in stock?" }
  );
  assert.equal(out.watchAction, "none");
  assert.equal(out.watch?.model, "Street Glide");
});

check("semantic: 'text me if ... comes in' with LLM none flips to set_watch", () => {
  const out = normalizeSemanticSlotLLMOutput(
    {
      watch_action: "none",
      watch: { model: "Road Glide 3", year: "", year_min: 0, year_max: 0, color: "", condition: "unknown", min_price: 0, max_price: 0, monthly_budget: 0, down_payment: 0 },
      department_intent: "none",
      contact_preference_intent: "none",
      media_intent: "none",
      service_records_intent: false,
      confidence: 0.9
    },
    { ...semanticCtx, text: "text me if a road glide trike comes in" }
  );
  assert.equal(out.watchAction, "set_watch");
});

check("semantic: parts department kills a watch even with 'in stock' phrasing", () => {
  const out = normalizeSemanticSlotLLMOutput(
    {
      watch_action: "set_watch",
      watch: { model: "Street Glide", year: "2018", year_min: 0, year_max: 0, color: "", condition: "unknown", min_price: 0, max_price: 0, monthly_budget: 0, down_payment: 0 },
      department_intent: "parts",
      contact_preference_intent: "none",
      media_intent: "none",
      service_records_intent: false,
      confidence: 0.95
    },
    { ...semanticCtx, text: "do you have brake pads in stock for my 2018 street glide? let me know if so" }
  );
  assert.equal(out.departmentIntent, "parts");
  assert.equal(out.watchAction, "none");
});

check("semantic: media video cue preserved; call_only without cue stripped", () => {
  const out = normalizeSemanticSlotLLMOutput(
    {
      watch_action: "none",
      watch: { model: "", year: "", year_min: 0, year_max: 0, color: "", condition: "unknown", min_price: 0, max_price: 0, monthly_budget: 0, down_payment: 0 },
      department_intent: "none",
      contact_preference_intent: "call_only",
      media_intent: "video",
      service_records_intent: false,
      confidence: 0.9
    },
    { ...semanticCtx, text: "can you send a walkaround video?" }
  );
  assert.equal(out.mediaIntent, "video");
  assert.equal(out.contactPreferenceIntent, "none");
});

check("semantic: connective-word watch model lifted from the agent's question is rejected + recovered (+15857552622)", () => {
  // Prod +15857552622 (2026-07-04): the parser copied the agent's own "new or
  // used trike" question into watch.model="Or New Trike", which rendered
  // customer-facing as "I'll keep an eye out for Or New Trike". The fail-safe
  // sanitizer must blank the connective-word garbage; the set_watch
  // context-recovery back-fills the real model (Tri Glide) from thread history.
  const out = normalizeSemanticSlotLLMOutput(
    {
      watch_action: "set_watch",
      watch: { model: "Or New Trike", year: "", year_min: 0, year_max: 0, color: "", condition: "new", min_price: 0, max_price: 0, monthly_budget: 0, down_payment: 0 },
      department_intent: "none",
      contact_preference_intent: "none",
      media_intent: "none",
      service_records_intent: false,
      confidence: 0.9
    },
    {
      ...semanticCtx,
      text: "keep an eye out for a used tri glide",
      history: [
        "are you looking at any particular trike model (Freewheeler, Tri Glide, or open to either)?",
        "I'll keep an eye out for a used tri glide and text you as soon as one comes in."
      ]
    }
  );
  assert.equal(out.watchAction, "set_watch");
  assert.notEqual(out.watch?.model, "Or New Trike");
  assert.ok(!/^\s*(?:or|and|either|both)\b/i.test(String(out.watch?.model ?? "")), `leading-connective garbage survived: ${out.watch?.model}`);
  assert.ok(!/\b(?:new|used|open|either|both)\b/i.test(String(out.watch?.model ?? "")), `qualifier garbage survived: ${out.watch?.model}`);
  assert.match(String(out.watch?.model ?? ""), /tri glide/i);
});

check("semantic: a legitimate two-model 'X or Y' watch list is NOT blanked by the sanitizer", () => {
  // Non-regression for the garbage guard: "XG500 or XG750" is a real two-model
  // list a rep genuinely watches for — 'or' mid-string with no leading connective
  // and no condition word must survive (contrast with lifted "Or New Trike").
  const out = normalizeSemanticSlotLLMOutput(
    {
      watch_action: "set_watch",
      watch: { model: "XG500 or XG750", year: "", year_min: 0, year_max: 0, color: "", condition: "unknown", min_price: 0, max_price: 0, monthly_budget: 0, down_payment: 0 },
      department_intent: "none",
      contact_preference_intent: "none",
      media_intent: "none",
      service_records_intent: false,
      confidence: 0.95
    },
    { ...semanticCtx, text: "keep an eye out for a XG500 or XG750 for me" }
  );
  assert.equal(out.watchAction, "set_watch");
  assert.equal(out.watch?.model, "XG500 or XG750");
});

// ── 4. combiner ─────────────────────────────────────────────────────────────
check("combine: all-null input returns null", () => {
  assert.equal(combineUnifiedSlotParse(null, null, null), null);
});

check("combine: confidence is the MIN across jobs; target maps to amount object", () => {
  const out = combineUnifiedSlotParse(
    { watchAction: "none", watch: {}, departmentIntent: "none", confidence: 0.9 } as any,
    { payoffStatus: "has_lien", needsLienHolderInfo: false, providesLienHolderInfo: false, confidence: 0.8 } as any,
    { hasTargetValue: true, amount: 7000, rawText: "need 7k", confidence: 0.95 } as any
  );
  assert.ok(out);
  assert.equal(out!.confidence, 0.8);
  assert.equal(out!.payoffStatus, "has_lien");
  assert.equal(out!.tradeTargetValue?.amount, 7000);
});

check("combine: missing trade job defaults to unknown/false/false", () => {
  const out = combineUnifiedSlotParse(
    { watchAction: "none", watch: {}, departmentIntent: "none", confidence: 0.9 } as any,
    null,
    null
  );
  assert.ok(out);
  assert.equal(out!.payoffStatus, "unknown");
  assert.equal(out!.needsLienHolderInfo, false);
  assert.equal(out!.tradeTargetValue ?? null, null);
});

// ── 5. shadow comparator ────────────────────────────────────────────────────
const base = () => ({
  watchAction: "set_watch" as const,
  watch: { model: "Street Glide", year: "2023", yearMin: null, yearMax: null, color: "black", condition: "used" as const, minPrice: null, maxPrice: 18000, monthlyBudget: null, downPayment: null },
  departmentIntent: "none" as const,
  contactPreferenceIntent: "none" as const,
  mediaIntent: "none" as const,
  serviceRecordsIntent: false,
  payoffStatus: "unknown" as const,
  needsLienHolderInfo: false,
  providesLienHolderInfo: false,
  tradeTargetValue: null,
  confidence: 0.9
});

check("diff: identical parses are equal", () => {
  const { equal, diffs } = diffUnifiedSlotParse(base(), base());
  assert.equal(equal, true);
  assert.equal(diffs.length, 0);
});

check("diff: case/whitespace and 0-vs-null are NOT disagreements", () => {
  const a = base();
  const b = base();
  b.watch.model = "  street glide ";
  (b.watch as any).minPrice = 0;
  (b as any).contactPreferenceIntent = undefined;
  const { equal } = diffUnifiedSlotParse(a, b);
  assert.equal(equal, true);
});

check("diff: real field changes are each named", () => {
  const a = base();
  const b = base();
  b.watchAction = "none" as any;
  b.payoffStatus = "has_lien" as any;
  (b as any).tradeTargetValue = { amount: 7000 };
  const { equal, diffs } = diffUnifiedSlotParse(a, b);
  assert.equal(equal, false);
  const fields = diffs.map(d => d.field).sort();
  assert.deepEqual(fields, ["payoffStatus", "tradeTargetValue.amount", "watchAction"]);
});

check("diff: semantic scope ignores payoff/target fields (legacy didn't run them)", () => {
  const a = base();
  const b = base();
  b.payoffStatus = "has_lien" as any;
  (b as any).tradeTargetValue = { amount: 7000 };
  const scoped = diffUnifiedSlotParse(a, b, { scope: "semantic" });
  assert.equal(scoped.equal, true);
  b.watchAction = "none" as any;
  const scoped2 = diffUnifiedSlotParse(a, b, { scope: "semantic" });
  assert.equal(scoped2.equal, false);
  assert.deepEqual(scoped2.diffs.map(d => d.field), ["watchAction"]);
});

// ── 5b. decision-scoped watch slots ─────────────────────────────────────────
// Watch slot fields (model/year/color/condition/price) are inert scratch notes on a NON-watch
// turn — both parsers guess them, downstream ignores them. A slot disagreement there is not a
// decision disagreement and must NOT count (this is the fix that lifts the shadow's headline
// agreement from ~73% to the true, decision-relevant number).
const none = () => ({
  watchAction: "none" as const,
  watch: { model: "", year: "", yearMin: null, yearMax: null, color: "", condition: "unknown" as const, minPrice: null, maxPrice: null, monthlyBudget: null, downPayment: null },
  departmentIntent: "none" as const,
  contactPreferenceIntent: "none" as const,
  mediaIntent: "none" as const,
  serviceRecordsIntent: false,
  payoffStatus: "unknown" as const,
  needsLienHolderInfo: false,
  providesLienHolderInfo: false,
  tradeTargetValue: null,
  confidence: 0.9
});

check("diff: watch-slot disagreement on a NON-watch turn is ignored (both watchAction=none)", () => {
  const a = none();
  const b = none();
  // merged fabricated a bike from noise; legacy left it blank — both watchAction=none.
  b.watch.model = "Street Glide" as any;
  b.watch.year = "2013" as any;
  b.watch.color = "vivid black" as any;
  b.watch.condition = "used" as any;
  const { equal, diffs } = diffUnifiedSlotParse(a, b, { scope: "semantic" });
  assert.equal(equal, true, `expected agree (inert slots), got diffs: ${JSON.stringify(diffs)}`);
});

check("diff: watch-slot disagreement DOES count when a watch is actually being set", () => {
  const a = base();          // watchAction=set_watch, model=Street Glide
  const b = base();
  b.watch.model = "Road Glide" as any;
  const { equal, diffs } = diffUnifiedSlotParse(a, b, { scope: "semantic" });
  assert.equal(equal, false);
  assert.ok(diffs.some(d => d.field === "watch.model"), "watch.model diff must surface on a real watch turn");
});

check("diff: watch-slot disagreement counts when only ONE side sets a watch (active on either side)", () => {
  const a = base();          // legacy: set_watch on Street Glide
  const b = none();          // merged: missed it entirely (none, blank)
  const { equal, diffs } = diffUnifiedSlotParse(a, b, { scope: "semantic" });
  assert.equal(equal, false);
  const fields = diffs.map(d => d.field);
  assert.ok(fields.includes("watchAction"), "a missed watch must surface as a watchAction diff");
  assert.ok(fields.includes("watch.model"), "slots compared because legacy side is an active watch");
});

// ── 6. prompt-mirror tripwire ───────────────────────────────────────────────
// The merged parser carries a copy of the legacy rules until cutover. Sentinel
// rule lines must appear at least twice in llmDraft.ts (legacy + merged copy) —
// a one-sided edit breaks this and fails the gate.
check("mirror: sentinel rule lines exist in BOTH the legacy and merged prompts", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "services/api/src/domain/llmDraft.ts"),
    "utf8"
  );
  const sentinels = [
    "watch_action=set_watch only when the customer asks to be notified/updated",
    "payoff_status=no_lien when customer says they own it, have title",
    "Detect when customer states a specific trade value target for their bike."
  ];
  for (const sentinel of sentinels) {
    const count = source.split(sentinel).length - 1;
    assert.ok(
      count >= 2,
      `sentinel "${sentinel.slice(0, 50)}…" appears ${count}x — legacy and merged prompts have drifted apart`
    );
  }
});

// ── 7. anti-fabrication rule present in the merged prompt ────────────────────
// The merged prompt intentionally LEADS legacy on anti-fabrication (2026-07-10 shadow soak: it
// invented watch bikes from URLs / App-IDs / survey blobs). This rule must not be silently dropped.
check("merged prompt carries the anti-fabrication watch rule + a URL negative example", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "services/api/src/domain/llmDraft.ts"),
    "utf8"
  );
  assert.ok(
    source.includes("NEVER populate watch.model/year/color/condition/price from URLs"),
    "anti-fabrication watch rule missing from the merged prompt"
  );
  assert.ok(
    source.includes("hdnetportal.sharepoint.com"),
    "URL negative example missing from the merged semantic examples"
  );
});

if (failures > 0) {
  console.error(`unified_slots_merged_shadow:eval FAILED (${failures} case(s))`);
  process.exit(1);
}
console.log("unified_slots_merged_shadow:eval OK");
