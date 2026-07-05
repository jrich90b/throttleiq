/**
 * "Disclose a unit's unavailability ONCE" guard for the proactive cadence.
 *
 * Origin: Lizbeth (+18035525355, 2026-07-04). Her lead unit went sold/held, and
 * the held-inventory cadence overrides (buildCadenceHeldInventoryOverride /
 * buildCadenceLeadUnitAvailabilityOverride in index.ts) re-sent the same
 * "I know you were interested in the {unit}, but that bike has sold …" message
 * on EVERY cadence step — five near-verbatim sends over six weeks — because the
 * overrides bypass the cadence no-repeat rotation (selectNonRepeatingCadenceMessage).
 *
 * The correct behavior is: say it once, then let the normal varied cadence (or the
 * inventory-watch nudge the override already armed) carry the thread. A customer
 * inbound RE-ARMS disclosure — if they write back after we told them a unit was
 * gone, a fresh disclosure (e.g. about a different unit they now ask about) is
 * allowed again.
 *
 * This is a deterministic dedup gate over the agent's OWN sent output (a
 * side-effect/state guard per AGENTS.md), NOT customer-intent comprehension — so
 * matching our outbound copy here is by-design, not a parser-first violation.
 */

export type CadenceOutboundLike = {
  direction?: string | null;
  provider?: string | null;
  body?: string | null;
};

const normalize = (body: string): string =>
  String(body ?? "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

// The two cadence availability-override builders emit exactly two message shapes:
//   1. "…I know you were interested in the {unit}, but that bike has sold. …"
//      "…I know you were interested in the {unit}, but that bike is on hold right now. …"
//   2. "…quick update — the {unit} is no longer available. …"
//      "…quick update — the {unit} is currently on hold and may no longer be available. …"
// Require the distinctive lead-in AND an unavailability status phrase so an
// ordinary check-in or an unrelated draft can never trip the guard.
const INTEREST_LEADIN_RE = /\bi know you were interested in the\b/;
const INTEREST_STATUS_RE = /\bbut that bike (?:has sold|is on hold right now)\b/;
const UPDATE_LEADIN_RE = /\bquick update\b/;
const UPDATE_STATUS_RE = /\bis (?:no longer available|currently on hold(?: and may no longer be available)?)\b/;

/**
 * True when `body` is one of the cadence unit-unavailability disclosures ("that
 * bike has sold / is on hold", "the {unit} is no longer available").
 */
export function isUnitUnavailabilityDisclosureText(body: string): boolean {
  const text = normalize(body);
  if (!text) return false;
  if (INTEREST_LEADIN_RE.test(text) && INTEREST_STATUS_RE.test(text)) return true;
  if (UPDATE_LEADIN_RE.test(text) && UPDATE_STATUS_RE.test(text)) return true;
  return false;
}

/**
 * True when the agent has ALREADY sent a unit-unavailability disclosure in this
 * conversation and the customer has not replied since — i.e. re-sending it now
 * would be a duplicate nag. Walks newest→oldest: a customer inbound re-arms
 * disclosure (returns false); a SENT (non-draft) disclosure outbound with no
 * inbound after it returns true. Pending drafts (provider "draft_ai") never
 * count — they aren't sent.
 */
export function hasDisclosedUnitUnavailabilityWithoutReply(
  messages: CadenceOutboundLike[] | undefined | null
): boolean {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    const direction = String(m?.direction ?? "");
    if (direction === "in") return false; // customer re-engaged after any prior disclosure
    if (direction !== "out") continue;
    if (String(m?.provider ?? "") === "draft_ai") continue; // unsent pending draft
    if (isUnitUnavailabilityDisclosureText(String(m?.body ?? ""))) return true;
  }
  return false;
}
