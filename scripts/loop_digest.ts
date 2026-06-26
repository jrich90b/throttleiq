/**
 * Loop digest mailer — the "surface" step of the self-healing loop (docs/autonomous_coding_loop.md).
 *
 * DETECT writes reports/anomaly_loop/next.json but nothing read it. This reads that work order, formats it
 * (formatLoopDigest), and EMAILS the operator so findings actually reach a human — the precision review of
 * the cross-model turn-critic + the graduation signal for the tier ladder, until the autonomous ACT runner
 * lands. By default it only emails when there ARE findings (no daily noise when healthy; LOOP_DIGEST_FORCE=1
 * sends an all-clear too).
 *
 * Needs SENDGRID_API_KEY (the cron sources the runtime api.env). Recipient: LOOP_DIGEST_EMAIL (default
 * integrations@leadrider.ai). From: SENDGRID_FROM_EMAIL || support@leadrider.ai. Kill: LOOP_DIGEST_ENABLED=0.
 *
 * Run (on the box):
 *   set -a; . /home/ubuntu/leadrider-runtime/americanharley/api.env; set +a; \
 *   REPORT_ROOT=/home/ubuntu/leadrider-runtime/americanharley/reports DEALER_LABEL=americanharley \
 *   npm run loop_digest
 */
import fs from "node:fs";
import path from "node:path";

const reportRoot = process.env.REPORT_ROOT || path.resolve("reports");
const nextPath = path.join(reportRoot, "anomaly_loop", "next.json");

if (String(process.env.LOOP_DIGEST_ENABLED ?? "1").trim() === "0") {
  console.log("loop_digest disabled (LOOP_DIGEST_ENABLED=0)");
  process.exit(0);
}
if (!fs.existsSync(nextPath)) {
  console.error(`No work order at ${nextPath} — run anomaly_loop_detect first.`);
  process.exit(2);
}

const payload = JSON.parse(fs.readFileSync(nextPath, "utf8"));

const { formatLoopDigest } = await import("../services/api/src/domain/loopDigest.ts");
const digest = formatLoopDigest(payload, { dealer: process.env.DEALER_LABEL || undefined });

const force = String(process.env.LOOP_DIGEST_FORCE ?? "").trim() === "1";
if (!digest.hasContent && !force) {
  console.log(`loop_digest — healthy, nothing to surface (workOrders=${payload.workOrderCount ?? 0}). No email sent.`);
  process.exit(0);
}

const to = (process.env.LOOP_DIGEST_EMAIL || "integrations@leadrider.ai").trim();
const from = (process.env.SENDGRID_FROM_EMAIL || "support@leadrider.ai").trim();

if (!process.env.SENDGRID_API_KEY) {
  // Never hard-fail the loop on a missing key — just surface to the cron log.
  console.log(`loop_digest — SENDGRID_API_KEY not set; would have emailed ${to}:\n\n${digest.subject}\n\n${digest.text}`);
  process.exit(0);
}

const { sendEmail } = await import("../services/api/src/domain/emailSender.ts");
try {
  await sendEmail({ to, from, subject: digest.subject, text: digest.text });
  console.log(`loop_digest — emailed ${to}: "${digest.subject}"`);
} catch (err: any) {
  console.error(`loop_digest — email failed: ${err?.message ?? String(err)}`);
  console.log(`\n${digest.subject}\n\n${digest.text}`);
  process.exit(1);
}
