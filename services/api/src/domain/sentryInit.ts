import "dotenv/config";
import * as Sentry from "@sentry/node";

const SENTRY_DSN = String(process.env.SENTRY_DSN ?? "").trim();
const SENTRY_ENABLED = !!SENTRY_DSN && String(process.env.SENTRY_ENABLED ?? "1") !== "0";

let sentryInitialized = false;

export function initializeSentry() {
  if (!SENTRY_ENABLED || sentryInitialized) return;
  sentryInitialized = true;
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
    release: process.env.SENTRY_RELEASE || undefined,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0"),
    sendDefaultPii: String(process.env.SENTRY_SEND_DEFAULT_PII ?? "0") === "1"
  });
}

export function isSentryEnabled() {
  return SENTRY_ENABLED;
}

initializeSentry();
