/**
 * established_stock_blocks_incoming_arm:eval — a bike sitting in our own service department is
 * never announced to the customer as "coming in".
 *
 * WHY THIS EXISTS (Joe, 2026-08-19, Zackary Busch +17162489119). His Traffic Log Pro note, in the
 * dealer's own words: *"I showed him the 2008 FLHTCU that i just took in on trade. I told him we are
 * going to get it through the service department to get serviced before it is ready to sell and we
 * are waiting for the title."* The bike is on the property.
 *
 * Two minutes later staff texted "I'll get a hold of you when that 08 Ultra is ready to look at",
 * Zack answered "Perfect, thank you. I'll be waiting", and the inbound-reply parser read THAT
 * exchange as a pending-incoming-inventory acknowledgement at 0.96 — not wrongly, since a promise
 * plus a thank-you reads the same whether the bike is on a truck or on a lift. It simply never saw
 * the note. Result: `dialogState: pending_incoming_inventory`, cadence stopped, manual handoff, a
 * task reading "notify when the 2008 Flhtcu ARRIVES", and a draft about "the 2008 Flhtcu we've got
 * coming in … as soon as it's here".
 *
 * The gate for exactly this mistake already existed (Robert Myers, 2026-08-06) — on the initial-ADF
 * branch only. Zack came through the acknowledgement branch, which had none.
 *
 * ⚠️ THE MEASUREMENT THAT KILLED THE OBVIOUS FIX, and the reason case 5 exists. The plan was to
 * reuse the ADF path's seed. That seed is the prose wrapped in the raw ADF header, and executed
 * against Zack's real record it is UNSTABLE:
 *
 *     full ADF block ("PHONE LOG (ADF) … Year: 2008 / Vehicle: Flhtcu" + prose)
 *         -> arriving, already_here, already_here, already_here, already_here, arriving   (2/6 WRONG)
 *     inquiry prose alone
 *         -> already_here x10 @ 0.85-0.90                                                 (0/10 wrong)
 *
 * The comprehension was never the problem; `Year: 2008 / Vehicle: Flhtcu` reads like an inbound-unit
 * spec and drags the answer toward "arriving". So the gate is seeded with the establishing PROSE.
 *
 * WHAT IS PINNED — the pure decision (executed), the seed picker, and the WIRING, which a ratchet
 * cannot prove and which is the entire shape of this bug.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decideEstablishedStockBlocksArm,
  establishingNoteForArrivalCheck,
  incomingUnitArrivalConfidenceFloor,
  parseIncomingUnitArrivalWithLLM
} from "../services/api/src/domain/incomingUnitArrival.js";

/** Zack's note, verbatim from the live store (the `Inquiry:` block, without the ADF header). */
const ZACK_NOTE =
  "Zack called looking to see if we had any pre-owned ultras under $7,500. I showed him the 2008 " +
  "FLHTCU that i just took in on trade. I told him we are going to get it through the service " +
  "department to get serviced before it is ready to sell and we are waiting for the title. Told him " +
  "I will give him a call when it is ready to sell. Remind me to call him by the end of the month.";

const FLOOR = incomingUnitArrivalConfidenceFloor();

