/**
 * Self-heal for stale held-unit follow-up holds.
 *
 * When a held/sold-unit cadence override fires, it creates an inventory watch
 * (note === HELD_GUARD_WATCH_NOTE), flips follow-up to `holding_inventory`, and
 * STOPS the time-based cadence (stopReason "inventory_watch") — the right move
 * when the customer's exact bike is genuinely unavailable. But if that hold was
 * created on a unit that is actually available (e.g. a same-model different-stock
 * unit misattributed before the cadenceHeldUnitModelConsistentWithLead guard, or
 * the held unit later came back in stock), the conversation gets stuck: the
 * standard cadence stays stopped and the customer hears nothing more.
 *
 * `planStaleHeldUnitWatchHeal` is the PURE decision: given the conversation's
 * current watch/cadence/mode state — and the caller having already confirmed the
 * lead's own unit IS available — it decides what stale state to undo. The caller
 * applies the plan (drop the auto-created watch, restore active mode, resume the
 * cadence). It is deliberately conservative:
 *   - only drops watches it created itself (the held-guard note), never a
 *     customer-requested watch;
 *   - only un-holds / resumes when NO other (customer-requested) watch remains;
 *   - only resumes a cadence that was stopped for the inventory_watch reason and
 *     is a standard/engaged cadence (never long_term/post_sale).
 */

export const HELD_GUARD_WATCH_NOTE = "Created from held-unit follow-up guard.";

export interface HeldUnitWatchHealPlan {
  /** Remove the auto-created held-guard watch(es). */
  removeHeldGuardWatch: boolean;
  /** No watches remain after removal -> safe to fully un-hold. */
  clearedAllWatches: boolean;
  /** Restore follow-up mode holding_inventory -> active. */
  restoreActiveMode: boolean;
  /** Resume the inventory_watch-stopped standard cadence. */
  resumeCadence: boolean;
  /** Reset an inventory_watch_* dialog state back to a neutral answered state. */
  resetDialogState: boolean;
}

const NO_HEAL: HeldUnitWatchHealPlan = {
  removeHeldGuardWatch: false,
  clearedAllWatches: false,
  restoreActiveMode: false,
  resumeCadence: false,
  resetDialogState: false
};

function includesInventoryWatch(value: string | null | undefined): boolean {
  return String(value ?? "").toLowerCase().includes("inventory_watch");
}

export function planStaleHeldUnitWatchHeal(input: {
  watches: Array<{ note?: string | null } | null | undefined>;
  followUpMode?: string | null;
  followUpReason?: string | null;
  cadenceStatus?: string | null;
  cadenceStopReason?: string | null;
  cadenceKind?: string | null;
  dialogState?: string | null;
}): HeldUnitWatchHealPlan {
  const watches = Array.isArray(input.watches) ? input.watches.filter(Boolean) : [];
  const heldGuard = watches.filter(
    w => String(w?.note ?? "").trim() === HELD_GUARD_WATCH_NOTE
  );
  const removeHeldGuardWatch = heldGuard.length > 0;
  // Watches that survive removal — customer-requested watches we must not disturb.
  const remaining = watches.length - heldGuard.length;
  const clearedAllWatches = remaining === 0;

  if (!removeHeldGuardWatch) return NO_HEAL;
  // If a customer-requested watch remains, the hold is still justified: drop only
  // the bogus auto-created watch, leave mode/cadence/dialog alone.
  if (!clearedAllWatches) {
    return { ...NO_HEAL, removeHeldGuardWatch: true };
  }

  const restoreActiveMode =
    String(input.followUpMode ?? "") === "holding_inventory" &&
    includesInventoryWatch(input.followUpReason);

  const kind = String(input.cadenceKind ?? "").trim().toLowerCase();
  const resumeCadence =
    String(input.cadenceStatus ?? "") === "stopped" &&
    includesInventoryWatch(input.cadenceStopReason) &&
    kind !== "long_term" &&
    kind !== "post_sale";

  const resetDialogState = includesInventoryWatch(input.dialogState);

  return {
    removeHeldGuardWatch: true,
    clearedAllWatches: true,
    restoreActiveMode,
    resumeCadence,
    resetDialogState
  };
}
