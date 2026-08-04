/**
 * Watch-opt-out turn resolution — what a customer on an INVENTORY WATCH just told us, and what the
 * caller should do about it. Pure: decides and composes the reply; the caller owns the side effects
 * and the save.
 *
 * WHY THIS MODULE EXISTS (2026-08-04). `resolveWatchOptOutReply` in index.ts used to gate the parser
 * CALL on a keyword list (`watchOptOutHint`). Mark Kocsis (+17168609533) answered a watch alert with
 * "Thanks for keeping me in mind but I actually just picked up a 2023 street glide anniversary
 * edition." — "just picked up" is not "already bought", so the list did not match, the parser was
 * never called, and he got NO reply while the alerts kept running for a bike he already owns.
 *
 * A regex whose miss produces a wrong, silent answer is comprehension, not a safety gate
 * (AGENTS.md's fail-direction test), so the gate is gone and the parser owns the read. The only gate
 * left is state: no active watch, nothing to decide.
 *
 * TWO OUTCOMES, deliberately different (Joe, 2026-08-04):
 *  - `pause_watch` — "take me off the list". Stop the alerts, KEEP the lead; they may still buy here.
 *  - `acknowledge_and_close` — "I bought one". Congratulate them, say we are here for anything the
 *    bike needs, drop the alerts, and close the lead once that reply actually goes out.
 *
 * WHAT THE CALLER DOES WITH THE OUTCOME (prose moved out of index.ts, 2026-08-04, to land under the
 * source_size_ratchet ceiling — the reasoning belongs next to the decision anyway):
 *  - The caller is BOTH `/webhooks/twilio` and `/conversations/:id/regenerate` (route-parity law);
 *    it only applies the side effects this outcome asks for.
 *  - THE WATCH COMES OFF NOW, not on send. Alerts still running for someone who just bought is the
 *    exact spam this path exists to stop, and pausing is reversible if they text back.
 *  - THE CLOSE WAITS FOR A REAL SEND (Joe: "after we send draft and it goes through it should close
 *    the lead"). `armPendingCloseout` here; `applyPendingCloseoutOnSend` fires it on a DELIVERED
 *    outbound only. `delivered: false` means the text never reached them, so the lead stays open and
 *    the arm stays put for the retry. The closeout referee still refuses if the customer has
 *    written since — an armed close is a request, never a guarantee.
 */
import { decideWatchOptOutTurn } from "./routeStateReducer.js";
import { buildAcquiredVehicleAck } from "./agentVoice.js";
import type { WatchOptOutParse } from "./llmDraft.js";

/** The ack for a plain opt-out: no purchase claimed, so no congratulations and no closeout. */
export function buildWatchOptOutAck(): string {
  return "No problem — I'll take you off the alerts for that one. Just text me anytime if you want back on.";
}

export type WatchOptOutTurnOutcome =
  | { kind: "none" }
  | { kind: "pause_watch"; reply: string; reason: "watch_opt_out"; closeAfterSend: false }
  | {
      kind: "acknowledge_and_close";
      reply: string;
      reason: "acquired_vehicle";
      /** What they said they bought, from THIS message only. "" when they named nothing. */
      vehicle: string;
      closeAfterSend: true;
    };

/**
 * Pure. FAIL DIRECTION: `none` — the caller then runs its normal draft pipeline, which is today's
 * behavior for everything this does not confidently recognize. Nothing here closes a lead by itself;
 * `closeAfterSend` only ASKS the caller to arm a closeout that a real send has to fire.
 */
export function resolveWatchOptOutOutcome(input: {
  hasActiveWatch: boolean;
  parse: WatchOptOutParse | null | undefined;
  confidenceMin: number;
}): WatchOptOutTurnOutcome {
  const parse = input.parse ?? null;
  const decision = decideWatchOptOutTurn({
    hasActiveWatch: input.hasActiveWatch,
    parserAccepted: !!parse,
    intent: parse?.intent ?? null,
    confidence: parse?.confidence ?? 0,
    confidenceMin: input.confidenceMin
  });
  if (decision.kind === "acknowledge_and_close") {
    const vehicle = String(parse?.vehicle ?? "").trim();
    return {
      kind: "acknowledge_and_close",
      reply: buildAcquiredVehicleAck(vehicle),
      reason: "acquired_vehicle",
      vehicle,
      closeAfterSend: true
    };
  }
  if (decision.kind === "pause_watch") {
    return { kind: "pause_watch", reply: buildWatchOptOutAck(), reason: "watch_opt_out", closeAfterSend: false };
  }
  return { kind: "none" };
}
