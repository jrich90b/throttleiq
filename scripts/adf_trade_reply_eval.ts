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

// Orchestrator wiring: the trade template branches on the ADF provider + uses the builder,
// and keeps the "Totally fair question" opener only for non-ADF (customer-SMS) trade questions.
const orch = fs.readFileSync(path.resolve("services/api/src/domain/orchestrator.ts"), "utf8");
assert.ok(
  /event\.provider === "sendgrid_adf"\s*\?\s*buildTradeAdfAck\(/.test(orch),
  "orchestrator trade template must use buildTradeAdfAck for ADF forms"
);
assert.ok(/midConversation: hasPriorOutbound/.test(orch), "orchestrator must pass hasPriorOutbound as the mid-conversation signal");
assert.ok(/"Totally fair question\. "/.test(orch), "the customer-question opener must stay for non-ADF trade SMS");

console.log("PASS adf-trade-reply eval (builder + orchestrator wiring)");
