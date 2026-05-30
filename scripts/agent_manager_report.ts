import fs from "node:fs";
import path from "node:path";

type AnyObj = Record<string, any>;

type ParsedArgs = {
  reportRoot: string;
  outDir: string;
  routeWatchdogPath?: string;
};

type TaskCandidate = {
  id: string;
  priority: "P0" | "P1" | "P2" | "P3";
  area: "routing" | "tone" | "feedback" | "voice" | "growth" | "evals" | "ops";
  title: string;
  signal: string;
  recommendedAction: string;
  evidence: AnyObj;
};

function parseArgs(argv: string[]): ParsedArgs {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) continue;
    args.set(key, value);
    i += 1;
  }

  const cwd = process.cwd();
  const reportRoot = args.get("--report-root") || process.env.REPORT_ROOT || path.resolve(cwd, "reports");
  const outDir =
    args.get("--out-dir") ||
    process.env.AGENT_MANAGER_OUT_DIR ||
    path.join(reportRoot, "agent_manager");
  const routeWatchdogPath = args.get("--route-watchdog") || process.env.AGENT_MANAGER_ROUTE_WATCHDOG_PATH || undefined;

  return { reportRoot, outDir, routeWatchdogPath };
}

function readJson(filePath: string): AnyObj | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function num(input: unknown, fallback = 0): number {
  const n = Number(input);
  return Number.isFinite(n) ? n : fallback;
}

function sumNumberValues(input: unknown): number {
  if (!input || typeof input !== "object") return 0;
  let total = 0;
  for (const value of Object.values(input as Record<string, unknown>)) {
    total += num(value);
  }
  return total;
}

