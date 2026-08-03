/**
 * inventory_hold_record:eval — ONE referee for "who may put a bike on hold for a lead, and what
 * does that hold record say?"
 *
 * WHAT WAS FIGHTING. Two places wrote `conv.hold`, and they were hand-maintained COPIES of each
 * other — the same fourteen fields in the same order, followed by the same cadence/mode aftermath:
 *
 *   index.ts applyOutcomeHold                    a rep records the appointment outcome as "held"
 *   POST /conversations/:id/resolution           the console's manual resolution, resolution "hold"
 *
 * The INVERSE referee already existed — `decideInventoryAvailabilityReopen` (PR #463) — but it only
 * ever CLEARS a hold, so it could not vouch for either of these. The only thing keeping the two
 * copies equal was that nobody had yet edited one without the other.
 *
 * TWO DIVERGENCES, PINNED AS-IS (preserved by the un-stacking, NOT fixed by it):
 *
 * (1) THE MODE STOMP. Both lanes stop the chase. The console lane then sets `paused_indefinite`
 *     only when this request did NOT also arm an inventory watch AND the thread is not already
 *     `manual_handoff`. The appointment-outcome lane sets it unconditionally, overwriting both.
 *     Overwriting `manual_handoff` is the fail-unsafe half: the thread stops saying "a human owns
 *     this", and the console's own hold_clear branch later flips a `unit_hold`/`order_hold` thread
 *     back to ACTIVE — so the agent can resume texting a lead a human had taken over. Nothing is
 *     texted at hold time (the chase is stopped either way), so it is LATENT, not a live send.
 *
 * (2) THE NULL KEY. An on-order hold has no stock number or VIN, so `normalizeInventoryHoldKey`
 *     returns null. The outcome lane stores that null; the console lane collapses it to `undefined`,
 *     which drops the property from the saved JSON. Every reader coalesces, so they behave the same
 *     — but they are not the same stored RECORD, so the difference is carried rather than tidied.
 *
 * FAIL DIRECTION. A hold STOPS outreach, so an unresolved lane should hold rather than not. What is
 * not reversible is waking the agent up on a thread a human owns — which is an argument for giving
 * the outcome lane the console lane's guards, in its own `fix/` PR with its own evidence.
 *
 * Behavior assertions only — no source-text pins (see eval_source_pin_ratchet:eval).
 *
 * Run: npx tsx scripts/inventory_hold_record_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH ||
  path.join(os.tmpdir(), `inventory-hold-record-eval-${Date.now()}.json`);

const { decideInventoryHoldRecord } = await import("../services/api/src/domain/routeStateReducer.ts");
const { applyInventoryHoldRecord } = await import("../services/api/src/domain/conversationStore.ts");

let checks = 0;
const eq = (actual: unknown, expected: unknown, message: string) => {
  assert.deepEqual(actual, expected, message);
  checks++;
};

const NOW = "2026-08-03T16:00:00.000Z";
const EARLIER = "2026-07-01T09:00:00.000Z";
const UNIT = {
  stockId: "T36-25",
  vin: "1HD1KHM19KB600123",
  year: "2025",
  make: "Harley-Davidson",
  model: "Road Glide",
  trim: "Limited",
  color: "Vivid Black",
  label: "2025 Harley-Davidson Road Glide Limited"
};

// --- THE LOAD-BEARING SECTION: the ORIGINAL inline rules, re-encoded as a table ------------------
// This is what turns "behavior-preserving" from a claim into something executable. Each row is what
// the code at that call site did BEFORE the un-stacking, read off the original source. If the
// referee ever stops matching a row, the un-stacking silently changed behavior.
//
// `decision_equivalence` does NOT carry this proof: it samples registered referees, and a brand-new
// referee has no baseline to differ from. This table is the proof.
{
  const ORIGINAL_RULES = [
    {
      site: "index.ts applyOutcomeHold — a floor unit",
      input: { lane: "appointment_outcome" as const, holdKey: "t36-25", onOrder: false },
      // Original: `reason: isOnOrderHold ? "order_hold" : "unit_hold"`.
      reason: "unit_hold",
      // Original: `key: holdKey` — the raw normalizer result, null included.
      key: "t36-25",
      // Original: an UNCONDITIONAL `setFollowUpMode(conv, "paused_indefinite", holdReason)`.
      setPausedIndefinite: true
    },
    {
      site: "index.ts applyOutcomeHold — a bike on order (no stock number, no VIN)",
      input: { lane: "appointment_outcome" as const, holdKey: null, onOrder: true },
      reason: "order_hold",
      // THE preserved divergence 2: this lane stores the literal null.
      key: null,
      setPausedIndefinite: true
    },
    {
      site: "index.ts applyOutcomeHold — a human already owns the thread",
      input: {
        lane: "appointment_outcome" as const,
        holdKey: "t36-25",
        onOrder: false,
        currentFollowUpMode: "manual_handoff"
      },
      reason: "unit_hold",
      key: "t36-25",
      // THE preserved divergence 1: the original never looked, so the handoff is overwritten.
      setPausedIndefinite: true
    },
    {
      site: "console resolution hold — a floor unit, nothing else on the request",
      input: {
        lane: "console_resolution" as const,
        holdKey: "t36-25",
        onOrder: false,
        watchApplied: false
      },
      reason: "unit_hold",
      key: "t36-25",
      // Original: `if (!shouldApplyWatch && conv.followUp?.mode !== "manual_handoff")`.
      setPausedIndefinite: true
    },
    {
      site: "console resolution hold — a bike on order",
      input: {
        lane: "console_resolution" as const,
        holdKey: null,
        onOrder: true,
        watchApplied: false
      },
      reason: "order_hold",
      // Divergence 2, the other side: `key: holdKey || undefined` drops the property.
      key: undefined,
      setPausedIndefinite: true
    },
    {
      site: "console resolution hold — a watch was armed on the SAME request",
      input: {
        lane: "console_resolution" as const,
        holdKey: "t36-25",
        onOrder: false,
        watchApplied: true
      },
      reason: "unit_hold",
      key: "t36-25",
      // Original: the watch arm set `holding_inventory` earlier in the handler; the hold must not
      // stomp it back to paused_indefinite.
      setPausedIndefinite: false
    },
    {
      site: "console resolution hold — a human already owns the thread",
      input: {
        lane: "console_resolution" as const,
        holdKey: "t36-25",
        onOrder: false,
        watchApplied: false,
        currentFollowUpMode: "manual_handoff"
      },
      reason: "unit_hold",
      key: "t36-25",
      // Divergence 1, the other side: this lane DOES look, and spares the handoff.
      setPausedIndefinite: false
    }
  ];

  for (const rule of ORIGINAL_RULES) {
    const decision = decideInventoryHoldRecord({ ...rule.input, unit: UNIT, nowIso: NOW });
    eq(decision.reason, rule.reason, `${rule.site}: same hold reason as before`);
    eq(decision.record.key, rule.key, `${rule.site}: stores the same hold key as before`);
    eq(
      decision.setPausedIndefinite,
      rule.setPausedIndefinite,
      `${rule.site}: pauses the thread indefinitely exactly when it did before`
    );
    eq(decision.stopCadenceReason, rule.reason, `${rule.site}: stops the chase under the hold reason`);
  }
}

// --- the stored record is byte-identical, FIELD ORDER included ------------------------------------
// The persisted JSON must not move. Key order is part of that, and both originals used this order —
// so "tidy the shape" is a regression, not an improvement (the #471 lesson).
{
  const decision = decideInventoryHoldRecord({
    lane: "appointment_outcome",
    holdKey: "t36-25",
    onOrder: false,
    unit: UNIT,
    note: "customer putting a deposit down Friday",
    nowIso: NOW
  });
  eq(
    Object.keys(decision.record),
    [
      "key",
      "onOrder",
      "stockId",
      "vin",
      "year",
      "make",
      "model",
      "trim",
      "color",
      "label",
      "note",
      "reason",
      "createdAt",
      "updatedAt"
    ],
    "the record's field ORDER is the originals' order — the persisted JSON must not move"
  );
  eq(decision.record.stockId, UNIT.stockId, "the unit's stock number is carried through");
  eq(decision.record.vin, UNIT.vin, "...its VIN");
  eq(decision.record.year, UNIT.year, "...its year");
  eq(decision.record.make, UNIT.make, "...its make");
  eq(decision.record.model, UNIT.model, "...its model");
  eq(decision.record.trim, UNIT.trim, "...its trim");
  eq(decision.record.color, UNIT.color, "...its color");
  eq(decision.record.label, UNIT.label, "...and the label the console shows");
  eq(decision.record.note, "customer putting a deposit down Friday", "the staff note is stored");
  eq(decision.record.updatedAt, NOW, "stamped at the caller's clock, not the wall clock");
}

// --- `onOrder` is stored as true-or-absent, never false -------------------------------------------
// Both originals wrote `onOrder: isOnOrderHold || undefined`. Storing a literal `false` would add a
// property to the saved JSON that has never been there.
{
  eq(
    decideInventoryHoldRecord({
      lane: "console_resolution",
      holdKey: "t36-25",
      onOrder: false,
      unit: UNIT,
      nowIso: NOW
    }).record.onOrder,
    undefined,
    "a floor unit stores NO onOrder property, not `false`"
  );
  eq(
    decideInventoryHoldRecord({
      lane: "console_resolution",
      holdKey: null,
      onOrder: true,
      unit: UNIT,
      nowIso: NOW
    }).record.onOrder,
    true,
    "a bike on order stores onOrder: true"
  );
}

// --- createdAt is the FIRST hold, not this one ----------------------------------------------------
// Both originals read `conv.hold?.createdAt ?? nowIso`. Re-holding the same lead must not reset the
// clock — anything reporting on how long a bike has been held off the floor reads this.
{
  eq(
    decideInventoryHoldRecord({
      lane: "appointment_outcome",
      holdKey: "t36-25",
      onOrder: false,
      unit: UNIT,
      nowIso: NOW,
      existingCreatedAt: EARLIER
    }).record.createdAt,
    EARLIER,
    "a re-hold keeps the ORIGINAL createdAt"
  );
  eq(
    decideInventoryHoldRecord({
      lane: "appointment_outcome",
      holdKey: "t36-25",
      onOrder: false,
      unit: UNIT,
      nowIso: NOW
    }).record.createdAt,
    NOW,
    "a first hold stamps createdAt now"
  );
}

// --- the divergences are NAMED on the decision, not buried ----------------------------------------
{
  eq(
    decideInventoryHoldRecord({
      lane: "console_resolution",
      holdKey: "t36-25",
      onOrder: false,
      unit: UNIT,
      nowIso: NOW,
      currentFollowUpMode: "manual_handoff"
    }).divergence,
    null,
    "the console lane is the careful answer, so it carries no divergence"
  );
  eq(
    decideInventoryHoldRecord({
      lane: "appointment_outcome",
      holdKey: "t36-25",
      onOrder: false,
      unit: UNIT,
      nowIso: NOW,
      currentFollowUpMode: "manual_handoff"
    }).divergence,
    "appointment_outcome_hold_overwrites_a_human_handoff",
    "the outcome lane's stomp over a human handoff is reported, so the known gap is visible"
  );
  eq(
    decideInventoryHoldRecord({
      lane: "appointment_outcome",
      holdKey: "t36-25",
      onOrder: false,
      unit: UNIT,
      nowIso: NOW,
      currentFollowUpMode: "active"
    }).divergence,
    null,
    "...and NOT reported on an ordinary thread, where the two lanes agree"
  );
}

// --- the applier writes what the referee decided ---------------------------------------------------
{
  // The outcome lane over a human handoff: the record lands, the chase stops, the handoff is lost.
  const conv: any = {
    id: "c1",
    leadKey: "lead-1",
    followUp: { mode: "manual_handoff", reason: "staff_took_over" },
    followUpCadence: { status: "active", kind: "standard_ramp", stepIndex: 3 }
  };
  const decision = applyInventoryHoldRecord(conv, {
    lane: "appointment_outcome",
    holdKey: "t36-25",
    onOrder: false,
    unit: UNIT,
    note: "held for pickup",
    nowIso: NOW
  });
  eq(conv.hold.key, "t36-25", "the hold record lands on the conversation");
  eq(conv.hold.reason, "unit_hold", "...under the right reason");
  eq(conv.hold.label, UNIT.label, "...carrying the unit label");
  eq(conv.followUpCadence.status, "stopped", "the chase is stopped — a held bike ends the chase");
  eq(
    conv.followUp.mode,
    "paused_indefinite",
    "THE DIVERGENCE, applied: the outcome lane overwrites the human handoff"
  );
  eq(decision.divergence, "appointment_outcome_hold_overwrites_a_human_handoff", "...and says so");
}

{
  // The console lane, same starting state: the record lands, the chase stops, the handoff SURVIVES.
  const conv: any = {
    id: "c2",
    leadKey: "lead-2",
    followUp: { mode: "manual_handoff", reason: "staff_took_over" },
    followUpCadence: { status: "active", kind: "standard_ramp", stepIndex: 3 }
  };
  applyInventoryHoldRecord(conv, {
    lane: "console_resolution",
    holdKey: "t36-25",
    onOrder: false,
    unit: UNIT,
    nowIso: NOW,
    watchApplied: false
  });
  eq(conv.hold.key, "t36-25", "the hold record lands");
  eq(conv.followUpCadence.status, "stopped", "the chase is stopped here too");
  eq(conv.followUp.mode, "manual_handoff", "...but the human keeps the thread");
  eq(conv.followUp.reason, "staff_took_over", "...with the reason they took it over for");
}

{
  // The console lane with a watch armed on the same request: the watch's mode must stand.
  const conv: any = {
    id: "c3",
    leadKey: "lead-3",
    followUp: { mode: "holding_inventory", reason: "inventory_watch" },
    followUpCadence: { status: "active", kind: "standard_ramp", stepIndex: 1 }
  };
  applyInventoryHoldRecord(conv, {
    lane: "console_resolution",
    holdKey: "t36-25",
    onOrder: false,
    unit: UNIT,
    nowIso: NOW,
    watchApplied: true
  });
  eq(conv.followUp.mode, "holding_inventory", "the watch's mode stands — the hold does not stomp it");
  eq(conv.followUpCadence.status, "stopped", "and the chase is still stopped");
}

{
  // A bike on order, through the applier, on a lead with nothing stored yet — the common first-hold
  // shape, and it must not throw.
  const conv: any = { id: "c4", leadKey: "lead-4" };
  applyInventoryHoldRecord(conv, {
    lane: "console_resolution",
    holdKey: null,
    onOrder: true,
    unit: { label: "2026 Street Glide (on order)" },
    nowIso: NOW,
    watchApplied: false
  });
  eq(conv.hold.reason, "order_hold", "an on-order hold lands as order_hold");
  eq(conv.hold.onOrder, true, "...flagged on order");
  eq("key" in conv.hold, true, "...the key property exists on the console lane's record");
  eq(conv.hold.key, undefined, "...as undefined, which drops it from the saved JSON (divergence 2)");
  eq(conv.hold.createdAt, NOW, "...stamped now, since this lead held nothing before");
  eq(conv.followUp.mode, "paused_indefinite", "...and an ordinary thread pauses indefinitely");
}

{
  // The outcome lane's on-order hold stores the literal null — the other side of divergence 2.
  const conv: any = { id: "c5", leadKey: "lead-5" };
  applyInventoryHoldRecord(conv, {
    lane: "appointment_outcome",
    holdKey: null,
    onOrder: true,
    unit: { label: "2026 Street Glide (on order)" },
    nowIso: NOW
  });
  eq(conv.hold.key, null, "the outcome lane stores a literal null key (divergence 2, preserved)");
}

// --- THE UNWIRE TEST: no unrefereed writer may put a bike on hold ----------------------------------
// Stronger than leaning on the ratchet total, which can cancel a +1 against a -1 and report GREEN on
// a genuine re-stacking (measured twice: #462 and #484). This asks the contention analyzer directly
// and NAMES the offender. Never accept a green ratchet as proof a write site is still wired.
{
  const { rankContention } = await import("../services/api/src/domain/stateWriterContention.ts");
  const ROOT = path.resolve("services/api/src");
  const files: Array<{ path: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        files.push({ path: path.relative(process.cwd(), full), text: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(ROOT);
  assert.ok(files.length > 50, "unwire test: that is not the real tree — an empty scan must never pass");
  const ranked = rankContention(files as any, { minWrites: 1 });

  const row = ranked.find((r: any) => r.field === "hold");
  // The field must still be VISIBLE to the analyzer — if it vanished, the test proves nothing.
  assert.ok(row, "unwire test: the analyzer no longer sees `hold` at all — the scan is broken");
  checks++;
  const offenders = ((row as any).unrefereedWriterSites ?? []).map(
    (s: any) => `${s.path ?? s.file}:${s.line}`
  );
  eq(
    offenders,
    [],
    `no unrefereed writer may set \`hold\` — every hold must ask decideInventoryHoldRecord. Found: ${offenders.join(", ")}`
  );
}

// --- the referee is registered with the equivalence harness ----------------------------------------
// An un-stacking whose referee is missing from buildDecisionRegistry ships with no evidence behind
// it: decision_equivalence would report IDENTICAL because it never looked.
{
  const reducer = await import("../services/api/src/domain/routeStateReducer.ts");
  const { buildDecisionRegistry } = await import("../services/api/src/domain/decisionFingerprint.ts");
  const registry = buildDecisionRegistry(reducer as any);
  const covered = registry.filter((entry: any) =>
    (entry.covers ?? []).includes("decideInventoryHoldRecord")
  );
  eq(covered.length, 2, "both lanes are sampled by the equivalence harness");
  for (const lane of ["appointment_outcome", "console_resolution"]) {
    eq(
      covered.some((entry: any) => entry.name === `inventoryHoldRecord:${lane}`),
      true,
      `the harness samples the ${lane} lane specifically`
    );
  }
  // ...and the samplers must actually project. One that silently returns undefined for every lead
  // would make the harness report IDENTICAL while comparing nothing.
  const lead = { followUp: { mode: "manual_handoff" }, hold: { createdAt: EARLIER } } as any;
  for (const entry of covered) {
    eq(
      entry.sample(lead, { nowMs: Date.parse(NOW), timeZone: "America/New_York" }) !== undefined,
      true,
      `${entry.name} projects a real answer off stored state`
    );
  }
  // The sampler must read the lead's STORED mode, or it could never see divergence 1 move.
  const outcome = covered.find((e: any) => e.name === "inventoryHoldRecord:appointment_outcome");
  eq(
    (outcome as any).sample(lead, { nowMs: Date.parse(NOW), timeZone: "America/New_York" }).divergence,
    "appointment_outcome_hold_overwrites_a_human_handoff",
    "the outcome sampler reports the stomp for a lead a human actually owns"
  );
  eq(
    (outcome as any).sample({ followUp: { mode: "active" } } as any, {
      nowMs: Date.parse(NOW),
      timeZone: "America/New_York"
    }).divergence,
    null,
    "...and not for an ordinary lead — so the projection tracks stored state, not a constant"
  );
}

console.log(`PASS inventory hold record — one referee for who may hold a bike (${checks} checks)`);
