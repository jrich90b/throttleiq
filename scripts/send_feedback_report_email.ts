import { config as dotenvConfig } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { sendEmail } from "../services/api/src/domain/emailSender.ts";

type AnyObj = Record<string, any>;

function readJson(filePath: string): AnyObj | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function fileBase64(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath).toString("base64");
}

function fmtCountRows(rows: AnyObj[] | undefined, key: string, valueKey = "count"): string {
  const arr = Array.isArray(rows) ? rows : [];
  if (!arr.length) return "none";
  return arr
    .map(r => `${r?.[key] ?? "unknown"}=${r?.[valueKey] ?? 0}`)
    .join(", ");
}

async function run() {
  // Mirror API startup behavior: load .env automatically.
  dotenvConfig();
  const feedbackLoopEnvPath = String(
    process.env.FEEDBACK_LOOP_ENV_PATH || "/home/ubuntu/throttleiq-runtime/.feedback_loop.env"
  ).trim();
  if (feedbackLoopEnvPath && fs.existsSync(feedbackLoopEnvPath)) {
    // Feedback-loop env should take precedence over base .env
    // so each dealer/runtime can use its own report email settings.
    dotenvConfig({ path: feedbackLoopEnvPath, override: true });
  }

  const cwd = process.cwd();
  const outDir =
    process.env.EDIT_FEEDBACK_OUT_DIR ||
    path.resolve(cwd, "scripts", "generated");
  const to = String(process.env.FEEDBACK_REPORT_EMAIL_TO ?? "").trim();
  const from = String(
    process.env.FEEDBACK_REPORT_EMAIL_FROM ||
      process.env.NOTIFICATION_FROM_EMAIL ||
      ""
  ).trim();

  if (!to) {
    console.error("Missing FEEDBACK_REPORT_EMAIL_TO");
    process.exit(1);
  }
  if (!from) {
    console.error("Missing FEEDBACK_REPORT_EMAIL_FROM (or NOTIFICATION_FROM_EMAIL)");
    process.exit(1);
  }

  const summaryPath = path.join(outDir, "edit_feedback_summary.json");
  const resultsPath = path.join(outDir, "edit_replay_fixture_results.json");
  const fixturesPath = path.join(outDir, "edit_replay_fixtures.json");
  const labeledPath = path.join(outDir, "edit_feedback_labeled.json");

  const summary = readJson(summaryPath);
  if (!summary) {
    console.error(`Summary not found or invalid JSON: ${summaryPath}`);
    process.exit(1);
  }

  const auditPath = String(process.env.FEEDBACK_REPORT_AUDIT_PATH ?? "").trim();
  const mineLogPath = String(process.env.FEEDBACK_REPORT_MINE_LOG_PATH ?? "").trim();
  const attachFull = String(process.env.FEEDBACK_REPORT_ATTACH_FULL ?? "0") === "1";
  const ts = String(summary.generatedAt ?? new Date().toISOString());
  const prefix = String(process.env.FEEDBACK_REPORT_SUBJECT_PREFIX ?? "[ThrottleIQ Feedback Loop]");
  const subject = `${prefix} ${ts}`;

  const text = [
    `Feedback loop completed: ${ts}`,
    "",
    `Snapshot window: ${
      summary.sinceHours && summary.windowStart
        ? `last ${summary.sinceHours}h (since ${summary.windowStart})`
        : "all-time"
    }`,
    "",
    `Changed rows: ${summary.totalChangedRows ?? 0}`,
    `Fixture candidates: ${summary.fixtureCandidates ?? 0}`,
    `Fixture pass/fail: ${summary.fixturePassNow ?? 0}/${summary.fixtureFailNow ?? 0}`,
    "",
    `Labels: ${fmtCountRows(summary.labelCounts, "label")}`,
    `Severity: ${fmtCountRows(summary.severityCounts, "severity")}`,
    "",
    `Output directory: ${outDir}`
  ].join("\n");

  const attachments: Array<{
    content: string;
    filename: string;
    type?: string;
    disposition?: "attachment" | "inline";
  }> = [];

  const maybeAttach = (filePath: string, filename: string) => {
    const content = fileBase64(filePath);
    if (!content) return;
    attachments.push({
      content,
      filename,
      type: "application/json",
      disposition: "attachment"
    });
  };

  maybeAttach(summaryPath, "edit_feedback_summary.json");
  maybeAttach(resultsPath, "edit_replay_fixture_results.json");
  if (attachFull) {
    maybeAttach(fixturesPath, "edit_replay_fixtures.json");
    maybeAttach(labeledPath, "edit_feedback_labeled.json");
  }
  if (auditPath) maybeAttach(auditPath, path.basename(auditPath));
  if (mineLogPath) maybeAttach(mineLogPath, path.basename(mineLogPath));

  await sendEmail({
    to,
    from,
    subject,
    text,
    attachments
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        to,
        subject,
        attachmentCount: attachments.length
      },
      null,
      2
    )
  );
}

run().catch(err => {
  console.error("send_feedback_report_email failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
