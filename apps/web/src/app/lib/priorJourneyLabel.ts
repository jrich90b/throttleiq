/**
 * How a returning customer's previous purchase reads on their NEW thread.
 *
 * Joe, 2026-08-18: a sold customer who comes back to buy or trade opens a second thread by design,
 * and the second thread said nothing about the first — so it looked like a duplicate. This turns the
 * carried `priorJourney` record into the one line a human needs at a glance.
 *
 * Split out of the card so it can be EXECUTED by an eval. Every field is optional on the wire, so
 * the FAIL DIRECTION is: say less, never guess. With no bike we say "Bought previously" rather than
 * inventing one, and with nothing at all we return null and the row shows no pill — a wrong claim
 * about what somebody owns is far worse than a missing one.
 */
export type PriorJourneyLike = {
  conversationId?: string | null;
  soldAt?: string | null;
  label?: string | null;
  soldByName?: string | null;
  messageCount?: number | null;
} | null | undefined;

/** Short pill text: "Bought 2021 Road Glide Special" (or a plain fallback). */
export function priorJourneyPillLabel(prior: PriorJourneyLike): string | null {
  if (!prior) return null;
  const bike = String(prior.label ?? "").trim();
  return bike ? `Bought ${bike}` : "Returning customer";
}

/** The fuller sentence for the tooltip / thread header. */
export function priorJourneyDetail(prior: PriorJourneyLike): string | null {
  if (!prior) return null;
  const bike = String(prior.label ?? "").trim();
  const seller = String(prior.soldByName ?? "").trim();
  const when = formatSoldOn(prior.soldAt);
  const parts: string[] = [];
  parts.push(bike ? `Bought ${bike}` : "Bought from us");
  if (when) parts.push(`on ${when}`);
  if (seller) parts.push(`from ${seller}`);
  let out = parts.join(" ");
  const count = typeof prior.messageCount === "number" ? prior.messageCount : 0;
  if (count > 0) out += ` — ${count} earlier message${count === 1 ? "" : "s"} on their previous thread`;
  return out;
}

/** A sale date as a human would say it. Returns "" when the stored value is unusable. */
export function formatSoldOn(soldAt: string | null | undefined): string {
  const ms = Date.parse(String(soldAt ?? ""));
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
