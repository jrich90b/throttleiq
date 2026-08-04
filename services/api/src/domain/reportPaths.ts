/**
 * ONE convention for "where does a report go" — because the fallback was silently wrong.
 *
 * WHY (Joe, 2026-08-04, "is this happening anywhere else?"). Every report picked its own env var
 * and its own default, and the default was CWD-RELATIVE. The live API's `process.cwd()` is
 * `services/api`, not the repo root and certainly not `REPORT_ROOT` — so any writer that fell back
 * to the default filed its output into the code tree, where no routine, digest, or human ever
 * looks. It fails SILENTLY: the directory is created, the write succeeds, the data is simply
 * invisible.
 *
 * What that cost, measured on the box the day it was found:
 *   - `email_lane_judge` — the ADF-lane draft judge HELD Michael Lococo's fabricated
 *     "$25,999-$44,999 / $560-$1,020/mo" draft at 2026-08-03T20:58Z, sixteen hours before Joe
 *     reported the same draft by hand. The verdict was correct, on time, and unreadable.
 *   - `compliance` — a compliance send audit running daily with NO readable copy anywhere.
 *   - `soft_visit_miss`, `stale_handoff`, `intent_handled` — fresh runs landing out of sight while
 *     the digest read copies up to five weeks old.
 *
 * THE ROOT CAUSE IS TWO-SIDED and both sides need the fix:
 *   1. the code defaulted to cwd instead of consulting `REPORT_ROOT` (this module), and
 *   2. `REPORT_ROOT` was never set in the API's own environment — only on individual cron lines —
 *      so the long-running process had nothing better to fall back to (api.env, ops side).
 *
 * RESOLUTION ORDER, and why:
 *   1. the report's own legacy env var, when one exists — cron lines already set these by name and
 *      silently repointing them would move files the schedulers depend on;
 *   2. `REPORT_ROOT/<name>` — the convention every batch report already follows;
 *   3. `cwd/reports/<name>` — last resort, and it now WARNS, because reaching here is the bug.
 *
 * FAIL DIRECTION: never throw. A report path is not worth taking down the inbound path for; the
 * worst case stays "a log line lands somewhere odd", which is exactly today's behaviour minus the
 * silence.
 */
import path from "node:path";

/** True when the process was told where reports live. */
export function reportRootConfigured(): boolean {
  return !!String(process.env.REPORT_ROOT ?? "").trim();
}

let warned = false;

/**
 * Warn ONCE per process that reports are going somewhere nobody reads. Once, not per write: this
 * fires from inside hot paths, and a per-record warning would bury the log it is trying to save.
 */
export function warnReportRootUnset(name: string, resolved: string): void {
  if (warned) return;
  warned = true;
  console.warn(
    "[report-paths] REPORT_ROOT is not set — writing reports under the process CWD, where nothing reads them.",
    { example: name, resolvedTo: resolved, fix: "set REPORT_ROOT in the runtime env (api.env)" }
  );
}

/** Test seam: the warn-once latch is per-process, so an eval covering both branches must reset it. */
export function resetReportRootWarningForTests(): void {
  warned = false;
}

/**
 * The directory this report should write into.
 *
 * @param name        report directory name, e.g. "email_lane_judge"
 * @param legacyEnvVar optional per-report override that already exists in cron lines
 */
export function resolveReportDir(name: string, legacyEnvVar?: string): string {
  const legacy = legacyEnvVar ? String(process.env[legacyEnvVar] ?? "").trim() : "";
  if (legacy) return legacy;

  const root = String(process.env.REPORT_ROOT ?? "").trim();
  if (root) return path.join(root, name);

  const fallback = path.resolve(process.cwd(), "reports", name);
  warnReportRootUnset(name, fallback);
  return fallback;
}
