/**
 * Ride-challenge cadence heals — the two state-reconcile passes that keep the season's
 * signups pointed at the 9/15 wrap-up. Extracted from index.ts (source-size ratchet: heal
 * bodies belong in domain modules; index keeps a one-call wiring site per heal).
 *
 * 1. realignRideChallengeCadences (Joe ruling 2026-07-09, +15857657010): legacy ride-challenge
 *    leads classified BEFORE the 6/24 event_promo source inference (aec61b68) are still on an
 *    ACTIVE standard/long_term drip — their next proactive touch should be the challenge
 *    wrap-up, not a sales nudge. Realign any ACTIVE cadence whose next touch lands before the
 *    event date by pausing it until then. Idempotent (a paused cadence is no longer status
 *    "active"); only DELAYS touches, never sends or closes (fail-safe).
 *
 * 2. reviveRideChallengeWrapUps (Joe ruling 2026-08-21: "generate a draft on the 15th"):
 *    the signup ack COMPLETED these cadences on the spot (advanceFollowUpCadence's reminder
 *    short-circuit) and the tick skips completed — so without this the 9/15 wrap-up never
 *    composes for the parked signups. decideRideChallengeWrapUpRevive (routeStateReducer)
 *    owns the decision: one-way (owed = lastSentStep < 1, so a sent wrap-up can never
 *    re-fire), staggered over 3 days so the approval box is not flooded, bounded to
 *    event + 7d grace. The revived cadence flows through the NORMAL tick → a suggest-mode
 *    draft; every existing gate applies. Closed threads are left dormant (the tick never
 *    fires their touch — no zombie "active" cadences on closed conversations).
 *
 * Both pinned by ride_challenge_event_cadence:eval (decision tables, stagger determinism,
 * convergence, and these wiring bodies).
 */
import { type Conversation, pauseFollowUpCadence, saveConversation } from "./conversationStore.js";
import { decideRideChallengeWrapUpRevive, resolveRideChallengeEventTouch } from "./routeStateReducer.js";

type RecordRouteOutcome = (scope: "manual", outcome: string, detail?: Record<string, unknown>) => void;

export function realignRideChallengeCadences(
  convs: Conversation[],
  followUpIso: string | null,
  recordRouteOutcome: RecordRouteOutcome
): number {
  let realigned = 0;
  for (const conv of convs) {
    const cad: any = conv.followUpCadence;
    if (!cad || String(cad.status ?? "") !== "active") continue;
    const touch = resolveRideChallengeEventTouch({
      leadSource: conv.lead?.source ?? null,
      classificationBucket: conv.classification?.bucket ?? null,
      classificationCta: conv.classification?.cta ?? null,
      nowMs: Date.now(),
      followUpIso
    });
    if (!touch) continue;
    const nextDueMs = Date.parse(String(cad.nextDueAt ?? ""));
    if (Number.isFinite(nextDueMs) && nextDueMs >= Date.parse(touch.pauseUntilIso)) continue; // already at/after the event
    pauseFollowUpCadence(conv, touch.pauseUntilIso, "event_date");
    saveConversation(conv);
    realigned += 1;
    recordRouteOutcome("manual", "ride_challenge_cadence_event_realign", {
      convId: conv.id,
      leadKey: conv.leadKey,
      pausedUntil: touch.pauseUntilIso
    });
  }
  if (realigned > 0) {
    console.log(`[state-reconcile] realigned ${realigned} ride-challenge cadence(s) to the event wrap-up date`);
  }
  return realigned;
}

export function reviveRideChallengeWrapUps(
  convs: Conversation[],
  followUpIso: string | null,
  recordRouteOutcome: RecordRouteOutcome
): number {
  let revivedCount = 0;
  for (const conv of convs) {
    const cad: any = conv.followUpCadence;
    if (!cad) continue;
    if (conv.status === "closed" || conv.closedAt) continue;
    const revive = decideRideChallengeWrapUpRevive({
      convId: conv.id,
      cadenceStatus: cad.status,
      cadenceKind: cad.kind,
      deferredMessage: cad.deferredMessage,
      lastSentStep: cad.lastSentStep,
      nowMs: Date.now(),
      followUpIso
    });
    if (!revive) continue;
    cad.status = "active";
    cad.stopReason = undefined;
    cad.nextDueAt = revive.nextDueAtIso;
    cad.pausedUntil = undefined;
    cad.pauseReason = undefined;
    conv.updatedAt = new Date().toISOString();
    saveConversation(conv);
    revivedCount += 1;
    recordRouteOutcome("manual", "ride_challenge_wrapup_revived", {
      convId: conv.id,
      leadKey: conv.leadKey,
      nextDueAt: revive.nextDueAtIso
    });
  }
  if (revivedCount > 0) {
    console.log(`[state-reconcile] revived ${revivedCount} ride-challenge wrap-up cadence(s) for the event touch`);
  }
  return revivedCount;
}
