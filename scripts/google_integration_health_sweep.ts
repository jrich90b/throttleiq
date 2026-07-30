/**
 * Google integration health sweep — folds calendar / support-mail / personal-mail credential expiry
 * into the unified anomaly feed.
 *
 * Google connections aren't conversations, so (like watch_fire_miss / mdf_portal_health) this is a
 * SIBLING sweep: it reads only the token files' METADATA, runs findGoogleIntegrationFailures, and writes
 * OutcomeAnomaly entries with synthetic `google:<name>` ids that anomaly_loop_detect merges into
 * reports/anomaly_loop/next.json. Deterministic, read-only, NO network and no token values are read or
 * logged — only `refresh_token_expires_in` (a duration) and the file mtime (when consent happened).
 *
 * It exists because both Gmail pollers sat dead for ~8 weeks while logging one warn line every 5
 * minutes and creating nothing a human would ever see.
 *
 * NOTE the calendar token path is deliberately different: googleCalendar.ts resolves it RELATIVE TO THE
 * SOURCE FILE (services/api/data/google_tokens.json), not via dataPath() like the two mail tokens. This
 * sweep mirrors that quirk exactly rather than "fixing" it here, so what it reports is what the server
 * actually loads. (Deploy rsync --delete is scoped to services/api/dist/, so that file is untidy but
 * not at risk.)
 *
 * Run (on the box, before anomaly_loop_detect):
 *   CONVERSATIONS_DB_PATH=.../data/conversations.json REPORT_ROOT=.../reports npm run google_integration_health_sweep
 */
import fs from "node:fs";
import path from "node:path";

const dbPath = path.resolve(process.env.CONVERSATIONS_DB_PATH || "data/conversations.json");
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.dirname(dbPath);
const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

type Probe = { consentAtMs: number | null; refreshTokenExpiresInSec: number | null; tokenPresent: boolean };

/** Reads ONLY metadata: the file's mtime and the refresh-token lifetime. Never a token value. */
function readTokenMeta(file: string): Probe {
  try {
    const stat = fs.statSync(file);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const ttl = Number(raw?.refresh_token_expires_in);
    return {
      tokenPresent: true,
      consentAtMs: stat.mtimeMs,
      refreshTokenExpiresInSec: Number.isFinite(ttl) && ttl > 0 ? ttl : null
    };
  } catch {
    return { tokenPresent: false, consentAtMs: null, refreshTokenExpiresInSec: null };
  }
}

// Mirror googleCalendar.ts's own path resolution, quirk included.
const CALENDAR_TOKEN =
  process.env.GOOGLE_TOKEN_PATH || path.join(repoRoot, "services/api/data/google_tokens.json");
const SUPPORT_TOKEN =
  process.env.GOOGLE_SUPPORT_MAIL_TOKEN_PATH || path.join(dataDir, "google_support_mail_tokens.json");
const PERSONAL_TOKEN =
  process.env.GOOGLE_PERSONAL_MAIL_TOKEN_PATH || path.join(dataDir, "google_personal_mail_tokens.json");

const { findGoogleIntegrationFailures } = await import(
  "../services/api/src/domain/googleIntegrationHealth.ts"
);

const specs = [
  { name: "calendar" as const, label: "Google Calendar (appointment booking + free/busy)", file: CALENDAR_TOKEN },
  { name: "support_mail" as const, label: "Support mailbox poller", file: SUPPORT_TOKEN },
  { name: "personal_mail" as const, label: "Personal mailbox poller", file: PERSONAL_TOKEN }
];

const connections = specs.map(s => ({ name: s.name, label: s.label, ...readTokenMeta(s.file) }));

const anomalies = findGoogleIntegrationFailures({
  connections,
  warnDays: Number(process.env.GOOGLE_HEALTH_WARN_DAYS ?? 2)
});

const reportRoot = process.env.REPORT_ROOT || path.resolve("reports");
const outDir = path.join(reportRoot, "google_health");
fs.mkdirSync(outDir, { recursive: true });

// The report lists EVERY connection, healthy or not — the audit trail that made this findable at all.
const statuses = specs.map((s, i) => {
  const c = connections[i];
  const ttl = c.refreshTokenExpiresInSec;
  const expiresAt =
    c.consentAtMs && ttl ? new Date(c.consentAtMs + ttl * 1000).toISOString() : null;
  return {
    name: s.name,
    label: s.label,
    tokenPath: s.file,
    tokenPresent: c.tokenPresent,
    consentAt: c.consentAtMs ? new Date(c.consentAtMs).toISOString() : null,
    refreshTokenTtlDays: ttl ? Math.round(ttl / 86_400) : null,
    expiresAt
  };
});

fs.writeFileSync(
  path.join(outDir, "latest.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      summary: { connections: statuses.length, problems: anomalies.length },
      statuses,
      anomalies
    },
    null,
    2
  )
);

console.log(
  `Google integration health sweep — ${statuses.length} connection(s), ${anomalies.length} problem(s)`
);
for (const s of statuses) {
  console.log(
    `   ${s.tokenPresent ? "•" : "!"} ${s.name}: consent=${s.consentAt?.slice(0, 10) ?? "n/a"} ttl=${s.refreshTokenTtlDays ?? "n/a"}d expires=${s.expiresAt ?? "n/a"}`
  );
}
for (const a of anomalies) console.log(`   - [${a.severity}] ${a.dimension} ${a.convId} | ${a.detail}`);
console.log(`\nFeed written: ${path.join(outDir, "latest.json")}`);
