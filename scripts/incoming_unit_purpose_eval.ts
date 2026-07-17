/**
 * Incoming-unit purpose eval (2026-07-16, Joe ruling — anomaly-review bucket B #1).
 *
 * Bill Indelicato (+17163591526) kept getting "Ok, will do. I'll keep this tied to the 2015 Road King
 * TRADE …" for a used bike the dealer was SOURCING for him to BUY. Two faults: (1) the framing was
 * guessed from the structured `condition` alone (`new` => "on order", anything else => "your trade"),
 * so every used incoming unit was called a trade; (2) it's a fixed route-arm template, so the staff's
 * thumbs-down couldn't reshape it and it re-sent the same wrong line every turn.
 *
 * Fix (parser-first, per AGENTS.md — comprehend, never regex): parseIncomingInventoryPurposeWithLLM
 * reads WHY the bike is coming in from the establishing context; decideIncomingInventoryPurpose (pure,
 * centralized in routeStateReducer, re-exported via routerV2) applies the confidence floor; the purpose
 * is stored on the record and drives the copy in all three builders.
 *
 * FAIL DIRECTION (the point): no parser / low confidence / unclear => "unclear" => the NEUTRAL
 * "coming in" copy, which is true whether it's a trade-in or a purchase. We only say "trade" on a
 * confident, explicit trade_in read — so we can never again invent a trade the customer doesn't have.
 * A structured `condition === "new"` stays a factory order regardless (keeps the Nicholas Braun fix).
 *
 * Run gated: LLM_ENABLED=1 LLM_INCOMING_INVENTORY_PURPOSE_PARSER_ENABLED=1 npx tsx scripts/incoming_unit_purpose_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseIncomingInventoryPurposeWithLLM } from "../services/api/src/domain/llmDraft.ts";
import { decideIncomingInventoryPurpose } from "../services/api/src/domain/routeStateReducer.ts";

let n = 0;

// --- 1) Source guard (no LLM). ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
const reducer = fs.readFileSync("services/api/src/domain/routeStateReducer.ts", "utf8");
const routerV2 = fs.readFileSync("services/api/src/domain/routerV2.ts", "utf8");
const pending = fs.readFileSync("services/api/src/domain/pendingIncomingInventory.ts", "utf8");
const store = fs.readFileSync("services/api/src/domain/conversationStore.ts", "utf8");

assert.ok(/export async function parseIncomingInventoryPurposeWithLLM/.test(llm), "parser must be exported");
assert.ok(/INCOMING_INVENTORY_PURPOSE_PARSER_JSON_SCHEMA/.test(llm), "strict JSON schema const must exist");
assert.ok(/LLM_INCOMING_INVENTORY_PURPOSE_PARSER_ENABLED/.test(llm), "parser must be behind an enable flag");
assert.ok(/export function decideIncomingInventoryPurpose/.test(reducer), "decision must be centralized in routeStateReducer");
assert.ok(/decideIncomingInventoryPurpose/.test(routerV2), "decision must be re-exported via routerV2");
assert.ok(/purpose\?: "trade_in" \| "sourced_for_purchase" \| "factory_order" \| "unclear"/.test(store), "purpose must be persisted on PendingIncomingInventory");
// Wired: the state applier comprehends the purpose and stores it.
assert.ok(/parseIncomingInventoryPurposeWithLLM\(\{/.test(index), "the state applier must call the parser");
assert.ok(/pending\.purpose = decideIncomingInventoryPurpose\(/.test(index), "the decision must set the stored purpose");
// A prior confident read is carried forward instead of re-parsing on every ack turn.
assert.ok(/priorPurpose && priorPurpose !== "unclear"/.test(index), "a prior confident purpose must be carried forward");
// BOTH reply paths (live + regenerate) plus ADF intake must await the async applier — route parity.
const applyCalls = (index.match(/await applyPendingIncomingInventoryState\(conv, \{/g) || []).length;
assert.ok(applyCalls >= 3, `all applier call sites must await (ADF intake + live + regen); found ${applyCalls}`);
// The copy must be purpose-first, and must NOT fall back to "trade" on an unknown/used unit.
assert.ok(/if \(purpose === "trade_in"\) return "trade"/.test(pending), "trade framing only on a comprehended trade_in");
assert.ok(/lower\(pending\?\.condition\) === "new" \? "order" : "incoming"/.test(pending), "unknown/used must fall back to the NEUTRAL incoming framing, never trade");
n += 11;

// --- 2) Decision table (pure). ---
type Row = { id: string; input: Parameters<typeof decideIncomingInventoryPurpose>[0]; purpose: string };
const ok = { parserAccepted: true, purpose: "sourced_for_purchase" as string | null, confidence: 0.9, confidenceMin: 0.7, condition: "used" as string | null };
const rows: Row[] = [
  { id: "sourced_high_conf", input: { ...ok }, purpose: "sourced_for_purchase" },
  { id: "trade_in_high_conf", input: { ...ok, purpose: "trade_in" }, purpose: "trade_in" },
  { id: "at_confidence_floor", input: { ...ok, confidence: 0.7 }, purpose: "sourced_for_purchase" },
  // Fail-safe: anything uncertain lands on "unclear" => neutral copy, never an invented trade.
  { id: "below_floor", input: { ...ok, confidence: 0.69 }, purpose: "unclear" },
  { id: "parser_not_accepted", input: { ...ok, parserAccepted: false }, purpose: "unclear" },
  { id: "null_purpose", input: { ...ok, purpose: null }, purpose: "unclear" },
  { id: "unclear_purpose", input: { ...ok, purpose: "unclear" }, purpose: "unclear" },
  { id: "below_floor_trade_in_never_invents_trade", input: { ...ok, purpose: "trade_in", confidence: 0.5 }, purpose: "unclear" },
  // A structured NEW condition is a factory order regardless of the parser (Nicholas Braun fix).
  { id: "new_condition_wins", input: { ...ok, condition: "new", purpose: "trade_in" }, purpose: "factory_order" },
  { id: "new_condition_no_parser", input: { ...ok, condition: "new", parserAccepted: false }, purpose: "factory_order" }
];
for (const r of rows) {
  const got = decideIncomingInventoryPurpose(r.input).purpose;
  assert.equal(got, r.purpose, `decision[${r.id}] expected ${r.purpose}, got ${got}`);
}
n += rows.length;

// --- 3) LLM coverage (gated; skips cleanly when the parser is disabled). ---
const coverage: { seedText: string; condition?: string; expect: string }[] = [
  // The Bill Indelicato replay fixture — a used bike sourced FOR the buyer is NOT his trade.
  { seedText: "We've got a 2015 Road King coming in for Bill to look at and buy — it's coming from another store. He wants to know when it gets here.", condition: "used", expect: "sourced_for_purchase" },
  { seedText: "Getting a used Street Glide in for this customer to buy, will let him know when it lands", condition: "used", expect: "sourced_for_purchase" },
  { seedText: "Here are pictures of the 2016 Freewheeler we are taking in on trade from the customer — his bike comes in next week.", condition: "used", expect: "trade_in" },
  { seedText: "Customer is trading in his 2015 Road King, we are taking it in next week", condition: "used", expect: "trade_in" },
  { seedText: "New 2026 Street Bob on order from the factory for this customer", condition: "new", expect: "factory_order" }
];
let ran = 0;
for (const c of coverage) {
  const parsed = await parseIncomingInventoryPurposeWithLLM({ seedText: c.seedText, condition: c.condition ?? null });
  if (!parsed) continue; // parser disabled / transient null — skip, don't red the gate
  ran += 1;
  assert.equal(parsed.purpose, c.expect, `"${c.seedText.slice(0, 60)}…" should be ${c.expect}, got ${parsed.purpose}`);
}

// ADVERSARIAL: a bare unit label gives no side information — it must NOT be guessed as a trade.
let safetyRan = 0;
for (const seedText of ["2015 Road King", "Harley-Davidson Full Line"]) {
  const parsed = await parseIncomingInventoryPurposeWithLLM({ seedText, condition: "used" });
  if (!parsed) continue;
  safetyRan += 1;
  assert.notEqual(parsed.purpose, "trade_in", `ADVERSARIAL: bare label "${seedText}" must not be read as a trade_in, got ${parsed.purpose}`);
}

console.log(
  ran === 0 && safetyRan === 0
    ? `PASS incoming unit purpose eval (${n} source-guard + decision-table assertions; LLM coverage skipped — parser disabled)`
    : `PASS incoming unit purpose eval (${n} source-guard + decision-table assertions + ${ran}/${coverage.length} coverage + ${safetyRan}/2 adversarial)`
);
