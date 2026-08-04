/**
 * Corpus replay flywheel eval — runs the flywheel's pure self-test (scoring, baseline diff,
 * findings shape, judge gating; no network) and guards the wiring contracts: the judge and
 * actionability filter are SHARED with the nightly intent-handled audit (same semantics in the
 * offline flywheel and the live net), and findings carry the OutcomeAnomaly essentials
 * (occurredAt for stale-suppression, category, convId) so the next.json fold can consume them.
 *
 * Run: npx tsx scripts/corpus_replay_flywheel_eval.ts
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const out = execFileSync("npx", ["tsx", "scripts/corpus_replay_flywheel.ts", "--self-test"], { encoding: "utf8" });
assert.ok(/self-test OK/.test(out), `flywheel self-test must pass, got: ${out.slice(0, 300)}`);

const flywheel = fs.readFileSync("scripts/corpus_replay_flywheel.ts", "utf8");
assert.ok(
  /from "\.\/intent_handled_audit\.ts"/.test(flywheel) && /realJudge/.test(flywheel) && /isNonActionableInbound/.test(flywheel),
  "the flywheel shares the intent-handled judge + actionability filter (one judging semantics, offline and live)"
);
assert.ok(/maxJudge/.test(flywheel) && /LLM_ENABLED/.test(flywheel), "LLM cost is capped and key-gated");
assert.ok(/occurredAt: atIso/.test(flywheel), "findings are timestamped for downstream stale-suppression");
// Dealer Lead App post-ride survey logs are staff-filed, never a customer question: the first
// earns one by-design thank-you, a repeat correctly stays silent. Body-keyed so it holds even
// when the replayed router state lacks a dealer_ride reason (reviewed 2026-07-12 with Joe).
assert.ok(/isDealerRideLogBody/.test(flywheel) && /return isDealerRideLogBody\(String\(row\.body/.test(flywheel), "a dealer-ride survey log producing silence is scored as expected silence, body-keyed");

// Placeholder-vehicle clarify (2026-07-17): an ADF Vehicle of "Harley-Davidson Other" /
// "H-D Meta Promo" / bare make names NO real bike, so a which-model clarify ADDRESSES the ask
// (the live deflection's own rule — modelDeflection: genuinely unknown → ask). The judge was
// reading the placeholder as a specified model and failing the clarify (8 of 73 fails, 7/17
// sweep). Pinned: the flywheel REUSES the live placeholder notion (no scorer-local drift on
// Other/Full Line/bare make) and adjustScore hooks the deterministic classifier — behavior
// cases live in the self-test above.
assert.ok(
  /from "\.\.\/services\/api\/src\/domain\/modelDeflection\.ts"/.test(flywheel) && /isPlaceholderModel/.test(flywheel),
  "the flywheel reuses the LIVE placeholder-model notion (modelDeflection.isPlaceholderModel)"
);
assert.ok(
  /isPlaceholderVehicleClarify\(row, score\.judge\)/.test(flywheel),
  "adjustScore excuses a which-model clarify on a placeholder ADF vehicle (deterministic pre-classification, not prompt-tweaking)"
);

// Design-accept coverage (2026-07-23 sweep, finding flywheel-design-accept-coverage-gap):
// (1) Reaction-only inbounds (tapback echo / emoji-only) are a designed no-reply signal —
//     expected silence REUSES the eval-pinned scorer exclusions so the flywheel can't drift
//     from the live guard's notion (+19198105169).
assert.ok(
  /isQuotedReactionEchoInbound/.test(flywheel) && /isBareReactionOnlyInbound/.test(flywheel) &&
    /scoringExclusions\.ts"/.test(flywheel),
  "reaction-only silence reuses the shared scoring exclusions (no scorer-local reaction regex)"
);
// (2) The post_sale owner-thread step-back: name-greeting + post_sale reason BOTH required, so
//     a post_sale question with no greeting still fails as unexpected silence (+17166035402).
assert.ok(
  /reason === "post_sale" && opensWithPersonNameGreeting/.test(flywheel),
  "post_sale silence is excused ONLY behind the name-greeting step-back shape"
);
// (3) Empty-Inquiry ADF first-touch intro (judge-minor only) and (4) the pinned non-buyer
//     survey ack (non_buyer_survey_ack:eval copy) pass as accepted design — behavior cases
//     including the judge-major and real-question fail-direction guards live in the self-test.
assert.ok(
  /isEmptyInquiryAdfIntroByDesign\(row, score\.judge\)/.test(flywheel) &&
    /isNonBuyerSurveyAckByDesign\(row, score\.judge\)/.test(flywheel) &&
    /isRoom58StandardHandoffAckByDesign\(row, score\.judge\)/.test(flywheel),
  "adjustScore hooks the empty-Inquiry ADF intro + non-buyer survey ack + Room58 handoff design accepts"
);
assert.ok(
  /severity !== "minor"\) return false/.test(flywheel),
  "the judge-severity design accepts excuse judge-minor ONLY — a judge-major still fails"
);
// (5) The Room58 - Standard handoff ack is the ONE accept that may excuse a judge-MAJOR, because
//     the lead is deliberately never answered by the agent (c682179b). It is gated on the BODY
//     instead: an empty Inquiry from that one source. Both gates are pinned here so the accept can
//     never be widened into "any punt passes" without this eval going red.
assert.ok(
  /isEmptyInquiryAdfBody\(body\)/.test(flywheel) &&
    /source:\\s\*room58 - standard/i.test(flywheel),
  "the Room58 handoff accept stays gated on an empty Inquiry from Room58 - Standard"
);

// (5) Stock-check-first (charter C4.3) design-accept must track BOTH unavailability drafts. The
//     classifier originally matched only the orchestrator/regen copy; PR #367 gave the initial-ADF
//     first touch its own shorter copy, and the same ruled behavior started failing the release
//     gate as a P1 (08610167776, +16785960725, +18188420202 — 7/31 sweep). Pinned: the second arm
//     exists, and it keys on the judge's ASK, never judge.why (a why that tacks on "…or offer to
//     schedule" must not rescue an unanswered specs/pricing miss). Behavior + fail-direction cases
//     live in the self-test above.
assert.ok(
  /isBlockedTestRideWithWatchOffer\(row, score\.judge\)/.test(flywheel),
  "adjustScore hooks the stock-check-first design accept"
);
{
  const fn = flywheel.slice(
    flywheel.indexOf("export function isBlockedTestRideWithWatchOffer"),
    flywheel.indexOf("export function isBlockedTestRideWithWatchOffer") + 1400
  );
  assert.ok(
    /not seeing \[\^\.\]\{0,60\}in stock right now/.test(fn) && /is no longer available/.test(fn),
    "the design accept covers the initial-ADF unavailability copy (#367), not just the orchestrator draft"
  );
  assert.ok(
    /judge\.customerAsk/.test(fn) && !/judge\.why/.test(fn),
    "the availability-ask test reads customerAsk ONLY — judge.why must not widen the accept"
  );
}

const audit = fs.readFileSync("scripts/intent_handled_audit.ts", "utf8");
assert.ok(/export async function realJudge/.test(audit), "realJudge stays exported for the flywheel");

// Release contract (Joe, 2026-07-05): the GATE blocks on correctness only (criticals=0 AND
// regressions=0); the pass-rate is a tracked TREND aligned with the live tone floor (0.85),
// never blocking — pinned so a future edit can't quietly re-block on the judge's taste.
{
  const { TREND_PASS_RATE_TARGET } = await import("./corpus_replay_flywheel.ts");
  assert.equal(TREND_PASS_RATE_TARGET, 0.85, "trend target stays aligned with the live tone-gate floor");
  const src = fs.readFileSync("scripts/corpus_replay_flywheel.ts", "utf8");
  assert.ok(/gate_pass: criticalsZero && regressionsZero/.test(src), "the blocking gate is criticals+regressions ONLY");
  assert.ok(!/pass_rate_ge_090|>=\s*0\.9\b/.test(src), "the retired 90%-overall blocker must not reappear");
  assert.ok(/trend_on_target: rate >= TREND_PASS_RATE_TARGET/.test(src), "pass rate is tracked as a trend, not a gate");
}

// Nightly box orchestrator: the sweep gate is pure + self-tested (skip-if-unchanged, forced,
// weekly UTC-Monday confirmation, fail-toward-measuring), and the detect chain folds the
// flywheel's latest.json like every other sibling feed.
const nightlyOut = execFileSync("npx", ["tsx", "scripts/corpus_replay_nightly.ts", "--self-test"], { encoding: "utf8" });
assert.ok(/self-test OK/.test(nightlyOut), `nightly self-test must pass, got: ${nightlyOut.slice(0, 200)}`);
const detect = fs.readFileSync("scripts/anomaly_loop_detect.ts", "utf8");
assert.ok(/corpus_replay", "latest\.json"/.test(detect), "anomaly_loop_detect must fold the corpus_replay sibling feed into next.json");

// Confirm-on-refail (2026-07-06): one unlucky sample of a NONDETERMINISTIC pipeline must not
// block the release gate — a candidate regression re-replays its conversation and only a repeat
// failure counts (7/6 sweep: 2 phantom "regressions" from LLM routing flips, 0/6 reproducible;
// ~13 more from the Brooke→Alexandra rename). Pinned so a future edit can't quietly go back to
// single-sample gating or let persona renames read as code changes.
assert.ok(/resolveRefailOutcome/.test(flywheel) && /confirmedRegressions/.test(flywheel), "the gate counts CONFIRMED regressions only (confirm-on-refail)");
assert.ok(/gate_regressions_zero: regressionsZero/.test(flywheel) && /regressionsZero = confirmedRegressions\.length === 0/.test(flywheel), "the blocking regression bar reads the confirmed set");
assert.ok(/stripAgentIntro/.test(flywheel), "persona renames normalize out of draft signatures");
assert.ok(/FLYWHEEL_REFAIL/.test(flywheel), "refail keeps its kill switch");
const shadowReplay = fs.readFileSync("scripts/inbound_shadow_replay.ts", "utf8");
assert.ok(/--conv/.test(shadowReplay) && /convIds/.test(shadowReplay), "the replay harness supports the per-conversation filter refail depends on");

// HARNESS-vs-AGENT error attribution (2026-08-04). The harness boots one temporary API per case
// out of the same deploy checkout a deploy runs `npm ci` in; a deploy landing mid-sweep made 29
// consecutive boots fail on module resolution. Those became 9 of the 12 criticals — 75% of the
// release-BLOCKING signal — plus one "draft: (none)" P1 per conversation. Pinned so the
// attribution can't drift back to blaming the agent, and so the honesty rails stay:
assert.ok(
  /classifyReplayErrorCause/.test(flywheel) && /excluded_harness_error/.test(flywheel),
  "the flywheel attributes replay errors before scoring them"
);
assert.ok(
  /gate_coverage_complete/.test(flywheel) && /gate_pass: criticalsZero && regressionsZero && coverageComplete/.test(flywheel),
  "lost coverage is a BLOCKING bar — a gutted sweep can never read PASS"
);
assert.ok(
  /harnessErrors/.test(flywheel) && /UNMEASURED/.test(flywheel),
  "the run reports what it lost instead of quietly scoring a smaller corpus"
);
// The classifier lives in the shared pure module (ci:eval pins its fail direction in
// replay_fidelity:eval), not re-implemented scorer-side where the two could drift apart.
assert.ok(
  /from "\.\.\/services\/api\/src\/domain\/replayFidelity\.ts"/.test(flywheel),
  "attribution is imported from the pure module, never re-spelled in the scorer"
);
assert.ok(
  /classifyReplayErrorCause\(err\?\.message\) !== "harness"/.test(shadowReplay),
  "only a harness-caused boot failure is retried — a real agent failure is not re-rolled until it passes"
);

console.log("PASS corpus replay flywheel eval (self-test + shared-judge + cost-cap + finding-shape + refail guards + harness-error attribution & coverage floor)");
