/**
 * Stale held-unit follow-up watch self-heal. Production fixture: Jason Roorda
 * (+17165104578, Lead Ref 11460, 2026-06-17) — before the EXACT-unit guard, a
 * same-model different-stock unit (Gauntlet Gray U886-21) was misattributed to a
 * lead whose actual unit (Snake Venom U889-21) was IN STOCK. The held-unit
 * override created an auto inventory watch, flipped follow-up to holding_inventory,
 * and STOPPED the standard cadence (stopReason "inventory_watch") — leaving the
 * conversation permanently silent even though the customer's bike was available.
 *
 * Once the lead's own unit is confirmed available, the heal must undo that stale
 * hold (drop the auto-created watch, restore active mode, resume the cadence) so a
 * regenerate / next cadence build re-triggers the correct follow-up. It must NOT:
 *   - touch a customer-requested watch (only the held-guard note watch);
 *   - un-hold while a real customer watch still remains;
 *   - resurrect a cadence stopped for a NON-inventory reason (opt-out, handoff);
 *   - resume a long_term / post_sale cadence.
 */
import assert from "node:assert/strict";
import {
  HELD_GUARD_WATCH_NOTE,
  planStaleHeldUnitWatchHeal
} from "../services/api/src/domain/heldUnitWatchHeal.ts";

const guardWatch = { model: "Street Glide Special", note: HELD_GUARD_WATCH_NOTE };
const customerWatch = { model: "Road Glide", note: "Customer asked us to watch for one." };

// Jason's exact stuck state -> full heal (drop watch, restore mode, resume cadence).
{
  const plan = planStaleHeldUnitWatchHeal({
    watches: [guardWatch],
    followUpMode: "holding_inventory",
    followUpReason: "inventory_watch",
    cadenceStatus: "stopped",
    cadenceStopReason: "inventory_watch",
    cadenceKind: "standard",
    dialogState: "inventory_answered"
  });
  assert.equal(plan.removeHeldGuardWatch, true, "Jason: drop the auto-created held-guard watch");
  assert.equal(plan.clearedAllWatches, true, "Jason: no watches remain");
  assert.equal(plan.restoreActiveMode, true, "Jason: holding_inventory -> active");
  assert.equal(plan.resumeCadence, true, "Jason: resume the inventory_watch-stopped standard cadence");
  assert.equal(plan.resetDialogState, false, "Jason: dialog already inventory_answered, no reset");
}

// A customer-requested watch still present -> drop ONLY the bogus auto watch; keep the hold.
{
  const plan = planStaleHeldUnitWatchHeal({
    watches: [guardWatch, customerWatch],
    followUpMode: "holding_inventory",
    followUpReason: "inventory_watch",
    cadenceStatus: "stopped",
    cadenceStopReason: "inventory_watch",
    cadenceKind: "standard",
    dialogState: "inventory_watch_active"
  });
  assert.equal(plan.removeHeldGuardWatch, true, "still remove the bogus auto watch");
  assert.equal(plan.clearedAllWatches, false, "a customer watch remains");
  assert.equal(plan.restoreActiveMode, false, "keep the hold — customer is watching something real");
  assert.equal(plan.resumeCadence, false, "do not resume — customer watch justifies the hold");
  assert.equal(plan.resetDialogState, false, "leave the inventory_watch dialog intact");
}

// No held-guard watch (only a customer watch) -> nothing to heal at all.
{
  const plan = planStaleHeldUnitWatchHeal({
    watches: [customerWatch],
    followUpMode: "holding_inventory",
    followUpReason: "inventory_watch",
    cadenceStatus: "stopped",
    cadenceStopReason: "inventory_watch",
    cadenceKind: "standard"
  });
  assert.equal(plan.removeHeldGuardWatch, false, "no auto watch -> no heal");
  assert.equal(plan.resumeCadence, false, "no auto watch -> never resume");
}

// Cadence stopped for a NON-inventory reason -> drop the watch but DON'T resurrect it.
{
  const plan = planStaleHeldUnitWatchHeal({
    watches: [guardWatch],
    followUpMode: "manual_handoff",
    followUpReason: "manual_handoff",
    cadenceStatus: "stopped",
    cadenceStopReason: "manual_handoff",
    cadenceKind: "standard"
  });
  assert.equal(plan.removeHeldGuardWatch, true, "drop the stale auto watch");
  assert.equal(plan.restoreActiveMode, false, "not a holding_inventory hold -> leave mode");
  assert.equal(plan.resumeCadence, false, "manual_handoff stop must not be resurrected by the heal");
}

// long_term / post_sale cadence must never be resumed by this heal.
for (const kind of ["long_term", "post_sale"]) {
  const plan = planStaleHeldUnitWatchHeal({
    watches: [guardWatch],
    followUpMode: "holding_inventory",
    followUpReason: "inventory_watch",
    cadenceStatus: "stopped",
    cadenceStopReason: "inventory_watch",
    cadenceKind: kind
  });
  assert.equal(plan.resumeCadence, false, `${kind} cadence is not resumed by the held-unit heal`);
  assert.equal(plan.restoreActiveMode, true, `${kind}: still restore mode off the inventory hold`);
}

// inventory_watch_* dialog state gets reset to a neutral answered state.
{
  const plan = planStaleHeldUnitWatchHeal({
    watches: [guardWatch],
    followUpMode: "holding_inventory",
    followUpReason: "inventory_watch",
    cadenceStatus: "stopped",
    cadenceStopReason: "inventory_watch",
    cadenceKind: "standard",
    dialogState: "inventory_watch_matched"
  });
  assert.equal(plan.resetDialogState, true, "inventory_watch_matched -> reset to answered");
}

console.log("PASS held unit watch heal eval");
