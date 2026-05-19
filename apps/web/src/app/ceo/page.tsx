"use client";

import { useMemo, useState } from "react";

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

export default function CeoCommandDashboard() {
  const [selectedClient, setSelectedClient] = useState(clients[0].name);
  const [agreementPlan, setAgreementPlan] = useState("Starter");
  const [commandText, setCommandText] = useState("Prepare American Harley for agreement send and Stripe billing.");
  const [actionNotice, setActionNotice] = useState(
    "Dashboard is ready. Connect DocuSign or Dropbox Sign, Stripe, QuickBooks, and Codex task hooks to automate actions."
  );

  const client = clients.find(row => row.name === selectedClient) ?? clients[0];
  const monthlyRunRate = useMemo(
    () => clients.reduce((sum, row) => sum + (row.stage === "Active" || row.stage === "Pilot" ? row.monthlyFee : 0), 0),
    []
  );
  const pipelineValue = useMemo(() => clients.reduce((sum, row) => sum + row.monthlyFee, 0), []);
  const blockedCount = clients.filter(row => row.health === "blocked").length;
  const connectedCount = connectors.filter(row => row.status === "connected").length;

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
          {["Command", "Clients", "Agents", "Agreements", "Billing", "Connectors"].map(item => (
            <a key={item} href={`#${item.toLowerCase()}`}>
              {item}
            </a>
          ))}
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
            <button type="button" onClick={() => setActionNotice("Agreement draft exists. Next step: choose DocuSign, Dropbox Sign, or PandaDoc and connect the e-sign workflow.")}>
              Generate agreement
            </button>
            <button type="button" className="lr-ceo-secondary-btn" onClick={() => setActionNotice("Setup review is ready to route to Codex. Next step: wire this button to the Dealer Setup Agent automation.")}>
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
                <button type="button" onClick={() => setActionNotice(`${client.name} agreement packet is staged for the ${agreementPlan} plan. Final legal fields are required before sending.`)}>
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

        <section className="lr-ceo-panel lr-ceo-command-box">
          <div className="lr-ceo-panel-title">
            <div>
              <p className="lr-ceo-kicker">Ask an agent</p>
              <h3>Command draft</h3>
            </div>
          </div>
          <textarea value={commandText} onChange={event => setCommandText(event.target.value)} />
          <div className="lr-ceo-action-row">
            <button type="button" onClick={() => setActionNotice(`Codex command staged: "${commandText}"`)}>
              Send to Codex
            </button>
            <button type="button" className="lr-ceo-secondary-btn" onClick={() => setActionNotice("Linear is connected for incidents. Next step: add a CEO-dashboard task creation endpoint.")}>
              Create Linear task
            </button>
            <button type="button" className="lr-ceo-secondary-btn" onClick={() => setActionNotice("SOP save is staged. Next step: connect Notion or Google Drive as the operating manual destination.")}>
              Save as SOP
            </button>
          </div>
        </section>
      </section>
    </main>
  );
}
