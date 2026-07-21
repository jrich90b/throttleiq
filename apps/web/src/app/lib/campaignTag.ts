// "Campaign sent" inbox pill visibility (Joe, 2026-07-21: fade after 14 days).
//
// The pill tells staff "this contact got a blast and hasn't replied yet." That context decays
// fast — replies land in the first days, and blasts run roughly monthly (each new blast
// re-stamps lastSentAt, so the pill re-arms fresh). Past the window it's stale noise, so the
// row hides it. A reply still clears it instantly (the caller's campaignReply check wins first).
//
// Fail direction: a tagged thread MISSING both sent timestamps keeps the pill (status quo —
// never silently hide context staff may rely on just because an old record predates the stamps).

export const CAMPAIGN_SENT_TAG_TTL_DAYS = 14;
const TTL_MS = CAMPAIGN_SENT_TAG_TTL_DAYS * 24 * 60 * 60 * 1000;

export function isCampaignSentTagFresh(
  campaignThread: { lastSentAt?: string | null; firstSentAt?: string | null } | null | undefined,
  nowMs: number
): boolean {
  const stamp = String(campaignThread?.lastSentAt ?? "").trim() || String(campaignThread?.firstSentAt ?? "").trim();
  if (!stamp) return true; // no timestamp on the record — keep today's behavior (visible)
  const sentMs = new Date(stamp).getTime();
  if (!Number.isFinite(sentMs)) return true; // unparseable stamp — same status-quo fallback
  return nowMs - sentMs <= TTL_MS;
}
