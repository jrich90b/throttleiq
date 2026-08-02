/**
 * Cadence realign sweeps — the reconcile tick's "is this ladder pointing at the right rung?" pass.
 *
 * Two heals live here, both of which walk the whole conversation list once per tick:
 *
 *  1. MIS-DEFERRED LONG_TERM (Richard Tait, 2026-06-25): a lead wrongly parked on a months-out
 *     long_term first touch when its structured purchase timeframe actually resolves to the
 *     standard day-1 ramp. Heal the never-contacted ones so their nurture fires now, not in
 *     three months.
 *
 *  2. BURNED LADDER (Dennis Daffron +16303628805, 2026-08-02): a standard/engaged cadence sitting
 *     on a rung the calendar has not earned — the residue of the pre-86e3ec79 bug where every
 *     staff manual send consumed a ladder step. Ten texts on day one marched his stepIndex 0 -> 9
 *     of 13, which is the 45-day rung, parking his next automated touch on Sept 5 right after he
 *     said "I should have a decision soon". That fix stopped new damage but could not repair the
 *     records already burned, and a burned ladder is invisible: the cadence looks perfectly
 *     healthy, it is just pointing somewhere the calendar has not reached.
 *
 * Extracted from index.ts (2026-08-02) under the source-size ratchet's own instruction — a change
 * that will not fit is the signal the code belongs in a domain module. Both sweeps were already
 * near-identical loops; this is the shared shape, so the caller records outcomes and logs instead
 * of hand-rolling the walk twice.
 *
 * Neither sweep SENDS anything. They only move a cadence back onto its correct rung, where the
 * cadence value gate and the no-repeat guards still decide whether the touch has anything worth
 * saying. Both are capped per tick and idempotent.
 */
import {
  realignMisdeferredLongTermCadence,
  realignBurnedCadenceLadder,
  saveConversation,
  type Conversation
} from "./conversationStore.js";

/** Max heals of each kind per tick — the same cap the inline loops carried. */
export const CADENCE_REALIGN_SWEEP_CAP = 25;

export type LongTermRealignOutcome = {
  convId: string;
  leadKey: string;
  purchaseTimeframe: string | null;
};

export type BurnedLadderOutcome = {
  convId: string;
  leadKey: string;
  /** The rung the cadence was wrongly sitting on. */
  fromStep: number;
  /** The rung elapsed time had actually earned. */
  toStep: number;
};

export type CadenceRealignSweepResult = {
  longTermRealigned: LongTermRealignOutcome[];
  burnedLaddersHealed: BurnedLadderOutcome[];
};

/**
 * Run both realign heals over the conversation list. Returns what changed so the caller can record
 * route outcomes and log; persistence happens here (a healed record is saved immediately, exactly
 * as the inline loops did).
 */
export function sweepCadenceRealigns(
  convs: Conversation[],
  timeZone: string,
  now: Date = new Date()
): CadenceRealignSweepResult {
  const longTermRealigned: LongTermRealignOutcome[] = [];
  const burnedLaddersHealed: BurnedLadderOutcome[] = [];
  for (const conv of convs ?? []) {
    if (longTermRealigned.length < CADENCE_REALIGN_SWEEP_CAP && realignMisdeferredLongTermCadence(conv, timeZone, now)) {
      saveConversation(conv);
      longTermRealigned.push({
        convId: conv.id,
        leadKey: conv.leadKey,
        purchaseTimeframe: conv.lead?.purchaseTimeframe ?? null
      });
      continue; // a cadence just re-anchored to step 0 is by definition not a burned ladder
    }
    if (burnedLaddersHealed.length >= CADENCE_REALIGN_SWEEP_CAP) continue;
    // Read the rung BEFORE the heal so the outcome can name the correction.
    const fromStep = Number(conv?.followUpCadence?.stepIndex ?? 0);
    if (realignBurnedCadenceLadder(conv, timeZone, now)) {
      saveConversation(conv);
      burnedLaddersHealed.push({
        convId: conv.id,
        leadKey: conv.leadKey,
        fromStep,
        toStep: Number(conv?.followUpCadence?.stepIndex ?? 0)
      });
    }
  }
  return { longTermRealigned, burnedLaddersHealed };
}
