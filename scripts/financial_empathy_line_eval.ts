/**
 * Financial-empathy line eval (deterministic — no LLM).
 *
 * Pins the financial-empathy acknowledgment (Scott's car-intake rule, dealer-adapted): when a
 * customer states a monthly payment target, the payment-ballpark reply acknowledges that number
 * FIRST (the ballpark then serves as the out-the-door reference). Generation-only. Pins the pure
 * helper + that both orchestrator payment-ballpark paths prepend it, gated on a present target.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildMonthlyTargetAck } from "../services/api/src/domain/financialEmpathyLine.ts";

// Pure helper: echoes the monthly target, rounds to whole dollars, reads as a monthly figure.
const ack = buildMonthlyTargetAck(400);
assert.ok(ack.includes("400"), "acknowledgment echoes the monthly target");
assert.ok(/\/mo/i.test(ack), "acknowledgment frames it as a monthly figure");
assert.ok(ack.length > 0 && ack.endsWith(" "), "non-empty + trailing space so it prefixes cleanly");
assert.equal(buildMonthlyTargetAck(399.6), "Got it — aiming for around $400/mo. ", "rounds to a whole dollar");

// No/invalid target → empty string, so the caller can prepend unconditionally (no NaN / double space).
assert.equal(buildMonthlyTargetAck(null), "", "null target → empty");
assert.equal(buildMonthlyTargetAck(undefined), "", "undefined target → empty");
assert.equal(buildMonthlyTargetAck(0), "", "zero target → empty");
assert.equal(buildMonthlyTargetAck(-50), "", "negative target → empty");

// Source guard: both orchestrator payment-ballpark paths prepend the ack, gated on a present target.
const orch = fs.readFileSync("services/api/src/domain/orchestrator.ts", "utf8");
assert.ok(/buildMonthlyTargetAck/.test(orch), "orchestrator imports/uses the helper");
const uses = (orch.match(/buildMonthlyTargetAck\(targetMonthly\)/g) || []).length;
assert.ok(uses >= 2, `both payment-ballpark sites prepend the ack (found ${uses})`);
assert.ok(/if \(targetMonthly != null\) \{/.test(orch), "the ack is gated on a present monthly target");

console.log("PASS financial empathy line eval");
