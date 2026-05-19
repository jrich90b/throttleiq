"use client";

import { useEffect, useMemo, useState } from "react";

type DealerSetupStepStatus = "pending" | "in_progress" | "blocked" | "done";

type DealerSetup = {
  id: string;
  dealerName: string;
  slug: string;
  commandUrl: string;
  appUrl: string;
  apiUrl: string;
  stage: string;
  status: string;
  owner?: string;
  primaryContact?: string;
  legalName?: string;
  dbaName?: string;
  dealerAddress?: string;
  website?: string;
  crmProvider?: string;
  leadVolume?: string;
  plan?: string;
  setupFee?: string;
  monthlyFee?: string;
  includedUsage?: string;
  overageTerms?: string;
  contractTerm?: string;
  billingStart?: string;
  notes?: string;
  steps: Array<{
    id: string;
    label: string;
    status: DealerSetupStepStatus;
    note?: string;
  }>;
  updatedAt: string;
};

type VercelDomain = {
  domain: string;
  exists: boolean;
  verified?: boolean;
  error?: string;
};

type DnsRecord = {
  id: string;
  type: string;
  name: string;
  value: string;
  purpose: string;
};

type SmokeCheck = {
  url: string;
  ok: boolean;
  status: number;
  ms: number;
  error?: string;
};

const emptyForm = {
  dealerName: "",
  slug: "",
  owner: "Joe Hartrich",
  primaryContact: "",
  legalName: "",
  dbaName: "",
  dealerAddress: "",
  website: "",
  crmProvider: "",
  leadVolume: "",
  plan: "Growth",
  setupFee: "",
  monthlyFee: "",
  includedUsage: "",
  overageTerms: "",
  contractTerm: "12 months",
  billingStart: "",
  generateAgreement: false,
  notes: ""
};

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function statusClass(value: string) {
  if (value === "done" || value === "ready" || value === "live") return "is-ready";
  if (value === "blocked") return "is-blocked";
  if (value === "in_progress") return "is-working";
  return "";
}

