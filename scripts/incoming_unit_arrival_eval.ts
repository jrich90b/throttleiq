/**
 * Incoming-unit ARRIVAL eval (agent loop, 2026-08-06 — Robert Myers +17163229218).
 *
 * A Traffic Log Pro walk-in note in the dealer's own words —
 *   "Robert came in and really liked the pre-owned 2015 Dyna low rider WE HAVE IN STOCK. I looked at
 *    his trade and gave him out the door numbers."
 * — produced the draft "I have you down for the 2015 FXDL Dyna Low Rider WE'VE GOT COMING IN", plus a
 * manual handoff, a stopped cadence and an arrival-notify task. He had just sat on that bike in the
 * showroom. `hasPendingIncomingInventorySignal` matched three unrelated words in a sliding window
 * ("came" … "in" stock … his "trade") and on the initial-ADF path that regex WAS the decision.
 *
 * Fix (AGENTS.md fail-direction test => MIGRATE): the regex is demoted to a prefilter and
 * parseIncomingUnitArrivalWithLLM comprehends whether a unit is actually arriving;
 * decideInitialAdfPendingIncomingArm (pure) applies the confidence floor.
 *
 * FAIL DIRECTION (the point): anything other than a confident "arriving" DECLINES — including the
 * parser being unavailable. Declining leaves the ordinary ADF ack, which staff can recover. Arming
 * wrongly tells a customer a bike is on its way, stops the cadence and hands the thread off, and
 * nothing downstream corrects that. The prefilter is unchanged, so this can only ever arm FEWER
 * leads than before, never more.
 *
 * Run gated: LLM_ENABLED=1 npx tsx scripts/incoming_unit_arrival_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  decideInitialAdfPendingIncomingArm,
  incomingUnitArrivalConfidenceFloor,
  parseIncomingUnitArrivalWithLLM
} from "../services/api/src/domain/incomingUnitArrival.ts";
import { hasPendingIncomingInventorySignal } from "../services/api/src/domain/pendingIncomingInventory.ts";

let n = 0;

// --- 1) The reproduced miss, at the prefilter layer (no LLM). ---
// This is the fact the whole fix exists for: the regex says YES on a bike that is in stock. Keeping
// it asserted means a future "just tighten the regex" patch cannot quietly make this eval vacuous —
// if the prefilter ever stops matching, this line fails and the author has to re-derive the case.
const ROBERT_NOTE =
  "Robert came in and really liked the pre-owned 2015 Dyna low rider we have in stock. I looked at his trade and gave him out the door numbers. said he was going to look at the credit union first. (Step 6)";
assert.equal(
  hasPendingIncomingInventorySignal(ROBERT_NOTE),
  true,
  "the keyword prefilter still matches Robert Myers' in-stock note — which is why it cannot be the decision"
);
n += 1;

// --- 2) Source + wiring guards (no LLM). ---
const arrival = fs.readFileSync("services/api/src/domain/incomingUnitArrival.ts", "utf8");
const sendgrid = fs.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");

assert.ok(/export async function parseIncomingUnitArrivalWithLLM/.test(arrival), "parser must be exported");
assert.ok(
  /INCOMING_UNIT_ARRIVAL_PARSER_JSON_SCHEMA/.test(arrival),
  "the parser must use a strict JSON schema const (requestStructuredJson contract)"
);
assert.ok(/LLM_INCOMING_UNIT_ARRIVAL_PARSER_ENABLED/.test(arrival), "parser must be behind an enable flag");
assert.ok(
  /schemaName: "incoming_unit_arrival_parser"/.test(arrival),
  "the schemaName must be stable — the distillation capture and any later shadow key off it"
);

// WIRING. The ratchet cannot prove wiring and a loose substring survives renaming a key to
// `…UNWIRED`, so pin the EXACT call shape and COUNT the sites (ROUTINE_CONTRACT trap 2 + 3).
assert.ok(
  /await parseIncomingUnitArrivalWithLLM\(\{ seedText: initialAdfPendingIncomingSourceText \}\)/.test(sendgrid),
  "the initial-ADF site must await the arrival parser on the ADF source text"
);
assert.ok(
  /decideInitialAdfPendingIncomingArm\(\{\s*prefilterSignal: initialAdfPendingIncomingPrefilter,\s*parse: initialAdfArrivalParse,\s*confidenceFloor: incomingUnitArrivalConfidenceFloor\(\)\s*\}\)/.test(
    sendgrid
  ),
  "the initial-ADF site must feed prefilter + parse + floor into the pure decision"
);
assert.ok(
  /if \(initialAdfPendingIncomingDecision\.arm\) \{/.test(sendgrid),
  "the pending-incoming block must be gated on the DECISION, not on the raw regex"
);
// The pre-fix gate must be gone, or the parser would be computed and then ignored.
assert.ok(
  !/if \(initialAdfPendingIncomingSignal\) \{/.test(sendgrid),
  "the raw-regex gate must no longer arm pending-incoming inventory"
);
const armSites = (sendgrid.match(/decideInitialAdfPendingIncomingArm\(\{/g) || []).length;
assert.equal(armSites, 1, `exactly one arm decision site is expected in sendgridInbound.ts; found ${armSites}`);
n += 8;

// --- 3) Decision table (pure). Every branch, including the fail-safe ones. ---
const FLOOR = 0.7;
type Row = {
  id: string;
  input: Parameters<typeof decideInitialAdfPendingIncomingArm>[0];
  arm: boolean;
  reason: string;
};
const base = {
  prefilterSignal: true,
  parse: { status: "arriving" as const, confidence: 0.9 },
  confidenceFloor: FLOOR
};
const rows: Row[] = [
  { id: "arriving_high_conf", input: { ...base }, arm: true, reason: "arrival_comprehended" },
  { id: "at_confidence_floor", input: { ...base, parse: { status: "arriving", confidence: FLOOR } }, arm: true, reason: "arrival_comprehended" },
  // The reproduced miss: the prefilter fires, the parser says the bike is already on the floor.
  { id: "already_here_declines", input: { ...base, parse: { status: "already_here", confidence: 0.95 } }, arm: false, reason: "arrival_already_here" },
  { id: "none_declines", input: { ...base, parse: { status: "none", confidence: 0.9 } }, arm: false, reason: "arrival_none" },
  // Fail-safe branches — every one of these armed before the fix.
  { id: "below_floor_declines", input: { ...base, parse: { status: "arriving", confidence: 0.69 } }, arm: false, reason: "arrival_below_confidence_floor" },
  { id: "missing_confidence_declines", input: { ...base, parse: { status: "arriving" } }, arm: false, reason: "arrival_below_confidence_floor" },
  { id: "parser_null_declines", input: { ...base, parse: null }, arm: false, reason: "arrival_parse_unavailable" },
  { id: "parser_undefined_declines", input: { ...base, parse: undefined }, arm: false, reason: "arrival_parse_unavailable" },
  // The prefilter is still necessary: no regex signal, no parse, no arm (and no LLM spend).
  { id: "no_prefilter_declines", input: { ...base, prefilterSignal: false }, arm: false, reason: "no_prefilter_signal" },
  {
    id: "no_prefilter_declines_even_when_arriving",
    input: { ...base, prefilterSignal: false, parse: { status: "arriving", confidence: 1 } },
    arm: false,
    reason: "no_prefilter_signal"
  }
];
for (const r of rows) {
  const got = decideInitialAdfPendingIncomingArm(r.input);
  assert.equal(got.arm, r.arm, `decision[${r.id}] expected arm=${r.arm}, got ${got.arm}`);
  assert.equal(got.reason, r.reason, `decision[${r.id}] expected reason=${r.reason}, got ${got.reason}`);
}
n += rows.length;

// The floor is configurable but must default to 0.7 — a 0 default would make the gate vacuous.
{
  const saved = process.env.INCOMING_UNIT_ARRIVAL_CONFIDENCE_MIN;
  delete process.env.INCOMING_UNIT_ARRIVAL_CONFIDENCE_MIN;
  assert.equal(incomingUnitArrivalConfidenceFloor(), 0.7, "default confidence floor must be 0.7");
  process.env.INCOMING_UNIT_ARRIVAL_CONFIDENCE_MIN = "0.85";
  assert.equal(incomingUnitArrivalConfidenceFloor(), 0.85, "the floor must be overridable");
  if (saved === undefined) delete process.env.INCOMING_UNIT_ARRIVAL_CONFIDENCE_MIN;
  else process.env.INCOMING_UNIT_ARRIVAL_CONFIDENCE_MIN = saved;
  n += 2;
}

// --- 4) LLM coverage (gated; skips cleanly when the parser is disabled). ---
//
// WHAT THIS ASSERTS, AND WHY IT IS NOT AN EXACT LABEL (2026-08-07, agent loop).
// This block used to demand an exact `status` on every fixture, and it made `main` red on a coin
// flip. Measured over 6 runs of the floor-note fixture: 4x `none`, 2x `already_here` — and
// `decideInitialAdfPendingIncomingArm` returned `arm: false` on ALL SIX. Robert's note wobbles the
// same way (3x `already_here`, 1x `none`, arm false every time). The two labels are behaviourally
// IDENTICAL here: only `arriving` can arm a pending-incoming watch, so `none` and `already_here`
// are the same answer wearing different hats, and the gate was failing on which hat.
//
// So the not-incoming cases assert the PROPERTY #575 exists to protect — "an in-stock bike is
// never read as one that is coming in" — instead of the label. The guard keeps every tooth it had:
// a regression to `arriving` fails this AND the arm check below. The genuine arrivals still demand
// the exact `arriving` label, because that one IS load-bearing and it measured stable 4/4.
const coverage: { seedText: string; expect: "arriving" | "not_incoming" }[] = [
  // THE replay fixture. This is the one that must never come back.
  { seedText: ROBERT_NOTE, expect: "not_incoming" },
  {
    seedText:
      "Customer test rode the Low Rider S we have on the floor today and asked about payment options on his way out.",
    expect: "not_incoming"
  },
  // Genuine arrivals — the capability must survive the fix, or we have traded one miss for another.
  { seedText: "Interested in 2016 Freewheeler we are taking in on trade. His bike comes in next week.", expect: "arriving" },
  { seedText: "We've got a 2015 Road King coming in from another store for him to look at and buy.", expect: "arriving" },
  {
    seedText: "New 2026 Street Glide on order from the factory for this customer, projected ship date 8/21.",
    expect: "arriving"
  }
];
let ran = 0;
for (const c of coverage) {
  const parsed = await parseIncomingUnitArrivalWithLLM({ seedText: c.seedText });
  if (!parsed) continue; // parser disabled / transient null — skip, don't red the gate
  ran += 1;
  if (c.expect === "arriving") {
    assert.equal(parsed.status, "arriving", `"${c.seedText.slice(0, 60)}…" should read arriving, got ${parsed.status}`);
  } else {
    assert.notEqual(
      parsed.status,
      "arriving",
      `"${c.seedText.slice(0, 60)}…" is already here — it must never read arriving, got ${parsed.status}`
    );
    // and the only thing that label is used for must stay declined, whichever non-arriving label it picked.
    const decision = decideInitialAdfPendingIncomingArm({
      prefilterSignal: hasPendingIncomingInventorySignal(c.seedText),
      parse: parsed,
      confidenceFloor: incomingUnitArrivalConfidenceFloor()
    });
    assert.equal(
      decision.arm,
      false,
      `"${c.seedText.slice(0, 60)}…" must not arm pending-incoming (${decision.reason})`
    );
  }
}

// --- 5) End-to-end: prefilter + parser + decision on the live shapes. ---
// Robert's note must reach the parser (prefilter true) and still be DECLINED.
let e2eRan = 0;
{
  const parsed = await parseIncomingUnitArrivalWithLLM({ seedText: ROBERT_NOTE });
  if (parsed) {
    e2eRan += 1;
    const decision = decideInitialAdfPendingIncomingArm({
      prefilterSignal: hasPendingIncomingInventorySignal(ROBERT_NOTE),
      parse: parsed,
      confidenceFloor: incomingUnitArrivalConfidenceFloor()
    });
    assert.equal(decision.arm, false, `Robert Myers' in-stock note must not arm pending-incoming (${decision.reason})`);
  }
}
{
  const seedText = "Interested in 2016 Freewheeler we are taking in on trade. His bike comes in next week.";
  const parsed = await parseIncomingUnitArrivalWithLLM({ seedText });
  if (parsed) {
    e2eRan += 1;
    const decision = decideInitialAdfPendingIncomingArm({
      prefilterSignal: hasPendingIncomingInventorySignal(seedText),
      parse: parsed,
      confidenceFloor: incomingUnitArrivalConfidenceFloor()
    });
    assert.equal(decision.arm, true, `a real incoming trade must still arm pending-incoming (${decision.reason})`);
  }
}

console.log(
  ran === 0 && e2eRan === 0
    ? `PASS incoming unit arrival eval (${n} source-guard + decision-table assertions; LLM coverage skipped — parser disabled)`
    : `PASS incoming unit arrival eval (${n} source-guard + decision-table assertions + ${ran}/${coverage.length} coverage + ${e2eRan}/2 end-to-end)`
);
