/**
 * cadence_quality_consensus:eval — pins the majority vote that makes a LIVE cadence suppression
 * reproducible (2026-08-02).
 *
 * WHY THIS EXISTS. `CADENCE_QUALITY_ENFORCE` holds proactive follow-ups back from customers. That
 * verdict was not reproducible: the production judge run twice over the same 100 proactive sends
 * gave 33 suppressions then 29, and only 22 were the SAME messages — 45% of the union flipped. A
 * 50-message / 300-call probe measured 74% single-sample self-agreement, 90% for vote-of-3, and
 * found 48% of messages judged BOTH ways at least once across six runs.
 *
 * Temperature pinning is NOT the fix and cannot be: `optionalTemperature` drops the parameter for
 * every gpt-5 model and this judge runs on gpt-5-mini, so setting it is a silent no-op. Nor is it a
 * schema problem — every sampled call returned valid JSON with a legal enum.
 *
 * Pure + deterministic (no LLM): the vote, the fail direction, and the early exit.
 *
 * Run: npx tsx scripts/cadence_quality_consensus_eval.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decideCadenceQualityConsensus,
  sampleCadenceQualityConsensus,
  verdictHoldsBack,
  cadenceQualityConsensusSamples,
  cadenceQualityUnanimousFloor,
  resolveCadenceUnanimousFloor,
  CADENCE_QUALITY_CONSENSUS_SAMPLES_DEFAULT,
  CADENCE_QUALITY_UNANIMOUS_FLOOR_DEFAULT
} from "../services/api/src/domain/cadenceQualityConsensus.ts";

const FLOOR = 0.9;
const hold = (c = 0.95) => ({ overall: "suppress", confidence: c });
const holdLow = () => ({ overall: "suppress", confidence: 0.7 });
const send = (c = 0.95) => ({ overall: "good", confidence: c });
let n = 0;

// --- 1) verdictHoldsBack mirrors the live gate's trigger -----------------------------------------
assert.equal(verdictHoldsBack(hold(0.95), FLOOR), true, "suppress at/above the floor holds back");
assert.equal(verdictHoldsBack({ overall: "hold", confidence: 0.9 }, FLOOR), true, "hold counts, floor is inclusive");
assert.equal(verdictHoldsBack(holdLow(), FLOOR), false, "suppress BELOW the floor sends");
assert.equal(verdictHoldsBack(send(), FLOOR), false, "a good verdict sends");
assert.equal(verdictHoldsBack({ overall: "needs_regenerate", confidence: 0.99 }, FLOOR), false, "regenerate is not a hold-back");
assert.equal(verdictHoldsBack(null, FLOOR), false, "no verdict never holds a message back");
assert.equal(verdictHoldsBack({ overall: "suppress" }, FLOOR), false, "a missing confidence cannot clear the floor");
n += 7;

// --- 2) the majority itself ----------------------------------------------------------------------
assert.equal(decideCadenceQualityConsensus([hold(), hold(), hold()], FLOOR).holdBack, true, "3-0 holds back");
assert.equal(decideCadenceQualityConsensus([hold(), hold(), send()], FLOOR).holdBack, true, "2-1 holds back");
// THE CASE THE FIX EXISTS FOR: a lone dissenting sample no longer decides a customer's turn.
assert.equal(decideCadenceQualityConsensus([hold(), send(), send()], FLOOR).holdBack, false, "1-2 sends");
assert.equal(decideCadenceQualityConsensus([send(), send(), send()], FLOOR).holdBack, false, "0-3 sends");
assert.equal(decideCadenceQualityConsensus([hold(), hold(), hold()], FLOOR).agreement, "unanimous");
assert.equal(decideCadenceQualityConsensus([hold(), hold(), send()], FLOOR).agreement, "majority");
n += 6;

// A TIE never holds back — a message only stops on a real majority.
assert.equal(decideCadenceQualityConsensus([hold(), send()], FLOOR).holdBack, false, "1-1 tie sends");
n += 1;

// --- 3) FAIL DIRECTION: toward sending ------------------------------------------------------------
// A failed sample is an ABSENCE of evidence, not a vote. Counting nulls as "send" would hand the
// outcome to the API's error rate; dropping them keeps the vote among real verdicts.
const oneFailed = decideCadenceQualityConsensus([hold(), null, hold()] as any, FLOOR);
assert.equal(oneFailed.holdBack, true, "a dropped sample does not flip a 2-0 majority");
assert.equal(oneFailed.usableVotes, 2, "nulls are not counted as votes");
const allFailed = decideCadenceQualityConsensus([null, null, null] as any, FLOOR);
assert.equal(allFailed.holdBack, false, "no usable verdict => SEND (today's behaviour when the judge is off)");
assert.equal(allFailed.verdict, null);
assert.equal(allFailed.agreement, "no_verdict");
n += 5;

// --- 4) the reported verdict comes from the WINNING side ------------------------------------------
// The logged reason must describe the decision actually taken, or the trace lies about the call.
const mixed = decideCadenceQualityConsensus([hold(0.92), hold(0.99), send(0.97)], FLOOR);
assert.equal(mixed.holdBack, true);
assert.equal(mixed.verdict?.confidence, 0.99, "representative = most confident verdict on the winning side");
const sends = decideCadenceQualityConsensus([hold(0.99), send(0.91), send(0.96)], FLOOR);
assert.equal(sends.holdBack, false);
assert.equal(sends.verdict?.overall, "good", "a send decision never reports the suppressing verdict");
n += 4;

// --- 5) EARLY EXIT: a stable message must not pay for a third call ---------------------------------
let calls = 0;
const counted = (v: any) => async () => { calls += 1; return v; };
calls = 0;
let r = await sampleCadenceQualityConsensus(counted(hold()), { samples: 3, floor: FLOOR });
assert.equal(r.holdBack, true);
assert.equal(calls, 2, "two agreeing samples decide a best-of-three — the third is never spent");
calls = 0;
r = await sampleCadenceQualityConsensus(counted(send()), { samples: 3, floor: FLOOR });
assert.equal(r.holdBack, false);
assert.equal(calls, 2, "…the same on the send side");
n += 4;

// A genuinely split message DOES spend the third call.
calls = 0;
const alternating = [hold(), send(), hold()];
r = await sampleCadenceQualityConsensus(async () => alternating[calls++] as any, { samples: 3, floor: FLOOR });
assert.equal(calls, 3, "a split message spends all three samples");
assert.equal(r.holdBack, true, "2-1 hold on a split");
assert.equal(r.agreement, "majority");
n += 3;

// Shadow costs exactly ONE call — the vote is only paid for where it changes a customer's turn.
calls = 0;
r = await sampleCadenceQualityConsensus(counted(hold()), { samples: 1, floor: FLOOR });
assert.equal(calls, 1, "shadow keeps a single sample");
assert.equal(r.holdBack, true, "one sample still decides when that is all we asked for");
n += 2;

// A throwing sampler is a failed sample, never an aborted vote.
calls = 0;
r = await sampleCadenceQualityConsensus(async () => { calls += 1; if (calls === 1) throw new Error("boom"); return hold() as any; }, { samples: 3, floor: FLOOR });
assert.equal(r.holdBack, true, "the vote survives a throwing sample");
assert.ok(calls >= 2, "a throw does not end the sampling");
n += 2;

// --- 6) sample count is sane --------------------------------------------------------------------
const withEnv = (v: string | undefined, fn: () => void) => {
  const prev = process.env.CADENCE_QUALITY_CONSENSUS_SAMPLES;
  if (v === undefined) delete process.env.CADENCE_QUALITY_CONSENSUS_SAMPLES;
  else process.env.CADENCE_QUALITY_CONSENSUS_SAMPLES = v;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.CADENCE_QUALITY_CONSENSUS_SAMPLES;
    else process.env.CADENCE_QUALITY_CONSENSUS_SAMPLES = prev;
  }
};
withEnv(undefined, () => assert.equal(cadenceQualityConsensusSamples(), CADENCE_QUALITY_CONSENSUS_SAMPLES_DEFAULT));
withEnv("3", () => assert.equal(cadenceQualityConsensusSamples(), 3));
// An EVEN count can never produce a majority — it is rounded up, never silently accepted.
withEnv("2", () => assert.equal(cadenceQualityConsensusSamples(), 3, "even counts round up to an odd majority"));
withEnv("4", () => assert.equal(cadenceQualityConsensusSamples(), 5));
withEnv("99", () => assert.equal(cadenceQualityConsensusSamples(), 5, "clamped — this is a per-send cost"));
withEnv("0", () => assert.equal(cadenceQualityConsensusSamples(), 1));
withEnv("garbage", () => assert.equal(cadenceQualityConsensusSamples(), CADENCE_QUALITY_CONSENSUS_SAMPLES_DEFAULT));
n += 7;

// --- 7) CONFIRM-ON-BLOCK — the draft-gate variant (2026-08-02) -----------------------------------
// Measured on the LIVE draft gate: 92% per-item self-agreement, but 6 of 77 staff-approved drafts
// flipped the live outcome between identical runs, all @0.9 confidence. Unlike the cadence vote, a
// PASSING first verdict must stand at exactly today's cost (this gate sits on the live reply path
// and fails OPEN); only a would-block verdict pays for a confirming vote.
import { confirmBlockWithVote } from "../services/api/src/domain/cadenceQualityConsensus.ts";
import { confirmDraftQualityHold, type DraftQualityVerdict } from "../services/api/src/domain/draftQualityGate.ts";

const gHold = (c = 0.9): DraftQualityVerdict => ({ intentOk: false, toneOk: true, dispositionOk: true, safetyOk: false, overall: "hold", confidence: c, reason: "fabricated availability" });
const gRegen = (c = 0.9): DraftQualityVerdict => ({ intentOk: false, toneOk: true, dispositionOk: true, safetyOk: true, overall: "needs_regenerate", confidence: c, reason: "misses the ask" });
const gGood = (c = 0.9): DraftQualityVerdict => ({ intentOk: true, toneOk: true, dispositionOk: true, safetyOk: true, overall: "good", confidence: c, reason: "fine" });

{
  // A PASSING first verdict spends ZERO extra samples — the whole point of confirm-on-block.
  let calls = 0;
  const r1 = await confirmDraftQualityHold({ firstVerdict: gGood(), resample: async () => { calls++; return gHold(); }, samples: 3, holdClassOnly: true });
  assert.equal(r1.held, false, "a passing verdict stands");
  assert.equal(calls, 0, "…at exactly today's cost — no resamples");
  // No verdict at all = fail open, no resamples (a judge error must never block a draft).
  calls = 0;
  const r0 = await confirmDraftQualityHold({ firstVerdict: null, resample: async () => { calls++; return gHold(); }, samples: 3, holdClassOnly: true });
  assert.equal(r0.held, false); assert.equal(calls, 0);
  n += 4;

  // THE FLIP CLASS: a lone would-hold verdict must now win a majority. Two passing resamples
  // out-vote it — the draft publishes instead of riding one sample's coin flip.
  calls = 0;
  const r2 = await confirmDraftQualityHold({ firstVerdict: gHold(), resample: async () => { calls++; return gGood(); }, samples: 3, holdClassOnly: true });
  assert.equal(r2.held, false, "1-2: the lone hold loses the vote");
  assert.equal(calls, 2, "a would-block spends the confirming samples");
  // A REAL hold survives: two agreeing samples confirm, early exit skips the third.
  calls = 0;
  const r3 = await confirmDraftQualityHold({ firstVerdict: gHold(0.95), resample: async () => { calls++; return gHold(0.85); }, samples: 3, holdClassOnly: true });
  assert.equal(r3.held, true, "2-0 confirms the hold");
  assert.equal(calls, 1, "early exit: the third sample is never spent");
  assert.equal(r3.held && r3.reason, "live_hold", "reason reflects the confirmed action");
  n += 5;

  // holdClassOnly gating flows through the vote: regenerate verdicts are not blocks in the first
  // live slice, so a regenerate first-verdict passes without any resample…
  calls = 0;
  const r4 = await confirmDraftQualityHold({ firstVerdict: gRegen(), resample: async () => { calls++; return gRegen(); }, samples: 3, holdClassOnly: true });
  assert.equal(r4.held, false, "holdClassOnly: regenerate is not a block");
  assert.equal(calls, 0);
  // …and IS a block once the flag opens the class.
  const r5 = await confirmDraftQualityHold({ firstVerdict: gRegen(), resample: async () => gRegen(), samples: 3, holdClassOnly: false });
  assert.equal(r5.held, true, "holdClassOnly=0: regenerate blocks when confirmed");
  assert.equal(r5.held && r5.reason, "live_regenerate");
  n += 4;

  // A throwing/failed resample is DROPPED, never a vote — in EITHER direction. So a confident
  // hold whose confirmations all fail keeps TODAY'S single-sample behaviour (block): the vote can
  // only overturn a hold with real contrary evidence, never by the API being down. A flaky API
  // weakening the quality gate would be the worse failure — in suggest mode a held draft just
  // reaches a human, while a silently-disabled gate reaches the customer.
  const r6 = await confirmDraftQualityHold({ firstVerdict: gHold(), resample: async () => { throw new Error("api down"); }, samples: 3, holdClassOnly: true });
  assert.equal(r6.held, true, "hold + all resamples failed = today's behaviour stands (API failure never weakens the gate)");
  n += 1;

  // The generic primitive: below-floor confidence never blocks (decideDraftQualityGate owns the floor).
  const low = await confirmDraftQualityHold({ firstVerdict: gHold(0.5), resample: async () => gHold(0.5), samples: 3, holdClassOnly: true });
  assert.equal(low.held, false, "below the gate's own confidence floor = pass, no vote");
  // And confirmBlockWithVote reports the winning side's strongest verdict.
  const cb = await confirmBlockWithVote(gHold(0.85), async () => gHold(0.99), { samples: 3, blocks: (v: DraftQualityVerdict) => v.overall === "hold" });
  assert.equal(cb.block, true);
  assert.equal(cb.verdict?.confidence, 0.99, "representative = most confident on the winning side");
  n += 3;
}

// --- 7) POST-SALE UNANIMITY: sub-floor agreement is evidence, not a vote to send -------------------
// THE PRODUCTION TURNS THIS PINS (2026-08-04 work order, 26 judged proactive touches). The two that
// actually REACHED a customer were both unanimous `suppress` at 0.88 — just under the 0.90 enforce
// floor — so every sample was counted as a vote to SEND and the agreement between them was thrown
// away. Both were the generic post-sale check-in charter C3.1 forbids:
//   +17163741119::2  2026-08-01T14:30  "Congrats on your Tri Glide Ultra! If you need anything,
//                                       just let me know."  (customer replied 4 minutes later)
//   +17163440581     2026-07-21T14:30  "Thanks again for coming to see us for your Road King
//                                       Special."            (landed on an open fob issue)
// Every touch judged at 0.90 was correctly held — the judge was right all 26 times; the gate could
// not act on two of them.
const UFLOOR = 0.8;
const sub = (c = 0.88) => ({ overall: "suppress", confidence: c });

// Today's behaviour WITHOUT the unanimity option — unchanged, and still the default everywhere
// except a settled post-sale thread.
assert.equal(
  decideCadenceQualityConsensus([sub(), sub(), sub()], FLOOR).holdBack,
  false,
  "3 unanimous sub-floor suppressions still SEND when no unanimity floor is supplied (live leads)"
);
const uni = decideCadenceQualityConsensus([sub(), sub(), sub()], FLOOR, { unanimousFloor: UFLOOR });
assert.equal(uni.holdBack, true, "…and are HELD on a settled post-sale thread (+17163741119::2)");
assert.equal(uni.unanimousBelowFloor, true, "the hold is attributed to the unanimity path");
assert.equal(uni.agreement, "unanimous");
assert.equal(uni.floorApplied, UFLOOR, "floorApplied reports the floor actually used, for the gate");
assert.equal(uni.verdict?.confidence, 0.88, "the representative verdict comes from the held side");
n += 6;

// A SINGLE dissenting sample still sends: the path turns on agreement, not on a lowered bar.
assert.equal(
  decideCadenceQualityConsensus([sub(), sub(), send()], FLOOR, { unanimousFloor: UFLOOR }).holdBack,
  false,
  "one genuine send vote breaks the unanimity — 2 sub-floor suppressions are not enough"
);
// A judge that is actually unsure is not agreement. The floor is lowered, never removed.
assert.equal(
  decideCadenceQualityConsensus([sub(0.6), sub(0.6), sub(0.6)], FLOOR, { unanimousFloor: UFLOOR }).holdBack,
  false,
  "unanimous but BELOW the unanimity floor => sends (a coin flip is not evidence)"
);
// One sample is not unanimity — it is the very irreproducibility this module manages.
assert.equal(
  decideCadenceQualityConsensus([sub()], FLOOR, { unanimousFloor: UFLOOR }).holdBack,
  false,
  "a single sample can never trigger the unanimity path"
);
// `hold` counts alongside `suppress`, same as the ordinary test.
assert.equal(
  decideCadenceQualityConsensus([{ overall: "hold", confidence: 0.85 }, sub()], FLOOR, { unanimousFloor: UFLOOR }).holdBack,
  true,
  "hold and suppress both count toward the agreement"
);
// Failed samples are still dropped, not counted as dissent — consistent with section 3.
const uniNull = decideCadenceQualityConsensus([sub(), null, sub()] as any, FLOOR, { unanimousFloor: UFLOOR });
assert.equal(uniNull.holdBack, true, "a dropped sample does not break unanimity among the usable ones");
assert.equal(uniNull.usableVotes, 2);
n += 6;

// The path can only ADD a hold-back, never overturn one: when the ordinary majority already held,
// the enforce floor is what gets reported to the gate.
const majorityWins = decideCadenceQualityConsensus([hold(0.95), hold(0.95), send()], FLOOR, { unanimousFloor: UFLOOR });
assert.equal(majorityWins.holdBack, true);
assert.equal(majorityWins.unanimousBelowFloor, false, "a real majority is not relabelled as unanimity");
assert.equal(majorityWins.floorApplied, FLOOR, "an ordinary hold still reports the ENFORCE floor to the gate");
// And a plain send decision reports the enforce floor too, so the gate is never loosened by accident.
assert.equal(
  decideCadenceQualityConsensus([send(), send()], FLOOR, { unanimousFloor: UFLOOR }).floorApplied,
  FLOOR,
  "a send decision never hands the gate a lowered floor"
);
n += 4;

// EARLY EXIT must not abort before unanimity can be seen: two sub-floor suppressions read 2-0 to
// SEND under the old majority test, which would have stopped the loop one sample short.
calls = 0;
r = await sampleCadenceQualityConsensus(counted(sub()), { samples: 3, floor: FLOOR, unanimousFloor: UFLOOR });
assert.equal(calls, 3, "an all-suppress post-sale touch spends the third sample to confirm the agreement");
assert.equal(r.holdBack, true, "…and is held");
// The moment a genuine send appears, unanimity is dead and the old early exit applies again.
calls = 0;
r = await sampleCadenceQualityConsensus(counted(send()), { samples: 3, floor: FLOOR, unanimousFloor: UFLOOR });
assert.equal(calls, 2, "a stable send still costs only two calls — the extra sample is not a blanket cost");
assert.equal(r.holdBack, false);
n += 4;

// --- 8) the unanimity floor itself ----------------------------------------------------------------
const withUFloor = (v: string | undefined, fn: () => void) => {
  const prev = process.env.CADENCE_QUALITY_UNANIMOUS_MIN_CONFIDENCE;
  if (v === undefined) delete process.env.CADENCE_QUALITY_UNANIMOUS_MIN_CONFIDENCE;
  else process.env.CADENCE_QUALITY_UNANIMOUS_MIN_CONFIDENCE = v;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.CADENCE_QUALITY_UNANIMOUS_MIN_CONFIDENCE;
    else process.env.CADENCE_QUALITY_UNANIMOUS_MIN_CONFIDENCE = prev;
  }
};
withUFloor(undefined, () => assert.equal(cadenceQualityUnanimousFloor(), CADENCE_QUALITY_UNANIMOUS_FLOOR_DEFAULT));
withUFloor(undefined, () => assert.equal(cadenceQualityUnanimousFloor(), 0.8, "defaults to 0.80 — under the 0.90 breakpoint, well over a coin flip"));
withUFloor("0.85", () => assert.equal(cadenceQualityUnanimousFloor(), 0.85, "env-tunable"));
withUFloor("nope", () => assert.equal(cadenceQualityUnanimousFloor(), 0.8, "an invalid floor falls back to the default"));
withUFloor("0", () => assert.equal(cadenceQualityUnanimousFloor(), 0.8, "a zero floor would disable the confidence check — rejected"));
// The unanimity floor must stay BELOW the enforce floor, or the path is dead code.
assert.ok(CADENCE_QUALITY_UNANIMOUS_FLOOR_DEFAULT < 0.9, "the unanimity floor sits below the enforce breakpoint");
n += 6;

// --- 9) THE SCOPE PREDICATE: null everywhere except a settled post-sale thread ---------------------
// This is the whole safety argument. Anything that returns null keeps today's fail-toward-sending
// behaviour byte for byte, so each way OUT of the path is worth its own assertion.
const SOLD = "2026-07-31T20:12:53.459Z";
assert.equal(
  resolveCadenceUnanimousFloor({ enforce: true, cadenceKind: "post_sale", sale: { soldAt: SOLD } }),
  CADENCE_QUALITY_UNANIMOUS_FLOOR_DEFAULT,
  "a settled post-sale thread votes at the unanimity floor (+17163741119::2)"
);
assert.equal(
  resolveCadenceUnanimousFloor({ enforce: true, cadenceKind: "standard", sale: { soldAt: SOLD } }),
  null,
  "a STANDARD cadence is untouched — a wrongly-suppressed touch there ghosts a live lead"
);
assert.equal(
  resolveCadenceUnanimousFloor({ enforce: true, cadenceKind: "engaged", sale: { soldAt: SOLD } }),
  null,
  "…and so is an engaged cadence"
);
assert.equal(
  resolveCadenceUnanimousFloor({ enforce: true, cadenceKind: "post_sale", sale: null }),
  null,
  "post_sale WITHOUT a recorded sale is not settled — the judge's own 'did they actually buy?' doubt"
);
assert.equal(
  resolveCadenceUnanimousFloor({ enforce: true, cadenceKind: "post_sale", sale: { soldAt: "  " } }),
  null,
  "a blank soldAt is not a sale"
);
assert.equal(
  resolveCadenceUnanimousFloor({ enforce: false, cadenceKind: "post_sale", sale: { soldAt: SOLD } }),
  null,
  "SHADOW never votes — it takes one sample, and one sample is not agreement"
);
assert.equal(
  resolveCadenceUnanimousFloor({ enforce: true, cadenceKind: null, sale: { soldAt: SOLD } }),
  null,
  "no cadence kind => no unanimity path"
);
n += 7;

// --- 10) WIRING: the predicate and the shared floor are actually in the live path ------------------
// Both are one edit away from silently reverting to the old behaviour, so pin them at the call site.
const idxSrc = readFileSync(new URL("../services/api/src/index.ts", import.meta.url), "utf8");
assert.match(
  idxSrc,
  /resolveCadenceUnanimousFloor\(\{ enforce, cadenceKind, sale: conv\?\.sale \}\)/,
  "the live cadence gate asks the scope predicate rather than re-deriving it inline"
);
assert.match(
  idxSrc,
  /minConfidence: enforce \? consensus\.floorApplied : undefined/,
  "the gate re-checks confidence at the floor the vote actually used, never a stale enforce floor"
);
n += 2;

console.log(`PASS cadence-quality consensus eval (${n} assertions — vote, fail-direction toward sending, winning-side verdict, early exit, shadow stays 1 call, draft-gate confirm-on-block, post-sale sub-floor unanimity)`);
