"use client";

import { useEffect, useMemo, useState } from "react";

type AgentTask = {
  id: string;
  provider: "codex" | "claude";
  kind: string;
  title: string;
  instructions: string;
  clientName?: string;
  status: "queued" | "needs_approval" | "running" | "completed" | "failed" | "blocked";
  createdAt: string;
  approval?: {
    required: boolean;
    reason?: string;
  };
  output?: {
    summary?: string;
    links?: string[];
  };
};

type AutomationRun = {
  id: string;
  name: string;
  source: "codex" | "feedback_loop" | "manual" | "other";
  status: "running" | "completed" | "failed" | "needs_approval" | "approved" | "declined";
  summary: string;
  startedAt: string;
  approvalRequired: boolean;
  approvalReason?: string;
  commitHash?: string;
  pullRequestUrl?: string;
  deployUrl?: string;
  changedFiles?: string[];
};

type SupportTicket = {
  id: string;
  type: string;
  severity: string;
  title: string;
  note?: string;
  createdAt: string;
  status: "open" | "triaged" | "closed";
  reporter?: {
    name?: string;
    email?: string;
  };
  context?: {
    leadName?: string | null;
    pageUrl?: string | null;
  };
};

type SupportMailStatus = {
  connected: boolean;
  email?: string | null;
  reason?: string;
  error?: string;
  messagesTotal?: number | null;
  threadsTotal?: number | null;
};

type SupportMailMessage = {
  id: string;
  threadId?: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  labelIds?: string[];
};

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function statusLabel(value: string) {
  return value.replace(/_/g, " ");
}

