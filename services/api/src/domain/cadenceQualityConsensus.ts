/**
 * Cadence-quality judge CONSENSUS — make a live suppression reproducible.
 *
 * THE DEFECT (measured 2026-08-02). `CADENCE_QUALITY_ENFORCE` is live: a `suppress` verdict at
 * >= the enforce floor holds a proactive follow-up back from a customer. That verdict is not
 * reproducible. Running the production judge twice over the same 100 proactive sends, with the
 * same prompt and the same model, produced 33 suppressions and then 29 — and only 22 were the
 * SAME messages. Of the union, 45% flipped. A 50-message / 6-judgement probe put single-sample
 * self-agreement at 74%, with 48% of messages judged BOTH ways at least once across six runs.
 * The identical event invite ("Join us Sat, July 18, 12-5PM…") came back 1/6, 2/6 and 3/6
 * hold-back on different customers.
 *
 * So roughly a third of proactive touches were being held back, and about half of those
 * decisions were noise: whether a customer heard from us depended on which way a sample landed.
 *
 * WHY NOT JUST PIN THE TEMPERATURE. We can't. `optionalTemperature` drops the parameter for every
 * gpt-5 model (`modelSupportsTemperature = !isGpt5Model`), and this judge runs on gpt-5-mini, so
 * deterministic decoding is unavailable — setting it would be a silent no-op, the same shape as
 * the claude-opus-5 `temperature` 400 in #440. Nor is this a schema problem: every one of those
 * 300 calls returned valid JSON with a legal enum. Strict structured outputs constrain the SHAPE
 * of an answer, never its stability.
 *
 * THE FIX. Sample the judge up to N times and take the majority. Measured on the same corpus:
 * vote-of-3 agreement 90% vs 74% single-sample — it roughly halves the error. It manages the
 * instability rather than removing it; the residual is recorded so it stays visible.
 *
 * FAIL DIRECTION: toward SENDING. No usable verdict (every sample failed, LLM off) => holdBack
 * false, which is exactly today's behaviour when the judge returns null. That matters here: a
 * wrongly-sent filler touch is recoverable and visible, while a wrongly-suppressed one is a lead
 * going quiet with nothing to show for it — the failure mode the taper scope-guard was already
 * added for (26 threads, 25 then ghosted).
 *
 * COST: shadow keeps ONE sample. Only the ENFORCE path votes, and it early-exits as soon as one
 * side cannot be caught (two agreeing samples decide a best-of-three), so a stable message costs
 * 2 calls and only a genuinely split one costs 3.
 */

/** The shape this module needs off a judge verdict; the full parse carries more. */
export type CadenceQualityVerdictLike = {
  overall?: string | null;
  confidence?: number | null;
} | null;

export type CadenceQualityConsensus<V extends CadenceQualityVerdictLike> = {
  /** Would the gate hold the message back? */
  holdBack: boolean;
  /** The representative verdict from the WINNING side, so the recorded reason matches the call. */
  verdict: V | null;
  holdVotes: number;
  usableVotes: number;
  agreement: "unanimous" | "majority" | "no_verdict";
};

/** Default number of samples for a live suppression decision. */
export const CADENCE_QUALITY_CONSENSUS_SAMPLES_DEFAULT = 3;

export function cadenceQualityConsensusSamples(): number {
  const raw = Number(process.env.CADENCE_QUALITY_CONSENSUS_SAMPLES);
  if (!Number.isFinite(raw)) return CADENCE_QUALITY_CONSENSUS_SAMPLES_DEFAULT;
  // Even sample counts cannot produce a majority; clamp to a sane odd range.
  const n = Math.max(1, Math.min(5, Math.floor(raw)));
  return n % 2 === 0 ? n + 1 : n;
}

/**
 * Does THIS verdict hold the message back? Mirrors the gate's own trigger: a suppress/hold verdict
 * at or above the floor. Anything else (including a missing verdict) sends.
 */
export function verdictHoldsBack(verdict: CadenceQualityVerdictLike, floor: number): boolean {
  if (!verdict) return false;
  const overall = String(verdict.overall ?? "").trim().toLowerCase();
  if (overall !== "suppress" && overall !== "hold") return false;
  const confidence = Number(verdict.confidence);
  return Number.isFinite(confidence) && confidence >= floor;
}

/**
 * Pure majority over collected verdicts. Nulls are DROPPED, not counted as "send" — a failed
 * sample is an absence of evidence, and letting it vote would hand the outcome to the API's
 * error rate. If every sample failed there is no verdict and the message sends.
 */
export function decideCadenceQualityConsensus<V extends CadenceQualityVerdictLike>(
  verdicts: V[],
  floor: number
): CadenceQualityConsensus<V> {
  const usable = verdicts.filter((v): v is V => !!v);
  if (!usable.length) {
    return { holdBack: false, verdict: null, holdVotes: 0, usableVotes: 0, agreement: "no_verdict" };
  }
  const holds = usable.filter(v => verdictHoldsBack(v, floor));
  const holdBack = holds.length * 2 > usable.length;
  const winners = holdBack ? holds : usable.filter(v => !verdictHoldsBack(v, floor));
  // Representative = the most confident verdict on the winning side, so the reason we log is the
  // strongest statement of the decision we actually took.
  const verdict = winners.reduce<V | null>((best, v) => {
    if (!best) return v;
    return Number(v?.confidence ?? 0) > Number(best?.confidence ?? 0) ? v : best;
  }, null);
  return {
    holdBack,
    verdict,
    holdVotes: holds.length,
    usableVotes: usable.length,
    agreement: holds.length === 0 || holds.length === usable.length ? "unanimous" : "majority"
  };
}

/**
 * Sample the judge up to `samples` times and return the majority verdict.
 *
 * EARLY EXIT: stops as soon as the remaining samples cannot change the outcome — with 3 samples,
 * two agreeing verdicts decide it. A sampler that throws counts as a failed (dropped) sample and
 * never aborts the vote.
 */
export async function sampleCadenceQualityConsensus<V extends CadenceQualityVerdictLike>(
  sample: () => Promise<V>,
  opts: { samples: number; floor: number }
): Promise<CadenceQualityConsensus<V>> {
  const total = Math.max(1, Math.floor(opts.samples));
  const collected: V[] = [];
  let holds = 0;
  let sends = 0;
  for (let i = 0; i < total; i += 1) {
    let v: V | null = null;
    try {
      v = await sample();
    } catch {
      v = null;
    }
    collected.push(v as V);
    if (v) {
      if (verdictHoldsBack(v, opts.floor)) holds += 1;
      else sends += 1;
    }
    const remaining = total - (i + 1);
    // One side already unbeatable => the rest of the samples cannot change the majority.
    if (holds > sends + remaining || sends > holds + remaining) break;
  }
  return decideCadenceQualityConsensus(collected, opts.floor);
}
