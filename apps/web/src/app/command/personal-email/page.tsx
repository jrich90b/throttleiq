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

type PersonalMailStatus = {
  connected: boolean;
  email?: string | null;
  reason?: string;
  error?: string;
  messagesTotal?: number | null;
  threadsTotal?: number | null;
};

type PersonalMailMessage = {
  id: string;
  threadId?: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  labelIds?: string[];
};

type EmailStyleSettings = {
  tone: string;
  signature: string;
};

type ComposeForm = {
  to: string;
  subject: string;
  notes: string;
};

const defaultEmailStyle: EmailStyleSettings = {
  tone:
    "Write like Joe: direct, casual, helpful, short paragraphs, no corporate filler, no over-polished wording. Keep the next step clear.",
  signature: "Joe Hartrich\nLeadRider\njoe.hartrich@leadrider.ai"
};

const emptyCompose: ComposeForm = {
  to: "",
  subject: "",
  notes: ""
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

function taskStatusLabel(value: string) {
  return value.replace(/_/g, " ");
}

function isPersonalMailTask(task: AgentTask) {
  return (
    task.instructions.includes("[personal-mail-auto:") ||
    task.instructions.includes("[personal-mail-auto-trash:") ||
    /^Review personal email:/i.test(task.title) ||
    /^Auto-trashed personal email:/i.test(task.title)
  );
}

function personalGmailMessageId(task: AgentTask) {
  const instructionMatch = task.instructions.match(/\[personal-mail-auto:([^\]]+)\]/);
  if (instructionMatch?.[1]) return instructionMatch[1];
  const trashMatch = task.instructions.match(/\[personal-mail-auto-trash:([^\]]+)\]/);
  if (trashMatch?.[1]) return trashMatch[1];
  const linkMatch = task.output?.links?.find(link => link.startsWith("personal-mail:") && !link.startsWith("personal-mail:trashed"));
  return linkMatch?.replace("personal-mail:", "") || null;
}

function personalMailRecommendation(task: AgentTask) {
  const text = `${task.instructions}\n${task.output?.summary || ""}`.toLowerCase();
  if (text.includes("trash candidate")) return "Trash candidate";
  if (text.includes("draft reply")) return "Draft reply";
  if (text.includes("approval")) return "Needs review";
  return "Review";
}

const defaultPersonalMailInstructions =
  "Review Joe's personal email. Auto-trash safe spam, promos, expired codes, and routine no-reply vendor mail. Draft replies for real business conversations. Ask approval before sending, archiving important mail, or making account changes.";
const autoTrashLogRetentionMs = 24 * 60 * 60 * 1000;
const emailStyleStorageKey = "leadrider-command-personal-email-style";

