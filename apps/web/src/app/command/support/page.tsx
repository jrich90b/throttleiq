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

export default function SupportAgentCommandPage() {
  const [supportMailStatus, setSupportMailStatus] = useState<SupportMailStatus | null>(null);
  const [supportMailMessages, setSupportMailMessages] = useState<SupportMailMessage[]>([]);
  const [supportTickets, setSupportTickets] = useState<SupportTicket[]>([]);
  const [, setAgentTasks] = useState<AgentTask[]>([]);
  const [notice, setNotice] = useState("Support Agent workspace is ready.");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [instructions, setInstructions] = useState(
    "Review current support emails, open tickets, and closed-loop runs. Draft the next support actions for approval. Do not send emails or close tickets without approval."
  );

  const openTickets = useMemo(() => supportTickets.filter(ticket => ticket.status !== "closed"), [supportTickets]);
  const closedTickets = useMemo(() => supportTickets.filter(ticket => ticket.status === "closed"), [supportTickets]);
  useEffect(() => {
    let active = true;
    Promise.allSettled([
      fetch("/api/google/support-mail/status", { cache: "no-store" }).then(resp => resp.json()),
      fetch("/api/support-mail/messages?limit=12", { cache: "no-store" }).then(resp => resp.json()),
      fetch("/api/ops/anomalies?limit=20", { cache: "no-store" }).then(resp => resp.json())
    ]).then(results => {
      if (!active) return;
      const [mailStatus, mailMessages, tickets] = results.map(result =>
        result.status === "fulfilled" ? result.value : null
      );
      if (mailStatus?.ok) setSupportMailStatus(mailStatus);
      if (mailMessages?.ok && Array.isArray(mailMessages.messages)) setSupportMailMessages(mailMessages.messages);
      if (tickets?.ok && Array.isArray(tickets.anomalies)) setSupportTickets(tickets.anomalies);
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

  async function trashSupportMailMessage(message: SupportMailMessage) {
    setBusyId(message.id);
    try {
      const resp = await fetch(`/api/support-mail/messages/${encodeURIComponent(message.id)}/trash`, {
        method: "POST"
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Support email could not be moved to trash.");
      setSupportMailMessages(current => current.filter(row => row.id !== message.id));
      setNotice(`Moved support email to trash: ${message.subject}.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Support email could not be moved to trash.");
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
          <a href="/command/sales">Sales Funnel</a>
          <a href="/command/support" className="is-active">Support Agent</a>
          <a href="/command/approvals">Approvals</a>
          <a href="/command/personal-email">Personal Email</a>
          <a href="/command/clients">Active Clients</a>
          <a href="/command/clients/new">Dealer Setup</a>
          <a href="/command/users">Users</a>
          <a href="/command">Agreements</a>
          <a href="/command">Billing</a>
          <a href="/command">Connectors</a>
        </nav>
        <section className="lr-ceo-side-panel">
          <p className="lr-ceo-kicker">Support Agent</p>
          <strong>{openTickets.length} open support tickets</strong>
          <span>{supportMailStatus?.connected ? "Support Gmail connected" : "Support Gmail not connected"}</span>
        </section>
      </aside>

      <section className="lr-ceo-main">
        <header className="lr-ceo-header">
          <div>
            <p className="lr-ceo-kicker">Agent workspace</p>
            <h2>Support Agent</h2>
            <p>Monitor support emails, Report Issue tickets, and closed-loop automation runs.</p>
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
            <span>Recent emails</span>
            <strong>{supportMailMessages.length}</strong>
            <small>Loaded from support Gmail</small>
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
                      <button
                        type="button"
                        className="lr-ceo-secondary-btn"
                        onClick={() => trashSupportMailMessage(message)}
                        disabled={busyId === message.id}
                      >
                        Approve trash
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

      </section>
    </main>
  );
}
