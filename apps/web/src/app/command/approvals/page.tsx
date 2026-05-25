"use client";

import { useEffect, useMemo, useState } from "react";

type AutomationRun = {
  id: string;
  name: string;
  source: "codex" | "feedback_loop" | "manual" | "other";
  status: "running" | "completed" | "failed" | "needs_approval" | "approved" | "declined";
  summary: string;
  startedAt: string;
  finishedAt?: string;
  approvalRequired: boolean;
  approvalReason?: string;
  commitHash?: string;
  pullRequestUrl?: string;
  deployUrl?: string;
  logPath?: string;
  changedFiles?: string[];
  approvedBy?: {
    name?: string;
    email?: string;
    at: string;
  };
};

type AgentTask = {
  id: string;
  provider: "codex" | "claude";
  kind: string;
  title: string;
  instructions: string;
  clientName?: string;
  priority: "normal" | "high";
  risk: "low" | "approval_required" | "blocked";
  status: "queued" | "needs_approval" | "running" | "completed" | "failed" | "blocked";
  createdAt: string;
  updatedAt?: string;
  approval?: {
    required: boolean;
    reason?: string;
  };
  output?: {
    summary?: string;
    links?: string[];
  };
};

function formatTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function label(value: string) {
  return value.replace(/_/g, " ");
}

