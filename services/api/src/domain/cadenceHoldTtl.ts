/**
 * Inventory-hold TTL — the fail-safe reconcile heal for the `holding_inventory` freeze.
 *
 * How the freeze happens: a watch fire (or a held-unit guard) flips `followUp.mode` to
 * `holding_inventory` and pauses/holds the cadence, expecting the customer to reply to the
 * "your bike is available" text or the watch to re-fire. The cadence tick then SKIPS every
 * `holding_inventory` conversation (`services/api/src/index.ts`, the `!isPostSale &&
 * followUp.mode === "holding_inventory"` continue), so if the customer never replies and the
 * watch never re-fires, an ACTIVE cadence sits with a past-due `nextDueAt` forever — the
 * console shows an overdue "next follow-up" and the lead never hears from us again
 * (2026-07-17 census: 11 conversations frozen, worst 104 days; Cory Fiegel +17169490089 —
 * engaged test-ride lead, held since a 6/5 watch fire, 41 days overdue, zero touches).
 *
 * The heal (applied by the 60s reconcile tick in `processDueFollowUpsUnlocked`): once the
 * hold is older than the TTL (default 14 days, env `CADENCE_HOLD_INVENTORY_TTL_DAYS`) and
 * the watch has NOT re-fired inside that window (`lastNotifiedAt` resets the clock), resume
 * ONE gentle future-dated cadence step — mode back to `active` with reason
 * `inventory_hold_expired`, `nextDueAt` pushed ~24h forward (never a burst of missed
 * touches, never pulled EARLIER than an already-future date). Fail direction: the lead gets
 * one gentle future-dated follow-up instead of eternal silence — safe (a deterministic
 * side-effect/state gate, which AGENTS.md allows).
 *
 * This is the PURE decision (no store, no clock); the caller applies it. It enumerates every
 * stop-state the cadence tick itself honors so none of them can ever be resumed:
 * closed/sold, suppressed (STOP/opt-out/do-not-contact), call_only, human (staff-owned)
 * mode, manual_handoff / paused_indefinite (only `holding_inventory` is ever resumed),
 * post-sale, booked appointment, and non-active cadences.
 *
 * Pinned by scripts/cadence_hold_ttl_eval.ts (ci:eval).
 */

export const CADENCE_HOLD_INVENTORY_TTL_DAYS_DEFAULT = 14;

