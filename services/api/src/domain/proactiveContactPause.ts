/**
 * Shared "is this lead on hold?" gate for PROACTIVE outbound (inventory
 * watch-fire alerts and cadence touches). The agent must never proactively
 * message a lead the customer or staff has put on hold.
 *
 * Production case (2026-06-30, Mark Scoville +17164815673 & Kevin Short
 * +17166035402): both leads were `followUp.mode = "paused_indefinite"` ("hold
 * off" / not ready), yet the watch-fire engines generated "good news — we have X
 * in stock" drafts because they only skipped `manual_handoff`. A held lead must
 * be excluded from proactive outreach until they re-engage (the hold lifts).
 *
 * Held modes:
 *  - `manual_handoff`     — staff own the conversation; the agent stays out.
 *  - `paused_indefinite`  — explicit hold ("hold off", "not ready", soft-close ack).
 *
 * Deliberately NOT held:
 *  - `holding_inventory`  — the lead's own unit is on hold and they WANT the
 *    "it's available again / a match arrived" alert. This is the legitimate
 *    watch-fire use case, so it must still fire (subject to the model matcher).
 *  - `active` / unset     — normal proactive cadence applies.
 *
 * Fail-direction: this only ever SUPPRESSES an outbound (withholds a proactive
 * message), never causes a wrong action — a deterministic side-effect gate, which
 * AGENTS.md allows.
 */
export type FollowUpModeBearer = {
  followUp?: { mode?: string | null } | null;
};

const PROACTIVE_HELD_MODES = new Set(["manual_handoff", "paused_indefinite"]);

export function isProactiveContactPaused(conv: FollowUpModeBearer | null | undefined): boolean {
  const mode = String(conv?.followUp?.mode ?? "").trim().toLowerCase();
  return PROACTIVE_HELD_MODES.has(mode);
}
