/**
 * adf_trade_reply:eval — pins buildTradeAdfAck (the trade/sell ADF acknowledgment) + the
 * orchestrator wiring that uses it. An ADF web-lead is a FORM, not a customer question, so a
 * trade ADF must NOT be answered with "Totally fair question…"; mid-conversation it must tie to
 * the existing relationship instead of re-introducing cold (Laricuss Nelson, Ref 11466 — a
 * trade-in ADF arrived during a live finance deal and got "Totally fair question. I have you on
 * a 2008 SUZUKI C50K8 Boulevard (Two."). The customer-SMS trade-question opener is preserved.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildTradeAdfAck,
  tradeAdfPurchaseIsOnFloor,
  tradeAdfPurchaseTargetIsAssertable,
  tradeAdfPurchaseUnitIsAvailable
} from "../services/api/src/domain/tradeAdfReply.ts";

// Initial trade ADF: clean intake, no greeting (the agent intro is added downstream by
// applyInitialAdfPrefix), no claim of a prior relationship.
const initial = buildTradeAdfAck({ bikeLabel: "2008 Suzuki C50K8 Boulevard", midConversation: false });
assert.ok(initial.includes("2008 Suzuki C50K8 Boulevard"), "initial ack names the bike");
assert.ok(/firm number after a quick in-person appraisal/i.test(initial), "initial ack offers an in-person appraisal");
assert.ok(/what day and time works best/i.test(initial), "initial ack asks for a day/time");
assert.ok(!/totally fair question/i.test(initial), "initial ack does NOT use the customer-question opener");
assert.ok(!/i have you on/i.test(initial), "initial ack does NOT use the cold 'I have you on' opener");
assert.ok(!/already working on/i.test(initial), "initial ack does NOT claim a prior relationship");

// Mid-conversation trade ADF: ties to the existing relationship, no cold re-intro.
const mid = buildTradeAdfAck({ bikeLabel: "2008 Suzuki C50K8 Boulevard", midConversation: true });
assert.ok(mid.includes("2008 Suzuki C50K8 Boulevard"), "mid-conversation ack names the bike");
assert.ok(/already working on/i.test(mid), "mid-conversation ack ties to the existing relationship");
assert.ok(/what day and time works best/i.test(mid), "mid-conversation ack asks for a day/time");
assert.ok(!/totally fair question/i.test(mid), "mid-conversation ack does NOT use the customer-question opener");
assert.ok(!/i have you on/i.test(mid), "mid-conversation ack does NOT use the cold 'I have you on' opener");

// Missing bike label falls back gracefully.
const noBike = buildTradeAdfAck({ bikeLabel: "", midConversation: false });
assert.ok(/your bike/i.test(noBike), "missing bike label falls back to 'your bike'");

// TRADE-TOWARD-BUY (steven osipovitch, 2026-06-26): a trade lead that ALSO names a DISTINCT purchase
// vehicle must acknowledge the bike they want, not just the trade.
const towardBuy = buildTradeAdfAck({
  bikeLabel: "2023 Can-Am Ryker Rally 900 ACE",
  purchaseLabel: "2016 Trike Freewheeler",
  midConversation: false
});
assert.ok(/2023 Can-Am Ryker Rally 900 ACE/.test(towardBuy), "trade-toward-buy ack still names the trade");
assert.ok(/2016 Trike Freewheeler/.test(towardBuy), "trade-toward-buy ack names the bike they WANT (the miss this fixes)");
assert.ok(/toward the/i.test(towardBuy), "trade-toward-buy ack frames it as trading toward the purchase");
assert.ok(/firm number after a quick in-person appraisal/i.test(towardBuy), "trade-toward-buy ack still offers the appraisal");
const towardBuyMid = buildTradeAdfAck({ bikeLabel: "2008 Suzuki Boulevard", purchaseLabel: "2024 Street Glide", midConversation: true });
assert.ok(/2024 Street Glide/.test(towardBuyMid) && /already working on/i.test(towardBuyMid), "mid-conversation trade-toward-buy names the purchase + ties to the relationship");

// DUPLICATE-FIELD GUARD: when the ADF duplicates the trade into the vehicle field (purchase == trade),
// do NOT produce "trade your X toward the X" — fall back to the plain trade ack. (Protects against the
// open-critic false-positive class where vehicle and tradeVehicle are the same unit.)
const dup = buildTradeAdfAck({ bikeLabel: "2000 Dyna Wide Glide", purchaseLabel: "2000 Dyna Wide Glide", midConversation: false });
assert.ok(!/toward the/i.test(dup), "duplicate purchase==trade => no 'toward the' weave");
assert.ok(/trade-in request for 2000 Dyna Wide Glide/.test(dup), "duplicate field => plain trade ack");
// A blank/your-bike purchase label never weaves.
const blankPurchase = buildTradeAdfAck({ bikeLabel: "2008 Suzuki Boulevard", purchaseLabel: "", midConversation: false });
assert.ok(!/toward the/i.test(blankPurchase), "no purchase label => plain trade ack (unchanged behavior)");

// PLACEHOLDER-TARGET GUARD (Gene Campana, Ref 11551, 2026-06-26 — human_correction_material wrong_fact):
// a Trade Accelerator ADF whose `vehicle` field is the placeholder "Harley-Davidson Other" must NOT be
// woven in as a concrete trade target ("trade your Road King toward the 2026 Harley-Davidson Other").
// It falls through to the plain trade ack — exactly the staff correction.
for (const placeholder of ["2026 Harley-Davidson Other", "Harley-Davidson Other", "Other", "Harley-Davidson Full Line", "harley-davidson"]) {
  const ph = buildTradeAdfAck({ bikeLabel: "2013 FLHRSE5 CVO Road King", purchaseLabel: placeholder, midConversation: false });
  assert.ok(!/toward the/i.test(ph), `placeholder target "${placeholder}" => no 'toward the' weave`);
  assert.ok(!/other/i.test(ph), `placeholder target "${placeholder}" => never names the placeholder`);
  assert.ok(/trade-in request for 2013 FLHRSE5 CVO Road King/.test(ph), `placeholder target "${placeholder}" => plain trade ack naming the real trade-in`);
}
// A REAL purchase target alongside a real make is still woven (the guard is placeholder-only, not make-wide).
const realTarget = buildTradeAdfAck({ bikeLabel: "2013 CVO Road King", purchaseLabel: "2026 Road Glide Limited", midConversation: false });
assert.ok(/toward the 2026 Road Glide Limited/.test(realTarget), "a real, specific target is still woven (placeholder guard does not over-suppress)");

// ═══ NOT-ON-THE-FLOOR GUARD (Cale Rice, Ref 11757, 2026-08-08 — operator-reported routing) ═══
// A Trade Accelerator ADF named a 2021 Electra Glide Standard in its `vehicle` field and the ack
// promised "we'll go over the 2021 Electra Glide Standard while you're here". Executed against the
// live feed the same day: 67 units, ZERO Electra Glide Standard under any name (the only Electra
// Glide is a 2013 Ultra Limited — a distinct model, correctly non-matching). The `vehicle` field is
// what the customer WANTS; nothing in it says we stock it. So: keep the acknowledgment (it only
// restates their own request — the #93 trade-toward-buy fix), drop the in-person walk-through promise.
const offFloor = buildTradeAdfAck({
  bikeLabel: "2007 FLHTC Electra Glide",
  purchaseLabel: "2021 Electra Glide Standard",
  purchaseOnFloor: false,
  midConversation: false
});
assert.ok(/toward the 2021 Electra Glide Standard/.test(offFloor), "off-floor target is still ACKNOWLEDGED (we restate their request)");
assert.ok(!/while you're here/i.test(offFloor), "off-floor target gets NO in-person walk-through promise (the reported miss)");
assert.ok(!/go over the/i.test(offFloor), "off-floor target is never offered a walk-through");
assert.ok(/firm number after a quick in-person appraisal/i.test(offFloor), "the trade appraisal invite survives — that IS the lead");
assert.ok(/what day and time works best/i.test(offFloor), "off-floor ack still ends by asking for a day/time (charter C1.7)");
const offFloorMid = buildTradeAdfAck({
  bikeLabel: "2007 FLHTC Electra Glide",
  purchaseLabel: "2021 Electra Glide Standard",
  purchaseOnFloor: false,
  midConversation: true
});
assert.ok(/toward the 2021 Electra Glide Standard/.test(offFloorMid), "mid-conversation off-floor target is still acknowledged");
assert.ok(!/while you're here/i.test(offFloorMid), "mid-conversation off-floor target gets NO walk-through promise");
assert.ok(/already working on/i.test(offFloorMid), "mid-conversation off-floor ack still ties to the existing relationship");
assert.ok(/what day and time works best/i.test(offFloorMid), "mid-conversation off-floor ack still asks for a day/time");

// A CONFIRMED on-floor target keeps the walk-through — the guard must not over-suppress.
const onFloor = buildTradeAdfAck({
  bikeLabel: "2013 CVO Road King",
  purchaseLabel: "2026 Road Glide Limited",
  purchaseOnFloor: true,
  midConversation: false
});
assert.ok(/go over the 2026 Road Glide Limited while you're here/.test(onFloor), "a confirmed on-floor target still earns the walk-through");
const onFloorMid = buildTradeAdfAck({
  bikeLabel: "2008 Suzuki Boulevard",
  purchaseLabel: "2024 Street Glide",
  purchaseOnFloor: true,
  midConversation: true
});
assert.ok(/go over the 2024 Street Glide while you're here/.test(onFloorMid), "mid-conversation confirmed target still earns the walk-through");
assert.ok(/already working on/i.test(onFloorMid), "mid-conversation confirmed target still ties to the relationship");

// FAIL DIRECTION: an OMITTED flag must behave exactly like "not on the floor". A caller that forgets
// to resolve availability (or a feed outage that cannot answer) must never assert a bike is here.
const omitted = buildTradeAdfAck({ bikeLabel: "2007 FLHTC Electra Glide", purchaseLabel: "2021 Electra Glide Standard", midConversation: false });
assert.strictEqual(omitted, offFloor, "omitting purchaseOnFloor is identical to false (fails toward not promising)");
// The flag alone never fabricates a target: with no purchase to weave, on-floor changes nothing.
const onFloorNoPurchase = buildTradeAdfAck({ bikeLabel: "2000 Dyna Wide Glide", purchaseLabel: "", purchaseOnFloor: true, midConversation: false });
assert.ok(!/toward the/i.test(onFloorNoPurchase) && !/while you're here/i.test(onFloorNoPurchase), "purchaseOnFloor without a purchase target changes nothing");
// ...and a placeholder target stays suppressed even when something 'matches' the floor.
const onFloorPlaceholder = buildTradeAdfAck({ bikeLabel: "2013 CVO Road King", purchaseLabel: "2026 Harley-Davidson Other", purchaseOnFloor: true, midConversation: false });
assert.ok(!/toward the/i.test(onFloorPlaceholder) && !/while you're here/i.test(onFloorPlaceholder), "the placeholder guard still wins over an on-floor flag");

// The availability decision itself, executed (no network): holds and solds both disqualify a unit,
// and a single free unit is enough.
assert.strictEqual(tradeAdfPurchaseUnitIsAvailable({ matches: [] }), false, "no feed matches => not on the floor");
assert.strictEqual(
  tradeAdfPurchaseUnitIsAvailable({ matches: [{ stockId: "U903-13", vin: "VIN1" }] }),
  true,
  "a plain match with no hold/sold => on the floor"
);
assert.strictEqual(
  tradeAdfPurchaseUnitIsAvailable({ matches: [{ stockId: "U903-13", vin: "VIN1" }], solds: { "u903-13": { soldAt: "x" } } }),
  false,
  "a SOLD unit is not on the floor"
);
assert.strictEqual(
  tradeAdfPurchaseUnitIsAvailable({ matches: [{ stockId: "U903-13", vin: "VIN1" }], holds: { "u903-13": { heldFor: "x" } } }),
  false,
  "a HELD unit is not walk-through-able for a different customer"
);
assert.strictEqual(
  tradeAdfPurchaseUnitIsAvailable({
    matches: [{ stockId: "U903-13", vin: "VIN1" }, { stockId: "U904-13", vin: "VIN2" }],
    solds: { "u903-13": { soldAt: "x" } }
  }),
  true,
  "one free unit alongside a sold one is still on the floor"
);
// The resolver refuses to look up a target it could never assert, without touching the feed. Pinned
// on the PURE predicate, not on the resolver's return value: findInventoryMatches independently
// returns [] for both inputs, so a resolver-level assertion would pass with the guard deleted — true
// but inert, and it would start making a live feed call inside ci:eval.
assert.strictEqual(tradeAdfPurchaseTargetIsAssertable(""), false, "an empty model is not an assertable target");
assert.strictEqual(tradeAdfPurchaseTargetIsAssertable("   "), false, "a whitespace model is not an assertable target");
assert.strictEqual(tradeAdfPurchaseTargetIsAssertable(null), false, "a missing model is not an assertable target");
assert.strictEqual(tradeAdfPurchaseTargetIsAssertable("Harley-Davidson Other"), false, "a placeholder model is not an assertable target");
assert.strictEqual(tradeAdfPurchaseTargetIsAssertable("Electra Glide Standard"), true, "a real model IS an assertable target (the guard does not over-suppress)");

// The RESOLVER itself, executed end to end against injected lookups — no live feed. This is what pins
// the parts a pure-function test cannot see: which year it asks the floor about, and that it consults
// holds/solds at all rather than treating "a match exists" as "it's here".
const seenQueries: Array<{ year?: string | null; model?: string | null }> = [];
const deps = (matches: Array<{ stockId?: string | null; vin?: string | null }>, holds = {}, solds = {}) => ({
  findMatches: async (opts: { year?: string | null; model?: string | null }) => {
    seenQueries.push(opts);
    return matches;
  },
  loadHolds: async () => holds as Record<string, unknown>,
  loadSolds: async () => solds as Record<string, unknown>
});
assert.strictEqual(
  await tradeAdfPurchaseIsOnFloor({ year: "2021", model: "Electra Glide Standard", deps: deps([]) }),
  false,
  "resolver: no feed match => not on the floor (Cale Rice's actual case)"
);
assert.deepStrictEqual(
  seenQueries.at(-1),
  { year: "2021", model: "Electra Glide Standard" },
  "resolver asks the floor about the model YEAR the customer named, not the family"
);
assert.strictEqual(
  await tradeAdfPurchaseIsOnFloor({ year: "2026", model: "Road Glide Limited", deps: deps([{ stockId: "N1", vin: "V1" }]) }),
  true,
  "resolver: a free matching unit => on the floor"
);
assert.strictEqual(
  await tradeAdfPurchaseIsOnFloor({
    year: "2026",
    model: "Road Glide Limited",
    deps: deps([{ stockId: "N1", vin: "V1" }], {}, { n1: { soldAt: "x" } })
  }),
  false,
  "resolver CONSULTS the sold list — a sold unit is not walk-through-able"
);
assert.strictEqual(
  await tradeAdfPurchaseIsOnFloor({
    year: "2026",
    model: "Road Glide Limited",
    deps: deps([{ stockId: "N1", vin: "V1" }], { n1: { heldFor: "x" } })
  }),
  false,
  "resolver CONSULTS the hold list — a held unit is not walk-through-able"
);
assert.strictEqual(
  await tradeAdfPurchaseIsOnFloor({
    year: "2021",
    model: "Electra Glide Standard",
    deps: {
      findMatches: async () => {
        throw new Error("feed down");
      }
    }
  }),
  false,
  "resolver: a feed OUTAGE fails toward not promising, never toward asserting"
);
const skipped: string[] = [];
assert.strictEqual(
  await tradeAdfPurchaseIsOnFloor({
    year: "2026",
    model: "Harley-Davidson Other",
    deps: {
      findMatches: async () => {
        skipped.push("looked-up");
        return [{ stockId: "N1" }];
      }
    }
  }),
  false,
  "the resolver honours the assertable-target guard"
);
assert.deepStrictEqual(skipped, [], "a placeholder target never reaches the feed at all");

// Orchestrator wiring: the trade template branches on the ADF provider + uses the builder,
// and keeps the "Totally fair question" opener only for non-ADF (customer-SMS) trade questions.
const orch = fs.readFileSync(path.resolve("services/api/src/domain/orchestrator.ts"), "utf8");
assert.ok(
  /event\.provider === "sendgrid_adf"\s*\?\s*buildTradeAdfAck\(/.test(orch),
  "orchestrator trade template must use buildTradeAdfAck for ADF forms"
);
assert.ok(/midConversation: hasPriorOutbound/.test(orch), "orchestrator must pass hasPriorOutbound as the mid-conversation signal");
assert.ok(/"Totally fair question\. "/.test(orch), "the customer-question opener must stay for non-ADF trade SMS");
assert.ok(/purchaseLabel/.test(orch), "orchestrator passes the purchase vehicle to the trade ack");
// BOTH paths must RESOLVE availability, not just accept the flag — a call site that never calls the
// resolver would silently default to false and quietly retire the trade-toward-buy walk-through.
assert.ok(orch.includes("tradeAdfPurchaseIsOnFloor"), "orchestrator resolves the purchase target against the floor");
assert.ok(orch.includes("purchaseOnFloor,"), "orchestrator passes the resolved floor answer to the trade ack");

// Both-paths: the live Trade-Accelerator intake routes through the SAME builder (centralized) with the
// purchase label — no divergent inline trade ack.
const sg = fs.readFileSync(path.resolve("services/api/src/routes/sendgridInbound.ts"), "utf8");
assert.ok(/buildTradeAdfAck\(\{ bikeLabel, purchaseLabel/.test(sg), "the live ADF trade intake uses the shared builder with the purchase label");
assert.ok(sg.includes("tradeAdfPurchaseIsOnFloor"), "the live ADF trade intake resolves the purchase target against the floor");
assert.ok(sg.includes("purchaseOnFloor,"), "the live ADF trade intake passes the resolved floor answer to the trade ack");

console.log(
  "PASS adf-trade-reply eval (builder + trade-toward-buy + dup-guard + placeholder-target guard + not-on-the-floor guard + both-path wiring)"
);