export default function SupportAgentCommandPage() {
  const [supportMailStatus, setSupportMailStatus] = useState<SupportMailStatus | null>(null);
  const [supportMailMessages, setSupportMailMessages] = useState<SupportMailMessage[]>([]);
  const [supportTickets, setSupportTickets] = useState<SupportTicket[]>([]);
  const [automationRuns, setAutomationRuns] = useState<AutomationRun[]>([]);
  const [agentTasks, setAgentTasks] = useState<AgentTask[]>([]);
  const [notice, setNotice] = useState("Support Agent workspace is ready.");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [instructions, setInstructions] = useState(
    "Review current support emails, open tickets, and closed-loop runs. Draft the next support actions for approval. Do not send emails or close tickets without approval."
  );

  const openTickets = useMemo(() => supportTickets.filter(ticket => ticket.status !== "closed"), [supportTickets]);
  const closedTickets = useMemo(() => supportTickets.filter(ticket => ticket.status === "closed"), [supportTickets]);
  const approvalRuns = useMemo(() => automationRuns.filter(run => run.status === "needs_approval"), [automationRuns]);
  const closedLoopRuns = useMemo(
    () => automationRuns.filter(run => run.source === "feedback_loop" || /feedback|closed loop/i.test(run.name)),
    [automationRuns]
  );
  const approvalTasks = useMemo(() => agentTasks.filter(task => task.status === "needs_approval" || task.approval?.required), [agentTasks]);

  useEffect(() => {
    let active = true;
    Promise.allSettled([
      fetch("/api/google/support-mail/status", { cache: "no-store" }).then(resp => resp.json()),
      fetch("/api/support-mail/messages?limit=12", { cache: "no-store" }).then(resp => resp.json()),
      fetch("/api/ops/anomalies?limit=20", { cache: "no-store" }).then(resp => resp.json()),
      fetch("/api/automation-runs?limit=20", { cache: "no-store" }).then(resp => resp.json()),
      fetch("/api/agent-tasks?limit=20", { cache: "no-store" }).then(resp => resp.json())
    ]).then(results => {
      if (!active) return;
      const [mailStatus, mailMessages, tickets, runs, tasks] = results.map(result =>
        result.status === "fulfilled" ? result.value : null
      );
      if (mailStatus?.ok) setSupportMailStatus(mailStatus);
      if (mailMessages?.ok && Array.isArray(mailMessages.messages)) setSupportMailMessages(mailMessages.messages);
      if (tickets?.ok && Array.isArray(tickets.anomalies)) setSupportTickets(tickets.anomalies);
      if (runs?.ok && Array.isArray(runs.runs)) setAutomationRuns(runs.runs);
      if (tasks?.ok && Array.isArray(tasks.tasks)) setAgentTasks(tasks.tasks);
    });
    return () => {
      active = false;
    };
  }, []);

  async function createSupportAgentTask(title?: string, taskInstructions?: string) {
    setAgentBusy(true);
    try {
      const resp = await fetch("/api/agent-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "claude",
          kind: "email",
          priority: "high",
          clientName: "LeadRider",
          title: title || "Support Agent review",
          instructions: taskInstructions || instructions
        })
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Support Agent task could not be created.");
      setAgentTasks(current => [data.task, ...current.filter(row => row.id !== data.task.id)].slice(0, 20));
      setNotice(`Support Claude task created: ${data.task.title}.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Support Agent task could not be created.");
    } finally {
      setAgentBusy(false);
    }
  }

  async function closeSupportTicket(ticket: SupportTicket) {
    setBusyId(ticket.id);
    try {
      const resp = await fetch(`/api/ops/anomalies/${encodeURIComponent(ticket.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "closed" })
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Support ticket could not be closed.");
      setSupportTickets(current => current.map(row => (row.id === ticket.id ? data.anomaly : row)));
      setNotice(`Support ticket closed: ${data.anomaly.title}.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Support ticket could not be closed.");
    } finally {
      setBusyId(null);
    }
  }

  async function decideAutomationRun(run: AutomationRun, status: "approved" | "declined") {
    setBusyId(run.id);
    try {
      const resp = await fetch(`/api/automation-runs/${encodeURIComponent(run.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status })
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Automation run could not be updated.");
      setAutomationRuns(current => current.map(row => (row.id === run.id ? data.run : row)));
      setNotice(`Automation run ${status}: ${data.run.name}.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Automation run could not be updated.");
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
        <nav className="lr-ceo-nav" aria-label="LeadRider command agents">
          <a href="/command">Command Home</a>
          <a href="/command/support" className="is-active">Support Agent</a>
          <a href="/command/clients/new">Dealer Setup</a>
          <a href="/command">Agreements</a>
          <a href="/command">Billing</a>
          <a href="/command">Connectors</a>
        </nav>
        <section className="lr-ceo-side-panel">
          <p className="lr-ceo-kicker">Support Agent</p>
          <strong>{approvalRuns.length + approvalTasks.length} approvals waiting</strong>
          <span>{openTickets.length} open support tickets</span>
        </section>
      </aside>

      <section className="lr-ceo-main">
        <header className="lr-ceo-header">
          <div>
            <p className="lr-ceo-kicker">Agent workspace</p>
            <h2>Support Agent</h2>
            <p>Monitor support emails, Report Issue tickets, closed-loop automation runs, and anything waiting for your approval.</p>
          </div>
          <div className="lr-ceo-header-actions">
            <button type="button" onClick={() => createSupportAgentTask()} disabled={agentBusy}>
              Ask Claude
            </button>
            {supportMailStatus?.connected ? (
              <span className="lr-ceo-mailbox-connected">Gmail connected</span>
            ) : (
              <a className="lr-ceo-button-link" href="/integrations/google/start?kind=support_mail">Connect Gmail</a>
            )}
          </div>
        </header>

        <section className="lr-ceo-notice" aria-live="polite">{notice}</section>

        <section className="lr-ceo-metrics" aria-label="Support metrics">
          <article>
            <span>Support inbox</span>
            <strong>{supportMailStatus?.messagesTotal ?? supportMailMessages.length}</strong>
            <small>{supportMailStatus?.email || "support@leadrider.ai"}</small>
          </article>
          <article>
            <span>Open tickets</span>
            <strong>{openTickets.length}</strong>
            <small>Report Issue queue</small>
          </article>
          <article>
            <span>Needs approval</span>
            <strong>{approvalRuns.length + approvalTasks.length}</strong>
            <small>Agent or automation approvals</small>
          </article>
          <article>
            <span>Closed tickets</span>
            <strong>{closedTickets.length}</strong>
            <small>Recently completed</small>
          </article>
        </section>

        <section className="lr-ceo-grid">
          <article className="lr-ceo-panel lr-ceo-panel-wide">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Claude support agent</p>
                <h3>Work queue</h3>
              </div>
              <span className="lr-ceo-status-attention">Approval gated</span>
            </div>
            <textarea
              className="lr-ceo-agent-textarea"
              value={instructions}
              onChange={event => setInstructions(event.target.value)}
            />
            <div className="lr-ceo-action-row">
              <button type="button" onClick={() => createSupportAgentTask()} disabled={agentBusy}>
                Create support task
              </button>
              <button
                type="button"
                className="lr-ceo-secondary-btn"
                onClick={() =>
                  createSupportAgentTask(
                    "Draft support inbox replies",
                    "Review the latest support Gmail messages and draft concise replies for approval. Do not send anything."
                  )
                }
                disabled={agentBusy}
              >
                Draft email replies
              </button>
            </div>
          </article>

          <article className="lr-ceo-panel">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Approvals</p>
                <h3>Needs your review</h3>
              </div>
            </div>
            <div className="lr-ceo-ticket-list">
              {approvalTasks.map(task => (
                <div key={task.id} className="lr-ceo-ticket-row">
                  <div>
                    <span>{task.provider}</span>
                    <strong>{task.title}</strong>
                    <small>{task.approval?.reason || statusLabel(task.status)}</small>
                    {task.output?.summary ? <p>{task.output.summary}</p> : <p>Claude is preparing this for review.</p>}
                  </div>
                </div>
              ))}
              {approvalRuns.map(run => (
                <div key={run.id} className="lr-ceo-ticket-row">
                  <div>
                    <span>Automation</span>
                    <strong>{run.name}</strong>
                    <small>{run.approvalReason || run.summary}</small>
                  </div>
                  <div className="lr-ceo-run-actions">
                    <button type="button" onClick={() => decideAutomationRun(run, "approved")} disabled={busyId === run.id}>
                      Approve
                    </button>
                    <button type="button" className="lr-ceo-secondary-btn" onClick={() => decideAutomationRun(run, "declined")} disabled={busyId === run.id}>
                      Decline
                    </button>
                  </div>
                </div>
              ))}
              {!approvalTasks.length && !approvalRuns.length ? <p className="lr-ceo-note">No approvals waiting.</p> : null}
            </div>
          </article>
        </section>

        <section className="lr-ceo-grid">
          <article className="lr-ceo-panel">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Support Gmail</p>
                <h3>Recent emails</h3>
              </div>
              <span className={supportMailStatus?.connected ? "lr-ceo-status-ready" : "lr-ceo-status-attention"}>
                {supportMailStatus?.connected ? "Connected" : "Needs connection"}
              </span>
            </div>
            <div className="lr-ceo-ticket-list">
              {supportMailMessages.length ? (
                supportMailMessages.map(message => (
                  <div key={message.id} className="lr-ceo-mail-row">
                    <span>Gmail</span>
                    <strong>{message.subject}</strong>
                    <small>{message.from}</small>
                    <p>{message.snippet}</p>
                    <div className="lr-ceo-action-row">
                      <button
                        type="button"
                        className="lr-ceo-secondary-btn"
                        onClick={() =>
                          createSupportAgentTask(
                            `Draft reply: ${message.subject}`,
                            `Draft a support reply for this email. From: ${message.from}. Subject: ${message.subject}. Snippet: ${message.snippet}. Do not send it.`
                          )
                        }
                        disabled={agentBusy}
                      >
                        Draft reply
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <p className="lr-ceo-note">No support emails loaded yet.</p>
              )}
            </div>
          </article>

          <article className="lr-ceo-panel">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Report Issue</p>
                <h3>Support tickets</h3>
              </div>
            </div>
            <div className="lr-ceo-ticket-list">
              {supportTickets.length ? (
                supportTickets.map(ticket => (
                  <div key={ticket.id} className="lr-ceo-ticket-row">
                    <div>
                      <span>{ticket.status}</span>
                      <strong>{ticket.title}</strong>
                      <small>
                        {ticket.reporter?.name || ticket.reporter?.email || "Unknown reporter"}
                        {ticket.context?.leadName ? ` • ${ticket.context.leadName}` : ""}
                      </small>
                    </div>
                    {ticket.status !== "closed" ? (
                      <button type="button" className="lr-ceo-secondary-btn" onClick={() => closeSupportTicket(ticket)} disabled={busyId === ticket.id}>
                        Mark complete
                      </button>
                    ) : null}
                  </div>
                ))
              ) : (
                <p className="lr-ceo-note">No support tickets loaded yet.</p>
              )}
            </div>
          </article>
        </section>

        <section className="lr-ceo-panel">
          <div className="lr-ceo-panel-title">
            <div>
              <p className="lr-ceo-kicker">Closed feedback loop</p>
              <h3>Automation runs</h3>
            </div>
            <span className="lr-ceo-status-ready">Synced</span>
          </div>
          <div className="lr-ceo-run-list">
            {closedLoopRuns.length ? (
              closedLoopRuns.map(run => (
                <div key={run.id} className="lr-ceo-run-row">
                  <div>
                    <span className={`lr-ceo-run-status is-${run.status}`}>{statusLabel(run.status)}</span>
                    <strong>{run.name}</strong>
                    <p>{run.summary}</p>
                    <small>
                      {statusLabel(run.source)} • {formatTime(run.startedAt)}
                      {run.commitHash ? ` • commit ${run.commitHash.slice(0, 7)}` : ""}
                      {run.changedFiles?.length ? ` • ${run.changedFiles.length} files changed` : ""}
                    </small>
                    {run.approvalRequired && run.status === "needs_approval" ? (
                      <em>{run.approvalReason || "This run needs approval before the next production action."}</em>
                    ) : null}
                  </div>
                  <div className="lr-ceo-run-actions">
                    {run.pullRequestUrl ? <a href={run.pullRequestUrl}>PR</a> : null}
                    {run.deployUrl ? <a href={run.deployUrl}>Deploy</a> : null}
                    {run.status === "needs_approval" ? (
                      <>
                        <button type="button" onClick={() => decideAutomationRun(run, "approved")} disabled={busyId === run.id}>
                          Approve
                        </button>
                        <button type="button" className="lr-ceo-secondary-btn" onClick={() => decideAutomationRun(run, "declined")} disabled={busyId === run.id}>
                          Decline
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
              ))
            ) : (
              <p className="lr-ceo-note">No closed-loop feedback runs logged yet.</p>
            )}
          </div>
        </section>
      </section>
    </main>
  );
}
