"use client";

import { useEffect, useMemo, useState } from "react";

type ClientStage = "Prospect" | "Agreement" | "Build" | "Pilot" | "Active";
type Health = "ready" | "attention" | "blocked";

type DealerClient = {
  name: string;
  stage: ClientStage;
  plan: string;
  owner: string;
  monthlyFee: number;
  setupFee: number;
  nextAction: string;
  due: string;
  health: Health;
  progress: number;
  domains: string[];
  blockers: string[];
};

type AgentLane = {
  name: string;
  role: string;
  status: "ready" | "running" | "needs approval";
  lastRun: string;
  nextRun: string;
  output: string;
};

type Connector = {
  name: string;
  status: "connected" | "setup needed" | "planned";
  owner: string;
  purpose: string;
};
type AgentTaskProvider = "codex" | "claude";
type AgentTaskKind =
  | "dealer_setup"
  | "feedback_review"
  | "agreement"
  | "email"
  | "quickbooks"
  | "prospect_research"
  | "linear_ticket"
  | "sop"
  | "other";
type AgentTask = {
  id: string;
  provider: AgentTaskProvider;
  kind: AgentTaskKind;
  title: string;
  instructions: string;
  clientName?: string;
  priority: "normal" | "high";
  risk: "low" | "approval_required" | "blocked";
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
  finishedAt?: string;
  approvalRequired: boolean;
  approvalReason?: string;
  commitHash?: string;
  pullRequestUrl?: string;
  deployUrl?: string;
  logPath?: string;
  changedFiles?: string[];
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

const clients: DealerClient[] = [
  {
    name: "American Harley-Davidson",
    stage: "Pilot",
    plan: "Starter",
    owner: "Joe Hartrich",
    monthlyFee: 995,
    setupFee: 1500,
    nextAction: "Send dealer agreement for signature",
    due: "Today",
    health: "attention",
    progress: 72,
    domains: ["americanharley.leadrider.ai", "api.americanharley.leadrider.ai"],
    blockers: ["Meta app activation", "Agreement not signed", "Stripe subscription not started"]
  },
  {
    name: "Next Harley Prospect",
    stage: "Prospect",
    plan: "Growth candidate",
    owner: "Joe Hartrich",
    monthlyFee: 1495,
    setupFee: 3000,
    nextAction: "Book discovery call and collect lead volume",
    due: "This week",
    health: "ready",
    progress: 18,
    domains: [],
    blockers: []
  },
  {
    name: "Multi-store Group",
    stage: "Prospect",
    plan: "Enterprise",
    owner: "Joe Hartrich",
    monthlyFee: 0,
    setupFee: 0,
    nextAction: "Define multi-location pricing and data isolation",
    due: "Later",
    health: "blocked",
    progress: 8,
    domains: [],
    blockers: ["Needs billing model", "Needs multi-client architecture decision"]
  }
];

const agents: AgentLane[] = [
  {
    name: "Feedback Loop Agent",
    role: "Reviews thumbs, draft edits, anomalies, and tone reports.",
    status: "running",
    lastRun: "May 19, 3:59 AM",
    nextRun: "Daily at 3:00 AM",
    output: "Auto-commits low-risk fixes. Asks before routing/sending/deploy changes."
  },
  {
    name: "Dealer Setup Agent",
    role: "Runs the onboarding checklist for a selected dealer.",
    status: "ready",
    lastRun: "Not started",
    nextRun: "Manual trigger",
    output: "Creates setup plan, DNS checklist, env checklist, and validation steps."
  },
  {
    name: "Agreement Agent",
    role: "Generates agreement drafts and e-sign packets from selected plan terms.",
    status: "ready",
    lastRun: "American Harley draft created",
    nextRun: "Manual trigger",
    output: "Needs final legal/entity fields before sending."
  },
  {
    name: "Billing Agent",
    role: "Reconciles plans, Stripe/QuickBooks status, and unpaid accounts.",
    status: "needs approval",
    lastRun: "Not connected",
    nextRun: "After QuickBooks/Stripe setup",
    output: "Requires connector access before automation."
  }
];

const connectors: Connector[] = [
  {
    name: "Vercel",
    status: "connected",
    owner: "integrations@leadrider.ai",
    purpose: "Hosts dealer web UI and production domains."
  },
  {
    name: "GitHub",
    status: "connected",
    owner: "Joe / LeadRider",
    purpose: "Code changes, commits, deployments, and release history."
  },
  {
    name: "Sentry / Slack / Linear",
    status: "connected",
    owner: "integrations@leadrider.ai",
    purpose: "Errors, incidents, and ticket escalation."
  },
  {
    name: "DocuSign or Dropbox Sign",
    status: "setup needed",
    owner: "Joe",
    purpose: "Send dealer agreements for signature."
  },
  {
    name: "Stripe",
    status: "setup needed",
    owner: "Joe",
    purpose: "Subscriptions, setup fees, card/ACH, and paywall status."
  },
  {
    name: "QuickBooks",
    status: "planned",
    owner: "Joe",
    purpose: "Accounting sync, invoices, tax records, and revenue reporting."
  }
];

const agentTaskKinds: { value: AgentTaskKind; label: string; provider: AgentTaskProvider; template: string }[] = [
  {
    value: "dealer_setup",
    label: "Dealer setup",
    provider: "codex",
    template: "Create the setup checklist, DNS/env validation list, smoke test plan, and next blockers for this dealer."
  },
  {
    value: "agreement",
    label: "Agreement draft",
    provider: "claude",
    template: "Draft or update the dealer agreement with pricing, setup fee, included usage, approval gates, and e-sign send notes."
  },
  {
    value: "quickbooks",
    label: "QuickBooks review",
    provider: "claude",
    template: "Review invoice/customer setup needs and prepare accounting notes. Do not create invoices or change books without approval."
  },
  {
    value: "email",
    label: "Email draft",
    provider: "claude",
    template: "Draft a professional dealer-facing email for approval. Do not send it."
  },
  {
    value: "prospect_research",
    label: "Prospect research",
    provider: "claude",
    template: "Research this prospect, summarize dealership fit, likely lead volume, decision makers, and recommended next action."
  },
  {
    value: "linear_ticket",
    label: "Linear ticket",
    provider: "codex",
    template: "Create a clear implementation ticket with scope, acceptance checks, and approval risk."
  }
];

const buildSteps = [
  "Agreement drafted",
  "Agreement sent",
  "Agreement signed",
  "Stripe customer created",
  "Subscription active",
  "Dealer DNS verified",
  "API health verified",
  "Twilio/SendGrid tested",
  "Google Calendar connected",
  "CRM logging verified",
  "Meta connected",
  "Go-live smoke test"
];

function money(value: number) {
  if (!value) return "Custom";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);
}

