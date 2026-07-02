/**
 * Indefinite-defer cadence pause eval (pure, no LLM).
 *
 * Pins the Chuck Bailey class (+17163197142, 2026-07-01, operator-reported): a customer who is
 * STILL ENGAGED but defers indefinitely ("Still interested in checking out a Streetglide...,
 * but kind of tied up with family concerns, but will get back to you as soon as I have free
 * time") must get the follow-up cadence PAUSED for a default window — not closed out (the
 * competing-active-intent guard correctly blocks that for an engaged lead) and not kept on an
 * active nudge cadence (the pre-fix behavior Joe reported).
 *
 * Layers:
 *   1. Decision table — decideIndefiniteDeferTurn pauses ONLY for an accepted defer_no_window
 *      with no concrete short window; everything else is untouched.
 *   2. Wiring guard — the shared resolver (resolveCustomerFollowUpDeferralDecision, index.ts)
 *      consults the centralized decision, so BOTH paths (live + regen, which both flow through
 *      that resolver) inherit it; the short-window path stays first (customer's own timeframe
 *      wins over the default window).
 *
 * Run: npx tsx scripts/indefinite_defer_cadence_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  decideIndefiniteDeferTurn,
  INDEFINITE_DEFER_PAUSE_DAYS
} from "../services/api/src/domain/routeStateReducer.ts";

// --- 1) Decision table (pure). ---
type Row = {
  id: string;
  parserAccepted: boolean;
  disposition: string | null;
  shortWindowResolved: boolean;
  pause: boolean;
};
const rows: Row[] = [
  // The Chuck Bailey replay: accepted defer_no_window, no concrete window, closeout suppressed
  // upstream (competing active intent) → pause the cadence for the default window.
  { id: "engaged_indefinite_defer", parserAccepted: true, disposition: "defer_no_window", shortWindowResolved: false, pause: true },
  // A concrete short window already resolved wins — the customer's own timeframe drives the pause.
  { id: "short_window_wins", parserAccepted: true, disposition: "defer_no_window", shortWindowResolved: true, pause: false },
  // defer_with_window is handled by the with-window path, never the default window.
  { id: "defer_with_window_untouched", parserAccepted: true, disposition: "defer_with_window", shortWindowResolved: false, pause: false },
  // Parser not accepted (low confidence / disabled LLM) → fail toward today's behavior, no pause.
  { id: "parser_not_accepted", parserAccepted: false, disposition: "defer_no_window", shortWindowResolved: false, pause: false },
  // Non-defer dispositions are untouched.
  { id: "stepping_back_untouched", parserAccepted: true, disposition: "stepping_back", shortWindowResolved: false, pause: false },
  { id: "sell_on_own_untouched", parserAccepted: true, disposition: "sell_on_own", shortWindowResolved: false, pause: false },
  { id: "none_untouched", parserAccepted: true, disposition: "none", shortWindowResolved: false, pause: false },
  { id: "null_disposition_untouched", parserAccepted: true, disposition: null, shortWindowResolved: false, pause: false }
];
for (const r of rows) {
  const decision = decideIndefiniteDeferTurn({
    parserAccepted: r.parserAccepted,
    disposition: r.disposition,
    shortWindowResolved: r.shortWindowResolved
  });
  assert.equal(
    decision.kind === "pause_cadence_default_window",
    r.pause,
    `decideIndefiniteDeferTurn[${r.id}] expected pause=${r.pause}, got kind=${decision.kind}`
  );
  if (decision.kind === "pause_cadence_default_window") {
    assert.equal(decision.pauseDays, INDEFINITE_DEFER_PAUSE_DAYS, `[${r.id}] default window must be ${INDEFINITE_DEFER_PAUSE_DAYS} days`);
  }
}
assert.ok(
  INDEFINITE_DEFER_PAUSE_DAYS >= 7 && INDEFINITE_DEFER_PAUSE_DAYS <= 30,
  "default window stays a bounded courtesy pause (7-30 days), not a close"
);

// --- 2) Wiring guard — the shared resolver consults the centralized decision (both paths flow
//        through resolveCustomerFollowUpDeferralDecision, so live/regen stay in parity). ---
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const resolverBody = index.slice(
  index.indexOf("function resolveCustomerFollowUpDeferralDecision"),
  index.indexOf("async function applyCustomerFollowUpDeferral")
);
assert.ok(
  /decideIndefiniteDeferTurn/.test(resolverBody),
  "resolveCustomerFollowUpDeferralDecision must consult decideIndefiniteDeferTurn"
);
assert.ok(
  resolverBody.indexOf("parseCustomerFollowUpDeferralFallback(text, base)") <
    resolverBody.indexOf("decideIndefiniteDeferTurn"),
  "the short-window fallback must be consulted BEFORE the default-window decision (customer timeframe wins)"
);
// Both paths call the shared resolver.
const liveCalls = index.split("resolveCustomerFollowUpDeferralDecision(").length - 1;
assert.ok(liveCalls >= 3, "both call sites (live + regen) plus the definition must reference the shared resolver");

console.log(
  `PASS indefinite-defer cadence eval — ${rows.length} decision cases (1 pause / ${rows.length - 1} untouched), ${INDEFINITE_DEFER_PAUSE_DAYS}-day default window, shared-resolver wiring`
);
