/**
 * Per-recipient personalization for a CAMPAIGN broadcast SMS.
 *
 * A campaign body is generated ONCE and then sent to every contact on the list, so until now
 * all 772 contacts received a byte-identical text with nobody's name in it (Joe, 2026-08-13:
 * "Can a sms be personalized with a name when it gets sent out"). The recipient record is
 * already in scope in the broadcast loop — it simply was not being used for the body.
 *
 * WHY THE GREETING IS DETERMINISTIC AND THE BODY IS NOT. Picking a customer's own first name
 * out of our own contact record is structured extraction of a field we already own, not
 * comprehension of anything a customer said — deterministic is correct here per AGENTS.md. The
 * VOICE of the message (which the same change moves into the dealer's own register) stays with
 * the copy generator, which cannot know the recipient. Clean split: the generator writes one
 * dealer-voice body, the send path adds one name.
 *
 * FAIL DIRECTION: safe in both directions. An unusable name degrades to "Hey there!", never to a
 * broken greeting, and a body that already opens with its own greeting is left completely alone
 * rather than double-greeted. The worst case is the message we send today.
 */

import { normalizeGreetingNameCase } from "./agentVoice.js";

type CampaignContactLike = {
  firstName?: unknown;
  name?: unknown;
};

/**
 * A first name is usable in a greeting only if it is plainly a name.
 *
 * MEASURED on the live americanharley contact store, 2026-08-13: 767 of 772 contacts carry a
 * usable first name. The 5 that do not are exactly the shapes this rejects — one blank, three
 * single letters ("B", "K", "G"), and one run-together junk field ("s           R"). Texting a
 * real customer "Hey B!" is worse than not using a name at all, so every one of those falls
 * back to the name-less greeting.
 *
 * Rules, deliberately strict: the FIRST whitespace token only, at least two characters, and
 * letters-plus-name-punctuation only (so "7166795683", "n/a" and "-" are all out).
 */
export function resolveCampaignGreetingName(contact: CampaignContactLike): string | null {
  const raw = String(contact?.firstName ?? contact?.name ?? "").trim();
  if (!raw) return null;
  const firstToken = raw.split(/\s+/).filter(Boolean)[0] ?? "";
  if (firstToken.length < 2) return null;
  if (!/^[A-Za-z][A-Za-z'’.-]*$/.test(firstToken)) return null;
  const normalized = normalizeGreetingNameCase(firstToken).trim();
  return normalized || null;
}

/**
 * The campaign greeting: "Hey Mike! " / "Hey there! " (trailing space).
 *
 * DELIBERATELY NOT `buildAgentGreeting`, which yields the comma form "Hey Mike, ". That form
 * exists to run straight into a self-intro clause ("Hey Mike, it's Scott over at …"), and a
 * campaign body is a standalone sentence that carries its own capital — "Hey Mike, Get 10%
 * Customer Cash" is wrong, and lowercasing a generated body's first letter would mangle "10%",
 * model names and acronyms. Ending the greeting with its own terminator makes the join correct
 * no matter what the generator wrote. Exclamation points are explicitly welcome in the Agent
 * Voice Charter's register, and this adds no em-dash.
 */
export function buildCampaignGreeting(firstName: string | null | undefined): string {
  const name = String(firstName ?? "").trim();
  return name ? `Hey ${name}! ` : "Hey there! ";
}

/** Does this body already open with its own greeting? Then leave it entirely alone. */
export function hasLeadingGreeting(body: string): boolean {
  return /^\s*(hi|hey|hello|good\s+(morning|afternoon|evening))\b/i.test(String(body ?? ""));
}

/**
 * Prepend the recipient's greeting to a generated campaign SMS body.
 *
 * No-ops (returns the body unchanged) when there is no body, or when the generator already
 * wrote a greeting of its own — a double "Hey Mike! Hi Mike," is a worse text than the
 * un-personalized one this replaces.
 */
export function personalizeCampaignSmsBody(
  body: string,
  contact: CampaignContactLike
): string {
  const text = String(body ?? "").trim();
  if (!text) return text;
  if (hasLeadingGreeting(text)) return text;
  return `${buildCampaignGreeting(resolveCampaignGreetingName(contact))}${text}`;
}
