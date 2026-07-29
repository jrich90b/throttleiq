/**
 * Model-discontinuation eval (no LLM) — pins the pure decision AND validates the data interface
 * against the real MSRP sheet. 4-pillar shape; iterations are the adversarial pillar.
 * Run: npx tsx scripts/model_discontinuation_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  decideModelDiscontinuation,
  MSRP_MATCH_MIN_SCORE,
  buildDiscontinuedModelReply,
  buildDiscontinuedFactoryOrderReply,
  decideInitialAdfOrderAnswer,
  modelDiscontinuationReplyEnabled,
  type DiscontinuationStatus
} from "../services/api/src/domain/modelDiscontinuation.ts";
import { findModelInMsrp, MSRP_SHEET_MODEL_YEAR } from "../services/api/src/domain/msrpPriceList.ts";

const YEAR = MSRP_SHEET_MODEL_YEAR; // fresh sheet
type Case = { pillar: 1 | 2 | 3 | 4; id: string; in: any; status: string };
const cases: Case[] = [
  // 1. SATISFIED / keep (must NOT be called discontinued)
  { pillar: 1, id: "in_inventory_wins", in: { inInventory: true, msrpMatchScore: 0, sheetModelYear: YEAR, currentYear: YEAR }, status: "available" }, // carryover stock
  { pillar: 1, id: "current_in_catalog", in: { inInventory: false, msrpMatchScore: 90, sheetModelYear: YEAR, currentYear: YEAR }, status: "current" },
  // 2. THE TARGET: absent from catalog + not in inventory, fresh sheet -> discontinued
  { pillar: 2, id: "fat_bob_discontinued", in: { inInventory: false, msrpMatchScore: 0, sheetModelYear: YEAR, currentYear: YEAR }, status: "discontinued" },
  // 3. EDGES
  { pillar: 3, id: "stale_sheet_unknown", in: { inInventory: false, msrpMatchScore: 0, sheetModelYear: 2026, currentYear: 2029 }, status: "unknown" }, // sheet too old to trust
  { pillar: 3, id: "borderline_match_unknown", in: { inInventory: false, msrpMatchScore: 40, sheetModelYear: YEAR, currentYear: YEAR }, status: "unknown" },
  { pillar: 3, id: "at_threshold_is_current", in: { inInventory: false, msrpMatchScore: MSRP_MATCH_MIN_SCORE, sheetModelYear: YEAR, currentYear: YEAR }, status: "current" },
  // 4. ADVERSARIAL — iterations / don't-false-flag
  { pillar: 4, id: "iteration_low_rider_current", in: { inInventory: false, msrpMatchScore: 80, sheetModelYear: YEAR, currentYear: YEAR }, status: "current" }, // "Low Rider" matched "Low Rider S"
  { pillar: 4, id: "in_stock_but_not_catalog", in: { inInventory: true, msrpMatchScore: 0, sheetModelYear: YEAR, currentYear: YEAR }, status: "available" }
];
const byPillar: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
for (const c of cases) {
  const got = decideModelDiscontinuation(c.in);
  assert.equal(got.status, c.status, `[P${c.pillar} ${c.id}] expected ${c.status}, got ${got.status} (${got.reason})`);
  byPillar[c.pillar]++;
}

// --- Real-data validation against the actual MSRP sheet (the case that started this) ---
const fatBob = await findModelInMsrp("Fat Bob");
const fatBob114 = await findModelInMsrp("Fat Bob 114"); // the exact iteration Mark referenced
const lowRider = await findModelInMsrp("Low Rider"); // a CURRENT model's base name -> must match S/ST
assert.equal(fatBob.matched, false, `Fat Bob must be ABSENT from the 2026 sheet (score ${fatBob.score})`);
assert.equal(fatBob114.matched, false, `Fat Bob 114 must be ABSENT (score ${fatBob114.score})`);
assert.equal(lowRider.matched, true, `Low Rider must MATCH a current iteration (got score ${lowRider.score}, family ${lowRider.family})`);
// end-to-end: Fat Bob, no inventory, fresh sheet -> discontinued; Low Rider -> current
assert.equal(decideModelDiscontinuation({ inInventory: false, msrpMatchScore: fatBob.score, sheetModelYear: YEAR, currentYear: YEAR }).status, "discontinued", "Fat Bob resolves to discontinued");
assert.equal(decideModelDiscontinuation({ inInventory: false, msrpMatchScore: lowRider.score, sheetModelYear: YEAR, currentYear: YEAR }).status, "current", "Low Rider resolves to current (iteration safe)");

// --- reply builder: acknowledges, names the model, offers numbers/alternatives, no fabricated availability ---
const reply = buildDiscontinuedModelReply("Harley-Davidson Fat Bob");
assert.ok(/Fat Bob/.test(reply) && !/Harley-Davidson Fat Bob/.test(reply), "names the model, make-prefix stripped");
assert.ok(/not carrying/i.test(reply), "acknowledges discontinuation honestly");
assert.ok(/numbers|options/i.test(reply) && /\?$/.test(reply.trim()), "offers numbers/alternatives + a question");
assert.ok(!/in stock|still available|available right now/i.test(reply), "must NOT fabricate availability");

// --- dark by default ---
delete process.env.MODEL_DISCONTINUATION_REPLY_ENABLED;
assert.equal(modelDiscontinuationReplyEnabled(), false, "ships DARK — flag off by default");

// --- source guard: orchestrateInbound wires the precedence behind the flag, both paths ---
const orch = fs.readFileSync("services/api/src/domain/orchestrator.ts", "utf8");
assert.ok(/from "\.\/modelDiscontinuation\.js"/.test(orch), "orchestrator imports the discontinuation module");
assert.ok(/modelDiscontinuationReplyEnabled\(\)/.test(orch), "the guard is gated by the flag (dark by default)");
assert.ok(/resolveModelDiscontinuation\(/.test(orch) && /buildDiscontinuedModelReply\(/.test(orch), "orchestrator resolves status + builds the reply");
assert.ok(/disc\.status === "discontinued"/.test(orch), "only a confident 'discontinued' triggers the reply");

// --- initial-ADF factory-order answer: never promise an order on a model the factory stopped building ---
// (+15416478489 Mark Griffin 7/29: a 2023 Fat Bob 114 ADF drew "factory orders are usually around 6 to
// 12 weeks". The SMS path already diverted; the initial-ADF order branch returned early and bypassed it.)
const orderCases: { id: string; status: DiscontinuationStatus; answer: string }[] = [
  // THE TARGET — the only status that may divert
  { id: "discontinued_diverts", status: "discontinued", answer: "discontinued" },
  // Everything short of confident stays on the ordinary answer — removing this decision is a no-op
  { id: "current_keeps_order", status: "current", answer: "factory_order" },
  { id: "available_keeps_order", status: "available", answer: "factory_order" },
  { id: "unknown_keeps_order", status: "unknown", answer: "factory_order" }
];
for (const c of orderCases) {
  const got = decideInitialAdfOrderAnswer({ modelStatus: c.status });
  assert.equal(got.answer, c.answer, `[order ${c.id}] expected ${c.answer}, got ${got.answer} (${got.reason})`);
}

const orderReply = buildDiscontinuedFactoryOrderReply("Harley-Davidson Fat Bob 114");
assert.ok(/Fat Bob 114/.test(orderReply) && !/Harley-Davidson Fat Bob/.test(orderReply), "names the model, make-prefix stripped");
assert.ok(/no longer sells/i.test(orderReply) && /can’t factory-order|cannot factory-order/i.test(orderReply), "answers the ORDER question, not just availability");
assert.ok(/pre-owned/i.test(orderReply), "points at the real path (pre-owned) — the customer's actual out");
assert.ok(!/6 to 12 weeks|in stock|still available/i.test(orderReply), "must NOT promise order timing or fabricate stock");
// The Street 750 hardcode this generalizes must still produce the same shape.
assert.ok(/Street 750/.test(buildDiscontinuedFactoryOrderReply("Street 750")), "generalizes the Street 750 one-off");

// --- source guard: BOTH initial-ADF order branches consult the guard, behind the same kill switch ---
const adf = fs.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");
assert.ok(/decideInitialAdfOrderAnswer\(/.test(adf), "ADF path uses the pure decision");
assert.ok(/modelDiscontinuationReplyEnabled\(\)/.test(adf), "ADF path shares the orchestrator's kill switch");
const orderBranchHits = adf.match(/resolveInitialAdfOrderAnswer\(conv\)\) === "discontinued"/g) ?? [];
assert.equal(orderBranchHits.length, 2, `both order branches (parser-accepted + lexical fallback) must be guarded, found ${orderBranchHits.length}`);
assert.ok(/buildDiscontinuedFactoryOrderReply\(/.test(adf), "ADF path builds the order-framed reply");

// --- parser side: the comprehension miss that started it is pinned as a few-shot ---
const draft = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
assert.ok(
  /Do any dealers have this bike in stock or do I need to find a used one\?/.test(draft),
  "the Mark Griffin inbound is a faq-topic few-shot (must read as availability, not factory_order_timing)"
);

console.log(`PASS model-discontinuation — ${cases.length} decision cases (4 pillars: ${byPillar[1]}/${byPillar[2]}/${byPillar[3]}/${byPillar[4]}) + real-sheet validation + reply builder + dark-flag + orchestrator source guard + ${orderCases.length} initial-ADF order cases + ADF branch/parser guards.`);