/** The single gentle resume step: ~24h out, so the tick sends at most one future touch. */
export const CADENCE_HOLD_RESUME_STEP_DELAY_HOURS = 24;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Env override parse for CADENCE_HOLD_INVENTORY_TTL_DAYS; falls back to the 14-day default. */
export function resolveCadenceHoldInventoryTtlDays(envValue?: string | null): number {
  const n = Number(String(envValue ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : CADENCE_HOLD_INVENTORY_TTL_DAYS_DEFAULT;
}

/**
 * Console display honesty: while `followUp.mode` is one of the hold modes, the cadence tick
 * will not send (holding_inventory skip + isProactiveContactPaused), so a frozen past-due
 * `nextDueAt` must not render as an overdue "next follow-up". Post-sale cadences are the
 * carve-out — the tick runs them THROUGH a hold (`!isPostSale &&` on both skips), so their
 * nextDueAt stays honest. Exposed to the console as `followUpHold`.
 */
const FOLLOW_UP_HOLD_MODES = new Set(["holding_inventory", "manual_handoff", "paused_indefinite"]);

export function isFollowUpCadenceHeld(
  followUpMode?: string | null,
  cadenceKind?: string | null
): boolean {
  const mode = String(followUpMode ?? "").trim().toLowerCase();
  if (!FOLLOW_UP_HOLD_MODES.has(mode)) return false;
  return String(cadenceKind ?? "").trim().toLowerCase() !== "post_sale";
}

export interface CadenceHoldTtlInput {
  followUpMode?: string | null;
  /** Hold start — setFollowUpMode stamps followUp.updatedAt when the hold is applied. */
  followUpUpdatedAt?: string | null;
  /** Every watch's lastNotifiedAt — a re-fire inside the TTL window resets the clock. */
  watchLastNotifiedAts?: Array<string | null | undefined>;
  conversationStatus?: string | null; // "open" | "closed"
  closedAt?: string | null;
  closedReason?: string | null;
  soldAt?: string | null;
  /** STOP / opt-out / do-not-contact — the suppression store (isSuppressed(leadKey)). */
  suppressed?: boolean;
  contactPreference?: string | null; // "call_only" never gets a text cadence
  conversationMode?: string | null; // "human" = staff own the thread
  appointmentBookedEventId?: string | null;
  cadenceStatus?: string | null;
  cadenceKind?: string | null;
  cadenceNextDueAt?: string | null;
  nowMs: number;
  ttlDays: number;
}

export type CadenceHoldTtlDecision =
  | { resume: false; reason: string }
  | { resume: true; reason: "inventory_hold_expired"; nextDueAtIso: string; heldDays: number };

function parseMs(value: unknown): number {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? ms : NaN;
}

export function decideCadenceHoldTtlResume(input: CadenceHoldTtlInput): CadenceHoldTtlDecision {
  const mode = String(input.followUpMode ?? "").trim().toLowerCase();
  // ONLY the inventory hold is TTL'd. manual_handoff / paused_indefinite are deliberate
  // staff/customer holds with their own lifecycles — never auto-resume them here.
  if (mode !== "holding_inventory") return { resume: false, reason: "not_holding_inventory" };

  // Every stop-state the cadence tick honors — a resumed conv must be one the tick would
  // actually be allowed to touch.
  if (input.suppressed) return { resume: false, reason: "suppressed" };
  if (String(input.contactPreference ?? "").trim().toLowerCase() === "call_only") {
    return { resume: false, reason: "call_only" };
  }
  if (String(input.conversationMode ?? "").trim().toLowerCase() === "human") {
    return { resume: false, reason: "human_mode" };
  }
  const closed =
    String(input.conversationStatus ?? "").trim().toLowerCase() === "closed" ||
    !!String(input.closedAt ?? "").trim() ||
    !!String(input.closedReason ?? "").trim();
  if (closed) return { resume: false, reason: "closed" };
  const postSale =
    !!String(input.soldAt ?? "").trim() ||
    String(input.cadenceKind ?? "").trim().toLowerCase() === "post_sale";
  if (postSale) return { resume: false, reason: "post_sale" };
  if (String(input.appointmentBookedEventId ?? "").trim()) {
    return { resume: false, reason: "appointment_booked" };
  }
  // Only the census freeze shape: an ACTIVE cadence the tick skips forever. A stopped
  // cadence during holding_inventory was an intentional stop (e.g. stopReason
  // "inventory_watch") with its own heal (heldUnitWatchHeal) — out of scope here.
  if (String(input.cadenceStatus ?? "").trim().toLowerCase() !== "active") {
    return { resume: false, reason: "cadence_not_active" };
  }

  // TTL clock: the hold start, pushed forward by any watch re-fire. If the watch fired
  // again recently, the hold is doing its job — the customer just got a real touch.
  let heldSinceMs = parseMs(input.followUpUpdatedAt);
  for (const at of input.watchLastNotifiedAts ?? []) {
    const ms = parseMs(at);
    if (!Number.isFinite(ms)) continue;
    if (!Number.isFinite(heldSinceMs) || ms > heldSinceMs) heldSinceMs = ms;
  }
  // No datable hold at all (setFollowUpMode always stamps updatedAt, so this is a
  // corrupt/legacy shape): stay conservative — we can't prove the TTL elapsed.
  if (!Number.isFinite(heldSinceMs)) return { resume: false, reason: "no_hold_anchor" };

  const ttlDays = Number.isFinite(input.ttlDays) && input.ttlDays > 0
    ? input.ttlDays
    : CADENCE_HOLD_INVENTORY_TTL_DAYS_DEFAULT;
  const heldMs = input.nowMs - heldSinceMs;
  if (heldMs < ttlDays * DAY_MS) return { resume: false, reason: "within_ttl" };

  // Exactly ONE gentle future step: ~24h out — and never EARLIER than an already-future
  // nextDueAt (a legitimately future-dated touch stands; only the frozen past date moves).
  const gentleMs = input.nowMs + CADENCE_HOLD_RESUME_STEP_DELAY_HOURS * HOUR_MS;
  const existingMs = parseMs(input.cadenceNextDueAt);
  const nextDueMs =
    Number.isFinite(existingMs) && existingMs > gentleMs ? existingMs : gentleMs;
  return {
    resume: true,
    reason: "inventory_hold_expired",
    nextDueAtIso: new Date(nextDueMs).toISOString(),
    heldDays: Math.floor(heldMs / DAY_MS)
  };
}
