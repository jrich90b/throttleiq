/**
 * Watch pin guards — pure. May we pin a given attribute onto an inventory watch, or would that
 * pin make the watch un-fireable? Two attributes are guarded here: the model YEAR
 * (`decideWatchYearPin`) and the NEW/USED CONDITION (`decideWatchConditionPin`). Same safety
 * shape for both: a pin is only dropped when it provably can't match, and dropping a pin only ever
 * WIDENS the watch (fails toward contacting the customer, never toward silence).
 */

/**
 * Watch year-pin decision — pure. "May we pin this model YEAR onto an inventory watch?"
 *
 * A `year_model` watch only ever fires when a unit of that EXACT model year lands in inventory.
 * Pin a year that can never exist and the watch is silently un-fireable: the customer is told
 * "I'll keep an eye out and text you" and then hears nothing, forever. That is the worst kind of
 * failure — it looks like a promise kept until it quietly isn't.
 *
 * Production miss (+18188420202, George Khoury, 2026-07-21): the Room58 ADF carried structured
 * `Year: 2022` but the free-text inquiry read "2027 883". The intake extractor took 2027 off the
 * free text and pinned a **2027 Iron 883** watch — a bike that cannot exist (the Iron 883 was
 * discontinued after the 2020 model year). The watch has been active and unfireable ever since.
 *
 * FAIL DIRECTION: dropping a year pin only ever WIDENS the watch (year_model -> model_only), so the
 * customer gets contacted about MORE units, never fewer. Keeping a bad pin fails toward silence.
 * So this drops a pin only when it provably cannot match, and otherwise leaves the pin alone:
 *   - `unknown` / `borderline` model status never drops a pin (mirrors decideModelDiscontinuation's
 *     conservatism — we only act on a CONFIDENT "discontinued").
 *   - an older year on a discontinued model is KEPT (a used 2015 Iron 883 can absolutely show up).
 * The only drops are "no such model year exists yet" and "that model stopped being made".
 *
 * Deterministic on purpose: this is an invariant guard over a STRUCTURED value (a model year), not
 * a read of what the customer meant — AGENTS.md allows deterministic here. Comprehension (what the
 * customer actually wants) stays with the parsers upstream.
 */

import type { DiscontinuationStatus } from "./modelDiscontinuation.js";

export type WatchYearPin = "year" | "range" | "none";

export type WatchYearPinDecision = {
  pin: WatchYearPin;
  reason: string;
};

/**
 * Model years run ahead of the calendar — in July 2026 a 2027 unit of a CURRENT model is perfectly
 * plausible. So "too far in the future" starts at currentYear + 2; only the model-discontinued rule
 * catches a next-year pin, and only when we're confident the model is gone.
 */
export const MAX_MODEL_YEAR_LOOKAHEAD = 1;

export function decideWatchYearPin(input: {
  year?: number | null;
  yearMin?: number | null;
  yearMax?: number | null;
  modelStatus: DiscontinuationStatus;
  currentYear: number;
}): WatchYearPinDecision {
  const maxPlausibleYear = input.currentYear + MAX_MODEL_YEAR_LOOKAHEAD;
  const discontinued = input.modelStatus === "discontinued";

  const usable = (v: number | null | undefined): number | null =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

  const year = usable(input.year);
  const yearMin = usable(input.yearMin);
  const yearMax = usable(input.yearMax);

  // A range is only dropped when its ENTIRE span is impossible — its earliest year is already
  // unreachable. A partially-valid range (e.g. 2015-2027 on a discontinued model) keeps its pin;
  // widening it would trade a precise, still-matchable watch for a noisier one.
  if (yearMin && yearMax) {
    if (yearMin > maxPlausibleYear) {
      return { pin: "none", reason: "range_beyond_max_model_year" };
    }
    if (discontinued && yearMin >= input.currentYear) {
      return { pin: "none", reason: "range_after_model_discontinued" };
    }
    return { pin: "range", reason: "range_plausible" };
  }

  if (year) {
    if (year > maxPlausibleYear) {
      return { pin: "none", reason: "year_beyond_max_model_year" };
    }
    if (discontinued && year >= input.currentYear) {
      // The model is confidently out of production, so a current/future model year cannot exist.
      return { pin: "none", reason: "year_after_model_discontinued" };
    }
    return { pin: "year", reason: "year_plausible" };
  }

  return { pin: "none", reason: "no_year_requested" };
}

export type WatchConditionPin = "condition" | "none";

export type WatchConditionPinDecision = {
  pin: WatchConditionPin;
  reason: string;
};

/**
 * Watch condition-pin decision — pure. "May we pin `new` onto a watch for this model?"
 *
 * A `new`-condition watch only fires when a brand-NEW unit of the model lands. If the model is
 * confidently out of production, no new unit will ever be built — so a `new` watch on it is
 * un-fireable, the same silent-forever failure as an impossible year (+17166887637: a `new`
 * Super Glide watch, a model Harley no longer makes).
 *
 * Drop the `new` pin (widen to any-condition) only when the model is CONFIDENTLY discontinued — a
 * used unit of a discontinued model can still arrive on a trade, so the widened watch stays
 * fireable and fails toward contacting. Everything else keeps its pin:
 *   - `used` is always kept (used units of a discontinued model exist — that's the whole point).
 *   - `unknown`/`current`/`available` model status never drops a pin (mirrors
 *     decideModelDiscontinuation's "only act on a confident discontinued").
 * Note this guards the CONDITION only; a genuinely-wrong MODEL on the watch (e.g. a rep's typo) is
 * a data-correction concern, not something this can infer.
 */
export function decideWatchConditionPin(input: {
  condition?: string | null;
  modelStatus: DiscontinuationStatus;
}): WatchConditionPinDecision {
  const condition = String(input.condition ?? "").trim().toLowerCase();
  if (condition !== "new" && condition !== "used") {
    return { pin: "none", reason: "no_condition_requested" };
  }
  if (condition === "new" && input.modelStatus === "discontinued") {
    return { pin: "none", reason: "new_pin_on_discontinued_model" };
  }
  return { pin: "condition", reason: "condition_plausible" };
}
