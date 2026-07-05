/**
 * Long-term-timeline deferral cadence message.
 *
 * Single source of truth shared by the live path (orchestrator.ts) and the ADF/email cadence
 * path (sendgridInbound.ts). These were copy-pasted and had already drifted — the orchestrator
 * copy was de-corporatized to "text me" while the sendgrid twin still said "reach out" — exactly
 * the kind of voice drift this consolidation removes (Voice Charter, AGENTS.md).
 *
 * `hasLicense` is accepted for call-site parity; the copy is intentionally identical with or
 * without a license (both originals returned the same string in either branch). The leading
 * "this is {agent} at {dealer}" intro is re-prepended by applyInitialAdfPrefix on the ADF path.
 *
 * NOTE (pre-existing): the agent/dealer names are still hardcoded here, carried over verbatim from
 * both originals. De-hardcoding to the dealer profile is a separate dealer-portability follow-up.
 */
export function buildLongTermTimelineMessage(timeframe?: string, _hasLicense?: boolean): string {
  const tf = timeframe ? timeframe.trim() : "a future";
  return `Hi, this is Brooke at American Harley-Davidson. You mentioned a ${tf} timeline. I’m here when you’re ready. Just text me when the time is right.`;
}
