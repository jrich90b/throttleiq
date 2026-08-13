/**
 * Lead identity — who a conversation actually BELONGS to, and therefore which other
 * conversations are the same person.
 *
 * `findRelatedConversations` is the join behind every cross-thread side effect we own:
 * `stopRelatedCadences` (kills a lead's follow-up), cross-channel handoff mode, and
 * cross-channel closes. A wrong join does not produce a wrong REPLY — it silently
 * performs one customer's side effect on a different customer's thread, which is why
 * no reply-grading net can see it.
 *
 * MEASURED on the americanharley store 2026-08-13: 13 `lead.email` values were shared by
 * more than one conversation, and the four largest were not people at all —
 *   "n/a"            -> 11 conversations
 *   "na@na.com"      ->  5
 *   "na"             ->  3
 *   <a rep's own work address, dropped into customer records by the lead feed> -> 18
 * Walk-in / Traffic Log Pro ADF leads arrive with a literal `Email: n/a` line, so every one
 * of them joined every other one. The cost, measured the same day: FOUR conversations carried
 * `followUpCadence.stopReason === "appointment_booked"` with no appointment of their own —
 * their cadence was stopped by a DIFFERENT customer's booking. Tom Balko (+17164656440, a live
 * trade lead) was stopped 47 seconds after Paul Harrigan (+17169467451) booked a test ride.
 *
 * The rep-address half of this was already ruled on 2026-08-04 for the leak audit
 * (`crossLeadLeak.ts` deliberately refuses to treat a rep's work address as a customer's
 * contact) — the identity join never got the same memo. This module fixes the half that is
 * decidable WITHOUT the dealer profile: a value that is not an email address at all.
 * Excluding the dealer's own domain needs `collectDealerContacts`, which is async here, and is
 * deliberately left for its own slice rather than half-built.
 *
 * Deterministic on purpose — AGENTS.md allows deterministic code for invariant guards, and
 * "n/a" is not a comprehension question. Fail direction is safe by construction: refusing a
 * join means we DON'T perform a side effect on a thread, never that we perform an extra one.
 *
 * PHONES ARE DELIBERATELY UNTOUCHED. Measured the same day: of 840 distinct normalized lead
 * phones only 3 were shared, and all 3 were genuine duplicates of the same number. There is no
 * placeholder-phone problem to fix, so this does not invent a guard for one.
 */

/** Values a lead feed writes into an email field when it has no email. Not addresses. */
const NON_IDENTIFYING_EMAIL_VALUES = new Set([
  "n/a",
  "na",
  "n\\a",
  "none",
  "null",
  "nil",
  "no",
  "no email",
  "noemail",
  "not provided",
  "unknown",
  "tbd",
  "-",
  "--",
  "na@na.com",
  "n/a@n/a.com",
  "none@none.com",
  "noemail@noemail.com",
  "no@email.com",
  "test@test.com",
  "email@email.com",
  "unknown@unknown.com"
]);

/**
 * True when `raw` cannot identify a customer: blank, a feed placeholder, or not shaped like an
 * address at all. Shape is checked last so a novel placeholder ("no e-mail on file") still fails.
 */
export function isNonIdentifyingLeadEmail(raw: unknown): boolean {
  const text = String(raw ?? "").trim().toLowerCase();
  if (!text) return true;
  if (NON_IDENTIFYING_EMAIL_VALUES.has(text)) return true;
  const at = text.indexOf("@");
  // Must have a local part, a domain, and a dot in the domain — "na" and "n/a" fail here too.
  if (at <= 0 || at === text.length - 1) return true;
  const domain = text.slice(at + 1);
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return true;
  return false;
}

export type LeadIdentity = { email?: string; phone?: string };

/**
 * The email/phone a conversation is identified BY. `normalizePhone` is injected so this shares
 * one definition of "a phone" with its caller instead of quietly growing a second one.
 */
export function resolveLeadIdentity(
  conv: any,
  event: { from?: string } | undefined,
  normalizePhone: (raw: string) => string
): LeadIdentity {
  const leadKey = typeof conv?.leadKey === "string" ? conv.leadKey.trim() : "";
  const eventFrom = String(event?.from ?? "").trim();

  const emailCandidates = [
    conv?.lead?.email,
    leadKey.includes("@") ? leadKey : "",
    eventFrom.includes("@") ? eventFrom : ""
  ];
  let email: string | undefined;
  for (const candidate of emailCandidates) {
    const text = String(candidate ?? "").trim();
    if (!text) continue;
    if (isNonIdentifyingLeadEmail(text)) continue;
    email = text.toLowerCase();
    break;
  }

  const phoneCandidates = [
    conv?.lead?.phone,
    leadKey && !leadKey.includes("@") ? leadKey : "",
    eventFrom && !eventFrom.includes("@") ? eventFrom : ""
  ];
  let phoneRaw = "";
  for (const candidate of phoneCandidates) {
    const text = String(candidate ?? "").trim();
    if (!text) continue;
    phoneRaw = text;
    break;
  }
  const phone = phoneRaw ? normalizePhone(phoneRaw) : undefined;

  return { email, phone };
}

/** Every OTHER conversation that is the same customer. Empty when nothing identifies this one. */
export function findRelatedConversations(
  conv: any,
  all: any[],
  event: { from?: string } | undefined,
  normalizePhone: (raw: string) => string
): any[] {
  const { email, phone } = resolveLeadIdentity(conv, event, normalizePhone);
  // Fast path only — NOT the guard. With no identity the filter below already matches nothing,
  // and the eval confirms that by deleting this line and still passing. Kept because scanning
  // every conversation to learn that is wasted work on a store this size.
  if (!email && !phone) return [];
  return (all ?? []).filter(other => {
    if (!other || other.id === conv?.id) return false;
    const ids = resolveLeadIdentity(other, undefined, normalizePhone);
    const emailMatch = email && ids.email && ids.email === email;
    const phoneMatch = phone && ids.phone && ids.phone === phone;
    return !!(emailMatch || phoneMatch);
  });
}
