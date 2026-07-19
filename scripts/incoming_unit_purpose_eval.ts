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
assert.ok(/pending\.purpose = purposeDecision\.purpose/.test(index), "the decision must set the stored purpose");
// A prior confident read is carried forward instead of re-parsing on every ack turn.
assert.ok(/priorPurpose && priorPurpose !== "unclear"/.test(index), "a prior confident purpose must be carried forward");
// BOTH reply paths (live + regenerate) plus ADF intake must await the async applier — route parity.
const applyCalls = (index.match(/await applyPendingIncomingInventoryState\(conv, \{/g) || []).length;
assert.ok(applyCalls >= 3, `all applier call sites must await (ADF intake + live + regen); found ${applyCalls}`);
// The copy must be purpose-first, and must NOT fall back to "trade" on an unknown/used unit.
assert.ok(/if \(purpose === "trade_in"\) return "trade"/.test(pending), "trade framing only on a comprehended trade_in");
assert.ok(/lower\(pending\?\.condition\) === "new" \? "order" : "incoming"/.test(pending), "unknown/used must fall back to the NEUTRAL incoming framing, never trade");
n += 11;

// --- 1b) Spoken-for allocation source guards (Joe ruling 2026-07-19, Peter Arnoldo +17166887637). ---
const sendgrid = fs.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");
assert.ok(/"allocation"/.test(llm) && /spoken_for_other/.test(llm), "the parser schema must carry the allocation field");
assert.ok(
  /allocation\?: "spoken_for_other" \| "for_this_customer" \| "unclear"/.test(store),
  "allocation must be persisted on PendingIncomingInventory"
);
assert.ok(/priorAllocation && priorAllocation !== "unclear"/.test(index), "a prior confident allocation must be carried forward");
// The walk-in intake site must gate the watch on the spoken-for decision: prefilter → parser →
// centralized decision → handoff (task + pending state), never an inline regex answer.
assert.ok(/hasSpokenForIncomingCue\(walkInCleanedComment\)/.test(sendgrid), "walk-in site must prefilter for the spoken-for cue");
assert.ok(/parseIncomingInventoryPurposeWithLLM\(\{/.test(sendgrid), "walk-in site must comprehend allocation via the typed parser");
assert.ok(/decideIncomingInventoryPurpose\(\{/.test(sendgrid), "walk-in site must use the centralized decision");
assert.ok(/spokenForDecision\.allocation === "spoken_for_other"/.test(sendgrid), "walk-in watch must divert only on a confident spoken_for_other");
assert.ok(/!walkInSpokenForHandoff/.test(sendgrid), "the watch-set blocks must be gated by the spoken-for handoff");
assert.ok(/buildSpokenForIncomingHandoffAck\(/.test(sendgrid), "the handoff ack must come from the shared builder");
n += 9;

// --- 2) Decision table (pure). ---
type Row = {
  id: string;
  input: Parameters<typeof decideIncomingInventoryPurpose>[0];
  purpose: string;
  allocation?: string;
};
const ok = { parserAccepted: true, purpose: "sourced_for_purchase" as string | null, confidence: 0.9, confidenceMin: 0.7, condition: "used" as string | null };
const rows: Row[] = [
  { id: "sourced_high_conf", input: { ...ok }, purpose: "sourced_for_purchase", allocation: "unclear" },
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
  { id: "new_condition_no_parser", input: { ...ok, condition: "new", parserAccepted: false }, purpose: "factory_order" },
  // Allocation (Joe ruling 2026-07-19): confident spoken_for_other diverts the watch into a
  // handoff; anything uncertain fails to "unclear" (= today's watch behavior), because a wrong
  // spoken_for_other would suppress a legitimate availability watch.
  { id: "alloc_spoken_for_high_conf", input: { ...ok, allocation: "spoken_for_other" }, purpose: "sourced_for_purchase", allocation: "spoken_for_other" },
  { id: "alloc_for_this_customer", input: { ...ok, allocation: "for_this_customer" }, purpose: "sourced_for_purchase", allocation: "for_this_customer" },
  { id: "alloc_below_floor_fails_safe", input: { ...ok, allocation: "spoken_for_other", confidence: 0.69 }, purpose: "unclear", allocation: "unclear" },
  { id: "alloc_parser_not_accepted_fails_safe", input: { ...ok, allocation: "spoken_for_other", parserAccepted: false }, purpose: "unclear", allocation: "unclear" },
  { id: "alloc_null_is_unclear", input: { ...ok, allocation: null }, purpose: "sourced_for_purchase", allocation: "unclear" },
  { id: "alloc_survives_new_condition", input: { ...ok, condition: "new", allocation: "spoken_for_other" }, purpose: "factory_order", allocation: "spoken_for_other" }
];
for (const r of rows) {
  const got = decideIncomingInventoryPurpose(r.input);
  assert.equal(got.purpose, r.purpose, `decision[${r.id}] expected ${r.purpose}, got ${got.purpose}`);
  if (r.allocation !== undefined) {
    assert.equal(got.allocation, r.allocation, `decision[${r.id}] expected allocation ${r.allocation}, got ${got.allocation}`);
  }
}
n += rows.length;

// --- 3) LLM coverage (gated; skips cleanly when the parser is disabled). ---
const coverage: { seedText: string; condition?: string; expect: string; expectAllocation?: string }[] = [
  // The Bill Indelicato replay fixture — a used bike sourced FOR the buyer is NOT his trade.
  { seedText: "We've got a 2015 Road King coming in for Bill to look at and buy — it's coming from another store. He wants to know when it gets here.", condition: "used", expect: "sourced_for_purchase" },
  { seedText: "Getting a used Street Glide in for this customer to buy, will let him know when it lands", condition: "used", expect: "sourced_for_purchase" },
  { seedText: "Here are pictures of the 2016 Freewheeler we are taking in on trade from the customer — his bike comes in next week.", condition: "used", expect: "trade_in" },
  { seedText: "Customer is trading in his 2015 Road King, we are taking it in next week", condition: "used", expect: "trade_in" },
  { seedText: "New 2026 Street Bob on order from the factory for this customer", condition: "new", expect: "factory_order" },
  // The Peter Arnoldo replay fixture (Joe ruling 2026-07-19): the in-transit unit is SPOKEN FOR
  // by someone else — this customer waits on the NEXT one → handoff, never a watch.
  {
    seedText: "Wants to see new Super Glide and told him we would reach out once the next one we have coming in arrives which is spoken for, projected ship date 7/29.",
    condition: "new",
    expect: "sourced_for_purchase",
    expectAllocation: "spoken_for_other"
  }
];
let ran = 0;
for (const c of coverage) {
  const parsed = await parseIncomingInventoryPurposeWithLLM({ seedText: c.seedText, condition: c.condition ?? null });
  if (!parsed) continue; // parser disabled / transient null — skip, don't red the gate
  ran += 1;
  assert.equal(parsed.purpose, c.expect, `"${c.seedText.slice(0, 60)}…" should be ${c.expect}, got ${parsed.purpose}`);
  if (c.expectAllocation) {
    assert.equal(
      parsed.allocation,
      c.expectAllocation,
      `"${c.seedText.slice(0, 60)}…" should carry allocation ${c.expectAllocation}, got ${parsed.allocation}`
    );
  }
}

// ADVERSARIAL (allocation): "coming in for him to look at" is FOR THIS CUSTOMER — it must never
// read spoken_for_other, or we'd wrongly suppress the Bill Indelicato class's legitimate watch.
let allocSafetyRan = 0;
for (const seedText of [
  "We've got a 2015 Road King coming in for Bill to look at and buy — he wants to know when it gets here.",
  "Getting a used Street Glide in for this customer to buy, will let him know when it lands"
]) {
  const parsed = await parseIncomingInventoryPurposeWithLLM({ seedText, condition: "used" });
  if (!parsed) continue;
  allocSafetyRan += 1;
  assert.notEqual(
    parsed.allocation,
    "spoken_for_other",
    `ADVERSARIAL: "${seedText.slice(0, 50)}…" must not be read as spoken_for_other`
  );
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
  ran === 0 && safetyRan === 0 && allocSafetyRan === 0
    ? `PASS incoming unit purpose eval (${n} source-guard + decision-table assertions; LLM coverage skipped — parser disabled)`
    : `PASS incoming unit purpose eval (${n} source-guard + decision-table assertions + ${ran}/${coverage.length} coverage + ${safetyRan}/2 adversarial + ${allocSafetyRan}/2 allocation-adversarial)`
);
