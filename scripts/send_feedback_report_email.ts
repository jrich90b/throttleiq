import { config as dotenvConfig } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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

function buildZip(zipPath: string, files: string[]): string | null {
  const existing = Array.from(
    new Set(files.map(f => String(f || "").trim()).filter(Boolean).filter(f => fs.existsSync(f)))
  );
  if (!existing.length) return null;
  try {
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    const result = spawnSync("zip", ["-j", "-q", zipPath, ...existing], {
      stdio: "pipe",
      encoding: "utf8"
    });
    if (result.status !== 0) {
      const stderr = String(result.stderr || "").trim();
      const stdout = String(result.stdout || "").trim();
      console.warn(`Zip attachment build failed: ${stderr || stdout || `exit ${result.status}`}`);
      return null;
    }
    if (!fs.existsSync(zipPath)) return null;
    return zipPath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Zip attachment build failed: ${message}`);
    return null;
  }
}

function fmtCountRows(rows: AnyObj[] | undefined, key: string, valueKey = "count"): string {
  const arr = Array.isArray(rows) ? rows : [];
  if (!arr.length) return "none";
  return arr
    .map(r => `${r?.[key] ?? "unknown"}=${r?.[valueKey] ?? 0}`)
    .join(", ");
}

function num(input: unknown, fallback = 0): number {
  const n = Number(input);
  return Number.isFinite(n) ? n : fallback;
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
  const toneOutDir =
    process.env.TONE_QUALITY_OUT_DIR ||
    path.resolve(path.dirname(outDir), "tone_quality");
  const voiceOutDir =
    process.env.VOICE_FEEDBACK_OUT_DIR ||
    path.resolve(path.dirname(outDir), "voice_feedback");
  const toneSummaryPath = path.join(toneOutDir, "tone_quality_summary.json");
  const toneFailuresPath = path.join(toneOutDir, "tone_quality_failures.json");
  const voiceSummaryPath = path.join(voiceOutDir, "voice_feedback_summary.json");
  const voiceRowsPath = path.join(voiceOutDir, "voice_feedback_rows.json");
  const outcomeQaOutDir =
    process.env.OUTCOME_QA_OUT_DIR ||
    path.resolve(path.dirname(outDir), "outcome_qa");
  const outcomeQaJsonPath =
    String(process.env.FEEDBACK_REPORT_OUTCOME_QA_PATH ?? "").trim() ||
    path.join(outcomeQaOutDir, "outcome_qa_report.json");
  const outcomeQaMdPath = path.join(path.dirname(outcomeQaJsonPath), "outcome_qa_report.md");
  const vehicleWatchQaOutDir =
    process.env.VEHICLE_WATCH_QA_OUT_DIR ||
    path.resolve(path.dirname(outDir), "vehicle_watch_qa");
  const vehicleWatchQaJsonPath =
    String(process.env.FEEDBACK_REPORT_VEHICLE_WATCH_QA_PATH ?? "").trim() ||
    path.join(vehicleWatchQaOutDir, "vehicle_watch_catalog_report.json");
  const vehicleWatchQaMdPath = path.join(path.dirname(vehicleWatchQaJsonPath), "vehicle_watch_catalog_report.md");
  const agentManagerOutDir =
    process.env.AGENT_MANAGER_OUT_DIR ||
    path.resolve(path.dirname(outDir), "agent_manager");
  const agentManagerJsonPath = path.join(agentManagerOutDir, "agent_manager_report.json");
  const agentManagerMdPath = path.join(agentManagerOutDir, "agent_manager_report.md");
  const followupTaskAuditPath = String(process.env.FEEDBACK_REPORT_FOLLOWUP_TASK_AUDIT_PATH ?? "").trim();

  const summary = readJson(summaryPath);
  if (!summary) {
    console.error(`Summary not found or invalid JSON: ${summaryPath}`);
    process.exit(1);
  }
  const summarySinceHours = Number(summary.sinceHours ?? summary?.source?.sinceHours);
  const summaryWindowStart = String(summary.windowStart ?? summary?.source?.windowStart ?? "").trim();
  const toneSummary = readJson(toneSummaryPath);
  const voiceSummary = readJson(voiceSummaryPath);
  const outcomeQaSummary = readJson(outcomeQaJsonPath);
  const vehicleWatchQaSummary = readJson(vehicleWatchQaJsonPath);
  const agentManagerSummary = readJson(agentManagerJsonPath);
  const followupTaskAudit = followupTaskAuditPath ? readJson(followupTaskAuditPath) : null;

  const auditPath = String(process.env.FEEDBACK_REPORT_AUDIT_PATH ?? "").trim();
  const mineLogPath = String(process.env.FEEDBACK_REPORT_MINE_LOG_PATH ?? "").trim();
  const attachFull = String(process.env.FEEDBACK_REPORT_ATTACH_FULL ?? "0") === "1";
  const attachZip = String(process.env.FEEDBACK_REPORT_ATTACH_ZIP ?? "0") === "1";
  const zipOnly = String(process.env.FEEDBACK_REPORT_ZIP_ONLY ?? "0") === "1";
  const zipName = String(process.env.FEEDBACK_REPORT_ZIP_NAME ?? "").trim();
  const ts = String(summary.generatedAt ?? new Date().toISOString());
  const prefix = String(process.env.FEEDBACK_REPORT_SUBJECT_PREFIX ?? "[ThrottleIQ Feedback Loop]");
  const subject = `${prefix} ${ts}`;

  const text = [
    `Feedback loop completed: ${ts}`,
    "",
    `Snapshot window: ${
      Number.isFinite(summarySinceHours) && summarySinceHours > 0 && summaryWindowStart
        ? `last ${summarySinceHours}h (since ${summaryWindowStart})`
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
    `Tone eval: ${
      toneSummary
        ? `avg=${num(toneSummary.avgScore).toFixed(2)} median=${num(toneSummary.medianScore).toFixed(2)} passRate=${num(
            toneSummary.passRate
          ).toFixed(2)}%`
        : "not available"
    }`,
    `Tone volume: ${
      toneSummary
        ? `inbound=${num(toneSummary.totalInboundTurns)} responded=${num(toneSummary.respondedTurns)} missing=${num(
            toneSummary.missingResponseCount
          )}`
        : "not available"
    }`,
    `Tone issues: ${toneSummary ? fmtCountRows(toneSummary.issueCounts, "issue") : "none"}`,
    "",
    `Voice turns: ${
      voiceSummary
        ? `total=${num(voiceSummary.totalVoiceTranscripts)} with_summary=${num(
            voiceSummary.withVoiceSummary
          )} with_customer_outbound=${num(voiceSummary.withCustomerFacingOutbound)}`
        : "not available"
    }`,
    `Voice outbound providers: ${
      voiceSummary ? fmtCountRows(voiceSummary.outboundProviderStats, "provider") : "none"
    }`,
    "",
    `Outcome QA: ${
      outcomeQaSummary
        ? `outcomes=${num(outcomeQaSummary?.summary?.outcomeCount)} findings=${num(
            outcomeQaSummary?.summary?.findingCount
          )} parser_seeds=${num(outcomeQaSummary?.summary?.parserSeedCandidateCount)}`
        : "not available"
    }`,
    `Outcome QA issues: ${
      outcomeQaSummary ? fmtCountRows(outcomeQaSummary?.summary?.findingsByIssue, "issue") : "none"
    }`,
    "",
    `Vehicle watch QA: ${
      vehicleWatchQaSummary
        ? `status=${vehicleWatchQaSummary.ok ? "ok" : "needs_review"} checks=${num(
            vehicleWatchQaSummary?.summary?.checkCount
          )} findings=${num(vehicleWatchQaSummary?.summary?.failureCount)} 2026_models=${num(
            vehicleWatchQaSummary?.summary?.configured2026ModelCount
          )}/${num(vehicleWatchQaSummary?.summary?.official2026ModelCount)} alias_bridges=${num(
            vehicleWatchQaSummary?.summary?.aliasBridgeCount
          )} family_aliases=${num(vehicleWatchQaSummary?.summary?.familyAliasCount)}`
        : "not available"
    }`,
    `Vehicle watch runtime: ${
      vehicleWatchQaSummary?.runtimeWatch
        ? `watch_conversations=${num(vehicleWatchQaSummary.runtimeWatch.watchConversations)} active_watches=${num(
            vehicleWatchQaSummary.runtimeWatch.activeWatchCount
          )} prompted=${num(vehicleWatchQaSummary.runtimeWatch.promptedWatchCount)} findings=${num(
            vehicleWatchQaSummary.runtimeWatch.findingCount
          )}`
        : "not available"
    }`,
    `Vehicle watch findings: ${
      Array.isArray(vehicleWatchQaSummary?.findings) && vehicleWatchQaSummary.findings.length
        ? vehicleWatchQaSummary.findings
            .slice(0, 5)
            .map((finding: AnyObj) => finding.message ?? "unknown")
            .join("; ")
        : Array.isArray(vehicleWatchQaSummary?.runtimeWatch?.findings) &&
            vehicleWatchQaSummary.runtimeWatch.findings.length
          ? vehicleWatchQaSummary.runtimeWatch.findings
              .slice(0, 5)
              .map((finding: AnyObj) => `${finding.issue ?? "runtime_watch"}: ${finding.message ?? "unknown"}`)
              .join("; ")
        : "none"
    }`,
    "",
    `Agent manager: ${
      agentManagerSummary
        ? `status=${agentManagerSummary.status ?? "unknown"} tasks=${Array.isArray(agentManagerSummary.tasks) ? agentManagerSummary.tasks.length : 0}`
        : "not available"
    }`,
    `Agent manager top tasks: ${
      Array.isArray(agentManagerSummary?.tasks) && agentManagerSummary.tasks.length
        ? agentManagerSummary.tasks
            .slice(0, 5)
            .map((task: AnyObj) => `${task.priority ?? "P?"} ${task.title ?? "Untitled"}`)
            .join("; ")
        : "none"
    }`,
    `Follow-up/task consistency: ${
      followupTaskAudit
        ? `flagged=${num(followupTaskAudit?.summary?.flaggedConversations)} issues=${fmtCountRows(
            followupTaskAudit?.summary?.issueCounts,
            "issue"
          )}`
        : "not available"
    }`,
    "",
    `Output directory: ${outDir}`
  ].join("\n");

  const attachments: Array<{
    content: string;
    filename: string;
    type?: string;
    disposition?: "attachment" | "inline";
  }> = [];

  const maybeAttach = (filePath: string, filename: string, type = "application/json") => {
    const content = fileBase64(filePath);
    if (!content) return;
    attachments.push({
      content,
      filename,
      type,
      disposition: "attachment"
    });
  };

  if (!zipOnly) {
    maybeAttach(summaryPath, "edit_feedback_summary.json");
    maybeAttach(resultsPath, "edit_replay_fixture_results.json");
    maybeAttach(toneSummaryPath, "tone_quality_summary.json");
    maybeAttach(toneFailuresPath, "tone_quality_failures.json");
    maybeAttach(voiceSummaryPath, "voice_feedback_summary.json");
    maybeAttach(voiceRowsPath, "voice_feedback_rows.json");
    maybeAttach(outcomeQaJsonPath, "outcome_qa_report.json");
    maybeAttach(outcomeQaMdPath, "outcome_qa_report.md", "text/markdown");
    maybeAttach(vehicleWatchQaJsonPath, "vehicle_watch_catalog_report.json");
    maybeAttach(vehicleWatchQaMdPath, "vehicle_watch_catalog_report.md", "text/markdown");
    maybeAttach(agentManagerJsonPath, "agent_manager_report.json");
    maybeAttach(agentManagerMdPath, "agent_manager_report.md", "text/markdown");
    if (followupTaskAuditPath) maybeAttach(followupTaskAuditPath, path.basename(followupTaskAuditPath));
    if (attachFull) {
      maybeAttach(fixturesPath, "edit_replay_fixtures.json");
      maybeAttach(labeledPath, "edit_feedback_labeled.json");
    }
    if (auditPath) maybeAttach(auditPath, path.basename(auditPath));
    if (mineLogPath) maybeAttach(mineLogPath, path.basename(mineLogPath));
  }

  if (attachZip || zipOnly) {
    const zipTs = ts.replace(/[^0-9A-Za-z]/g, "").slice(0, 16);
    const finalZipName = zipName || `feedback_report_${zipTs || "bundle"}.zip`;
    const zipPath = path.join(outDir, finalZipName);
    const zipFiles = [
      summaryPath,
      resultsPath,
      toneSummaryPath,
      toneFailuresPath,
      voiceSummaryPath,
      voiceRowsPath,
      outcomeQaJsonPath,
      outcomeQaMdPath,
      vehicleWatchQaJsonPath,
      vehicleWatchQaMdPath,
      agentManagerJsonPath,
      agentManagerMdPath,
      ...(followupTaskAuditPath ? [followupTaskAuditPath] : []),
      ...(attachFull ? [fixturesPath, labeledPath] : []),
      ...(auditPath ? [auditPath] : []),
      ...(mineLogPath ? [mineLogPath] : [])
    ];
    const builtZip = buildZip(zipPath, zipFiles);
    if (builtZip) {
      maybeAttach(builtZip, path.basename(builtZip), "application/zip");
    }
  }

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
