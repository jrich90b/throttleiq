/**
 * Cadence-quality judge eval (STEP 1 — shadow). Judge #3 of the self-correcting loop.
 *
 * The draft + no-response judges only fire on INBOUND-triggered turns, so the proactive follow-up
 * cadence (the nudges WE initiate) was unjudged by the loop. judgeCadenceQualityWithLLM scores a
 * cadence message about to go out on four axes — send_worthy / state_fit / tone_ok (real employee,
 * never a bot) / disposition_ok — and the pure gate (decideCadenceQualityGate) maps the verdict to
 * pass / regenerate / suppress / hold. STEP 1 ships DARK: it only shadow-logs; suppressing or
 * rewording a live cadence touch is a later, approve-first step.
 *
 * Layers: (1) source guard (judge + gate + flags exist; the shadow hook is wired at the cadence
 * emit; enforce is flag-gated + default-off), (2) pure decision table (pass on good / low-confidence /
 * no-verdict; act only on a confident non-good verdict; live only when the flag is on), (3) LLM
 * coverage — a concrete warm nudge is good; a bare "just checking in" is suppress; a corporate-bot
 * message fails tone_ok.
 *
 * Run gated: LLM_ENABLED=1 LLM_CADENCE_QUALITY_JUDGE_ENABLED=1 npx tsx scripts/cadence_quality_judge_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { judgeCadenceQualityWithLLM } from "../services/api/src/domain/llmDraft.ts";
import {
  formatCadenceQualityInventoryFacts,
  buildCadenceQualityJudgeArgs,
  type CadenceQualityInventoryFacts
} from "../services/api/src/domain/cadenceQualityFacts.ts";
import { decideCadenceQualityGate, DRAFT_QUALITY_MIN_CONFIDENCE } from "../services/api/src/domain/draftQualityGate.ts";

// --- 1) Source guard (no LLM). ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
const gate = fs.readFileSync("services/api/src/domain/draftQualityGate.ts", "utf8");

assert.ok(/export async function judgeCadenceQualityWithLLM/.test(llm), "the judge must be exported from llmDraft.ts");
assert.ok(/CADENCE_QUALITY_JUDGE_JSON_SCHEMA/.test(llm), "the strict JSON schema const must exist");
assert.ok(/LLM_CADENCE_QUALITY_JUDGE_ENABLED/.test(llm), "the judge must be behind an enable flag");
assert.ok(/export function decideCadenceQualityGate/.test(gate), "the pure gate must be in draftQualityGate.ts");
assert.ok(
  /CADENCE_QUALITY_JUDGE_ENABLED/.test(gate) && /CADENCE_QUALITY_JUDGE_SHADOW/.test(gate),
  "the live-enable + shadow flags must exist"
);
const callSites = (index.match(/void runCadenceQualityJudgeShadow\(/g) || []).length;
assert.ok(callSites >= 1, `the shadow hook must be wired at the cadence emit; found ${callSites}`);
// ENFORCE (STEP 2) is flag-gated and default OFF: when off, the shadow hook runs and the cadence draft
// is NOT altered (byte-identical behavior); enforcement only holds a `suppress` touch under the flag.
// The suppress-only enforce + flag defaults are pinned behaviorally by cadence_quality_enforce:eval.
assert.ok(
  /if \(isCadenceQualityEnforceEnabled\(\)\)/.test(index) && /enfDecision\?\.action === "suppress"/.test(index),
  "cadence enforce must be wired behind the CADENCE_QUALITY_ENFORCE flag (suppress-only)"
);
assert.ok(
  /export function isCadenceQualityEnforceEnabled/.test(gate) && /CADENCE_QUALITY_ENFORCE\b/.test(gate),
  "the enforce flag helper must exist and default off (shadow), so the flip is opt-in and reversible"
);

// --- 2) Decision-table coverage (pure). ---
type V = Parameters<typeof decideCadenceQualityGate>[0]["verdict"];
type Row = { id: string; input: Parameters<typeof decideCadenceQualityGate>[0]; action: string; live: boolean };
const rows: Row[] = [
  { id: "no_verdict_pass", input: { enabled: true, verdict: null }, action: "pass", live: false },
  { id: "good_pass", input: { enabled: true, verdict: { overall: "good", confidence: 0.95 } as V }, action: "pass", live: false },
  { id: "suppress_shadow_when_off", input: { enabled: false, verdict: { overall: "suppress", confidence: 0.95 } as V }, action: "suppress", live: false },
  { id: "suppress_live_when_on", input: { enabled: true, verdict: { overall: "suppress", confidence: 0.95 } as V }, action: "suppress", live: true },
  { id: "regenerate_live_when_on", input: { enabled: true, verdict: { overall: "needs_regenerate", confidence: 0.95 } as V }, action: "regenerate", live: true },
  { id: "hold_live_when_on", input: { enabled: true, verdict: { overall: "hold", confidence: 0.95 } as V }, action: "hold", live: true },
  { id: "below_confidence_pass", input: { enabled: true, verdict: { overall: "suppress", confidence: DRAFT_QUALITY_MIN_CONFIDENCE - 0.01 } as V }, action: "pass", live: false },
  { id: "at_floor_acts", input: { enabled: true, verdict: { overall: "suppress", confidence: DRAFT_QUALITY_MIN_CONFIDENCE } as V }, action: "suppress", live: true }
];
for (const r of rows) {
  const d = decideCadenceQualityGate(r.input);
  assert.equal(d.action, r.action, `gate[${r.id}] action expected ${r.action}, got ${d.action}`);
  assert.equal(d.live, r.live, `gate[${r.id}] live expected ${r.live}, got ${d.live}`);
}

// --- 3) LLM coverage (gated; skips cleanly). ---
// The two sentinels must never collapse: matched-but-unpriced PROTECTS an honest deferral, while
// never-matched means we know nothing. A single sentinel would grade an unmatched unit as unpriced.
{
  const unpriced = formatCadenceQualityInventoryFacts({ matched: true, status: "available", listPrice: null });
  const missing = formatCadenceQualityInventoryFacts({ matched: false, status: "unknown", listPrice: null });
  const priced = formatCadenceQualityInventoryFacts({ matched: true, status: "available", listPrice: 18995 });
  assert.match(unpriced, /UNPRICED_NO_SET_PRICE/, "an unpriced matched unit must say so explicitly");
  assert.match(unpriced, /DEFERRING a price question is the CORRECT/i, "the unpriced block must protect an honest deferral");
  assert.match(missing, /NOT_MATCHED/, "an unmatched unit must say NOT_MATCHED");
  assert.doesNotMatch(missing, /UNPRICED_NO_SET_PRICE/, "never-matched must NOT be reported as unpriced");
  assert.match(priced, /\$18,995/, "a priced unit must state its list price for the judge to audit against");
  assert.doesNotMatch(priced + unpriced + missing, /21,?5/, "the internal target-price note must never reach the prompt");
}

// WIRING, EXECUTED — not grepped. The LLM cases below hand `inventory` straight to the judge, so
// they keep passing even if production stops supplying it (a sabotage on 2026-08-06 proved exactly
// that). This calls the real assembly the cadence path uses and asserts the facts are actually
// resolved and attached.
{
  const withUnit = await buildCadenceQualityJudgeArgs({
    conv: { lead: { vehicle: { stockId: "U590-17", vin: "" } } },
    message: "test",
    channel: "sms"
  });
  assert.ok(
    withUnit.inventory && typeof withUnit.inventory.matched === "boolean",
    "a lead naming a unit must get resolved inventory facts attached to the judge args"
  );
  const withoutUnit = await buildCadenceQualityJudgeArgs({
    conv: { lead: { vehicle: {} } },
    message: "test",
    channel: "sms"
  });
  assert.equal(
    withoutUnit.inventory,
    null,
    "a lead naming no unit must attach null — never a fabricated NOT_MATCHED assertion"
  );
  assert.ok("lead" in withUnit && "sale" in withUnit, "the assembly must still carry lead + sale");
}

const cases: {
  id: string;
  message: string;
  history?: { direction: "in" | "out"; body: string }[];
  inventory?: CadenceQualityInventoryFacts | null;
  assert: (v: NonNullable<Awaited<ReturnType<typeof judgeCadenceQualityWithLLM>>>) => void;
}[] = [
  {
    id: "concrete_warm_nudge",
    message: "Hey Charlie, the 2026 Street Glide in Vivid Black just landed — want to come take a look this week?",
    assert: v => assert.equal(v.overall, "good", `concrete warm nudge should be good, got ${v.overall} (${v.reason})`)
  },
  {
    id: "bare_check_in",
    message: "Just checking in!",
    assert: v => assert.equal(v.overall, "suppress", `bare check-in should suppress, got ${v.overall} (${v.reason})`)
  },
  // --- Ground-truth cases from a hand-labelled sample of LIVE judge calls (2026-08-05). The judge
  // scored 8 of 13 correctly; all three shapes below are ones it got WRONG, so they are the fixtures.
  {
    // Tim, 2026-08-01: judged suppress @0.88 ("no new info"), went out anyway, and the customer
    // replied "Thanks allot Scott you're very professional. Nancy wanted me to tell you thank you
    // so much". Warmth is a reason to send; the empty-ping rule is for sales nudges, not gratitude.
    id: "post_sale_warmth_is_send_worthy",
    message:
      "Hi Tim — this is Scott at American Harley-Davidson. Congrats on your Tri Glide Ultra! If you need anything, just let me know.",
    assert: v =>
      assert.notEqual(
        v.overall,
        "suppress",
        `a warm post-sale congratulations must not be suppressed for 'no new info', got ${v.overall} (${v.reason})`
      )
  },
  {
    // Mark, 2026-08-01: judged GOOD @0.9 for having "a concrete reason (price drop)". The $4,000
    // promotion belongs to a NEW bike; this lead is a USED 2017 (stock U590-17). A money claim
    // borrowed from another unit is a fabrication, not a concrete reason.
    id: "discount_borrowed_from_another_unit_is_not_good",
    message:
      "Hey Mark, quick update on the Breakout: Save $4,000 off list price. Want me to send a short pricing and payment breakdown? Still watching for something with Custom Colour Laguna Orange (stock U590-17) for you.",
    history: [
      { direction: "in" as const, body: "WEB LEAD (ADF) Year: 2017 Vehicle: Harley-Davidson Breakout Stock: U590-17 (pre-owned)" },
      { direction: "out" as const, body: "Hey Mark, thanks for your inquiry about the 2017 Breakout. If you'd like to stop in and check it out, just say the word." }
    ],
    assert: v =>
      assert.notEqual(
        v.overall,
        "good",
        `a $4,000 new-bike discount attached to a used 2017 unit must not pass as good, got ${v.overall} (${v.reason})`
      )
  },
  {
    // Clifton, 2026-08-04: judged GOOD @0.9 as a "concrete, relevant update about availability" —
    // two turns after we told him we were taking one in next week. It contradicts our own last word.
    id: "contradicts_our_own_previous_message",
    message:
      "Hey Clifton, quick update on the Freewheeler: I'm not seeing one available right now. I can help pick another bike for a test ride or keep an eye out for one.",
    history: [
      {
        direction: "out" as const,
        body: "Hey Clifton, quick update on the Freewheeler: I'm going to be taking in a pre-owned 2016 with about 6,800 miles on it next week. Would that be something you'd want to see?"
      },
      { direction: "in" as const, body: "Sounds good" }
    ],
    assert: v =>
      assert.equal(
        v.stateFit,
        false,
        `a message contradicting our own previous turn must fail state_fit, got state_fit=${v.stateFit} (${v.reason})`
      )
  },
  // --- INVENTORY GROUND TRUTH (Joe, 2026-08-06). Four cases, and the two CONTROLS matter as much
  // as the two catches: without them we would fix hallucinated prices by punishing honest ones.
  {
    // The unit is UNPRICED in the feed. Declining to quote is the correct, safe reply. This exact
    // draft was disposed no-action on 2026-08-05 — the rep had said the bike still needed to go
    // through service, so the deferral was right and the wrong_fact grade against it was wrong.
    id: "control_safe_deferral_on_unpriced_unit_must_pass",
    message:
      "I'll have the team confirm the current price on the 2023 Street Glide Special and send it over.",
    inventory: { matched: true, status: "available", listPrice: null },
    assert: v =>
      assert.notEqual(
        v.overall,
        "hold",
        `deferring a quote on an UNPRICED unit is correct and must not be held, got ${v.overall} (${v.reason})`
      )
  },
  {
    // A promotion that belongs to a different (new) unit, asserted on a used one the feed prices
    // at $18,995. Judged good@0.9 in production for having "a concrete reason".
    id: "promo_not_supported_by_inventory_facts",
    message: "Hey Mark, quick update on the Breakout: Save $4,000 off list price. Want a payment breakdown?",
    inventory: { matched: true, status: "available", listPrice: 18995 },
    history: [
      { direction: "in" as const, body: "WEB LEAD (ADF) Year: 2017 Vehicle: Harley-Davidson Breakout Stock: U590-17 (pre-owned)" }
    ],
    assert: v =>
      assert.equal(
        v.stateFit,
        false,
        `a $4,000 discount unsupported by the inventory facts must fail state_fit, got state_fit=${v.stateFit} (${v.reason})`
      )
  },
  {
    // We know nothing about this unit. A DENIAL is as unsupported as a claim — the judge must not
    // treat an empty feed match as evidence the bike is gone.
    id: "control_not_matched_denial_is_also_unsupported",
    message: "Hey Clifton, quick update on the Freewheeler: I'm not seeing one available right now.",
    inventory: { matched: false, status: "unknown", listPrice: null },
    history: [
      {
        direction: "out" as const,
        body: "Hey Clifton, quick update on the Freewheeler: I'm taking a pre-owned 2016 in next week. Would that be something you'd want to see?"
      }
    ],
    assert: v =>
      assert.equal(
        v.stateFit,
        false,
        `an availability denial contradicting our own last turn must fail state_fit, got state_fit=${v.stateFit} (${v.reason})`
      )
  },
  {
    id: "corporate_bot",
    message:
      "Per your inquiry, we would be delighted to assist you in exploring our wide range of options at your earliest convenience.",
    assert: v => assert.equal(v.toneOk, false, `corporate-bot copy should fail tone_ok, got tone_ok=${v.toneOk} (${v.reason})`)
  }
];

let ran = 0;
for (const c of cases) {
  const v = await judgeCadenceQualityWithLLM({ message: c.message, channel: "sms", history: c.history, inventory: c.inventory });
  if (!v) continue; // judge disabled / transient null — skip, don't red the gate
  ran += 1;
  c.assert(v);
}

console.log(
  ran === 0
    ? `PASS cadence quality judge eval (source guard + ${rows.length} decision-table rows; LLM coverage skipped — judge disabled)`
    : `PASS cadence quality judge eval (source guard + ${rows.length} decision-table rows + ${ran}/${cases.length} LLM coverage cases)`
);
