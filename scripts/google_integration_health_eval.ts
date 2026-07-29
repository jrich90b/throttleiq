/**
 * Google integration health eval.
 *
 * Pins findGoogleIntegrationFailures (domain/googleIntegrationHealth.ts) plus the classifier route.
 *
 * THE BUG THIS GUARDS AGAINST is silence, not a wrong answer: both Gmail pollers were dead for ~8 weeks
 * (last mail-derived task 2026-06-02) while logging one warn line every 5 minutes and surfacing nothing.
 * The calendar was 18 hours from the same fate and nobody could have known. So the cases below are
 * weighted toward "does a dead/dying connection actually surface", and one case pins the opposite guard:
 * a healthy connection must NOT produce a daily false alarm, or the signal gets trained away.
 *
 * Deterministic; fixed clock; no network, no credentials, no token values.
 */
import assert from "node:assert/strict";

const { findGoogleIntegrationFailures, TESTING_STATUS_REFRESH_TTL_SEC } = await import(
  "../services/api/src/domain/googleIntegrationHealth.ts"
);
const { classifyOutcomeAnomaly } = await import("../services/api/src/domain/anomalyClassifier.ts");

const NOW = Date.parse("2026-07-29T23:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const SEVEN_DAY_TTL = 604_799; // exactly what production stores (Google "Testing" status)

assert.equal(TESTING_STATUS_REFRESH_TTL_SEC, 604_800, "the documented 7-day testing TTL constant");

const conn = (over: Record<string, unknown> = {}) => ({
  name: "support_mail" as const,
  label: "Support mailbox poller",
  tokenPresent: true,
  consentAtMs: NOW - 1 * DAY,
  refreshTokenExpiresInSec: SEVEN_DAY_TTL,
  ...over
});

const run = (connections: any[], warnDays?: number) =>
  findGoogleIntegrationFailures({ connections, now: NOW, warnDays });

let checks = 0;
const eq = (got: unknown, exp: unknown, m: string) => {
  assert.deepEqual(got, exp, m);
  checks++;
};

// ── (1) THE PRODUCTION CASE: mail consented 2026-05-20 with a 7-day token = dead ~8 weeks. ──
{
  const found = run([conn({ consentAtMs: Date.parse("2026-05-20T10:58:59.000Z") })]);
  eq(found.length, 1, "a long-expired mail connection surfaces");
  eq(found[0].dimension, "google_integration_expired", "it reads as EXPIRED");
  eq(found[0].severity, "P2", "a dead mailbox is P2 — no customer impact (internal admin mail only)");
  eq(found[0].convId, "google:support_mail", "carries a synthetic google:<name> id for the sibling feed");
  assert.ok(/expired \d+d ago/.test(found[0].detail), "says how long it has been dead");
  assert.ok(/silently/i.test(found[0].detail), "names the silent-failure mode");
  assert.ok(/Testing/.test(found[0].detail), "names the 7-day/Testing-status ROOT CAUSE, not just the symptom");
  assert.ok(/publish/i.test(found[0].detail), "points at the permanent fix");
  checks += 4;
}

// ── (2) THE CALENDAR CASE: healthy but ~18h from expiry — must warn BEFORE it breaks. ──
{
  const calendar = {
    name: "calendar" as const,
    label: "Google Calendar (appointment booking + free/busy)",
    tokenPresent: true,
    consentAtMs: Date.parse("2026-07-23T16:41:36.000Z"),
    refreshTokenExpiresInSec: SEVEN_DAY_TTL
  };
  const found = run([calendar]);
  eq(found.length, 1, "an about-to-expire calendar surfaces BEFORE it fails");
  eq(found[0].dimension, "google_integration_expiring", "it reads as EXPIRING, not yet expired");
  eq(found[0].severity, "P1", "the calendar is P1 — it backs appointment booking and free/busy");
  assert.ok(/expires in ~\d+h/.test(found[0].detail), "quantifies the runway in hours");
  checks++;
}

// ── (3) NO FALSE ALARMS: a freshly-consented connection is silent. ──
{
  eq(run([conn({ consentAtMs: NOW - 1 * DAY })]).length, 0, "1 day into a 7-day token → no alarm");
  eq(run([conn({ consentAtMs: NOW - 4 * DAY })]).length, 0, "4 days in, outside the 2-day warn window → no alarm");
  // Exactly at the warn boundary it DOES fire (5 days in on a 7-day token = 2 days left).
  eq(run([conn({ consentAtMs: NOW - 5 * DAY })]).length, 1, "inside the warn window → fires");
  // A long-lived token (published app: no refresh_token_expires_in) never fires on arithmetic.
  eq(
    run([conn({ refreshTokenExpiresInSec: null, consentAtMs: NOW - 300 * DAY })]).length,
    0,
    "a LONG-LIVED token (published OAuth app) never trips the expiry math, however old"
  );
  // Unknown metadata must not invent a problem (a daily false alarm trains the signal away).
  eq(run([conn({ consentAtMs: null })]).length, 0, "unknown consent time → no invented anomaly");
  eq(run([conn({ refreshTokenExpiresInSec: 0 })]).length, 0, "a zero/absent TTL → no invented anomaly");
}

// ── (4) A live probe failure is HARD evidence and overrides healthy-looking arithmetic. ──
{
  const found = run([conn({ consentAtMs: NOW - 1 * DAY, probeOk: false, probeReason: "invalid_grant" })]);
  eq(found.length, 1, "a failed probe surfaces even when the arithmetic looks fine");
  eq(found[0].dimension, "google_integration_expired", "a rejected credential is EXPIRED");
  assert.ok(/invalid_grant/.test(found[0].detail), "carries Google's reason through to the work order");
  checks++;
  // probeOk true/absent must not suppress a genuine expiry.
  eq(
    run([conn({ consentAtMs: Date.parse("2026-05-20T10:58:59.000Z"), probeOk: true })])[0].dimension,
    "google_integration_expired",
    "a stale 'probe ok' does not mask an expired refresh token"
  );
}

// ── (5) A missing token file is 'never connected', still visible. ──
{
  const found = run([conn({ tokenPresent: false, consentAtMs: null, refreshTokenExpiresInSec: null })]);
  eq(found.length, 1, "a missing token file surfaces");
  eq(found[0].dimension, "google_integration_disconnected", "it reads as DISCONNECTED");
  assert.ok(/never been connected/.test(found[0].detail), "explains it was never connected");
  checks++;
}

// ── (6) Unknown connection names are ignored; all three real ones are supported. ──
{
  eq(run([conn({ name: "gmail_other" as any })]).length, 0, "an unknown connection name is ignored");
  const all = run([
    conn({ name: "calendar", consentAtMs: NOW - 30 * DAY }),
    conn({ name: "support_mail", consentAtMs: NOW - 30 * DAY }),
    conn({ name: "personal_mail", consentAtMs: NOW - 30 * DAY })
  ]);
  eq(all.length, 3, "all three connections are checked independently");
  eq(all.map(a => a.severity).sort().join(","), "P1,P2,P2", "only the calendar is P1");
  eq(run([]).length, 0, "no connections → no anomalies (never crashes the loop)");
}

// ── (7) CLASSIFIER: always Tier 2 escalate, never auto-merge (re-consent needs a human). ──
{
  for (const dimension of [
    "google_integration_expired",
    "google_integration_expiring",
    "google_integration_disconnected"
  ]) {
    const verdict = classifyOutcomeAnomaly(
      { dimension, category: "state", severity: "P1", healed: false } as any,
      {} as any
    );
    eq(verdict.tier, 2, `${dimension} is Tier 2`);
    eq(verdict.autoMergeEligible, false, `${dimension} is NEVER auto-merge-eligible`);
    eq(verdict.action, "escalate", `${dimension} escalates`);
    eq(verdict.notify, true, `${dimension} notifies`);
    assert.ok(/re-consent|publish/i.test(verdict.rationale), `${dimension} rationale names the real fix`);
    checks++;
  }
}

console.log(`google_integration_health:eval PASS (${checks} checks)`);
