/**
 * How long a customer has been waiting, in words, for the "Awaiting your reply" tooltip.
 *
 * Split out of the card so it can be EXECUTED by an eval — the badge's whole job is to tell Joe how
 * stale a waiting customer is, and "12 hours" rendering as "720 minutes" would bury exactly the
 * rows that matter most.
 *
 * The age can legitimately be unknown (an undatable message row still flags — the flag is the
 * point, only the clock is missing), and then this returns "" so the tooltip reads as a plain
 * sentence with no dangling dash.
 */
export function formatAwaitingFor(ageMinutes: number | null | undefined): string {
  if (typeof ageMinutes !== "number" || !Number.isFinite(ageMinutes) || ageMinutes < 0) return "";
  if (ageMinutes < 60) {
    const m = Math.max(1, Math.round(ageMinutes));
    return `Waiting ${m} min — `;
  }
  const hours = ageMinutes / 60;
  if (hours < 48) {
    const h = Math.round(hours);
    return `Waiting ${h} hour${h === 1 ? "" : "s"} — `;
  }
  const days = Math.round(hours / 24);
  return `Waiting ${days} day${days === 1 ? "" : "s"} — `;
}
