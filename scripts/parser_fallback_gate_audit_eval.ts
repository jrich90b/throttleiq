/**
 * Parser-fallback gate audit (pure + filesystem; no LLM).
 *
 * Joe, 2026-08-11: "are there still any regex that triggers before the llm parser that shouldn't
 * be?" Measured on `main` at the time: NO keyword guard in the twilio handler fires before a parser
 * has read the turn (0 of 35), and the master keyword-fallback switch is hard-off. But ONE gate
 * disagrees with our own written rule. AGENTS.md "Fallback-vs-Parser Precedence":
 *
 *   > A fallback may not overrule a parser verdict that exists — INCLUDING A HEDGED ONE BELOW THE
 *   > ACCEPT FLOOR. A hedged reading of the sentence beats a keyword that never read it.
 *
 * `canUseInboundReplyActionFallback` opens the door to the keyword whenever confidence sits under
 * the floor (0.74) even though a reading EXISTS — the `hedged_below_floor` branch. It guards eleven
 * call sites in the live path plus the regenerate twin, and 252 customer turns ran through that
 * parser in the first ten days of August.
 *
 * Nothing could count how often it bites: the usage log records that a parser RAN, not what it
 * returned, and route-outcome counters are in-memory and die with every restart (8-17 a day). So the
 * instrument lands FIRST and the precedence change waits for its numbers. This eval pins the
 * instrument — and, just as importantly, pins that it changed NO decision.
 *
 * Everything here EXECUTES the real functions. A source-text assertion could not tell the difference
 * between an instrument that is wired and one that is merely present.
 *
 * Run: npx tsx scripts/parser_fallback_gate_audit_eval.ts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const FLOOR = 0.74;

async function main(): Promise<void> {
  process.env.LLM_INBOUND_REPLY_ACTION_CONFIDENCE_MIN = String(FLOOR); // pin it; never read the box's

  const {
    classifyInboundReplyActionFallback,
    canUseInboundReplyActionFallback,
    auditInboundReplyActionFallbackGate
  } = await import("../services/api/src/domain/inboundReplyActionPrompt.ts");
  const { recordParserFallbackAudit, parserFallbackAuditEnabled } = await import(
    "../services/api/src/domain/parserFallbackAudit.ts"
  );

  const parse = (confidence: number, action = "set_inventory_watch", explicitAction = true) =>
    ({ action, explicitAction, confidence }) as any;

  // --- 1. the four branches, named ---------------------------------------------------------------
  const cases: Array<[string, { parserEligible: boolean; parsed: any }, boolean, string]> = [
    ["parser never ran", { parserEligible: false, parsed: null }, true, "parser_disabled"],
    ["parser ran, read nothing", { parserEligible: true, parsed: null }, true, "no_parse"],
    ["parser READ the turn but hedged", { parserEligible: true, parsed: parse(0.6) }, true, "hedged_below_floor"],
    ["parser read it confidently", { parserEligible: true, parsed: parse(0.9) }, false, "reading_at_or_above_floor"],
    // Exactly at the floor is NOT hedged — the original used `<`, and an off-by-one here would
    // silently reclassify every borderline turn in the numbers we are about to collect.
    ["parser exactly at the floor", { parserEligible: true, parsed: parse(FLOOR) }, false, "reading_at_or_above_floor"]
  ];
  for (const [label, input, expectedAllowed, expectedReason] of cases) {
    const gate = classifyInboundReplyActionFallback(input);
    assert.equal(gate.allowed, expectedAllowed, `${label}: keyword allowed?`);
    assert.equal(gate.reason, expectedReason, `${label}: reason`);
    assert.equal(gate.floor, FLOOR, `${label}: the floor is reported, not assumed`);
  }

  // --- 2. THE INSTRUMENT CHANGED NO DECISION -----------------------------------------------------
  // Recomputed here from the three lines the gate had BEFORE this change, so the eval does not just
  // agree with itself. Every input the classifier can see must produce the identical boolean.
  const original = (input: { parserEligible: boolean; parsed: any }): boolean => {
    if (!input.parserEligible) return true;
    if (!input.parsed) return true;
    const c = typeof input.parsed.confidence === "number" && Number.isFinite(input.parsed.confidence)
      ? input.parsed.confidence
      : 0;
    return c < FLOOR;
  };
  const grid: Array<{ parserEligible: boolean; parsed: any }> = [];
  for (const parserEligible of [true, false]) {
    for (const parsed of [
      null,
      parse(0),
      parse(0.5),
      parse(0.73),
      parse(FLOOR),
      parse(0.75),
      parse(1),
      parse(Number.NaN),
      { action: "none", explicitAction: false } as any // confidence missing entirely
    ]) {
      grid.push({ parserEligible, parsed });
    }
  }
  for (const input of grid) {
    const expected = original(input);
    assert.equal(canUseInboundReplyActionFallback(input), expected, "pure gate must be unchanged");
    assert.equal(classifyInboundReplyActionFallback(input).allowed, expected, "classifier must agree");
  }
  console.log(`gate behaviour unchanged across ${grid.length} inputs`);

  // --- 3. the audited wrapper writes a row AND returns the same answer ----------------------------
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "parser-fallback-audit-"));
  const auditPath = path.join(dir, "audit.jsonl");
  const envBefore = {
    PARSER_FALLBACK_AUDIT_PATH: process.env.PARSER_FALLBACK_AUDIT_PATH,
    PARSER_FALLBACK_AUDIT_ENABLED: process.env.PARSER_FALLBACK_AUDIT_ENABLED
  };
  try {
    process.env.PARSER_FALLBACK_AUDIT_PATH = auditPath;
    delete process.env.PARSER_FALLBACK_AUDIT_ENABLED;
    assert.ok(parserFallbackAuditEnabled(), "the audit is ON by default — it exists to accrue data");

    // A hedged reading, on a turn whose words a keyword WOULD claim. This is the whole finding.
    const hedgedAllowed = auditInboundReplyActionFallbackGate({
      lane: "live",
      parserEligible: true,
      parsed: parse(0.6),
      text: "let me know when you get one in",
      convId: "+17165550123",
      messageId: "SM_audit_1"
    });
    assert.equal(hedgedAllowed, true, "the wrapper returns exactly what the pure gate returns");

    // Same hedged reading, wording no keyword claims: the door is open, nobody walks through.
    auditInboundReplyActionFallbackGate({
      lane: "live", parserEligible: true, parsed: parse(0.6), text: "sounds good", convId: "c2", messageId: "m2"
    });
    // A confident reading: the keyword is locked out no matter what the words say.
    const confidentAllowed = auditInboundReplyActionFallbackGate({
      lane: "regen", parserEligible: true, parsed: parse(0.95), text: "let me know when you get one in",
      convId: "c3", messageId: "m3"
    });
    assert.equal(confidentAllowed, false, "a reading at or above the floor blocks the keyword");

    const rows = (await fs.readFile(auditPath, "utf8")).trim().split("\n").map(l => JSON.parse(l));
    assert.equal(rows.length, 3, "every gate evaluation is recorded — the denominator matters as much as the hits");
    for (const row of rows) {
      assert.equal(row.kind, "inbound_reply_action_fallback_gate");
      assert.ok(typeof row.at === "string" && row.at.endsWith("Z"), "rows are timestamped");
      assert.equal(row.floor, FLOOR, "the floor travels with the row, so a later change to it is visible");
    }

    assert.equal(rows[0].reason, "hedged_below_floor");
    assert.equal(rows[0].confidence, 0.6, "what the parser actually said is recorded, not just that it was low");
    assert.equal(rows[0].action, "set_inventory_watch", "and WHAT it read");
    assert.equal(rows[0].lane, "live");
    assert.equal(rows[0].convId, "+17165550123");
    assert.equal(
      rows[0].disagreesWithKeyword,
      true,
      "parser read the turn, hedged, and a keyword that never read it wants to speak — the count we came for"
    );
    assert.equal(rows[1].disagreesWithKeyword, false, "door open but no keyword claims the turn");
    assert.equal(rows[2].reason, "reading_at_or_above_floor");
    assert.equal(
      rows[2].disagreesWithKeyword,
      false,
      "keyword words present, but a confident reading means no disagreement to count"
    );
    assert.equal(rows[2].lane, "regen", "both reply paths are instrumented, not just the live one");
    console.log(`audit rows written and readable (${rows.length}), 1 disagreement counted`);

    // --- 4. it can be switched off, and switching it off changes no decision ---------------------
    process.env.PARSER_FALLBACK_AUDIT_ENABLED = "0";
    assert.equal(parserFallbackAuditEnabled(), false);
    assert.equal(recordParserFallbackAudit({ kind: "should_not_be_written" }), false);
    const stillAllowed = auditInboundReplyActionFallbackGate({
      lane: "live", parserEligible: true, parsed: parse(0.6), text: "let me know when you get one in"
    });
    assert.equal(stillAllowed, true, "the answer is the same whether or not anyone is writing it down");
    const afterOff = (await fs.readFile(auditPath, "utf8")).trim().split("\n");
    assert.equal(afterOff.length, 3, "nothing is appended while the audit is off");
    delete process.env.PARSER_FALLBACK_AUDIT_ENABLED;

    // --- 5. a broken audit destination must never break a customer turn ---------------------------
    // The path is a DIRECTORY, so every write throws inside the writer.
    process.env.PARSER_FALLBACK_AUDIT_PATH = dir;
    assert.equal(recordParserFallbackAudit({ kind: "unwritable" }), false, "a failed write reports false");
    const survives = auditInboundReplyActionFallbackGate({
      lane: "live", parserEligible: true, parsed: parse(0.6), text: "let me know when you get one in"
    });
    assert.equal(survives, true, "an unwritable audit path must not throw and must not change the answer");
    console.log("a broken audit destination is survivable");
  } finally {
    for (const [k, v] of Object.entries(envBefore)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }

  console.log(
    "PASS parser fallback gate audit — the hedged-below-floor branch is named, counted in both paths, off-switchable, unbreakable, and provably decision-neutral."
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
