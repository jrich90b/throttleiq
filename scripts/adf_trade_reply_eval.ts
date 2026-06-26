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
import { buildTradeAdfAck } from "../services/api/src/domain/tradeAdfReply.ts";

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

// Both-paths: the live Trade-Accelerator intake routes through the SAME builder (centralized) with the
// purchase label — no divergent inline trade ack.
const sg = fs.readFileSync(path.resolve("services/api/src/routes/sendgridInbound.ts"), "utf8");
assert.ok(/buildTradeAdfAck\(\{ bikeLabel, purchaseLabel/.test(sg), "the live ADF trade intake uses the shared builder with the purchase label");

console.log("PASS adf-trade-reply eval (builder + trade-toward-buy + dup-guard + both-path wiring)");
