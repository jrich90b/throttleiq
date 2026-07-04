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

/**
 * Over-attachment guard for the held-guard watch's TARGET (which model/year/color/condition
 * the auto-created watch should carry).
 *
 * The held-unit follow-up guard fires from two kinds of source unit:
 *   - the customer's EXACTLY referenced unit (matched by stock#/VIN) — the unit's own
 *     attributes ARE the customer's interest, so they win; and
 *   - a unit surfaced only by a MODEL SEARCH (a "Road Glide" search can surface a held
 *     "Road Glide 3 / Iron Horse Metallic" via the directional inventory matcher). Inheriting
 *     that unit's sibling model + specific color would create a watch — and later a
 *     notification — for a bike the customer never named (Raysean Mcclinon +15136149740,
 *     2026-07: asked for a Road Glide, got watched/notified for a "Road Glide 3").
 *
 * Approach A (Joe, 2026-07-04): the customer's EXPRESSED interest is authoritative. Only when
 * `customerReferencedUnit` is true (an exact stock#/VIN reference) do the unit's model/color/
 * year win; otherwise the watch is built from the expressed vehicle and the search-surfaced
 * unit's attributes are ignored. Fail-safe: a base-model watch (post-#129 the matcher won't
 * fire it on a distinct sibling) is the correct, non-over-attaching target. Raw values are
 * returned; the caller canonicalizes/normalizes.
 */
export function resolveHeldGuardWatchTarget(input: {
  expressed: { model?: string | null; year?: number | string | null; color?: string | null; condition?: string | null } | null | undefined;
  unit: { model?: string | null; year?: number | string | null; color?: string | null; condition?: string | null } | null | undefined;
  customerReferencedUnit: boolean;
}): { model: string | null; year: number | null; color: string | null; condition: string | null } {
  const exp = input.expressed ?? {};
  const unit = input.unit ?? {};
  const useUnit = !!input.customerReferencedUnit;
  // When the customer referenced this exact unit, its own fields win (falling back to the
  // expressed vehicle for any gaps). Otherwise the expressed vehicle wins outright — the
  // search-surfaced unit's model/color must never over-attach.
  const pick = <T>(u: T | null | undefined, e: T | null | undefined): T | null =>
    (useUnit ? (u ?? e) : (e ?? u)) ?? null;
  const modelRaw = pick(unit.model, exp.model);
  const yearNum = Number(pick(unit.year, exp.year) ?? NaN);
  // Color is only inherited from the unit when we're honoring that referenced unit; a
  // search-surfaced unit's color is never carried onto an expressed-model watch.
  const colorRaw = useUnit ? (unit.color ?? exp.color ?? null) : (exp.color ?? null);
  const conditionRaw = pick(unit.condition, exp.condition);
  return {
    model: modelRaw != null && String(modelRaw).trim() ? String(modelRaw).trim() : null,
    year: Number.isFinite(yearNum) ? yearNum : null,
    color: colorRaw != null && String(colorRaw).trim() ? String(colorRaw).trim() : null,
    condition: conditionRaw != null && String(conditionRaw).trim() ? String(conditionRaw).trim() : null
  };
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
