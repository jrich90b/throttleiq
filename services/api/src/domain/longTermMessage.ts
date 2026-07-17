/**
 * Long-term-timeline deferral cadence message.
 *
 * Single source of truth shared by the live path (orchestrator.ts), the ADF/email cadence
 * path (sendgridInbound.ts), and the outbound-send cadence starter (index.ts
 * maybeStartCadence). These were copy-pasted and had already drifted — the orchestrator
 * copy was de-corporatized to "text me" while the sendgrid/index twins still said "reach
 * out" — exactly the kind of voice drift this consolidation removes (Voice Charter,
 * AGENTS.md).
 *
 * Identity comes from the DEALER PROFILE, never a hardcoded name. The old copy opened
 * with a hardcoded "Hi, this is {agent} at {dealer}." whose names did NOT match the live
 * profile's agent, so long-term leads heard from two different people on one thread — and
 * "this is {agent} at {dealer}" is also the stiff corporate intro the voice charter
 * softened. The opener therefore reuses `buildAgentIntro` (agentVoice.ts — the single
 * source of truth for the greeting + intro). Missing profile fields degrade gracefully
 * (dealer-only / agent-only intro, or plain greeting) — NEVER to a hardcoded agent or
 * dealer name. On the initial-ADF path `applyInitialAdfPrefix` dedupes the leading intro
 * against the same profile, so the message never double-introduces.
 *
 * `hasLicense` is accepted for call-site parity; the copy is intentionally identical with
 * or without a license (both originals returned the same string in either branch).
 * Pinned by `long_term_message:eval`.
 */
import { buildAgentGreeting, buildAgentIntro } from "./agentVoice.js";

export function buildLongTermTimelineMessage(args: {
  /** Dealer-profile agent name (may carry a per-send override); blank => degrade gracefully. */
  agentName?: string | null;
  /** Dealer-profile dealership name; blank => degrade gracefully. */
  dealerName?: string | null;
  /** Customer first name for the greeting; blank => "Hey there, ". */
  firstName?: string | null;
  /** The lead's stated purchase timeframe label (e.g. "4-6 Months"); blank => "a future timeline". */
  timeframe?: string | null;
  /** Accepted for call-site parity; the copy is identical with or without a license. */
  hasLicense?: boolean;
}): string {
  const tf = String(args.timeframe ?? "").trim();
  const timelineClause = tf ? `a ${tf} timeline` : "a future timeline";
  const closer = "I’m here when you’re ready. Just text me when the time is right.";
  const agentName = String(args.agentName ?? "").trim();
  const dealerName = String(args.dealerName ?? "").trim();
  if (agentName && dealerName) {
    return `${buildAgentIntro(args.firstName, agentName, dealerName)}You mentioned ${timelineClause}. ${closer}`;
  }
  if (dealerName) {
    return `${buildAgentGreeting(args.firstName)}it's the team over at ${dealerName}. You mentioned ${timelineClause}. ${closer}`;
  }
  if (agentName) {
    return `${buildAgentGreeting(args.firstName)}it's ${agentName}. You mentioned ${timelineClause}. ${closer}`;
  }
  return `${buildAgentGreeting(args.firstName)}you mentioned ${timelineClause}. ${closer}`;
}