function stageClass(stage: ClientStage) {
  if (stage === "Active") return "lr-ceo-pill-green";
  if (stage === "Pilot" || stage === "Build") return "lr-ceo-pill-blue";
  if (stage === "Agreement") return "lr-ceo-pill-orange";
  return "lr-ceo-pill-gray";
}

function healthLabel(health: Health) {
  if (health === "ready") return "Ready";
  if (health === "attention") return "Needs attention";
  return "Blocked";
}

function healthClass(health: Health) {
  if (health === "ready") return "lr-ceo-status-ready";
  if (health === "attention") return "lr-ceo-status-attention";
  return "lr-ceo-status-blocked";
}

function taskStatusLabel(status: AgentTask["status"]) {
  return status.replace(/_/g, " ");
}

function personalGmailMessageId(task: AgentTask) {
  if (!task.instructions.includes("[personal-mail-auto:") && !/^Review personal email:/i.test(task.title)) return "";
  return task.instructions.match(/Gmail message ID:\s*([^\s]+)/i)?.[1] ?? "";
}

function personalMailRecommendation(task: AgentTask) {
  const text = `${task.output?.summary ?? ""}\n${task.instructions}`.toLowerCase();
  if (text.includes("trash_candidate") || text.includes("spam_or_promo")) return "Trash candidate";
  if (text.includes("draft_reply")) return "Draft reply";
  if (text.includes("needs_approval") || text.includes("vendor_admin")) return "Needs approval";
  if (text.includes("keep_only")) return "Keep only";
  return "Review";
}

function formatRunTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

export default function CeoCommandDashboard() {
  const [selectedClient, setSelectedClient] = useState(clients[0].name);
  const [agreementPlan, setAgreementPlan] = useState("Starter");
  const [commandText, setCommandText] = useState("Prepare American Harley for agreement send and Stripe billing.");
  const [actionNotice, setActionNotice] = useState(
    "Dashboard is ready. Connect DocuSign or Dropbox Sign, Stripe, QuickBooks, and Codex task hooks to automate actions."
  );
  const [agentProvider, setAgentProvider] = useState<AgentTaskProvider>("claude");
  const [agentKind, setAgentKind] = useState<AgentTaskKind>("agreement");
  const [agentPriority, setAgentPriority] = useState<"normal" | "high">("normal");
  const [agentInstructions, setAgentInstructions] = useState(agentTaskKinds[1].template);
  const [agentTasks, setAgentTasks] = useState<AgentTask[]>([]);
  const [automationRuns, setAutomationRuns] = useState<AutomationRun[]>([]);
  const [personalMailStatus, setPersonalMailStatus] = useState<SupportMailStatus | null>(null);
  const [personalMailMessages, setPersonalMailMessages] = useState<SupportMailMessage[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [automationBusyId, setAutomationBusyId] = useState<string | null>(null);

  const client = clients.find(row => row.name === selectedClient) ?? clients[0];
  const monthlyRunRate = useMemo(
    () => clients.reduce((sum, row) => sum + (row.stage === "Active" || row.stage === "Pilot" ? row.monthlyFee : 0), 0),
    []
  );
  const pipelineValue = useMemo(() => clients.reduce((sum, row) => sum + row.monthlyFee, 0), []);
  const blockedCount = clients.filter(row => row.health === "blocked").length;
  const connectedCount = connectors.filter(row => row.status === "connected").length;

  useEffect(() => {
    let active = true;
    fetch("/api/agent-tasks?limit=8", { cache: "no-store" })
      .then(resp => resp.json())
      .then(data => {
        if (!active) return;
        if (data?.ok && Array.isArray(data.tasks)) setAgentTasks(data.tasks);
      })
      .catch(() => {
        if (active) setActionNotice("Agent task history could not be loaded. The dashboard still works for local planning.");
      });
    fetch("/api/automation-runs?limit=6", { cache: "no-store" })
      .then(resp => resp.json())
      .then(data => {
        if (!active) return;
        if (data?.ok && Array.isArray(data.runs)) setAutomationRuns(data.runs);
      })
      .catch(() => null);
    fetch("/api/google/personal-mail/status", { cache: "no-store" })
      .then(resp => resp.json())
      .then(data => {
        if (!active) return;
        if (data?.ok) setPersonalMailStatus(data);
      })
      .catch(() => null);
    fetch("/api/personal-mail/messages?limit=5", { cache: "no-store" })
      .then(resp => resp.json())
      .then(data => {
        if (!active) return;
        if (data?.ok && Array.isArray(data.messages)) setPersonalMailMessages(data.messages);
      })
      .catch(() => null);
    return () => {
      active = false;
    };
  }, []);

  function chooseAgentKind(nextKind: AgentTaskKind) {
    const preset = agentTaskKinds.find(row => row.value === nextKind);
    setAgentKind(nextKind);
    if (preset) {
      setAgentProvider(preset.provider);
      setAgentInstructions(preset.template);
    }
  }

  async function createAgentTask(overrides?: Partial<Pick<AgentTask, "provider" | "kind" | "title" | "instructions" | "priority">>) {
    const provider = overrides?.provider ?? agentProvider;
    const kind = overrides?.kind ?? agentKind;
    const instructions = overrides?.instructions ?? agentInstructions;
    if (!instructions.trim()) {
      setActionNotice("Add instructions before creating an agent task.");
      return;
    }
    setAgentBusy(true);
    try {
      const resp = await fetch("/api/agent-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          kind,
          priority: overrides?.priority ?? agentPriority,
          clientName: client.name,
          title: overrides?.title,
          instructions
        })
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Agent task could not be created.");
      setAgentTasks(current => [data.task, ...current.filter(row => row.id !== data.task.id)].slice(0, 8));
      const approval = data.task?.approval?.required ? " It is waiting for approval before any external action." : "";
      setActionNotice(`${provider === "claude" ? "Claude" : "Codex"} task created: ${data.task.title}.${approval}`);
    } catch (err) {
      setActionNotice(err instanceof Error ? err.message : "Agent task could not be created.");
    } finally {
      setAgentBusy(false);
    }
  }

  async function decideAutomationRun(run: AutomationRun, status: "approved" | "declined") {
    setAutomationBusyId(run.id);
    try {
      const resp = await fetch(`/api/automation-runs/${encodeURIComponent(run.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status })
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Automation run could not be updated.");
      setAutomationRuns(current => current.map(row => (row.id === run.id ? data.run : row)));
      setActionNotice(`Automation run ${status}: ${data.run.name}.`);
    } catch (err) {
      setActionNotice(err instanceof Error ? err.message : "Automation run could not be updated.");
    } finally {
      setAutomationBusyId(null);
    }
  }

  async function updateAgentTask(task: AgentTask, status: AgentTask["status"], summary: string) {
    setAgentBusy(true);
    try {
      const resp = await fetch(`/api/agent-tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, summary })
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Agent task could not be updated.");
      setAgentTasks(current => current.map(row => (row.id === task.id ? data.task : row)));
      setActionNotice(summary);
    } catch (err) {
      setActionNotice(err instanceof Error ? err.message : "Agent task could not be updated.");
    } finally {
      setAgentBusy(false);
    }
  }

  async function trashPersonalMailFromTask(task: AgentTask) {
    const messageId = personalGmailMessageId(task);
    if (!messageId) {
      setActionNotice("This task is missing a Gmail message id, so it cannot be trashed from Command.");
      return;
    }
    setAgentBusy(true);
    try {
      const resp = await fetch(`/api/personal-mail/messages/${encodeURIComponent(messageId)}/trash`, {
        method: "POST"
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Personal email could not be moved to trash.");
      const summary = `Moved personal Gmail message to trash: ${task.title.replace(/^Review personal email:\s*/i, "")}`;
      const taskResp = await fetch(`/api/agent-tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "completed", summary })
      });
      const taskData = await taskResp.json();
      if (taskResp.ok && taskData?.ok) {
        setAgentTasks(current => current.map(row => (row.id === task.id ? taskData.task : row)));
      } else {
        setAgentTasks(current => current.map(row => (row.id === task.id ? { ...row, status: "completed" } : row)));
      }
      setPersonalMailMessages(current => current.filter(message => message.id !== messageId));
      setActionNotice(summary);
    } catch (err) {
      setActionNotice(err instanceof Error ? err.message : "Personal email could not be moved to trash.");
    } finally {
      setAgentBusy(false);
    }
  }

  return (
    <main className="lr-ceo-shell">
      <aside className="lr-ceo-sidebar">
        <div className="lr-ceo-brand">
          <div className="lr-ceo-mark">LR</div>
          <div>
            <p className="lr-ceo-kicker">LeadRider</p>
            <h1>CEO Command</h1>
          </div>
        </div>
        <nav className="lr-ceo-nav" aria-label="CEO command sections">
          <a href="/command" className="is-active">Command Home</a>
          <a href="/command/sales">Sales Funnel</a>
          <a href="/command/support">Support Agent</a>
          <a href="/command/clients/new">Dealer Setup</a>
          <a href="/command/users">Users</a>
          <a href="/command">Agreements</a>
          <a href="/command">Billing</a>
          <a href="/command">Connectors</a>
        </nav>
        <section className="lr-ceo-side-panel">
          <p className="lr-ceo-kicker">Today</p>
          <strong>{client.nextAction}</strong>
          <span>{client.name}</span>
        </section>
      </aside>

      <section className="lr-ceo-main">
        <header className="lr-ceo-header" id="command">
          <div>
            <p className="lr-ceo-kicker">Operating system</p>
            <h2>Dealer build pipeline, agents, billing, and agreements</h2>
            <p>
              Track each client from prospect to live account, see approval blockers, and route work to the right
              agent or connector.
            </p>
          </div>
          <div className="lr-ceo-header-actions">
            <button
              type="button"
              onClick={() =>
                createAgentTask({
                  provider: "claude",
                  kind: "agreement",
                  title: `Prepare ${client.name} agreement packet`,
                  instructions: `Prepare the ${agreementPlan} agreement packet for ${client.name}. Use the existing pricing assumptions and list missing legal/e-sign fields. Do not send it.`
                })
              }
              disabled={agentBusy}
            >
              Generate agreement
            </button>
            <button
              type="button"
              className="lr-ceo-secondary-btn"
              onClick={() =>
                createAgentTask({
                  provider: "codex",
                  kind: "dealer_setup",
                  title: `Run ${client.name} setup review`,
                  instructions: `Review the build status for ${client.name}. Produce setup blockers, DNS/API/web checks, connector gaps, and a recommended next-action list.`
                })
              }
              disabled={agentBusy}
            >
              Run setup review
            </button>
          </div>
        </header>

        <section className="lr-ceo-notice" aria-live="polite">
          {actionNotice}
        </section>

        <section className="lr-ceo-metrics" aria-label="Business metrics">
          <article>
            <span>Monthly run rate</span>
            <strong>{money(monthlyRunRate)}</strong>
            <small>Signed or pilot accounts</small>
          </article>
          <article>
            <span>Pipeline MRR</span>
            <strong>{money(pipelineValue)}</strong>
            <small>Current target plans</small>
          </article>
          <article>
            <span>Connected systems</span>
            <strong>{connectedCount}/{connectors.length}</strong>
            <small>Ready for automation</small>
          </article>
          <article>
            <span>Blocked clients</span>
            <strong>{blockedCount}</strong>
            <small>Need owner decision</small>
          </article>
        </section>

        <section className="lr-ceo-grid">
          <article className="lr-ceo-panel lr-ceo-panel-wide" id="clients">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Client build process</p>
                <h3>Dealer pipeline</h3>
              </div>
              <select value={selectedClient} onChange={event => setSelectedClient(event.target.value)}>
                {clients.map(row => (
                  <option key={row.name} value={row.name}>{row.name}</option>
                ))}
              </select>
            </div>
            <div className="lr-ceo-client-list">
              {clients.map(row => (
                <button
                  key={row.name}
                  type="button"
                  className={row.name === selectedClient ? "is-selected" : ""}
                  onClick={() => setSelectedClient(row.name)}
                >
                  <span>
                    <strong>{row.name}</strong>
                    <small>{row.nextAction}</small>
                  </span>
                  <em className={stageClass(row.stage)}>{row.stage}</em>
                </button>
              ))}
            </div>
          </article>

          <article className="lr-ceo-panel">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Selected client</p>
                <h3>{client.name}</h3>
              </div>
              <span className={healthClass(client.health)}>{healthLabel(client.health)}</span>
            </div>
            <div className="lr-ceo-progress">
              <span style={{ width: `${client.progress}%` }} />
            </div>
            <dl className="lr-ceo-facts">
              <div><dt>Plan</dt><dd>{client.plan}</dd></div>
              <div><dt>Monthly</dt><dd>{money(client.monthlyFee)}</dd></div>
              <div><dt>Setup</dt><dd>{money(client.setupFee)}</dd></div>
              <div><dt>Owner</dt><dd>{client.owner}</dd></div>
            </dl>
            <div className="lr-ceo-blockers">
              <strong>Open blockers</strong>
              {client.blockers.length ? (
                client.blockers.map(item => <span key={item}>{item}</span>)
              ) : (
                <span>No blockers recorded</span>
              )}
            </div>
          </article>
        </section>

        <section className="lr-ceo-grid">
          <article className="lr-ceo-panel" id="agents">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Codex command room</p>
                <h3>Agent lanes</h3>
              </div>
            </div>
            <div className="lr-ceo-agent-list">
              {agents.map(agent => (
                <div key={agent.name} className="lr-ceo-agent-row">
                  <div>
                    <strong>{agent.name}</strong>
                    <p>{agent.role}</p>
                    <small>{agent.output}</small>
                  </div>
                  <span>{agent.status}</span>
                </div>
              ))}
            </div>
          </article>

          <article className="lr-ceo-panel" id="agreements">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Agreement studio</p>
                <h3>Generate dealer packet</h3>
              </div>
            </div>
            <div className="lr-ceo-form-stack">
              <label>
                Dealer
                <input value={client.name} readOnly />
              </label>
              <label>
                Plan
                <select value={agreementPlan} onChange={event => setAgreementPlan(event.target.value)}>
                  <option>Starter</option>
                  <option>Growth</option>
                  <option>Pro</option>
                  <option>Enterprise</option>
                </select>
              </label>
              <div className="lr-ceo-action-row">
                <button
                  type="button"
                  onClick={() =>
                    createAgentTask({
                      provider: "claude",
                      kind: "agreement",
                      title: `Draft ${client.name} ${agreementPlan} agreement`,
                      instructions: `Draft the ${agreementPlan} agreement for ${client.name}. Include pricing, setup fee, included usage, overage rules, approval rules, and e-sign packet checklist. Do not send it.`
                    })
                  }
                  disabled={agentBusy}
                >
                  Draft agreement
                </button>
                <button type="button" className="lr-ceo-secondary-btn" onClick={() => setActionNotice("E-sign send needs a connected DocuSign, Dropbox Sign, or PandaDoc account before it can send from the dashboard.")}>
                  Send e-sign packet
                </button>
              </div>
            </div>
            <p className="lr-ceo-note">
              Current output uses the saved American Harley draft. DocuSign, Dropbox Sign, and PandaDoc can be wired in
              after account selection.
            </p>
          </article>
        </section>

        <section className="lr-ceo-grid">
          <article className="lr-ceo-panel" id="connectors">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Connected stack</p>
                <h3>Systems</h3>
              </div>
            </div>
            <div className="lr-ceo-connector-grid">
              {connectors.map(connector => (
                <div key={connector.name} className="lr-ceo-connector">
                  <strong>{connector.name}</strong>
                  <span>{connector.status}</span>
                  <p>{connector.purpose}</p>
                  <small>Owner: {connector.owner}</small>
                </div>
              ))}
            </div>
          </article>

          <article className="lr-ceo-panel" id="billing">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Build checklist</p>
                <h3>American Harley launch</h3>
              </div>
            </div>
            <div className="lr-ceo-checklist">
              {buildSteps.map((step, index) => {
                const done = index < 6;
                const current = index === 6;
                return (
                  <div key={step} className={done ? "is-done" : current ? "is-current" : ""}>
                    <span>{done ? "OK" : current ? "Now" : ""}</span>
                    <p>{step}</p>
                  </div>
                );
              })}
            </div>
          </article>
        </section>

        <section className="lr-ceo-grid">
          <article className="lr-ceo-panel">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Personal inbox</p>
                <h3>Joe's email</h3>
              </div>
              <span className={personalMailStatus?.connected ? "lr-ceo-status-ready" : "lr-ceo-status-attention"}>
                {personalMailStatus?.connected ? "Gmail connected" : "Gmail needed"}
              </span>
            </div>
            <div className="lr-ceo-mailbox-status">
              <div>
                <strong>{personalMailStatus?.connected ? personalMailStatus.email || "Personal Gmail" : "Connect joe.hartrich@leadrider.ai"}</strong>
                <p>
                  {personalMailStatus?.connected
                    ? "Claude can monitor important personal email and prepare draft replies for approval."
                    : "Connect Joe's LeadRider inbox so Command can show important email and create Claude draft tasks."}
                </p>
              </div>
              {personalMailStatus?.connected ? (
                <span className="lr-ceo-mailbox-connected">Connected</span>
              ) : (
                <a href="/integrations/google/start?kind=personal_mail">Connect Gmail</a>
              )}
            </div>
            <div className="lr-ceo-action-row">
              <button
                type="button"
                onClick={() =>
                  createAgentTask({
                    provider: "claude",
                    kind: "email",
                    priority: "high",
                    title: "Review Joe's personal inbox",
                    instructions:
                      "Review Joe's personal LeadRider inbox messages shown in Command. Summarize what matters, identify obvious spam or promotions separately, and draft any needed replies for approval. Do not send, delete, archive, mark read, unsubscribe, or change external systems."
                  })
                }
                disabled={agentBusy || !personalMailStatus?.connected}
              >
                Ask Claude
              </button>
            </div>
            <div className="lr-ceo-support-flow">
              <div>
                <strong>Important first</strong>
                <p>Dealer, billing, legal, platform, and sales messages stay visible for review.</p>
              </div>
              <div>
                <strong>Drafts only</strong>
                <p>Claude can prepare replies and new emails, but sending stays approval-gated.</p>
              </div>
              <div>
                <strong>Spam reviewed</strong>
                <p>Low-value mail can be classified for review before any delete/archive automation is enabled.</p>
              </div>
            </div>
          </article>

          <article className="lr-ceo-panel">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Recent mail</p>
                <h3>Personal inbox</h3>
              </div>
            </div>
            <div className="lr-ceo-ticket-list">
              {personalMailMessages.length ? (
                personalMailMessages.map(message => (
                  <div key={message.id} className="lr-ceo-mail-row">
                    <span>Gmail</span>
                    <strong>{message.subject}</strong>
                    <small>{message.from}</small>
                    <p>{message.snippet}</p>
                  </div>
                ))
              ) : (
                <p className="lr-ceo-note">
                  {personalMailStatus?.connected ? "No personal inbox messages loaded yet." : "Connect Joe's Gmail to show personal inbox messages here."}
                </p>
              )}
            </div>
          </article>
        </section>

        <section className="lr-ceo-panel">
          <div className="lr-ceo-panel-title">
            <div>
              <p className="lr-ceo-kicker">Closed loop</p>
              <h3>Automation runs</h3>
            </div>
            <span className="lr-ceo-status-ready">Synced</span>
          </div>
          <div className="lr-ceo-run-list">
            {automationRuns.length ? (
              automationRuns.map(run => (
                <div key={run.id} className="lr-ceo-run-row">
                  <div>
                    <span className={`lr-ceo-run-status is-${run.status}`}>{run.status.replace(/_/g, " ")}</span>
                    <strong>{run.name}</strong>
                    <p>{run.summary}</p>
                    <small>
                      {run.source.replace(/_/g, " ")} • {formatRunTime(run.startedAt)}
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
                        <button
                          type="button"
                          onClick={() => decideAutomationRun(run, "approved")}
                          disabled={automationBusyId === run.id}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="lr-ceo-secondary-btn"
                          onClick={() => decideAutomationRun(run, "declined")}
                          disabled={automationBusyId === run.id}
                        >
                          Decline
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
              ))
            ) : (
              <p className="lr-ceo-note">
                No automation runs logged yet. The daily feedback loop will appear here after its next recorded run.
              </p>
            )}
          </div>
        </section>

        <section className="lr-ceo-panel lr-ceo-command-box">
          <div className="lr-ceo-panel-title">
            <div>
              <p className="lr-ceo-kicker">Ask an agent</p>
              <h3>Claude and Codex task launcher</h3>
            </div>
          </div>
          <div className="lr-ceo-agent-composer">
            <label>
              Agent
              <select value={agentProvider} onChange={event => setAgentProvider(event.target.value as AgentTaskProvider)}>
                <option value="claude">Claude - writing, agreements, emails, QuickBooks review</option>
                <option value="codex">Codex - code, setup, smoke tests, tickets</option>
              </select>
            </label>
            <label>
              Work type
              <select value={agentKind} onChange={event => chooseAgentKind(event.target.value as AgentTaskKind)}>
                {agentTaskKinds.map(row => (
                  <option key={row.value} value={row.value}>{row.label}</option>
                ))}
                <option value="other">Other</option>
              </select>
            </label>
            <label>
              Priority
              <select value={agentPriority} onChange={event => setAgentPriority(event.target.value as "normal" | "high")}>
                <option value="normal">Normal</option>
                <option value="high">High</option>
              </select>
            </label>
          </div>
          <textarea value={agentInstructions} onChange={event => setAgentInstructions(event.target.value)} />
          <div className="lr-ceo-action-row">
            <button type="button" onClick={() => createAgentTask()} disabled={agentBusy}>
              Create agent task
            </button>
            <button
              type="button"
              className="lr-ceo-secondary-btn"
              onClick={() =>
                createAgentTask({
                  provider: "codex",
                  kind: "linear_ticket",
                  title: `Create implementation ticket for ${client.name}`,
                  instructions: commandText
                })
              }
              disabled={agentBusy}
            >
              Create implementation task
            </button>
            <button
              type="button"
              className="lr-ceo-secondary-btn"
              onClick={() =>
                createAgentTask({
                  provider: "claude",
                  kind: "sop",
                  title: `Draft SOP for ${client.name}`,
                  instructions: "Turn this workflow into a clear operating procedure for future dealer launches."
                })
              }
              disabled={agentBusy}
            >
              Save as SOP
            </button>
          </div>
          <label className="lr-ceo-command-legacy">
            Implementation ticket note
            <input value={commandText} onChange={event => setCommandText(event.target.value)} />
          </label>
          <div className="lr-ceo-task-list">
            <strong>Recent agent tasks</strong>
            {agentTasks.length ? (
              agentTasks.map(task => (
                <div key={task.id} className="lr-ceo-task-row">
                  <span>{task.provider}</span>
                  <p>
                    <strong>{task.title}</strong>
                    <small>
                      {task.clientName || "No client"} • {taskStatusLabel(task.status)}
                      {task.approval?.required ? ` • approval needed: ${task.approval.reason}` : ""}
                    </small>
                    {personalGmailMessageId(task) ? (
                      <small>Recommendation: {personalMailRecommendation(task)}</small>
                    ) : null}
                    {task.output?.summary ? <small>{task.output.summary}</small> : null}
                  </p>
                  {personalGmailMessageId(task) && task.status === "needs_approval" ? (
                    <div className="lr-ceo-run-actions">
                      <button type="button" onClick={() => trashPersonalMailFromTask(task)} disabled={agentBusy}>
                        Trash email
                      </button>
                      <button
                        type="button"
                        className="lr-ceo-secondary-btn"
                        onClick={() => updateAgentTask(task, "completed", "Reviewed personal email and kept it in the inbox.")}
                        disabled={agentBusy}
                      >
                        Keep
                      </button>
                    </div>
                  ) : null}
                </div>
              ))
            ) : (
              <p className="lr-ceo-note">No agent tasks yet. Create one above to start tracking delegated work.</p>
            )}
          </div>
        </section>
      </section>
    </main>
  );
}
