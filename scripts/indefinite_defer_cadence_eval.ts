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
import {
  DEFER_SOFT_PAUSE_RESUME_DAYS,
  isDeclineCloseoutReason,
  isDeferResumeEligibleCloseReason,
  resolveDeferCloseSoftPause
} from "../services/api/src/domain/conversationStore.ts";

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
const store = fs.readFileSync("services/api/src/domain/conversationStore.ts", "utf8");
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
// Parsed-action precedence (2026-07-03, corpus flywheel): an ACCEPTED inventory-watch
// acknowledgement / location question outranks the deferral branch — a customer asking to be
// notified ("hit me up if one comes in") must never draw "take your time, no rush" + a pause.
const deferralArm = index.slice(
  index.indexOf("const followUpDeferralDecision = resolveCustomerFollowUpDeferralDecision"),
  index.indexOf("const followUpDeferralDecision = resolveCustomerFollowUpDeferralDecision") + 1400
);
assert.ok(
  /!inboundParserInventoryWatchAcknowledgement/.test(deferralArm),
  "the deferral arm must yield to an accepted inventory-watch acknowledgement"
);
assert.ok(
  /!inboundParserLocationQuestion/.test(deferralArm),
  "the deferral arm must yield to an accepted dealer-location question"
);
const affordArm = index.slice(
  index.indexOf("isAffordabilityRideConfidenceObjectionText(semanticInboundText) &&"),
  index.indexOf("isAffordabilityRideConfidenceObjectionText(semanticInboundText) &&") + 300
);
assert.ok(
  /!inboundParserLocationQuestion/.test(affordArm),
  "the affordability-objection reply site must yield to an accepted location question (KEEP detector unchanged elsewhere)"
);

// Both paths call the shared resolver.
const liveCalls = index.split("resolveCustomerFollowUpDeferralDecision(").length - 1;
assert.ok(liveCalls >= 3, "both call sites (live + regen) plus the definition must reference the shared resolver");

// --- 3) A DEFER-class close is a SOFT PAUSE, not a rejection (Joe ruling 2026-07-29) -----------
// Donald Schuler +17166220132: quoted $12,995 on a 2013 Electra Glide Ultra Limited, asked to
// schedule, replied "Not at this time thank you". Staff archived him "not interested" from the
// console, which stopped the cadence but left followUp.mode = "active" (reason
// manual_quote_delivered) — the record claimed the lead was BOTH actively worked AND rejected.
// Joe: soft pause, both paths (the console archive AND the agent's own defer closeout).
const softPauseNow = Date.parse("2026-07-25T16:19:17.303Z");

// SPLIT (Joe ruling 2026-07-29, second pass): every defer-class close gets the honest paused
// state, but only reasons worth RE-TOUCHING get a resume-eligible date. One bucket for four
// meanings was the flaw in the first cut.
//
// RE-ENGAGEABLE — a timing answer, not an outcome.
for (const reason of ["not_interested", "customer_deferred", "customer_keep_current_bike"]) {
  const plan = resolveDeferCloseSoftPause({ reason, nowMs: softPauseNow });
  assert.equal(plan.softPause, true, `${reason} is a defer-class close`);
  assert.equal(plan.followUpReason, reason, `${reason} carries through as the followUp reason`);
  assert.equal(isDeferResumeEligibleCloseReason(reason), true, `${reason} is resume-eligible`);
  assert.equal(
    plan.resumeEligibleAt,
    new Date(softPauseNow + DEFER_SOFT_PAUSE_RESUME_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    `${reason} records a resume-eligible date ${DEFER_SOFT_PAUSE_RESUME_DAYS} days out`
  );
}

// PARKED — honest paused state, but NEVER a resume date. customer_stepping_back is parked because
// it is ambiguous: the same reason carries "I'll pass", "can't afford it", AND "I ended up buying a
// 2016 in Ohio". Re-pitching a bike to someone who already bought one is the failure this prevents.
for (const reason of ["customer_stepping_back", "customer_sell_on_own"]) {
  const plan = resolveDeferCloseSoftPause({ reason, nowMs: softPauseNow });
  assert.equal(plan.softPause, true, `${reason} still gets the honest paused state`);
  assert.equal(isDeferResumeEligibleCloseReason(reason), false, `${reason} is NOT resume-eligible`);
  assert.equal(
    plan.resumeEligibleAt,
    null,
    `${reason} records NO resume date — it is an outcome, not a deferral`
  );
}

// The distinction has to SURVIVE the disposition mapping: defer_no_window must stop collapsing into
// customer_stepping_back, or the split above is decorative. dialogState stays customer_stepping_back
// so every existing disengagement guard (proactiveVisitInvite, reopen residue) keys off it as before.
assert.ok(
  /disposition === "defer_no_window"\)\s*\{[\s\S]{0,240}?reason: "customer_deferred"/.test(index),
  "defer_no_window must map to reason customer_deferred, not customer_stepping_back"
);
assert.ok(
  /reason: "customer_deferred", state: "customer_stepping_back"/.test(index),
  "the deferred reason must keep the customer_stepping_back dialogState"
);
// Reopening a deferred thread must clear the closeout residue like any other disposition archive.
const reopenResidue = index.split("const dispositionReasons = new Set([")[1]?.split("]);")[0] ?? "";
assert.ok(
  reopenResidue.includes("customer_deferred"),
  "reopen must clear customer_deferred residue (the Dave Batka zombie-reopen class)"
);

// Wiring: BOTH close paths apply it — the console archive endpoint and the agent's disposition
// closeout — and BOTH must run it AFTER closeConversation, which clears nextDueAt and would
// otherwise overwrite the honest state.
assert.equal(
  (index.match(/applyDeferCloseSoftPause\(/g) ?? []).length,
  2,
  "both the console archive and the agent disposition closeout must apply the defer soft pause"
);
const dispositionCloseout =
  index.split("function applyCustomerDispositionCloseout(")[1]?.split("\n}")[0] ?? "";
assert.ok(
  dispositionCloseout.indexOf("closeConversation(") <
    dispositionCloseout.indexOf("applyDeferCloseSoftPause("),
  "the disposition closeout must soft-pause AFTER closeConversation, not before"
);

// The archive + reopen contract is UNCHANGED: not_interested was already a decline reason, so a
// real inbound still reopens the thread and only a bare ack leaves it archived. This build adds
// honest state and a resume-eligible RECORD — it does not send, and must not arm a cadence.
for (const reason of ["not_interested", "customer_deferred"]) {
  assert.equal(
    isDeclineCloseoutReason(reason),
    true,
    `${reason} stays a decline reason, so a real customer text still reopens the thread and only a bare ack leaves it archived`
  );
}
const softPauseSrc =
  store.split("export function applyDeferCloseSoftPause(")[1]?.split("\n}")[0] ?? "";
assert.ok(softPauseSrc.length > 0, "applyDeferCloseSoftPause must exist");
for (const banned of ["publish", "sendSms", "queueDraft", "resumeFollowUpCadence", "nextDueAt ="]) {
  assert.ok(
    !softPauseSrc.includes(banned),
    `the soft pause must not ${banned} — it records state, it never re-arms outreach`
  );
}

console.log(
  `PASS indefinite-defer cadence eval — ${rows.length} decision cases (1 pause / ${rows.length - 1} untouched), ${INDEFINITE_DEFER_PAUSE_DAYS}-day default window, shared-resolver wiring, defer-close soft pause (3 resume-eligible @${DEFER_SOFT_PAUSE_RESUME_DAYS}d / 2 parked, both paths)`
);