export default function PersonalEmailCommandPage() {
  const [personalMailStatus, setPersonalMailStatus] = useState<PersonalMailStatus | null>(null);
  const [personalMailMessages, setPersonalMailMessages] = useState<PersonalMailMessage[]>([]);
  const [agentTasks, setAgentTasks] = useState<AgentTask[]>([]);
  const [notice, setNotice] = useState("Personal Email workspace is ready.");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [compose, setCompose] = useState<ComposeForm>(emptyCompose);
  const [emailStyle, setEmailStyle] = useState<EmailStyleSettings>(defaultEmailStyle);

  const personalTasks = useMemo(() => agentTasks.filter(isPersonalMailTask), [agentTasks]);
  const pendingPersonalTasks = useMemo(
    () => personalTasks.filter(task => task.status === "needs_approval"),
    [personalTasks]
  );
  const autoTrashedTasks = useMemo(
    () =>
      personalTasks.filter(task => {
        if (!/^Auto-trashed personal email:/i.test(task.title)) return false;
        const createdAt = new Date(task.createdAt).getTime();
        if (!Number.isFinite(createdAt)) return true;
        return Date.now() - createdAt <= autoTrashLogRetentionMs;
      }),
    [personalTasks]
  );

  async function loadWorkspace(isActive: () => boolean = () => true) {
    Promise.allSettled([
      fetch("/api/google/personal-mail/status", { cache: "no-store" }).then(resp => resp.json()),
      fetch("/api/personal-mail/messages?limit=12", { cache: "no-store" }).then(resp => resp.json()),
      fetch("/api/agent-tasks?limit=50", { cache: "no-store" }).then(resp => resp.json())
    ]).then(results => {
      if (!isActive()) return;
      const [mailStatus, mailMessages, tasks] = results.map(result =>
        result.status === "fulfilled" ? result.value : null
      );
      if (mailStatus?.ok) setPersonalMailStatus(mailStatus);
      if (mailMessages?.ok && Array.isArray(mailMessages.messages)) setPersonalMailMessages(mailMessages.messages);
      if (tasks?.ok && Array.isArray(tasks.tasks)) setAgentTasks(tasks.tasks);
    });
  }

  useEffect(() => {
    let active = true;
    loadWorkspace(() => active);
    try {
      const saved = window.localStorage.getItem(emailStyleStorageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        setEmailStyle({
          tone: String(parsed?.tone ?? defaultEmailStyle.tone),
          signature: String(parsed?.signature ?? defaultEmailStyle.signature)
        });
      }
    } catch {
      setEmailStyle(defaultEmailStyle);
    }
    return () => {
      active = false;
    };
  }, []);

  function styleInstruction() {
    return [
      "Use this email style profile:",
      emailStyle.tone.trim() || defaultEmailStyle.tone,
      "Use this signature at the end of the draft unless the email clearly should not include a signature:",
      emailStyle.signature.trim() || defaultEmailStyle.signature
    ].join("\n");
  }

  async function createPersonalMailTask(title?: string, taskInstructions?: string, successNotice?: string) {
    setAgentBusy(true);
    try {
      const resp = await fetch("/api/agent-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "claude",
          kind: "email",
          priority: "normal",
          clientName: "LeadRider",
          title: title || "Review personal email inbox",
          instructions: `${taskInstructions || defaultPersonalMailInstructions}\n\n${styleInstruction()}`
        })
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Personal email task could not be created.");
      setAgentTasks(current => [data.task, ...current.filter(row => row.id !== data.task.id)].slice(0, 50));
      setNotice(successNotice || `Draft queued: ${data.task.title}.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Personal email task could not be created.");
    } finally {
      setAgentBusy(false);
    }
  }

  async function createComposeDraft() {
    if (!compose.to.trim() && !compose.notes.trim()) {
      setNotice("Add a recipient or describe the email you want to draft.");
      return;
    }
    await createPersonalMailTask(
      `Draft personal email: ${compose.subject || compose.to || "New message"}`,
      [
        "Draft a new email from Joe's personal LeadRider inbox for approval.",
        "Do not send the email.",
        `From account: ${personalMailStatus?.email || "joe.hartrich@leadrider.ai"}`,
        `To: ${compose.to || "not specified"}`,
        `Subject: ${compose.subject || "write an appropriate subject"}`,
        "Joe's notes:",
        compose.notes || "No notes provided."
      ].join("\n"),
      "Email draft queued for review."
    );
    setCompose(emptyCompose);
  }

  function saveEmailStyle() {
    try {
      window.localStorage.setItem(emailStyleStorageKey, JSON.stringify(emailStyle));
      setNotice("Personal email tone and signature saved for this Command browser.");
    } catch {
      setNotice("Could not save email style in this browser.");
    }
  }

  async function updateAgentTask(task: AgentTask, status: AgentTask["status"], summary: string) {
    setBusyId(task.id);
    try {
      const resp = await fetch(`/api/agent-tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          summary
        })
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Review task could not be updated.");
      setAgentTasks(current => current.map(row => (row.id === task.id ? data.task : row)));
      setNotice(summary);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Review task could not be updated.");
    } finally {
      setBusyId(null);
    }
  }

  async function trashPersonalMailFromTask(task: AgentTask) {
    const messageId = personalGmailMessageId(task);
    if (!messageId) {
      setNotice("This review task is missing the Gmail message id, so it cannot be trashed from here.");
      return;
    }
    setBusyId(task.id);
    try {
      const resp = await fetch(`/api/personal-mail/messages/${encodeURIComponent(messageId)}/trash`, {
        method: "POST"
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Email could not be moved to trash.");
      setPersonalMailMessages(current => current.filter(message => message.id !== messageId));
      await updateAgentTask(task, "completed", "Reviewed personal email and moved it to trash.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Email could not be moved to trash.");
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
          <a href="/command/personal-email" className="is-active">Personal Email</a>
          <a href="/command/clients/new">Dealer Setup</a>
          <a href="/command/users">Users</a>
          <a href="/command">Agreements</a>
          <a href="/command">Billing</a>
          <a href="/command">Connectors</a>
        </nav>
        <section className="lr-ceo-side-panel">
          <p className="lr-ceo-kicker">Personal Email</p>
          <strong>{pendingPersonalTasks.length} reviews waiting</strong>
          <span>{personalMailStatus?.connected ? "Personal Gmail connected" : "Personal Gmail not connected"}</span>
        </section>
      </aside>

      <section className="lr-ceo-main">
        <header className="lr-ceo-header">
          <div>
            <p className="lr-ceo-kicker">Joe's inbox</p>
            <h2>Personal Email</h2>
            <p>Personal mail, automatic cleanup, draft replies, compose, and approval decisions in one place.</p>
          </div>
          <div className="lr-ceo-header-actions">
            <button
              type="button"
              className="lr-ceo-secondary-btn"
              onClick={() => {
                setNotice("Refreshing personal inbox and draft queue.");
                loadWorkspace();
              }}
              disabled={agentBusy}
            >
              Refresh inbox
            </button>
            {personalMailStatus?.connected ? (
              <span className="lr-ceo-mailbox-connected">Gmail connected</span>
            ) : (
              <a className="lr-ceo-button-link" href="/integrations/google/start?kind=personal_mail">Connect Gmail</a>
            )}
          </div>
        </header>

        <section className="lr-ceo-notice" aria-live="polite">{notice}</section>

        <section className="lr-ceo-metrics" aria-label="Personal email metrics">
          <article>
            <span>Personal inbox</span>
            <strong>{personalMailStatus?.messagesTotal ?? personalMailMessages.length}</strong>
            <small>{personalMailStatus?.email || "joe.hartrich@leadrider.ai"}</small>
          </article>
          <article>
            <span>Needs review</span>
            <strong>{pendingPersonalTasks.length}</strong>
            <small>Manual decisions</small>
          </article>
          <article>
            <span>Auto-trashed</span>
            <strong>{autoTrashedTasks.length}</strong>
            <small>Last 24 hours</small>
          </article>
          <article>
            <span>Email drafts</span>
            <strong>{personalTasks.length}</strong>
            <small>Draft and cleanup history</small>
          </article>
        </section>

        <section className="lr-ceo-email-workspace">
          <article className="lr-ceo-panel">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Compose</p>
                <h3>New email</h3>
              </div>
              <span className="lr-ceo-status-attention">Approval before send</span>
            </div>
            <div className="lr-ceo-compose-form">
              <label>
                To
                <input value={compose.to} onChange={event => setCompose(current => ({ ...current, to: event.target.value }))} placeholder="name@company.com" />
              </label>
              <label>
                Subject
                <input value={compose.subject} onChange={event => setCompose(current => ({ ...current, subject: event.target.value }))} placeholder="Subject" />
              </label>
              <label>
                What should this say?
                <textarea value={compose.notes} onChange={event => setCompose(current => ({ ...current, notes: event.target.value }))} placeholder="Type a rough note or tell the draft what you need." />
              </label>
              <button type="button" onClick={createComposeDraft} disabled={agentBusy}>Create draft</button>
            </div>
          </article>

          <article className="lr-ceo-panel">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Email style</p>
                <h3>Tone and signature</h3>
              </div>
              <span className="lr-ceo-status-ready">Used for drafts</span>
            </div>
            <div className="lr-ceo-compose-form">
              <label>
                Joe's tone
                <textarea value={emailStyle.tone} onChange={event => setEmailStyle(current => ({ ...current, tone: event.target.value }))} />
              </label>
              <label>
                Signature
                <textarea value={emailStyle.signature} onChange={event => setEmailStyle(current => ({ ...current, signature: event.target.value }))} />
              </label>
              <button type="button" className="lr-ceo-secondary-btn" onClick={saveEmailStyle}>Save email style</button>
            </div>
          </article>
        </section>

        <section className="lr-ceo-grid">
          <article className="lr-ceo-panel">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Inbox</p>
                <h3>Recent messages</h3>
              </div>
              <span className={personalMailStatus?.connected ? "lr-ceo-status-ready" : "lr-ceo-status-attention"}>
                {personalMailStatus?.connected ? "Auto-reviewing" : "Needs connection"}
              </span>
            </div>
            <div className="lr-ceo-ticket-list">
              {personalMailMessages.length ? (
                personalMailMessages.map(message => (
                  <div key={message.id} className="lr-ceo-mail-row">
                    <span>{formatTime(message.date)}</span>
                    <strong>{message.subject || "(No subject)"}</strong>
                    <small>{message.from}</small>
                    <p>{message.snippet}</p>
                    <div className="lr-ceo-action-row">
                      <button
                        type="button"
                        className="lr-ceo-secondary-btn"
                        onClick={() =>
                          createPersonalMailTask(
                            `Review personal email: ${message.subject || "(No subject)"}`,
                            `Review this personal email and classify it using the personal email rules. From: ${message.from}. Subject: ${message.subject}. Snippet: ${message.snippet}. [personal-mail-auto:${message.id}]`
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
                <p className="lr-ceo-note">No personal emails loaded.</p>
              )}
            </div>
          </article>

          <article className="lr-ceo-panel">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Review queue</p>
                <h3>Needs your decision</h3>
              </div>
              <span className="lr-ceo-status-attention">{pendingPersonalTasks.length} pending</span>
            </div>
            <div className="lr-ceo-task-list">
              {pendingPersonalTasks.length ? (
                pendingPersonalTasks.map(task => (
                  <div key={task.id} className="lr-ceo-task-row">
                    <span>{task.provider}</span>
                    <p>
                      <strong>{task.title}</strong>
                      <small>
                        {formatTime(task.createdAt)} • {taskStatusLabel(task.status)}
                        {task.approval?.required ? ` • ${task.approval.reason}` : ""}
                      </small>
                      <small>Recommendation: {personalMailRecommendation(task)}</small>
                      {task.output?.summary ? <small>{task.output.summary}</small> : null}
                    </p>
                    <div className="lr-ceo-run-actions">
                      <button type="button" onClick={() => trashPersonalMailFromTask(task)} disabled={busyId === task.id}>
                        Trash email
                      </button>
                      <button
                        type="button"
                        className="lr-ceo-secondary-btn"
                        onClick={() => updateAgentTask(task, "completed", "Reviewed personal email and kept it in the inbox.")}
                        disabled={busyId === task.id}
                      >
                        Keep
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <p className="lr-ceo-note">No personal email decisions waiting.</p>
              )}
            </div>
          </article>
        </section>

        <section className="lr-ceo-panel">
          <div className="lr-ceo-panel-title">
            <div>
              <p className="lr-ceo-kicker">Auto-trash log</p>
              <h3>Safe cleanup history</h3>
            </div>
            <span className="lr-ceo-status-ready">Last 24 hours</span>
          </div>
          <div className="lr-ceo-task-list">
            {autoTrashedTasks.length ? (
              autoTrashedTasks.map(task => (
                <div key={task.id} className="lr-ceo-task-row">
                  <span>{task.provider}</span>
                  <p>
                    <strong>{task.title}</strong>
                    <small>
                      {formatTime(task.createdAt)} • {taskStatusLabel(task.status)}
                    </small>
                    {task.output?.summary ? <small>{task.output.summary}</small> : null}
                  </p>
                </div>
              ))
            ) : (
              <p className="lr-ceo-note">No personal emails auto-trashed in the last 24 hours.</p>
            )}
          </div>
        </section>
      </section>
    </main>
  );
}
