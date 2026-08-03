/**
 * lead_closeout:eval — ONE referee for "the lead's thread is closing: what else has to settle?"
 *
 * WHAT WAS FIGHTING. Three places stamped a conversation closed, and only one of them was the
 * function whose job that is:
 *
 *   closeConversation(conv, reason)                 the generic close — every ordinary reason
 *   POST /conversations/:id/appointment-outcome     the console header's "sold" outcome
 *   POST .../questions/:convId/:questionId/done     the to-do endpoint's "sold" outcome
 *
 * The two outcome lanes are hand-maintained COPIES of each other — same sale record, same three
 * inline field writes (`status`, `closedAt`, `closedReason`), same follow-on post-sale cadence —
 * and both bypass `closeConversation` entirely. Three Tier-1 fields carried independent writers
 * with nobody arbitrating, and the only thing keeping the copies equal was that nobody had yet
 * edited one without the other.
 *
 * THE DIVERGENCE, PINNED AS-IS (preserved by the un-stacking, NOT fixed by it): `closeConversation`
 * pauses every ACTIVE inventory watch at write time, so a reopen cannot refire "it's available
 * again!" at a customer who already closed or bought (the `watch_active_on_closed` leak the outcome
 * auditor surfaced 6/25). Neither sold lane does. It is mitigated rather than unnoticed — the
 * state-invariant reconcile pauses watches on anything carrying closedAt/closedReason/sale.soldAt,
 * and its own comment names this exact gap — so the exposure is the window between the sold write
 * and the next tick, not a permanent leak. Preserved and named here; changing it is a behavior
 * change and belongs in its own `fix/` PR.
 *
 * FAIL DIRECTION. Pausing a watch is REVERSIBLE (the record stays; the fire engine skips paused)
 * while an alert already texted to someone who bought is not. So an unresolved lane should pause —
 * which is an argument for changing the sold lanes, not for changing the generic one.
 *
 * Behavior assertions only — no source-text pins (see eval_source_pin_ratchet:eval).
 *
 * Run: npx tsx scripts/lead_closeout_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH ||
  path.join(os.tmpdir(), `lead-closeout-eval-${Date.now()}.json`);

const { decideLeadCloseout } = await import("../services/api/src/domain/routeStateReducer.ts");
const { applyLeadCloseout } = await import("../services/api/src/domain/conversationStore.ts");

let checks = 0;
const eq = (actual: unknown, expected: unknown, message: string) => {
  assert.deepEqual(actual, expected, message);
  checks++;
};

const NOW = "2026-08-03T16:00:00.000Z";

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
      lane: "generic_close" as const,
      site: "conversationStore.closeConversation",
      reason: "not_interested",
      // Original: `conv.closedReason = reason` — passed through verbatim.
      closedReason: "not_interested",
      // Original: an unconditional `for (const w of collectInventoryWatches(conv)) ... = "paused"`.
      pauseActiveWatches: true
    },
    {
      lane: "generic_close" as const,
      site: "conversationStore.closeConversation, called with no reason",
      reason: undefined,
      // Original stored `undefined`, NOT "closed" — the string default lives in the cadence
      // lifecycle call (`stopReason: reason ?? "closed"`), never on the stored field. Defaulting
      // here would invent a closedReason on every bare close, which readers key off.
      closedReason: undefined,
      pauseActiveWatches: true
    },
    {
      lane: "appointment_outcome_sold" as const,
      site: "index.ts appointment-outcome sold (conversation header)",
      reason: "sold",
      // Original: `conv.closedReason = "sold"` — hard-coded, never read from a caller.
      closedReason: "sold",
      // Original: no watch loop anywhere in the block. THE preserved divergence.
      pauseActiveWatches: false
    },
    {
      lane: "appointment_outcome_sold" as const,
      site: "index.ts appointment-outcome sold (to-do endpoint) — the copy",
      reason: "sold",
      closedReason: "sold",
      pauseActiveWatches: false
    }
  ];

  for (const rule of ORIGINAL_RULES) {
    const decision = decideLeadCloseout({ lane: rule.lane, reason: rule.reason });
    eq(decision.closedReason, rule.closedReason, `${rule.site}: stores the same closedReason as before`);
    eq(
      decision.pauseActiveWatches,
      rule.pauseActiveWatches,
      `${rule.site}: pauses active watches exactly when it did before`
    );
  }
}

// --- the sold lane hard-codes its reason; the generic lane never invents one ---------------------
// Enumerated across reasons the store actually uses, including the shapes a tidy-up would "fix".
{
  for (const reason of ["sold", "not_interested", "duplicate", "", undefined]) {
    eq(
      decideLeadCloseout({ lane: "generic_close", reason }).closedReason,
      reason,
      `the generic lane passes ${JSON.stringify(reason)} through unchanged`
    );
    eq(
      decideLeadCloseout({ lane: "appointment_outcome_sold", reason }).closedReason,
      "sold",
      `the sold lane ignores the caller's ${JSON.stringify(reason)} and stores "sold"`
    );
  }
}

// --- the divergence is NAMED on the decision, not buried ------------------------------------------
{
  eq(
    decideLeadCloseout({ lane: "generic_close", reason: "sold" }).divergence,
    null,
    "the generic lane is the majority answer, so it carries no divergence"
  );
  eq(
    decideLeadCloseout({ lane: "appointment_outcome_sold", reason: "sold" }).divergence,
    "appointment_outcome_sold_leaves_active_watches_running_until_the_reconcile_tick",
    "the sold lane's odd answer is reported, so a caller can see the known gap"
  );
}

// --- the applier writes what the referee decided --------------------------------------------------
const leadWith = (watches: any[]): any => ({
  id: "c1",
  leadKey: "lead-1",
  status: "open",
  inventoryWatches: watches
});

{
  // The generic close: thread closed, reason stored, every active watch paused.
  const conv = leadWith([{ model: "Road Glide", status: "active" }, { model: "Street Bob" }]);
  const decision = applyLeadCloseout(conv, { nowIso: NOW, lane: "generic_close", reason: "not_interested" });
  eq(conv.status, "closed", "the thread closes");
  eq(conv.closedReason, "not_interested", "...with the caller's reason");
  eq(conv.closedAt, NOW, "...stamped at the caller's clock, not the wall clock");
  eq(
    conv.inventoryWatches.map((w: any) => w.status),
    ["paused", "paused"],
    "every active watch is paused — including one with no status set at all"
  );
  eq(decision.pauseActiveWatches, true, "and the applier reports what it did");
}

{
  // The sold lane: thread closes, watches deliberately left alone.
  const conv = leadWith([{ model: "Road Glide", status: "active" }]);
  const decision = applyLeadCloseout(conv, {
    nowIso: NOW,
    lane: "appointment_outcome_sold",
    reason: "sold"
  });
  eq(conv.status, "closed", "the sold outcome closes the thread");
  eq(conv.closedReason, "sold", "...as sold");
  eq(conv.closedAt, NOW, "...at the caller's clock");
  eq(
    conv.inventoryWatches.map((w: any) => w.status),
    ["active"],
    "THE DIVERGENCE, applied: the sold lane leaves an active watch running (reconcile tick catches it)"
  );
  eq(
    decision.divergence,
    "appointment_outcome_sold_leaves_active_watches_running_until_the_reconcile_tick",
    "...and says so"
  );
}

{
  // An already-paused watch is not re-stamped, and the legacy single `inventoryWatch` is unioned in
  // (collectInventoryWatches) — the array-if-present-else-single read is the leak this once had.
  const conv: any = {
    id: "c2",
    inventoryWatches: [{ model: "Low Rider", status: "paused" }],
    inventoryWatch: { model: "Fat Bob", status: "active" }
  };
  applyLeadCloseout(conv, { nowIso: NOW, lane: "generic_close", reason: "duplicate" });
  eq(conv.inventoryWatches[0].status, "paused", "an already-paused watch stays paused");
  eq(conv.inventoryWatch.status, "paused", "the legacy SINGLE watch is paused too, not skipped");
}

{
  // A lead with no watches at all is the common shape and must not throw.
  const conv: any = { id: "c3" };
  applyLeadCloseout(conv, { nowIso: NOW, lane: "generic_close", reason: undefined });
  eq(conv.status, "closed", "a lead with no watches closes cleanly");
  eq(conv.closedReason, undefined, "...and a bare close stores no reason");
}

// --- THE UNWIRE TEST: no unrefereed writer may stamp a thread closed -------------------------------
// Stronger than leaning on the ratchet total, which can cancel a +1 against a -1 and report GREEN on
// a genuine re-stacking (#462). This asks the contention analyzer directly and NAMES the offender.
//
// MEASURED ON THIS VERY CHANGE, so treat it as the rule and not a caution: unwiring the to-do
// endpoint's `applyLeadCloseout` call left `state_writer_contention:eval` at exactly 116/116 —
// restoring those three inline writes re-collapses a neighbouring writer, and the +1 and -1 cancel.
// The ratchet is BLIND to that re-stacking. This section is what catches it. Never accept a green
// ratchet as proof that a write site is still wired to its referee.
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

  for (const field of ["status", "closedReason", "closedAt"]) {
    const row = ranked.find((r: any) => r.field === field);
    // The field must still be VISIBLE to the analyzer — if it vanished, the test proves nothing.
    assert.ok(row, `unwire test: the analyzer no longer sees \`${field}\` at all — the scan is broken`);
    checks++;
    const offenders = ((row as any).unrefereedWriterSites ?? []).map(
      (s: any) => `${s.path ?? s.file}:${s.line}`
    );
    eq(
      offenders,
      [],
      `no unrefereed writer may set \`${field}\` — every close must ask decideLeadCloseout. Found: ${offenders.join(", ")}`
    );
  }
}

// --- the referee is registered with the equivalence harness ----------------------------------------
// An un-stacking whose referee is missing from buildDecisionRegistry ships with no evidence behind
// it: decision_equivalence would report IDENTICAL because it never looked.
{
  const reducer = await import("../services/api/src/domain/routeStateReducer.ts");
  const { buildDecisionRegistry } = await import("../services/api/src/domain/decisionFingerprint.ts");
  const registry = buildDecisionRegistry(reducer as any);
  const covered = registry.filter((entry: any) => (entry.covers ?? []).includes("decideLeadCloseout"));
  eq(covered.length, 2, "both lanes are sampled by the equivalence harness");
  for (const lane of ["generic_close", "appointment_outcome_sold"]) {
    eq(
      covered.some((entry: any) => entry.name === `leadCloseout:${lane}`),
      true,
      `the harness samples the ${lane} lane specifically`
    );
  }
  // ...and the samplers must actually project. One that silently returns undefined for every lead
  // would make the harness report IDENTICAL while comparing nothing.
  const lead = { closedReason: "not_interested" } as any;
  for (const entry of covered) {
    eq(
      entry.sample(lead, { nowMs: Date.parse(NOW), timeZone: "America/New_York" }) !== undefined,
      true,
      `${entry.name} projects a real answer off stored state`
    );
  }
}

console.log(`lead_closeout:eval OK — ${checks} checks`);