function trimSummary(value?: string, max = 520) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1).trim()}...` : text;
}

function isAutoReportTask(task: AgentTask) {
  const text = `${task.title}\n${task.instructions}\n${task.output?.summary ?? ""}`.toLowerCase();
  if (task.instructions.includes("[personal-mail-auto:")) return false;
  if (task.instructions.includes("[support-auto:")) return false;
  if (/^review personal email:/i.test(task.title)) return false;
  if (/support ticket|support gmail|support inbox|support reply/i.test(text)) return false;
  return (
    task.kind === "feedback_review" ||
    text.includes("automation run") ||
    text.includes("feedback loop") ||
    text.includes("closed-loop") ||
    text.includes("shadow replay") ||
    text.includes("tone quality") ||
    text.includes("deploy approval") ||
    text.includes("production approval")
  );
}

function needsRunDecision(run: AutomationRun) {
  if (run.status === "approved" || run.status === "declined") return false;
  return run.status === "needs_approval" || (run.approvalRequired && run.status !== "completed");
}

export default function CommandApprovalsPage() {
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [notice, setNotice] = useState("Approvals workspace is ready.");
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    const [runsResp, tasksResp] = await Promise.all([
      fetch("/api/automation-runs?limit=80", { cache: "no-store" }).then(resp => resp.json()),
      fetch("/api/agent-tasks?limit=120", { cache: "no-store" }).then(resp => resp.json())
    ]);
    if (runsResp?.ok && Array.isArray(runsResp.runs)) setRuns(runsResp.runs);
    if (tasksResp?.ok && Array.isArray(tasksResp.tasks)) setTasks(tasksResp.tasks);
  }

  useEffect(() => {
    let active = true;
    load().catch(err => {
      if (active) setNotice(err instanceof Error ? err.message : "Approvals could not be loaded.");
    });
    return () => {
      active = false;
    };
  }, []);

  const pendingRuns = useMemo(() => runs.filter(needsRunDecision), [runs]);
  const failedRuns = useMemo(() => runs.filter(run => run.status === "failed"), [runs]);
  const autoReportTasks = useMemo(
    () => tasks.filter(task => task.status === "needs_approval" && isAutoReportTask(task)),
    [tasks]
  );
  const recentDecisions = useMemo(
    () => runs.filter(run => run.status === "approved" || run.status === "declined").slice(0, 8),
    [runs]
  );

  async function decideRun(run: AutomationRun, status: "approved" | "declined") {
    setBusyId(run.id);
    try {
      const resp = await fetch(`/api/automation-runs/${encodeURIComponent(run.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status })
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Automation run could not be updated.");
      setRuns(current => current.map(row => (row.id === run.id ? data.run : row)));
      setNotice(`${status === "approved" ? "Approved" : "Declined"}: ${data.run.name}.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Automation run could not be updated.");
    } finally {
      setBusyId(null);
    }
  }

  async function markTaskReviewed(task: AgentTask) {
    setBusyId(task.id);
    try {
      const resp = await fetch(`/api/agent-tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "completed",
          summary: "Reviewed in Command Approvals. No external action was taken from this review button."
        })
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Review task could not be updated.");
      setTasks(current => current.map(row => (row.id === task.id ? data.task : row)));
      setNotice(`Marked reviewed: ${data.task.title}.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Review task could not be updated.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main className="lr-ceo-shell">
      <aside className="lr-ceo-sidebar">
        <div className="lr-ceo-brand">
          <div className="lr-ceo-mark">LR</div>
          <div>
            <p className="lr-ceo-kicker">LeadRider</p>
            <h1>Command</h1>
          </div>
        </div>
        <nav className="lr-ceo-nav" aria-label="LeadRider command sections">
          <a href="/command">Command Home</a>
          <a href="/command/sales">Sales Funnel</a>
          <a href="/command/support">Support Agent</a>
          <a href="/command/approvals" className="is-active">Approvals</a>
          <a href="/command/personal-email">Personal Email</a>
          <a href="/command/clients">Active Clients</a>
          <a href="/command/clients/new">Dealer Setup</a>
          <a href="/command/users">Users</a>
          <a href="/command">Agreements</a>
          <a href="/command">Billing</a>
          <a href="/command">Connectors</a>
        </nav>
        <section className="lr-ceo-side-panel">
          <p className="lr-ceo-kicker">Approvals</p>
          <strong>{pendingRuns.length + autoReportTasks.length} waiting</strong>
          <span>Auto reports, deploy gates, and production-change reviews.</span>
        </section>
      </aside>

      <section className="lr-ceo-main">
        <header className="lr-ceo-header">
          <div>
            <p className="lr-ceo-kicker">Command approvals</p>
            <h2>Review Before Action</h2>
            <p>Approve or decline automation output here. Support tickets and personal email stay in their own workspaces.</p>
          </div>
          <div className="lr-ceo-header-actions">
            <button type="button" className="lr-ceo-secondary-btn" onClick={() => void load()}>
              Refresh
            </button>
          </div>
        </header>

        <section className="lr-ceo-notice" aria-live="polite">{notice}</section>

        <section className="lr-ceo-metrics" aria-label="Approval metrics">
          <article>
            <span>Needs decision</span>
            <strong>{pendingRuns.length}</strong>
            <small>Approve or decline</small>
          </article>
          <article>
            <span>Needs review</span>
            <strong>{autoReportTasks.length}</strong>
            <small>Read and mark reviewed</small>
          </article>
          <article>
            <span>Failed reports</span>
            <strong>{failedRuns.length}</strong>
            <small>Needs inspection</small>
          </article>
          <article>
            <span>Recent decisions</span>
            <strong>{recentDecisions.length}</strong>
            <small>Approved or declined</small>
          </article>
        </section>

        <section className="lr-ceo-grid">
          <article className="lr-ceo-panel lr-ceo-panel-wide">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Auto reports</p>
                <h3>Waiting for approval</h3>
              </div>
              <span className={pendingRuns.length ? "lr-ceo-status-attention" : "lr-ceo-status-ready"}>
                {pendingRuns.length ? "Action needed" : "Clear"}
              </span>
            </div>
            <div className="lr-ceo-run-list">
              {pendingRuns.length ? (
                pendingRuns.map(run => (
                  <div key={run.id} className="lr-ceo-run-row">
                    <div>
                      <span className={`lr-ceo-run-status is-${run.status}`}>{label(run.status)}</span>
                      <strong>{run.name}</strong>
                      <p>{trimSummary(run.summary)}</p>
                      <small>
                        {label(run.source)} • {formatTime(run.startedAt)}
                        {run.commitHash ? ` • commit ${run.commitHash.slice(0, 7)}` : ""}
                        {run.changedFiles?.length ? ` • ${run.changedFiles.length} files changed` : ""}
                      </small>
                      {run.approvalReason ? <em>{run.approvalReason}</em> : null}
                      {run.changedFiles?.length ? (
                        <details>
                          <summary>Changed files</summary>
                          <ul>
                            {run.changedFiles.slice(0, 20).map(file => <li key={file}>{file}</li>)}
                          </ul>
                        </details>
                      ) : null}
                    </div>
                    <div className="lr-ceo-run-actions">
                      {run.pullRequestUrl ? <a href={run.pullRequestUrl}>PR</a> : null}
                      {run.deployUrl ? <a href={run.deployUrl}>Deploy</a> : null}
                      <button type="button" onClick={() => decideRun(run, "approved")} disabled={busyId === run.id}>
                        Approve
                      </button>
                      <button
                        type="button"
                        className="lr-ceo-secondary-btn"
                        onClick={() => decideRun(run, "declined")}
                        disabled={busyId === run.id}
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <p className="lr-ceo-note">No automation runs need approval right now.</p>
              )}
            </div>
          </article>
        </section>

        <section className="lr-ceo-grid">
          <article className="lr-ceo-panel">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Review queue</p>
                <h3>Auto-report notes</h3>
              </div>
            </div>
            <div className="lr-ceo-ticket-list">
              {autoReportTasks.length ? (
                autoReportTasks.map(task => (
                  <div key={task.id} className="lr-ceo-ticket-row">
                    <div>
                      <span>{task.provider}</span>
                      <strong>{task.title}</strong>
                      <small>
                        {label(task.kind)} • {formatTime(task.createdAt)}
                        {task.priority === "high" ? " • high priority" : ""}
                      </small>
                      <p>{trimSummary(task.output?.summary || task.instructions, 420)}</p>
                      {task.approval?.reason ? <em>{task.approval.reason}</em> : null}
                    </div>
                    <button
                      type="button"
                      className="lr-ceo-secondary-btn"
                      onClick={() => markTaskReviewed(task)}
                      disabled={busyId === task.id}
                    >
                      Mark reviewed
                    </button>
                  </div>
                ))
              ) : (
                <p className="lr-ceo-note">No auto-report review tasks are waiting.</p>
              )}
            </div>
          </article>

          <article className="lr-ceo-panel">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">History</p>
                <h3>Recent decisions</h3>
              </div>
            </div>
            <div className="lr-ceo-ticket-list">
              {recentDecisions.length ? (
                recentDecisions.map(run => (
                  <div key={run.id} className="lr-ceo-ticket-row">
                    <div>
                      <span>{label(run.status)}</span>
                      <strong>{run.name}</strong>
                      <small>
                        {run.approvedBy?.name || run.approvedBy?.email || "Command user"}
                        {run.approvedBy?.at ? ` • ${formatTime(run.approvedBy.at)}` : ""}
                      </small>
                      <p>{trimSummary(run.summary, 260)}</p>
                    </div>
                  </div>
                ))
              ) : (
                <p className="lr-ceo-note">No approval decisions logged yet.</p>
              )}
            </div>
          </article>
        </section>
      </section>
    </main>
  );
}
