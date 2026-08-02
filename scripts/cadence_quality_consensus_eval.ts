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
import {
  decideCadenceQualityConsensus,
  sampleCadenceQualityConsensus,
  verdictHoldsBack,
  cadenceQualityConsensusSamples,
  CADENCE_QUALITY_CONSENSUS_SAMPLES_DEFAULT
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

console.log(`PASS cadence-quality consensus eval (${n} assertions — vote, fail-direction toward sending, winning-side verdict, early exit, shadow stays 1 call)`);