export default function NewDealerClientPage() {
  const [form, setForm] = useState(emptyForm);
  const [setups, setSetups] = useState<DealerSetup[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [notice, setNotice] = useState("Create a dealer setup when you are ready to start onboarding.");
  const [busy, setBusy] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false);
  const [vercelBusy, setVercelBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [vercelDomains, setVercelDomains] = useState<VercelDomain[]>([]);
  const [dnsRecords, setDnsRecords] = useState<DnsRecord[]>([]);
  const [smokeChecks, setSmokeChecks] = useState<SmokeCheck[]>([]);

  const selected = useMemo(() => setups.find(setup => setup.id === selectedId) ?? setups[0] ?? null, [selectedId, setups]);
  const completion = useMemo(() => {
    if (!selected?.steps.length) return 0;
    return Math.round((selected.steps.filter(step => step.status === "done").length / selected.steps.length) * 100);
  }, [selected]);

  useEffect(() => {
    let active = true;
    fetch("/api/dealer-setups?limit=50", { cache: "no-store" })
      .then(resp => resp.json())
      .then(data => {
        if (!active) return;
        if (data?.ok && Array.isArray(data.setups)) {
          setSetups(data.setups);
          setSelectedId(current => current || data.setups[0]?.id || "");
        }
      })
      .catch(() => {
        if (active) setNotice("Dealer setups could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, []);

  function updateField(field: keyof typeof emptyForm, value: string) {
    setForm(current => ({ ...current, [field]: value }));
  }

  async function createSetup() {
    setBusy(true);
    try {
      const shouldGenerateAgreement = form.generateAgreement;
      const resp = await fetch("/api/dealer-setups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form)
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Dealer setup could not be created.");
      setSetups(current => [data.setup, ...current.filter(row => row.id !== data.setup.id)]);
      setSelectedId(data.setup.id);
      setForm(emptyForm);
      if (shouldGenerateAgreement) {
        await createAgreementTaskForSetup(data.setup);
        setNotice(`Dealer setup created for ${data.setup.dealerName}, and the agreement draft task was created.`);
      } else {
        setNotice(`Dealer setup created for ${data.setup.dealerName}.`);
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Dealer setup could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function createAgreementTaskForSetup(setup: DealerSetup) {
    const facts = [
      `Dealer: ${setup.dealerName}`,
      `Dealer legal name: ${setup.legalName || "not provided"}`,
      `DBA name: ${setup.dbaName || setup.dealerName || "not provided"}`,
      `Dealer address: ${setup.dealerAddress || "not provided"}`,
      `Primary contact: ${setup.primaryContact || "not provided"}`,
      `Website: ${setup.website || "not provided"}`,
      `Plan: ${setup.plan || "not provided"}`,
      `Setup fee: ${setup.setupFee || "not provided"}`,
      `Monthly fee: ${setup.monthlyFee || "not provided"}`,
      `Included usage: ${setup.includedUsage || setup.leadVolume || "not provided"}`,
      `Overage terms: ${setup.overageTerms || "not provided"}`,
      `Contract term: ${setup.contractTerm || "not provided"}`,
      `Billing start: ${setup.billingStart || "not provided"}`,
      `Notes: ${setup.notes || "none"}`
    ].join("\n");
    const resp = await fetch("/api/agent-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "claude",
        kind: "agreement",
        priority: "high",
        clientName: setup.dealerName,
        title: `Draft ${setup.dealerName} agreement`,
        instructions: [
          "Draft a dealer agreement packet using only the structured facts below for business terms.",
          "Do not invent pricing, usage, contract dates, legal names, signer details, or overage terms that are not provided.",
          "Flag missing fields clearly for human review. Do not send the agreement.",
          "",
          facts
        ].join("\n")
      })
    });
    const data = await resp.json();
    if (!resp.ok || !data?.ok) throw new Error(data?.error || "Agreement task could not be created.");
    return data.task;
  }

  async function updateStep(stepId: string, stepStatus: DealerSetupStepStatus) {
    if (!selected) return;
    setBusy(true);
    try {
      const resp = await fetch(`/api/dealer-setups/${encodeURIComponent(selected.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stepId, stepStatus, status: stepStatus === "blocked" ? "blocked" : "in_progress" })
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Setup step could not be updated.");
      setSetups(current => current.map(row => (row.id === data.setup.id ? data.setup : row)));
      setNotice(`${data.setup.dealerName} setup updated.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Setup step could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  async function createSetupTask(kind: "codex" | "agreement" | "vercel" | "stack" | "api" | "providers") {
    if (!selected) return;
    setTaskBusy(true);
    const instructions =
      kind === "agreement"
        ? [
            "Draft a dealer agreement packet using only the structured facts below for business terms.",
            "Do not invent pricing, usage, contract dates, legal names, signer details, or overage terms that are not provided.",
            "Flag missing fields clearly for human review. Do not send the agreement.",
            "",
            `Dealer: ${selected.dealerName}`,
            `Dealer legal name: ${selected.legalName || "not provided"}`,
            `DBA name: ${selected.dbaName || selected.dealerName || "not provided"}`,
            `Dealer address: ${selected.dealerAddress || "not provided"}`,
            `Primary contact: ${selected.primaryContact || "not provided"}`,
            `Website: ${selected.website || "not provided"}`,
            `Plan: ${selected.plan || "not provided"}`,
            `Setup fee: ${selected.setupFee || "not provided"}`,
            `Monthly fee: ${selected.monthlyFee || "not provided"}`,
            `Included usage: ${selected.includedUsage || selected.leadVolume || "not provided"}`,
            `Overage terms: ${selected.overageTerms || "not provided"}`,
            `Contract term: ${selected.contractTerm || "not provided"}`,
            `Billing start: ${selected.billingStart || "not provided"}`,
            `Notes: ${selected.notes || "none"}`
          ].join("\n")
        : kind === "api"
          ? `Create the API dealer setup work for ${selected.dealerName}. Use app URL ${selected.appUrl} and API URL ${selected.apiUrl}. Prepare dealer profile/config, routing defaults, owner/calendar placeholders, domain/callback settings, env requirements, and deploy/smoke-test steps. Do not overwrite existing clients.`
        : kind === "providers"
          ? `Create provider setup tasks for ${selected.dealerName}. Cover Google Workspace/Gmail/calendar, Twilio messaging/phone, SendGrid sender/domain, Meta app/callback, Sentry, Linear, Slack, and OpenAI usage logging. Separate steps that Codex can do from steps needing human login, billing, OAuth consent, phone verification, or credentials.`
        : kind === "stack"
          ? `Create the full tech-stack setup plan for ${selected.dealerName}. Include Vercel app domains, DNS records, API dealer profile/config, Google Workspace/Gmail/calendar, Twilio phone/messaging, SendGrid sender/domain, OpenAI usage logging, Meta app/callback, Sentry, Linear, Slack alerts, smoke tests, and handoff steps. Identify which steps can be automated now and which require human login, billing, verification, OAuth consent, or credentials.`
        : kind === "vercel"
          ? `Prepare Vercel deployment steps for ${selected.dealerName}. Target app URL: ${selected.appUrl}. Target API URL: ${selected.apiUrl}. List required Vercel project/domain/env changes and DNS records. Do not make external changes without approval.`
          : `Run dealer setup review for ${selected.dealerName}. Check onboarding blockers across Vercel, DNS, API dealer config, Google, Twilio, SendGrid, Meta, agreement, and smoke testing. Return the next action list.`;
    try {
      const resp = await fetch("/api/agent-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: kind === "agreement" ? "claude" : "codex",
          kind: kind === "agreement" ? "agreement" : "dealer_setup",
          priority: "high",
          clientName: selected.dealerName,
          title:
            kind === "agreement"
              ? `Draft ${selected.dealerName} agreement`
              : kind === "api"
                ? `Create ${selected.dealerName} API config task`
              : kind === "providers"
                ? `Create ${selected.dealerName} provider setup tasks`
              : kind === "stack"
                ? `Build ${selected.dealerName} tech-stack setup plan`
              : kind === "vercel"
                ? `Prepare ${selected.dealerName} Vercel setup`
                : `Run ${selected.dealerName} setup review`,
          instructions
        })
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Agent task could not be created.");
      setNotice(`Agent task created: ${data.task.title}.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Agent task could not be created.");
    } finally {
      setTaskBusy(false);
    }
  }

  async function generateDnsChecklist() {
    if (!selected) return;
    setActionBusy(true);
    try {
      const resp = await fetch(`/api/dealer-setups/${encodeURIComponent(selected.id)}/dns/checklist`, { method: "POST" });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "DNS checklist could not be generated.");
      setDnsRecords(Array.isArray(data.records) ? data.records : []);
      if (data.setup) setSetups(current => current.map(row => (row.id === data.setup.id ? data.setup : row)));
      setNotice("DNS checklist generated for the dealer app and API domains.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "DNS checklist could not be generated.");
    } finally {
      setActionBusy(false);
    }
  }

  async function runSmokeTest() {
    if (!selected) return;
    setActionBusy(true);
    try {
      const resp = await fetch(`/api/dealer-setups/${encodeURIComponent(selected.id)}/smoke-test`, { method: "POST" });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Smoke test could not be run.");
      setSmokeChecks(Array.isArray(data.checks) ? data.checks : []);
      if (data.setup) setSetups(current => current.map(row => (row.id === data.setup.id ? data.setup : row)));
      setNotice(data.passed ? "Launch smoke test passed." : "Launch smoke test found a blocker.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Smoke test could not be run.");
    } finally {
      setActionBusy(false);
    }
  }

  async function checkVercelDomains() {
    if (!selected) return;
    setVercelBusy(true);
    try {
      const resp = await fetch(`/api/dealer-setups/${encodeURIComponent(selected.id)}/vercel`, { cache: "no-store" });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Vercel status could not be checked.");
      setVercelDomains(Array.isArray(data.domains) ? data.domains : []);
      setNotice(data.configured ? "Vercel status checked." : "Vercel token is not configured yet. Add VERCEL_API_TOKEN on the API server to automate domains.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Vercel status could not be checked.");
    } finally {
      setVercelBusy(false);
    }
  }

  async function addVercelDomains() {
    if (!selected) return;
    setVercelBusy(true);
    try {
      const resp = await fetch(`/api/dealer-setups/${encodeURIComponent(selected.id)}/vercel/domains`, { method: "POST" });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Vercel domains could not be added.");
      setVercelDomains(Array.isArray(data.domains) ? data.domains : []);
      if (data.setup) setSetups(current => current.map(row => (row.id === data.setup.id ? data.setup : row)));
      setNotice("Vercel domains added or confirmed. DNS may still need to be pointed and verified.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Vercel domains could not be added.");
    } finally {
      setVercelBusy(false);
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
          <a href="/command/support">Support Agent</a>
          <a href="/command/clients/new" className="is-active">Dealer Setup</a>
          <a href="/command">Agreements</a>
          <a href="/command">Billing</a>
          <a href="/command">Connectors</a>
        </nav>
        <section className="lr-ceo-side-panel">
          <p className="lr-ceo-kicker">Dealer setup</p>
          <strong>{setups.length} setup records</strong>
          <span>{selected ? `${completion}% complete for ${selected.dealerName}` : "No dealer selected"}</span>
        </section>
      </aside>

      <section className="lr-ceo-main">
        <header className="lr-ceo-header">
          <div>
            <p className="lr-ceo-kicker">Client onboarding</p>
            <h2>New Dealer Client</h2>
            <p>Create the setup record, track Vercel/DNS/API/connectors, and generate the Codex work needed to bring a dealer live.</p>
          </div>
          <div className="lr-ceo-header-actions">
            <button type="button" onClick={() => createSetupTask("codex")} disabled={!selected || taskBusy}>
              Run setup review
            </button>
            <button type="button" className="lr-ceo-secondary-btn" onClick={() => createSetupTask("vercel")} disabled={!selected || taskBusy}>
              Prepare Vercel
            </button>
            <button type="button" className="lr-ceo-secondary-btn" onClick={() => createSetupTask("stack")} disabled={!selected || taskBusy}>
              Tech stack plan
            </button>
            <button type="button" className="lr-ceo-secondary-btn" onClick={() => createSetupTask("providers")} disabled={!selected || taskBusy}>
              Provider tasks
            </button>
          </div>
        </header>

        <section className="lr-ceo-notice" aria-live="polite">{notice}</section>

        <section className="lr-ceo-grid">
          <article className="lr-ceo-panel">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Create setup</p>
                <h3>Dealer intake</h3>
              </div>
            </div>
            <div className="lr-ceo-form-stack">
              <label>
                Dealer name
                <input value={form.dealerName} onChange={event => updateField("dealerName", event.target.value)} placeholder="American Harley-Davidson" />
              </label>
              <label>
                Subdomain slug
                <input value={form.slug} onChange={event => updateField("slug", event.target.value)} placeholder="americanharley" />
              </label>
              <label>
                Owner
                <input value={form.owner} onChange={event => updateField("owner", event.target.value)} />
              </label>
              <label>
                Primary contact
                <input value={form.primaryContact} onChange={event => updateField("primaryContact", event.target.value)} placeholder="Name, email, phone" />
              </label>
              <label>
                Dealer legal name
                <input value={form.legalName} onChange={event => updateField("legalName", event.target.value)} placeholder="Legal entity name" />
              </label>
              <label>
                DBA name
                <input value={form.dbaName} onChange={event => updateField("dbaName", event.target.value)} placeholder="American Harley-Davidson" />
              </label>
              <label>
                Dealer address
                <textarea value={form.dealerAddress} onChange={event => updateField("dealerAddress", event.target.value)} placeholder="Street, city, state, ZIP" />
              </label>
              <label>
                Dealer website
                <input value={form.website} onChange={event => updateField("website", event.target.value)} placeholder="https://..." />
              </label>
              <label>
                CRM / lead source
                <input value={form.crmProvider} onChange={event => updateField("crmProvider", event.target.value)} placeholder="Traffic Log Pro, ADF, ..." />
              </label>
              <label>
                Lead volume
                <input value={form.leadVolume} onChange={event => updateField("leadVolume", event.target.value)} placeholder="300 leads/month" />
              </label>
              <label>
                Plan
                <select value={form.plan} onChange={event => updateField("plan", event.target.value)}>
                  <option>Starter</option>
                  <option>Growth</option>
                  <option>Pro</option>
                  <option>Enterprise</option>
                </select>
              </label>
              <label>
                Setup fee
                <input value={form.setupFee} onChange={event => updateField("setupFee", event.target.value)} placeholder="$2,500" />
              </label>
              <label>
                Monthly fee
                <input value={form.monthlyFee} onChange={event => updateField("monthlyFee", event.target.value)} placeholder="$1,500/month" />
              </label>
              <label>
                Included usage
                <input value={form.includedUsage} onChange={event => updateField("includedUsage", event.target.value)} placeholder="Up to 500 leads/month, standard SMS/email usage" />
              </label>
              <label>
                Overage terms
                <input value={form.overageTerms} onChange={event => updateField("overageTerms", event.target.value)} placeholder="Usage above included tier billed at..." />
              </label>
              <label>
                Contract term
                <input value={form.contractTerm} onChange={event => updateField("contractTerm", event.target.value)} placeholder="12 months" />
              </label>
              <label>
                Billing start
                <input value={form.billingStart} onChange={event => updateField("billingStart", event.target.value)} placeholder="On launch / June 1, 2026" />
              </label>
              <label className="lr-ceo-checkbox-row">
                <input
                  type="checkbox"
                  checked={form.generateAgreement}
                  onChange={event => setForm(current => ({ ...current, generateAgreement: event.target.checked }))}
                />
                Generate agreement draft on create
              </label>
              <label>
                Notes
                <textarea value={form.notes} onChange={event => updateField("notes", event.target.value)} placeholder="Special routing, owners, calendar notes, pricing assumptions..." />
              </label>
              <button type="button" onClick={createSetup} disabled={busy || !form.dealerName.trim()}>
                Create dealer setup
              </button>
            </div>
          </article>

          <article className="lr-ceo-panel lr-ceo-panel-wide">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Build pipeline</p>
                <h3>{selected ? selected.dealerName : "No dealer selected"}</h3>
              </div>
              <select value={selected?.id || ""} onChange={event => setSelectedId(event.target.value)}>
                {setups.length ? setups.map(setup => <option key={setup.id} value={setup.id}>{setup.dealerName}</option>) : <option value="">No setups</option>}
              </select>
            </div>

            {selected ? (
              <>
                <div className="lr-ceo-progress">
                  <span style={{ width: `${completion}%` }} />
                </div>
                <dl className="lr-ceo-facts">
                  <div><dt>App URL</dt><dd>{selected.appUrl}</dd></div>
                  <div><dt>API URL</dt><dd>{selected.apiUrl}</dd></div>
                  <div><dt>Command</dt><dd>{selected.commandUrl}</dd></div>
                  <div><dt>Updated</dt><dd>{formatTime(selected.updatedAt)}</dd></div>
                </dl>
                <div className="lr-ceo-action-row">
                  <button type="button" onClick={() => createSetupTask("agreement")} disabled={taskBusy}>
                    Draft agreement
                  </button>
                  <button type="button" onClick={addVercelDomains} disabled={vercelBusy}>
                    Add Vercel domains
                  </button>
                  <button type="button" className="lr-ceo-secondary-btn" onClick={checkVercelDomains} disabled={vercelBusy}>
                    Check Vercel
                  </button>
                  <button type="button" className="lr-ceo-secondary-btn" onClick={generateDnsChecklist} disabled={actionBusy}>
                    DNS checklist
                  </button>
                  <button type="button" className="lr-ceo-secondary-btn" onClick={() => createSetupTask("api")} disabled={taskBusy}>
                    API config task
                  </button>
                  <button type="button" className="lr-ceo-secondary-btn" onClick={runSmokeTest} disabled={actionBusy}>
                    Smoke test
                  </button>
                  <button type="button" className="lr-ceo-secondary-btn" onClick={() => createSetupTask("codex")} disabled={taskBusy}>
                    Create Codex task
                  </button>
                </div>
                {vercelDomains.length ? (
                  <div className="lr-ceo-vercel-status">
                    {vercelDomains.map(domain => (
                      <span key={domain.domain} className={domain.exists && domain.verified ? "is-ready" : domain.error ? "is-blocked" : "is-working"}>
                        {domain.domain}: {domain.error || (domain.exists ? (domain.verified ? "verified" : "pending DNS") : "not added")}
                      </span>
                    ))}
                  </div>
                ) : null}
                {dnsRecords.length ? (
                  <div className="lr-ceo-dns-records">
                    {dnsRecords.map(record => (
                      <div key={record.id}>
                        <span>{record.type}</span>
                        <strong>{record.name}</strong>
                        <code>{record.value}</code>
                        <small>{record.purpose}</small>
                      </div>
                    ))}
                  </div>
                ) : null}
                {smokeChecks.length ? (
                  <div className="lr-ceo-vercel-status">
                    {smokeChecks.map(check => (
                      <span key={check.url} className={check.ok ? "is-ready" : "is-blocked"}>
                        {check.url}: {check.status || check.error} ({check.ms}ms)
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="lr-ceo-setup-steps">
                  {selected.steps.map(step => (
                    <div key={step.id} className="lr-ceo-setup-step">
                      <span className={statusClass(step.status)}>{step.status.replace(/_/g, " ")}</span>
                      <strong>{step.label}</strong>
                      {step.note ? <p>{step.note}</p> : null}
                      <div>
                        <button type="button" className="lr-ceo-secondary-btn" onClick={() => updateStep(step.id, "in_progress")} disabled={busy}>
                          Start
                        </button>
                        <button type="button" className="lr-ceo-secondary-btn" onClick={() => updateStep(step.id, "blocked")} disabled={busy}>
                          Block
                        </button>
                        <button type="button" onClick={() => updateStep(step.id, "done")} disabled={busy}>
                          Done
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="lr-ceo-note">Create the first dealer setup to start the onboarding workflow.</p>
            )}
          </article>
        </section>
      </section>
    </main>
  );
}
