/**
 * Google integration health detector (calendar + support mail + personal mail). Pure, deterministic,
 * read-only — no network, no credentials, no token VALUES (only metadata about them).
 *
 * WHY THIS EXISTS (2026-07-29). Both Gmail pollers had been dead for ~8 WEEKS and nothing surfaced it:
 * a failed poll writes one `console.warn` every 5 minutes and creates no task, no digest entry, no
 * anomaly. The last mail-derived task was 2026-06-02. It was found only by reading pm2 logs by hand.
 *
 * ROOT CAUSE, and why this detector is metadata-based rather than probe-based: every stored token
 * carries `refresh_token_expires_in: 604799` (~7 days). Google issues 7-day refresh tokens ONLY while
 * the OAuth app is in "Testing" publishing status — so EVERY Google connection here dies one week after
 * consent, by design. That makes expiry arithmetic (consent time + refresh-token lifetime) a complete
 * and offline-checkable signal: it caught all three connections correctly, including the calendar,
 * which was still working but 18 hours from expiry. A live probe would also work but needs network +
 * credentials on every sweep; this needs neither, so it can run in the loop like any other detector.
 *
 * Folds into the unified anomaly feed as a SIBLING sweep (like watch_fire_miss / mdf_portal_health) with
 * synthetic `google:<name>` ids, and classifies Tier-2 escalate: re-consent + publishing the OAuth app
 * (or moving to a service account with domain-wide delegation) is an ops decision, never an auto-heal.
 *
 * SEVERITY reflects CUSTOMER impact, not tidiness: the calendar backs appointment booking and free/busy,
 * so losing it is P1. The mailboxes only fed internal admin-email triage (their entire history is
 * DMARC reports and Workspace notices), so those are P2.
 */

/** ~7 days in seconds — the refresh-token lifetime Google issues for an app in "Testing" status. */
export const TESTING_STATUS_REFRESH_TTL_SEC = 604_800;

export type GoogleConnectionName = "calendar" | "support_mail" | "personal_mail";

export type GoogleConnectionState = {
  name: GoogleConnectionName;
  /** Human label for the work order. */
  label: string;
  /** Is a token file present at all? */
  tokenPresent: boolean;
  /** When consent last happened (token-file mtime), ms epoch. Null when unknown. */
  consentAtMs?: number | null;
  /** `refresh_token_expires_in` from the stored payload, in SECONDS. Null when absent (long-lived). */
  refreshTokenExpiresInSec?: number | null;
  /**
   * OPTIONAL live probe result, when a caller has one (e.g. the status endpoints). `false` is treated as
   * hard evidence of breakage regardless of the arithmetic; `null`/absent means "not probed".
   */
  probeOk?: boolean | null;
  probeReason?: string | null;
};

export type GoogleHealthAnomaly = {
  convId: string;
  leadKey: string;
  dimension:
    | "google_integration_expired"
    | "google_integration_expiring"
    | "google_integration_disconnected";
  category: "state";
  severity: "P1" | "P2";
  healed: false;
  detail: string;
};

/** Customer-facing blast radius decides severity — the calendar books appointments; mail did not. */
function severityFor(name: GoogleConnectionName): "P1" | "P2" {
  return name === "calendar" ? "P1" : "P2";
}

/** Names the 7-day-refresh-token root cause in the work order so the fix isn't re-diagnosed each time. */
function testingStatusNote(refreshTokenExpiresInSec?: number | null): string {
  const ttl = Number(refreshTokenExpiresInSec ?? 0);
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > TESTING_STATUS_REFRESH_TTL_SEC) return "";
  return (
    ` Refresh token lifetime is only ${Math.round(ttl / 86_400)}d, which means the Google OAuth app is` +
    ` still in "Testing" publishing status — re-consenting buys another ${Math.round(ttl / 86_400)} days.` +
    ` Permanent fix: publish/verify the OAuth app, or move to a service account with domain-wide delegation.`
  );
}

export function findGoogleIntegrationFailures(args: {
  connections: GoogleConnectionState[];
  now?: number;
  /** Warn this many days BEFORE the refresh token dies (default 2). */
  warnDays?: number;
}): GoogleHealthAnomaly[] {
  const now = args.now ?? Date.now();
  const warnMs = Math.max(0, args.warnDays ?? 2) * 24 * 60 * 60 * 1000;
  const out: GoogleHealthAnomaly[] = [];

  for (const c of args.connections ?? []) {
    const name = c?.name;
    if (name !== "calendar" && name !== "support_mail" && name !== "personal_mail") continue;
    const label = String(c.label ?? name);
    const base = {
      convId: `google:${name}`,
      leadKey: `google:${name}`,
      category: "state" as const,
      healed: false as const
    };

    // (a) Never connected / token file missing. Nothing to expire; still must be visible.
    if (!c.tokenPresent) {
      out.push({
        ...base,
        dimension: "google_integration_disconnected",
        severity: severityFor(name),
        detail: `${label}: no Google token stored — the integration has never been connected (or the token was removed). Re-connect via /integrations/google/start.`
      });
      continue;
    }

    // (b) A live probe that FAILED is hard evidence — trust it over the arithmetic.
    if (c.probeOk === false) {
      const why = String(c.probeReason ?? "").trim();
      out.push({
        ...base,
        dimension: "google_integration_expired",
        severity: severityFor(name),
        detail:
          `${label}: Google rejected the stored credentials${why ? ` (${why})` : ""} — this integration is DEAD and silently doing nothing.` +
          testingStatusNote(c.refreshTokenExpiresInSec)
      });
      continue;
    }

    // (c) Expiry arithmetic: consent time + refresh-token lifetime. Skipped when either is unknown —
    // we do not invent a problem we cannot evidence (a daily false alarm would train Joe to ignore it).
    const consentAt = Number(c.consentAtMs ?? NaN);
    const ttlSec = Number(c.refreshTokenExpiresInSec ?? NaN);
    if (!Number.isFinite(consentAt) || !Number.isFinite(ttlSec) || ttlSec <= 0) continue;

    const expiresAt = consentAt + ttlSec * 1000;
    const msLeft = expiresAt - now;

    if (msLeft <= 0) {
      const daysDead = Math.floor(-msLeft / (24 * 60 * 60 * 1000));
      out.push({
        ...base,
        dimension: "google_integration_expired",
        severity: severityFor(name),
        detail:
          `${label}: the refresh token expired ${daysDead}d ago (consent ${new Date(consentAt).toISOString().slice(0, 10)}) — this integration is DEAD and silently doing nothing.` +
          testingStatusNote(ttlSec)
      });
      continue;
    }

    if (msLeft <= warnMs) {
      const hoursLeft = Math.max(1, Math.round(msLeft / (60 * 60 * 1000)));
      out.push({
        ...base,
        dimension: "google_integration_expiring",
        severity: severityFor(name),
        detail:
          `${label}: the refresh token expires in ~${hoursLeft}h (${new Date(expiresAt).toISOString()}) and it will fail SILENTLY. Re-connect before then.` +
          testingStatusNote(ttlSec)
      });
    }
  }

  return out;
}