let failures = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok  ${name}`))
    .catch(err => {
      failures += 1;
      console.error(`  FAIL  ${name}: ${(err as Error).message}`);
    });
}

await check("a confident already_here blocks the arm", () => {
  const d = decideEstablishedStockBlocksArm({
    parse: { status: "already_here", confidence: 0.9 },
    confidenceFloor: FLOOR
  });
  assert.equal(d.block, true);
  assert.equal(d.reason, "established_stock_comprehended");
});

// FAIL DIRECTION. This arm has no gate today, so every one of these must keep arming exactly as it
// does now. Blocking on anything less than a confident already_here would be a NEW behaviour with a
// blast radius nobody measured.
await check("every uncertainty keeps today's behaviour - it arms", () => {
  const cases: Array<[string, Parameters<typeof decideEstablishedStockBlocksArm>[0]]> = [
    ["parser unavailable", { parse: null, confidenceFloor: FLOOR }],
    ["parser undefined", { parse: undefined, confidenceFloor: FLOOR }],
    ["arriving", { parse: { status: "arriving", confidence: 0.99 }, confidenceFloor: FLOOR }],
    ["none", { parse: { status: "none", confidence: 0.99 }, confidenceFloor: FLOOR }],
    ["already_here but hedged", { parse: { status: "already_here", confidence: 0.4 }, confidenceFloor: FLOOR }],
    ["already_here, no confidence", { parse: { status: "already_here" } as any, confidenceFloor: FLOOR }]
  ];
  for (const [label, args] of cases) {
    assert.equal(decideEstablishedStockBlocksArm(args).block, false, `${label} must not block`);
  }
});

await check("the floor is respected exactly at the boundary", () => {
  assert.equal(
    decideEstablishedStockBlocksArm({ parse: { status: "already_here", confidence: FLOOR }, confidenceFloor: FLOOR }).block,
    true
  );
  assert.equal(
    decideEstablishedStockBlocksArm({
      parse: { status: "already_here", confidence: FLOOR - 0.01 },
      confidenceFloor: FLOOR
    }).block,
    false
  );
});

// The seed picker: the establishing PROSE, never the ADF field header (see the measurement above).
await check("the seed is the lead's prose, and absent prose reads as no note", () => {
  assert.equal(establishingNoteForArrivalCheck({ lead: { inquiry: ZACK_NOTE } }), ZACK_NOTE);
  assert.equal(establishingNoteForArrivalCheck({ lead: { comment: "took it in on trade" } }), "took it in on trade");
  assert.equal(establishingNoteForArrivalCheck({ lead: {} }), "");
  assert.equal(establishingNoteForArrivalCheck({}), "");
  assert.equal(establishingNoteForArrivalCheck(null), "");
  const picked = establishingNoteForArrivalCheck({ lead: { inquiry: ZACK_NOTE } });
  assert.ok(!picked.includes("PHONE LOG"), "the ADF header must never reach the parser");
  assert.ok(!/Vehicle:\s*Flhtcu/.test(picked), "the field header destabilises the read - 2 of 6 wrong");
});

// 5. THE PRODUCTION CASE, executed. Measured 10/10 already_here @ 0.85-0.90 against a 0.7 floor, so
//    this is a collapse tripwire rather than a coin flip. It asserts the DECISION, not the label.
await check("Zack's real note blocks the arm end to end", async () => {
  const parse = await parseIncomingUnitArrivalWithLLM({ seedText: ZACK_NOTE });
  assert.ok(parse, "the parser must answer on the establishing note");
  const d = decideEstablishedStockBlocksArm({ parse, confidenceFloor: FLOOR });
  assert.equal(d.block, true, `expected a block, got ${JSON.stringify(parse)}`);
});

// 6. THE WIRING. The referee being right is worth nothing if the applier never asks it, or if the
//    callers reply about a unit it declined to arm — the ratchet cannot prove either.
await check("the shared applier asks the gate, and both callers respect its answer", () => {
  const src = readFileSync("services/api/src/index.ts", "utf8");
  assert.ok(
    src.includes("const establishedStock = await pendingIncomingArmBlockedByEstablishedStock(conv);"),
    "the applier must consult the established-stock gate"
  );
  const gateAt = src.indexOf("pendingIncomingArmBlockedByEstablishedStock(conv)");
  const purposeAt = src.indexOf("parseIncomingInventoryPurposeWithLLM({");
  assert.ok(gateAt > 0 && purposeAt > gateAt, "the gate must run BEFORE we comprehend why it is coming in");
  assert.ok(
    src.includes("pending_incoming_arm_blocked_established_stock"),
    "a blocked arm must record why it exited"
  );
  // Both the live and the regenerate caller must branch on the applier's return, or a declined arm
  // still sends the customer an acknowledgement about a unit we never armed.
  // Counting the calls is not enough: flipping `&&` to `||` leaves the count at 2 and re-opens the
  // bug. Pin the CONJUNCTION — the acknowledgement AND a successful arm.
  const conjoined = src.match(/Acknowledgement &&\s*\n\s*\(await applyPendingIncomingInventoryState\(conv, \{/g) ?? [];
  assert.equal(conjoined.length, 2, `both paths must AND the ack with the arm, found ${conjoined.length}`);
  assert.ok(
    !/Acknowledgement \|\|\s*\n\s*\(await applyPendingIncomingInventoryState/.test(src),
    "an acknowledgement OR-ed with the arm would reply about a unit we declined to arm"
  );
});

if (failures) {
  console.error(`established_stock_blocks_incoming_arm:eval FAILED (${failures} case(s))`);
  process.exit(1);
}
console.log("established_stock_blocks_incoming_arm:eval OK (6 case(s))");
