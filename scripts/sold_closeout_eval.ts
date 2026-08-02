/**
 * sold_closeout:eval — ONE referee for "the lead bought: does the thread close, and does the unit
 * hold come off?"
 *
 * WHAT WAS FIGHTING. Marking a unit sold happens down two paths that were written separately and
 * then kept in step BY HAND:
 *
 *   applyOutcomeSold                              a rep records the appointment outcome
 *   POST /conversations/:id/close  reason "sold"  the console's sold button
 *
 * Both stamp `conv.sale`, close the thread as "sold", decide whether the lead's unit HOLD is
 * released, and start the owner sequence — including a five-line hold-match condition duplicated
 * character for character. Three Tier-1 fields (`status`, `closedReason`, `hold`) carried two
 * independent writers each, and the only thing keeping them equal was that nobody had yet edited
 * one copy without the other.
 *
 * THE ONE DIVERGENCE, PINNED AS-IS (preserved by the un-stacking, NOT fixed by it): the outcome
 * path refuses a sale with no unit named — it returns an error before touching anything. The
 * console endpoint accepts one: it closes the thread as sold and starts the owner sequence, but
 * skips the whole inventory block, so the lead's hold is never released and the bike stays flagged
 * HELD in inventory with a sold conversation hanging off it. Preserved because the alternative —
 * releasing a hold we cannot match to the sold unit — could free the WRONG bike, which is worse.
 *
 * FAIL DIRECTION. Releasing a hold puts a unit back on the floor, so anything unresolved must KEEP
 * the hold. Closing the thread is not gated on the unit at all: both paths agree that a recorded
 * sale closes the conversation, and that is the right answer for a lead who just bought either way.
 *
 * Behavior assertions only — no source-text pins (see eval_source_pin_ratchet:eval).
 *
 * Run: npx tsx scripts/sold_closeout_eval.ts
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.CONVERSATIONS_DB_PATH =
  process.env.CONVERSATIONS_DB_PATH ||
  path.join(os.tmpdir(), `sold-closeout-eval-${Date.now()}.json`);

const { decideSoldCloseout } = await import("../services/api/src/domain/routeStateReducer.ts");
const { applySoldCloseout } = await import("../services/api/src/domain/conversationStore.ts");

let checks = 0;
const eq = (actual: unknown, expected: unknown, message: string) => {
  assert.deepEqual(actual, expected, message);
  checks++;
};

const NOW = "2026-08-02T15:00:00.000Z";
const SOLD_KEY = "STK-4471";

// --- a recorded sale always closes the thread ----------------------------------------------------
// Neither path has ever made this conditional, and a lead who bought must not be left in the
// working inbox as an open sales conversation.
{
  for (const hasSoldUnit of [true, false]) {
    for (const hold of [null, { key: SOLD_KEY }, { key: "STK-9999" }]) {
      const decision = decideSoldCloseout({
        hasSoldUnit,
        hold,
        soldKey: SOLD_KEY,
        holdMatchesSoldUnit: false
      });
      eq(decision.closeConversation, true, "a recorded sale always closes the thread");
      eq(decision.closedReason, "sold", "...with reason `sold`, which downstream readers key off");
    }
  }
}

// --- the five-line hold-match condition, stated once ---------------------------------------------
// Each of these four bars was one line of the duplicated inline condition.
{
  const release = (hold: any, holdMatchesSoldUnit = false) =>
    decideSoldCloseout({ hasSoldUnit: true, hold, soldKey: SOLD_KEY, holdMatchesSoldUnit })
      .releaseHold;

  eq(release({ onOrder: true, key: "STK-0001" }), true, "an ON-ORDER hold is always this lead's own");
  eq(release({ key: undefined }), true, "a keyless hold is always this lead's own");
  eq(release({ key: SOLD_KEY }), true, "a hold keyed to the unit that sold is released");
  eq(release({ key: "STK-9999" }, true), true, "the inventory matcher can still claim it by stock/VIN");
  eq(release({ key: "STK-9999" }, false), false, "an unmatched hold on a DIFFERENT unit stays put");
  eq(release(null), false, "no hold means nothing to release");
}

// --- the divergence: a sale with no unit named ---------------------------------------------------
{
  const held = { key: "STK-9999" };
  const noUnit = decideSoldCloseout({
    hasSoldUnit: false,
    hold: held,
    soldKey: null,
    holdMatchesSoldUnit: true // even a positive match must not release it — there is no unit
  });
  eq(noUnit.closeConversation, true, "the console endpoint still closes the thread with no unit named");
  eq(noUnit.releaseHold, false, "...but leaves the lead's hold standing");
  eq(
    noUnit.divergence,
    "sold_closeout_without_a_named_unit_leaves_the_hold_standing",
    "...and the decision NAMES that as the known odd case"
  );
  eq(
    decideSoldCloseout({ hasSoldUnit: false, hold: null, soldKey: null, holdMatchesSoldUnit: false })
      .divergence,
    null,
    "no unit AND no hold is not a divergence — there was nothing to leave standing"
  );
  eq(
    decideSoldCloseout({ hasSoldUnit: true, hold: held, soldKey: SOLD_KEY, holdMatchesSoldUnit: true })
      .divergence,
    null,
    "the ordinary path with a named unit carries no divergence"
  );
}

// --- fail direction: a keyed hold we cannot match is never freed ---------------------------------
// Freeing the wrong bike is the expensive mistake here; leaving a stale hold is the cheap one.
{
  eq(
    decideSoldCloseout({
      hasSoldUnit: true,
      hold: { key: "STK-9999", onOrder: false },
      soldKey: "",
      holdMatchesSoldUnit: false
    }).releaseHold,
    false,
    "a blank sold key does not accidentally equal a stored hold key"
  );
  // Keys are compared RAW on both sides, exactly as the two copies did. A whitespace-only hold key
  // is therefore a KEY (it is truthy), so the hold is kept rather than freed. That is the safe
  // direction, and normalizing it here would make keys match that do not match in production.
  eq(
    decideSoldCloseout({
      hasSoldUnit: true,
      hold: { key: "  ", onOrder: false },
      soldKey: SOLD_KEY,
      holdMatchesSoldUnit: false
    }).releaseHold,
    false,
    "a junk-but-present hold key is still a key — the hold is kept, not freed"
  );
}

// --- end to end, against the real store ----------------------------------------------------------
const leadWith = (hold: any) => ({
  id: `c-${Math.random().toString(36).slice(2)}`,
  leadKey: "+15550000000",
  status: "open",
  hold: hold ? { ...hold } : undefined
}) as any;

const SALE = {
  soldAt: NOW,
  soldById: "sp-1",
  soldByName: "Dana",
  stockId: SOLD_KEY,
  vin: "1HD1234",
  label: "2026 Road Glide",
  note: "delivered"
};

{
  // The ordinary case: the lead's own hold comes off and the thread closes as sold.
  const conv = leadWith({ key: SOLD_KEY, stockId: SOLD_KEY });
  const decision = applySoldCloseout(conv, {
    nowIso: NOW,
    sale: SALE,
    soldKey: SOLD_KEY,
    holdMatchesSoldUnit: true
  });
  eq(conv.status, "closed", "the thread closes");
  eq(conv.closedReason, "sold", "...as sold");
  eq(conv.closedAt, NOW, "...stamped at the caller's clock, not the wall clock");
  eq(conv.sale?.label, "2026 Road Glide", "the sale record is stamped");
  eq(conv.hold, undefined, "the lead's hold is released");
  eq(decision.releaseHold, true, "and the applier reports back what it did");
}

{
  // A hold on a DIFFERENT unit survives the sale — that bike is still spoken for.
  const conv = leadWith({ key: "STK-9999", stockId: "STK-9999" });
  applySoldCloseout(conv, {
    nowIso: NOW,
    sale: SALE,
    soldKey: SOLD_KEY,
    holdMatchesSoldUnit: false
  });
  eq(conv.status, "closed", "the thread still closes");
  eq(conv.hold?.key, "STK-9999", "but the other unit's hold is untouched");
}

{
  // The divergence, applied: the console's no-unit sale closes the thread and keeps the hold.
  const conv = leadWith({ key: "STK-9999", stockId: "STK-9999" });
  const decision = applySoldCloseout(conv, {
    nowIso: NOW,
    sale: { soldAt: NOW, soldByName: "Dana" },
    soldKey: null,
    holdMatchesSoldUnit: true
  });
  eq(conv.status, "closed", "a sale with no unit still closes the thread");
  eq(conv.hold?.key, "STK-9999", "...and leaves the hold standing");
  eq(
    decision.divergence,
    "sold_closeout_without_a_named_unit_leaves_the_hold_standing",
    "...reported so the caller can see the known odd case"
  );
}

{
  // A lead with no hold at all is the common shape and must not throw.
  const conv = leadWith(null);
  applySoldCloseout(conv, { nowIso: NOW, sale: SALE, soldKey: SOLD_KEY, holdMatchesSoldUnit: false });
  eq(conv.status, "closed", "a lead with no hold closes cleanly");
  eq(conv.hold, undefined, "...and still has no hold");
}

// --- the referee is registered with the equivalence harness ---------------------------------------
// An un-stacking whose referee is missing from buildDecisionRegistry ships with no evidence behind
// it: decision_equivalence would report IDENTICAL because it never looked.
{
  const reducer = await import("../services/api/src/domain/routeStateReducer.ts");
  const { buildDecisionRegistry } = await import(
    "../services/api/src/domain/decisionFingerprint.ts"
  );
  const registry = buildDecisionRegistry(reducer as any);
  const covered = registry.filter((entry: any) =>
    (entry.covers ?? []).includes("decideSoldCloseout")
  );
  eq(covered.length, 2, "both the unit-named and no-unit cases are sampled");
  for (const name of ["soldCloseout:unit_named", "soldCloseout:no_unit_named"]) {
    eq(covered.some((entry: any) => entry.name === name), true, `the harness samples ${name}`);
  }
  const lead = { hold: { key: "STK-9999" }, sale: { stockId: SOLD_KEY } } as any;
  for (const entry of covered) {
    eq(
      entry.sample(lead, { nowMs: Date.parse(NOW), timeZone: "America/New_York" }) !== undefined,
      true,
      `${entry.name} projects a real answer off a stored hold`
    );
  }
}

console.log(`sold_closeout:eval OK — ${checks} checks`);