function latestMatchingFile(dir: string, matcher: (name: string) => boolean): string | null {
  if (!fs.existsSync(dir)) return null;
  const rows = fs
    .readdirSync(dir)
    .filter(matcher)
    .map(name => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return { full, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return rows[0]?.full ?? null;
}

function pushTask(tasks: TaskCandidate[], task: TaskCandidate) {
  if (tasks.some(existing => existing.id === task.id)) return;
  tasks.push(task);
}

function priorityRank(priority: TaskCandidate["priority"]): number {
  return { P0: 0, P1: 1, P2: 2, P3: 3 }[priority];
}

function topCounts(rows: any[], key: string, limit = 5): Array<{ value: string; count: number }> {
  if (!Array.isArray(rows)) return [];
  return rows
    .map(row => ({
      value: String(row?.[key] ?? row?.label ?? row?.issue ?? row?.provider ?? "unknown"),
      count: num(row?.count)
    }))
    .filter(row => row.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function markdownReport(report: AnyObj, tasks: TaskCandidate[]): string {
  const lines = [
    `# Agent Manager Report`,
    "",
    `Generated: ${report.generatedAt}`,
    `Status: ${report.status}`,
    "",
    "## Top Tasks",
    ""
  ];

  if (!tasks.length) {
    lines.push("No task candidates crossed the configured thresholds.");
  } else {
    for (const task of tasks.slice(0, 20)) {
      lines.push(`- ${task.priority} [${task.area}] ${task.title}`);
      lines.push(`  - Signal: ${task.signal}`);
      lines.push(`  - Action: ${task.recommendedAction}`);
    }
  }

  lines.push("", "## Metrics", "");
  for (const [key, value] of Object.entries(report.metrics ?? {})) {
    lines.push(`- ${key}: ${JSON.stringify(value)}`);
  }

  return `${lines.join("\n")}\n`;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const editDir = process.env.EDIT_FEEDBACK_OUT_DIR || path.join(parsed.reportRoot, "edit_feedback");
  const languageDir = process.env.LANGUAGE_CORPUS_OUT_DIR || path.join(parsed.reportRoot, "language_corpus");
  const toneDir = process.env.TONE_QUALITY_OUT_DIR || path.join(parsed.reportRoot, "tone_quality");
  const voiceDir = process.env.VOICE_FEEDBACK_OUT_DIR || path.join(parsed.reportRoot, "voice_feedback");
  const feedbackLogDir = path.join(parsed.reportRoot, "feedback_loop_logs");
  const opsAnomaliesPath =
    process.env.OPS_ANOMALIES_PATH ||
    (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "ops_anomalies.json") : path.resolve(process.cwd(), "data", "ops_anomalies.json"));

  const editSummary = readJson(path.join(editDir, "edit_feedback_summary.json"));
  const languageSummary = readJson(path.join(languageDir, "language_corpus_summary.json"));
  const promotionSummary = readJson(path.join(languageDir, "deterministic_rules_promotion_summary.json"));
  const manualPromotionSummary = readJson(path.join(languageDir, "manual_outbound_promotion_summary.json"));
  const toneSummary = readJson(path.join(toneDir, "tone_quality_summary.json"));
  const voiceSummary = readJson(path.join(voiceDir, "voice_feedback_summary.json"));
  const opsAnomaliesRaw = readJson(opsAnomaliesPath);
  const conversationAuditPath =
    latestMatchingFile(feedbackLogDir, name => /^conversation_audit_.*\.json$/i.test(name)) ||
    path.join(parsed.reportRoot, "conversation_audit.json");
  const conversationAudit = readJson(conversationAuditPath);
  const followupTaskAuditPath =
    process.env.FOLLOWUP_TASK_AUDIT_PATH ||
    process.env.FOLLOWUP_TASK_AUDIT_JSON ||
    latestMatchingFile(feedbackLogDir, name => /^followup_task_consistency_.*\.json$/i.test(name)) ||
    path.join(parsed.reportRoot, "followup_task_consistency.json");
  const followupTaskAudit = readJson(followupTaskAuditPath);
  const routeWatchdogPath =
    parsed.routeWatchdogPath ||
    latestMatchingFile(feedbackLogDir, name => /^route_watchdog_.*\.json$/i.test(name)) ||
    path.join(parsed.reportRoot, "route_watchdog.json");
  const routeWatchdog = routeWatchdogPath ? readJson(routeWatchdogPath) : null;

  const tasks: TaskCandidate[] = [];
  const stuckCount = num(routeWatchdog?.stuckTurns?.count);
  const noResponseCount = num(routeWatchdog?.routeOutcomes?.noResponseOutcomeCount);
  const toneTotalInbound = num(toneSummary?.totalInboundTurns);
  const toneTotalResponded = num(toneSummary?.respondedTurns);
  const hasToneData = toneTotalInbound > 0 || toneTotalResponded > 0;
  const tonePassRateResponded = hasToneData
    ? toneSummary?.respondedPassRate != null
      ? num(toneSummary.respondedPassRate, 100)
      : num(toneSummary?.passRate, 100)
    : null;
  const tonePassRateAll = hasToneData ? num(toneSummary?.passRate, 100) : null;
  const toneMissing = hasToneData ? num(toneSummary?.missingResponseCount) : 0;
  const toneAvg = hasToneData ? num(toneSummary?.avgScore, 1) : null;
  const fixtureFailNow = num(editSummary?.fixtureFailNow);
  const negativeSeeds = Array.isArray(languageSummary?.seedExports?.negativeFeedback)
    ? languageSummary.seedExports.negativeFeedback.length
    : num(languageSummary?.negativeFeedbackRows ?? languageSummary?.negativeFeedbackCount);
  const promotedRules =
    num(promotionSummary?.promotedRules ?? promotionSummary?.writtenRules) ||
    sumNumberValues(promotionSummary?.promoted);
  const promotedManualExamples =
    num(manualPromotionSummary?.promotedExamples ?? manualPromotionSummary?.writtenExamples) ||
    sumNumberValues(manualPromotionSummary?.promotedByIntent);
  const voiceWithoutOutbound = Math.max(
    0,
    num(voiceSummary?.totalVoiceTranscripts) - num(voiceSummary?.withCustomerFacingOutbound)
  );
  const auditIssueCounts = Array.isArray(conversationAudit?.summary?.issueCounts)
    ? conversationAudit.summary.issueCounts
    : [];
  const orphanFollowUpCount = auditIssueCounts
    .filter((row: any) => /^orphan_followup_/i.test(String(row?.issue ?? "")))
    .reduce((sum: number, row: any) => sum + num(row?.count), 0);
  const followupTaskFlagged = num(followupTaskAudit?.summary?.flaggedConversations);
  const followupTaskIssueCounts = Array.isArray(followupTaskAudit?.summary?.issueCounts)
    ? followupTaskAudit.summary.issueCounts
    : [];
  const openOpsAnomalies = Array.isArray(opsAnomaliesRaw)
    ? opsAnomaliesRaw.filter((row: any) => String(row?.status ?? "open") === "open")
    : [];
  const recentOpsAnomalies = openOpsAnomalies.filter((row: any) => {
    const createdMs = Date.parse(String(row?.createdAt ?? ""));
    return Number.isFinite(createdMs) && Date.now() - createdMs <= 7 * 24 * 60 * 60 * 1000;
  });
  const opsAnomalyTypeCounts = Array.from(
    recentOpsAnomalies.reduce((acc: Map<string, number>, row: any) => {
      const key = String(row?.type ?? "other") || "other";
      acc.set(key, (acc.get(key) ?? 0) + 1);
      return acc;
    }, new Map<string, number>())
  )
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);

  if (stuckCount > 0) {
    pushTask(tasks, {
      id: "routing-stuck-turns",
      priority: stuckCount >= 5 ? "P0" : "P1",
      area: "routing",
      title: "Review inbound conversations with no outbound response",
      signal: `${stuckCount} stuck turn(s) older than ${routeWatchdog?.stuckTurns?.olderThanSec ?? "threshold"} seconds`,
      recommendedAction:
        "Open the listed conversations, classify why the draft/send path stalled, and add a parser/eval fixture for any repeatable miss.",
      evidence: {
        routeWatchdogPath,
        sample: Array.isArray(routeWatchdog?.stuckTurns?.rows) ? routeWatchdog.stuckTurns.rows.slice(0, 5) : []
      }
    });
  }

  if (orphanFollowUpCount > 0) {
    pushTask(tasks, {
      id: "cadence-orphan-followups",
      priority: orphanFollowUpCount >= 5 ? "P1" : "P2",
      area: "ops",
      title: "Review open conversations with no cadence, watch, appointment, or task",
      signal: `${orphanFollowUpCount} orphan follow-up signal(s) in conversation audit`,
      recommendedAction:
        "Inspect the listed threads. Backfill only true misses; then add a named pipeline hook or task rule for repeated patterns.",
      evidence: {
        conversationAuditPath,
        issueCounts: auditIssueCounts.filter((row: any) => /^orphan_followup_/i.test(String(row?.issue ?? ""))),
        sample: Array.isArray(conversationAudit?.flagged)
          ? conversationAudit.flagged
              .filter((row: any) =>
                Array.isArray(row?.issues) &&
                row.issues.some((issue: string) => /^orphan_followup_/i.test(String(issue)))
              )
              .slice(0, 10)
          : []
      }
    });
  }

  if (followupTaskFlagged > 0) {
    const highRiskIssues = new Set([
      "duplicate_open_todos_same_class",
      "duplicate_open_todos_same_summary",
      "active_cadence_with_open_followup_todo",
      "active_cadence_with_open_staff_followup_todo",
      "stale_cadence_generated_followup_todo",
      "active_cadence_with_dealer_ride_outcome_task",
      "manual_or_hold_mode_with_active_customer_cadence"
    ]);
    const highRiskCount = followupTaskIssueCounts
      .filter((row: any) => highRiskIssues.has(String(row?.issue ?? "")))
      .reduce((sum: number, row: any) => sum + num(row?.count), 0);
    pushTask(tasks, {
      id: "followup-task-consistency",
      priority: highRiskCount >= 5 || followupTaskFlagged >= 10 ? "P1" : "P2",
      area: "ops",
      title: "Review duplicate follow-up and task signals",
      signal: `${followupTaskFlagged} conversation(s) have duplicate or conflicting follow-up/task state`,
      recommendedAction:
        "Review the flagged rows before backfilling or closing tasks. If a pattern repeats, add a single upsert/merge rule at the pipeline stage that creates the duplicate.",
      evidence: {
        followupTaskAuditPath,
        issueCounts: followupTaskIssueCounts,
        sample: Array.isArray(followupTaskAudit?.flagged) ? followupTaskAudit.flagged.slice(0, 10) : []
      }
    });
  }

  if (recentOpsAnomalies.length > 0) {
    pushTask(tasks, {
      id: "ops-anomalies-reported",
      priority: recentOpsAnomalies.some((row: any) => String(row?.severity ?? "") === "error") ? "P1" : "P2",
      area: "ops",
      title: "Review staff-reported operational anomalies",
      signal: `${recentOpsAnomalies.length} open reported issue(s) in the last 7 days`,
      recommendedAction:
        "Group reported issues by type, inspect linked conversations/tasks, and add parser fixtures, route guards, task rules, or UI fixes for repeatable failures.",
      evidence: {
        opsAnomaliesPath,
        typeCounts: opsAnomalyTypeCounts,
        sample: recentOpsAnomalies.slice(0, 10).map((row: any) => ({
          id: row?.id,
          type: row?.type,
          severity: row?.severity,
          title: row?.title,
          note: row?.note,
          context: row?.context,
          linearIssueId: row?.external?.incidentResult?.linearIssueId
        }))
      }
    });
  }

  if (noResponseCount > 0) {
    pushTask(tasks, {
      id: "routing-no-response-outcomes",
      priority: noResponseCount >= 10 ? "P1" : "P2",
      area: "routing",
      title: "Audit route outcomes that produced no customer response",
      signal: `${noResponseCount} route outcome(s) were marked no-response in the current window`,
      recommendedAction:
        "Group by outcome reason, verify intentional suppressions versus misses, and add watchdog assertions for false suppressions.",
      evidence: { routeWatchdogPath, topOutcomes: routeWatchdog?.routeOutcomes?.topOutcomes ?? [] }
    });
  }

  if (hasToneData && tonePassRateResponded != null && toneAvg != null && (tonePassRateResponded < 92 || toneAvg < 0.82)) {
    pushTask(tasks, {
      id: "tone-quality-regression",
      priority: tonePassRateResponded < 85 || toneAvg < 0.75 ? "P1" : "P2",
      area: "tone",
      title: "Review low tone-quality pass rate",
      signal: `tone pass rate ${tonePassRateResponded.toFixed(1)}%, average score ${toneAvg.toFixed(2)}`,
      recommendedAction:
        "Inspect tone_quality_failures.json, promote only stable deterministic tone rules, and add fixtures for repeated issue codes.",
      evidence: { issueCounts: topCounts(toneSummary?.issueCounts, "issue"), toneDir }
    });
  }

  if (toneMissing > 0) {
    pushTask(tasks, {
      id: "tone-missing-responses",
      priority: toneMissing >= 5 ? "P1" : "P2",
      area: "ops",
      title: "Investigate actionable inbound turns with missing responses",
      signal: `${toneMissing} actionable inbound turn(s) had no response within the eval window`,
      recommendedAction:
        "Check whether the route was intentionally suppressed, staff-owned, or blocked by draft generation; add route-state tests for misses.",
      evidence: { toneDir }
    });
  }

  if (fixtureFailNow > 0) {
    pushTask(tasks, {
      id: "feedback-fixture-failures",
      priority: "P1",
      area: "evals",
      title: "Fix failing feedback replay fixtures",
      signal: `${fixtureFailNow} feedback replay fixture(s) currently fail`,
      recommendedAction:
        "Treat failing replay fixtures as regression candidates and patch the smallest parser/orchestrator surface that restores expected output.",
      evidence: { editDir, labels: topCounts(editSummary?.labelCounts, "label") }
    });
  }

  if (negativeSeeds > 0 && promotedRules === 0) {
    pushTask(tasks, {
      id: "negative-feedback-unpromoted",
      priority: "P2",
      area: "feedback",
      title: "Review negative feedback that did not promote into rules",
      signal: `${negativeSeeds} negative feedback seed(s), ${promotedRules} promoted deterministic rule(s)`,
      recommendedAction:
        "Look for repeated edit patterns that are below promotion thresholds and decide whether they need a hand-authored rule or more examples.",
      evidence: { languageDir }
    });
  }

  if (promotedManualExamples > 0) {
    pushTask(tasks, {
      id: "manual-reply-examples-promoted",
      priority: "P3",
      area: "growth",
      title: "Review newly promoted manual reply examples",
      signal: `${promotedManualExamples} manual outbound example(s) were promoted`,
      recommendedAction:
        "Spot-check promoted examples for brand voice and remove any example that encodes a one-off detail as reusable style.",
      evidence: { languageDir }
    });
  }

  if (voiceWithoutOutbound > 0) {
    pushTask(tasks, {
      id: "voice-followup-coverage",
      priority: voiceWithoutOutbound >= 10 ? "P2" : "P3",
      area: "voice",
      title: "Review voice transcripts without customer-facing follow-up",
      signal: `${voiceWithoutOutbound} voice transcript(s) had no following customer-facing outbound in the window`,
      recommendedAction:
        "Sample call summaries to confirm whether no follow-up was correct; add task/outcome automation where calls imply next steps.",
      evidence: { voiceDir, providers: topCounts(voiceSummary?.outboundProviderStats, "provider") }
    });
  }

  tasks.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.area.localeCompare(b.area));

  const report = {
    generatedAt: new Date().toISOString(),
    status: tasks.some(t => t.priority === "P0" || t.priority === "P1") ? "attention" : "ok",
    source: {
      reportRoot: parsed.reportRoot,
      editDir,
      languageDir,
      toneDir,
      voiceDir,
      opsAnomaliesPath,
      conversationAuditPath,
      followupTaskAuditPath,
      routeWatchdogPath
    },
    metrics: {
      stuckTurns: stuckCount,
      orphanFollowUpSignals: orphanFollowUpCount,
      followupTaskConsistencyFlags: followupTaskFlagged,
      followupTaskIssueCounts,
      noResponseRouteOutcomes: noResponseCount,
      tonePassRate: tonePassRateResponded,
      tonePassRateAll,
      toneAvgScore: toneAvg,
      toneMissingResponses: toneMissing,
      feedbackFixtureFailures: fixtureFailNow,
      negativeFeedbackSeeds: negativeSeeds,
      promotedDeterministicRules: promotedRules,
      promotedManualExamples,
      voiceTranscriptsWithoutCustomerOutbound: voiceWithoutOutbound,
      openOpsAnomalies: openOpsAnomalies.length,
      recentOpsAnomalies: recentOpsAnomalies.length,
      opsAnomalyTypeCounts
    },
    tasks
  };

  fs.mkdirSync(parsed.outDir, { recursive: true });
  const jsonPath = path.join(parsed.outDir, "agent_manager_report.json");
  const mdPath = path.join(parsed.outDir, "agent_manager_report.md");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, markdownReport(report, tasks));
  console.log(JSON.stringify({ ok: true, status: report.status, taskCount: tasks.length, jsonPath, mdPath }, null, 2));
}

main();
