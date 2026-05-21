"use client";

import { useEffect, useMemo, useState } from "react";

type SalesProspectStage =
  | "new"
  | "contacted"
  | "discovery"
  | "demo_scheduled"
  | "proposal"
  | "agreement_sent"
  | "closed_won"
  | "closed_lost";

type SalesProspect = {
  id: string;
  dealerName: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  website?: string;
  stage: SalesProspectStage;
  owner?: string;
  leadVolume?: string;
  plan?: string;
  expectedMonthly?: string;
  nextStep?: string;
  nextStepAt?: string;
  zoomLink?: string;
  docusignPacketId?: string;
  onboardingEmailThread?: string;
  emailSenderType?: "personal" | "onboarding" | "support";
  emailSenderAddress?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

type ZoomStatus = {
  configured: boolean;
  connected: boolean;
  connectedAt?: string;
  updatedAt?: string;
  apiBase?: string;
  redirectUri?: string;
  scopes?: string;
  missing?: string[];
};

type ProspectForm = {
  dealerName: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  website: string;
  stage: SalesProspectStage;
  owner: string;
  leadVolume: string;
  plan: string;
  expectedMonthly: string;
  nextStep: string;
  nextStepAt: string;
  zoomLink: string;
  docusignPacketId: string;
  onboardingEmailThread: string;
  emailSenderType: "personal" | "onboarding" | "support";
  emailSenderAddress: string;
  notes: string;
};

const emptyForm: ProspectForm = {
  dealerName: "",
  contactName: "",
  contactEmail: "",
  contactPhone: "",
  website: "",
  stage: "new",
  owner: "",
  leadVolume: "",
  plan: "Starter",
  expectedMonthly: "$999/month",
  nextStep: "",
  nextStepAt: "",
  zoomLink: "",
  docusignPacketId: "",
  onboardingEmailThread: "",
  emailSenderType: "personal",
  emailSenderAddress: "joe.hartrich@leadrider.ai",
  notes: ""
};

const stageLabels: Record<SalesProspectStage, string> = {
  new: "New",
  contacted: "Contacted",
  discovery: "Discovery",
  demo_scheduled: "Demo scheduled",
  proposal: "Proposal",
  agreement_sent: "Agreement sent",
  closed_won: "Won",
  closed_lost: "Lost"
};

const funnelStages: SalesProspectStage[] = ["new", "contacted", "discovery", "demo_scheduled", "proposal", "agreement_sent"];
const stageProgression: SalesProspectStage[] = ["new", "contacted", "discovery", "demo_scheduled", "proposal", "agreement_sent", "closed_won"];

function toForm(prospect: SalesProspect): ProspectForm {
  return {
    dealerName: prospect.dealerName || "",
    contactName: prospect.contactName || "",
    contactEmail: prospect.contactEmail || "",
    contactPhone: prospect.contactPhone || "",
    website: prospect.website || "",
    stage: prospect.stage || "new",
    owner: prospect.owner || "",
    leadVolume: prospect.leadVolume || "",
    plan: prospect.plan || "",
    expectedMonthly: prospect.expectedMonthly || "",
    nextStep: prospect.nextStep || "",
    nextStepAt: prospect.nextStepAt || "",
    zoomLink: prospect.zoomLink || "",
    docusignPacketId: prospect.docusignPacketId || "",
    onboardingEmailThread: prospect.onboardingEmailThread || "",
    emailSenderType: prospect.emailSenderType || "personal",
    emailSenderAddress: prospect.emailSenderAddress || emailAddressForSender(prospect.emailSenderType || "personal"),
    notes: prospect.notes || ""
  };
}

const emailSenderOptions: Array<{ value: ProspectForm["emailSenderType"]; label: string; email: string; managedBy: string }> = [
  {
    value: "personal",
    label: "Personal sales",
    email: "joe.hartrich@leadrider.ai",
    managedBy: "Claude drafts only; Joe approves before send"
  },
  {
    value: "onboarding",
    label: "Onboarding",
    email: "onboarding@leadrider.ai",
    managedBy: "Claude drafts onboarding emails for approval"
  },
  {
    value: "support",
    label: "Support",
    email: "support@leadrider.ai",
    managedBy: "Claude drafts support replies for approval"
  }
];

function emailAddressForSender(sender: ProspectForm["emailSenderType"] | undefined) {
  return emailSenderOptions.find(option => option.value === sender)?.email || "joe.hartrich@leadrider.ai";
}

function labelForSender(sender: ProspectForm["emailSenderType"] | undefined) {
  return emailSenderOptions.find(option => option.value === sender)?.label || "Personal sales";
}

function formatDate(value?: string) {
  if (!value) return "No date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function moneyValue(value?: string) {
  const match = String(value ?? "").match(/[\d,.]+/);
  if (!match) return 0;
  return Number(match[0].replace(/,/g, "")) || 0;
}

function isAtLeastStage(stage: SalesProspectStage | undefined, minimum: SalesProspectStage) {
  const currentIndex = stageProgression.indexOf(stage || "new");
  const minimumIndex = stageProgression.indexOf(minimum);
  return currentIndex >= minimumIndex && minimumIndex >= 0;
}

function commandApiError(message?: string) {
  if (message === "auth required" || message === "invalid session" || message === "user not found") {
    return "Sign in on www.leadrider.ai first, then try Zoom again.";
  }
  if (message === "manager required" || message === "forbidden") {
    return "Your LeadRider account does not have permission to manage Zoom.";
  }
  return message || "Request failed.";
}

export default function SalesFunnelPage() {
  const [prospects, setProspects] = useState<SalesProspect[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [form, setForm] = useState<ProspectForm>(emptyForm);
  const [newForm, setNewForm] = useState<ProspectForm>(emptyForm);
  const [showAddProspect, setShowAddProspect] = useState(false);
  const [notice, setNotice] = useState("Sales Funnel is ready.");
  const [busy, setBusy] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false);
  const [zoomStatus, setZoomStatus] = useState<ZoomStatus | null>(null);
  const [zoomBusy, setZoomBusy] = useState(false);

  const selected = useMemo(
    () => prospects.find(prospect => prospect.id === selectedId) ?? prospects[0] ?? null,
    [prospects, selectedId]
  );

  useEffect(() => {
    void loadProspects();
    void loadZoomStatus();
  }, []);

  useEffect(() => {
    if (selected) {
      setSelectedId(selected.id);
      setForm(toForm(selected));
    }
  }, [selected?.id]);

  const metrics = useMemo(() => {
    const open = prospects.filter(row => row.stage !== "closed_won" && row.stage !== "closed_lost");
    const proposals = prospects.filter(row => row.stage === "proposal" || row.stage === "agreement_sent");
    const won = prospects.filter(row => row.stage === "closed_won");
    const pipeline = open.reduce((sum, row) => sum + moneyValue(row.expectedMonthly), 0);
    return { open: open.length, proposals: proposals.length, won: won.length, pipeline };
  }, [prospects]);

  async function loadProspects() {
    try {
      const resp = await fetch("/api/sales-prospects?limit=250", { cache: "no-store" });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(commandApiError(data?.error || "Sales prospects could not be loaded."));
      const rows = Array.isArray(data.prospects) ? data.prospects : [];
      setProspects(rows);
      if (rows.length && !selectedId) setSelectedId(rows[0].id);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Sales prospects could not be loaded.");
    }
  }

  async function createProspect() {
    if (!newForm.dealerName.trim()) {
      setNotice("Dealer name is required.");
      return;
    }
    setBusy(true);
    try {
      const resp = await fetch("/api/sales-prospects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newForm)
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Prospect could not be created.");
      setProspects(current => [data.prospect, ...current]);
      setSelectedId(data.prospect.id);
      setNewForm(emptyForm);
      setShowAddProspect(false);
      setNotice(`${data.prospect.dealerName} added to the sales funnel.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Prospect could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function saveProspect(patch: Partial<ProspectForm> = {}) {
    if (!selected) return;
    setBusy(true);
    try {
      const resp = await fetch(`/api/sales-prospects/${encodeURIComponent(selected.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, ...patch })
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Prospect could not be updated.");
      setProspects(current => current.map(row => (row.id === data.prospect.id ? data.prospect : row)));
      setForm(toForm(data.prospect));
      setNotice(`${data.prospect.dealerName} updated.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Prospect could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  async function advanceProspectStage(prospect: SalesProspect, targetStage: SalesProspectStage, noticePrefix: string) {
    const currentIndex = stageProgression.indexOf(prospect.stage);
    const targetIndex = stageProgression.indexOf(targetStage);
    if (targetIndex < 0 || currentIndex < 0 || currentIndex >= targetIndex) return prospect;

    const resp = await fetch(`/api/sales-prospects/${encodeURIComponent(prospect.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...toForm(prospect), stage: targetStage })
    });
    const data = await resp.json();
    if (!resp.ok || !data?.ok) throw new Error(data?.error || "Prospect stage could not be updated.");
    setProspects(current => current.map(row => (row.id === data.prospect.id ? data.prospect : row)));
    setForm(toForm(data.prospect));
    setNotice(`${noticePrefix} Flow moved to ${stageLabels[targetStage]}.`);
    return data.prospect as SalesProspect;
  }

  async function loadZoomStatus() {
    try {
      const resp = await fetch("/api/integrations/zoom/status", { cache: "no-store" });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(commandApiError(data?.error || "Zoom status could not be loaded."));
      setZoomStatus(data);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Zoom status could not be loaded.");
    }
  }

  async function connectZoom() {
    setZoomBusy(true);
    try {
      const resp = await fetch("/api/integrations/zoom/start", { cache: "no-store" });
      const data = await resp.json();
      if (!resp.ok || !data?.ok || !data.url) throw new Error(commandApiError(data?.error || "Zoom connection could not start."));
      window.location.href = data.url;
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Zoom connection could not start.");
    } finally {
      setZoomBusy(false);
    }
  }

  async function createZoomMeeting() {
    if (!selected) return;
    if (!zoomStatus?.connected) {
      setNotice(zoomStatus?.configured ? "Connect Zoom before creating a meeting." : `Zoom is missing settings: ${(zoomStatus?.missing || []).join(", ") || "Zoom app credentials"}.`);
      return;
    }
    if (!form.nextStepAt && !selected.nextStepAt) {
      setNotice("Set the next step date before scheduling a demo.");
      return;
    }
    setZoomBusy(true);
    try {
      const resp = await fetch(`/api/sales-prospects/${encodeURIComponent(selected.id)}/zoom/meeting`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: `LeadRider discovery - ${form.dealerName || selected.dealerName}`,
          startTime: form.nextStepAt || selected.nextStepAt,
          duration: 30,
          agenda: [
            `Dealer prospect: ${form.dealerName || selected.dealerName}`,
            form.contactName ? `Contact: ${form.contactName}` : "",
            form.contactEmail ? `Email: ${form.contactEmail}` : "",
            form.contactPhone ? `Phone: ${form.contactPhone}` : "",
            form.website ? `Website: ${form.website}` : "",
            form.nextStep ? `Next step: ${form.nextStep}` : ""
          ].filter(Boolean).join("\n")
        })
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Zoom meeting could not be created.");
      setProspects(current => current.map(row => (row.id === data.prospect.id ? data.prospect : row)));
      setForm(toForm(data.prospect));
      setNotice(`Zoom meeting created for ${data.prospect.dealerName}.`);
      await advanceProspectStage(data.prospect, "demo_scheduled", `Zoom meeting created for ${data.prospect.dealerName}.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Zoom meeting could not be created.");
    } finally {
      setZoomBusy(false);
    }
  }

  async function pushToDealerSetup() {
    if (!selected) return;
    setBusy(true);
    try {
      const resp = await fetch(`/api/sales-prospects/${encodeURIComponent(selected.id)}/dealer-setup`, {
        method: "POST"
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Dealer setup could not be created.");
      if (data.prospect) setProspects(current => current.map(row => (row.id === data.prospect.id ? data.prospect : row)));
      if (data.prospect) await advanceProspectStage(data.prospect, "closed_won", `${data.setup.dealerName} is in Dealer Setup.`);
      const setupUrl = `/command/clients/new?setup=${encodeURIComponent(data.setup.id)}`;
      setNotice(`${data.setup.dealerName} is in Dealer Setup. ${data.existing ? "Opening existing setup." : "Opening new setup."}`);
      window.location.href = setupUrl;
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Dealer setup could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function createAgentTask(action: "sales_email" | "zoom" | "onboarding" | "docusign" | "research") {
    if (!selected) return;
    setTaskBusy(true);
    const senderType = form.emailSenderType || selected.emailSenderType || "personal";
    const senderAddress = form.emailSenderAddress || selected.emailSenderAddress || emailAddressForSender(senderType);
    const facts = [
      `Dealer prospect: ${selected.dealerName}`,
      `Contact: ${selected.contactName || "not provided"}`,
      `Email: ${selected.contactEmail || "not provided"}`,
      `Phone: ${selected.contactPhone || "not provided"}`,
      `Website: ${selected.website || "not provided"}`,
      `Stage: ${stageLabels[selected.stage]}`,
      `Owner: ${selected.owner || "not assigned"}`,
      `Plan: ${selected.plan || "not selected"}`,
      `Expected monthly: ${selected.expectedMonthly || "not set"}`,
      `Lead volume: ${selected.leadVolume || "not set"}`,
      `Next step: ${selected.nextStep || "not set"}`,
      `Next step date: ${selected.nextStepAt || "not set"}`,
      `Zoom link: ${selected.zoomLink || "not set"}`,
      `DocuSign packet: ${selected.docusignPacketId || "not set"}`,
      `Onboarding email thread: ${selected.onboardingEmailThread || "not set"}`,
      `Selected email sender lane: ${labelForSender(senderType)} (${senderAddress})`,
      `Notes: ${selected.notes || "none"}`
    ].join("\n");
    const config = {
      sales_email: {
        provider: "claude",
        kind: "email",
        title: `Draft sales follow-up for ${selected.dealerName}`,
        instructions: [
          `Draft a prospect follow-up email from ${senderAddress}.`,
          "This is approval-gated draft work only. Do not send the email, delete mail, mark messages read, or change external systems.",
          "If the sender is a personal sales inbox, write in Joe's voice and make the next step clear.",
          "Return subject, body, and a short note explaining why this email is appropriate.",
          "",
          facts
        ].join("\n")
      },
      zoom: {
        provider: "codex",
        kind: "prospect_research",
        title: `Prepare Zoom/Fathom workflow for ${selected.dealerName}`,
        instructions: [
          "Prepare a Zoom meeting workflow for this prospect. Use the logged-in salesperson email when connected.",
          "Include Fathom note capture requirements. Do not send invites or emails without approval.",
          "Return the exact missing account/API credentials or OAuth steps.",
          "",
          facts
        ].join("\n")
      },
      onboarding: {
        provider: "claude",
        kind: "email",
        title: `Draft onboarding email for ${selected.dealerName}`,
        instructions: [
          "Draft an onboarding email from onboarding@leadrider.ai for this prospect.",
          "Keep it approval-gated. Do not send the email, delete mail, or change CRM data.",
          "Include next steps, agreement status, and any setup items needed from the dealer.",
          "",
          facts
        ].join("\n")
      },
      docusign: {
        provider: "claude",
        kind: "agreement",
        title: `Prepare DocuSign packet for ${selected.dealerName}`,
        instructions: [
          "Prepare the DocuSign agreement packet for this prospect using only the facts below.",
          "Flag missing legal name, DBA, signer, address, pricing, and billing terms. Do not send the packet.",
          "",
          facts
        ].join("\n")
      },
      research: {
        provider: "codex",
        kind: "prospect_research",
        title: `Research ${selected.dealerName} sales opportunity`,
        instructions: [
          "Research and summarize the sales opportunity for this dealer prospect.",
          "Focus on lead volume, current website/forms, CRM clues, buying committee, and likely setup blockers.",
          "Do not contact the dealer or change external systems.",
          "",
          facts
        ].join("\n")
      }
    }[action];
    try {
      const resp = await fetch("/api/agent-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...config,
          priority: action === "sales_email" || action === "onboarding" || action === "docusign" ? "high" : "normal",
          clientName: selected.dealerName
        })
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Agent task could not be created.");
      setNotice(`Agent task created: ${data.task.title}.`);
      const autoStageByAction: Partial<Record<typeof action, SalesProspectStage>> = {
        sales_email: "contacted",
        docusign: "proposal"
      };
      const nextStage = autoStageByAction[action];
      if (nextStage) {
        await advanceProspectStage(selected, nextStage, `Agent task created: ${data.task.title}.`);
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Agent task could not be created.");
    } finally {
      setTaskBusy(false);
    }
  }

  function updateNew(field: keyof ProspectForm, value: string) {
    setNewForm(current => ({ ...current, [field]: value }));
  }

  function updateForm(field: keyof ProspectForm, value: string) {
    setForm(current => ({ ...current, [field]: value }));
  }

  function updateEmailSender(value: ProspectForm["emailSenderType"]) {
    setForm(current => ({ ...current, emailSenderType: value, emailSenderAddress: emailAddressForSender(value) }));
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
          <a href="/command/sales" className="is-active">Sales Funnel</a>
          <a href="/command/support">Support Agent</a>
          <a href="/command/personal-email">Personal Email</a>
          <a href="/command/clients/new">Dealer Setup</a>
          <a href="/command/users">Users</a>
          <a href="/command">Agreements</a>
          <a href="/command">Billing</a>
          <a href="/command">Connectors</a>
        </nav>
        <section className="lr-ceo-side-panel">
          <p className="lr-ceo-kicker">Sales</p>
          <strong>{metrics.open} open prospects</strong>
          <span>{metrics.proposals} in proposal or signature.</span>
        </section>
      </aside>

      <section className="lr-ceo-main">
        <header className="lr-ceo-header">
          <div>
            <p className="lr-ceo-kicker">LeadRider sales CRM</p>
            <h2>Sales Funnel</h2>
            <p>Track prospects, owner follow-up, meeting links, agreement status, and onboarding handoff from one workspace.</p>
          </div>
          <div className="lr-ceo-header-actions">
            <button type="button" className="lr-ceo-secondary-btn" onClick={loadProspects} disabled={busy}>Refresh</button>
            <button type="button" onClick={() => setShowAddProspect(current => !current)} disabled={busy}>
              {showAddProspect ? "Close add form" : "Add prospect"}
            </button>
          </div>
        </header>

        <section className="lr-ceo-notice" aria-live="polite">{notice}</section>

        <section className="lr-ceo-integration-strip">
          <div>
            <p className="lr-ceo-kicker">Meeting connector</p>
            <strong>Zoom</strong>
            <p>
              {zoomStatus?.connected
                ? "Connected and ready to create prospect meetings."
                : zoomStatus?.configured
                  ? "Ready to connect."
                  : zoomStatus
                    ? `Missing settings: ${(zoomStatus.missing || []).join(", ")}.`
                    : "Checking Zoom settings."}
            </p>
          </div>
          <span className={`lr-ceo-status-pill ${zoomStatus?.connected ? "is-ready" : zoomStatus?.configured || !zoomStatus ? "is-working" : "is-blocked"}`}>
            {zoomStatus?.connected ? "Zoom connected" : zoomStatus?.configured ? "Ready to connect" : zoomStatus ? "Not configured" : "Checking"}
          </span>
          {!zoomStatus?.connected ? (
            <button type="button" onClick={connectZoom} disabled={zoomBusy || zoomStatus?.configured === false}>
              Connect Zoom
            </button>
          ) : null}
          <button type="button" className="lr-ceo-secondary-btn" onClick={loadZoomStatus} disabled={zoomBusy}>
            Refresh
          </button>
        </section>

        <section className="lr-ceo-metrics" aria-label="Sales metrics">
          <article>
            <span>Open prospects</span>
            <strong>{metrics.open}</strong>
            <small>Active sales conversations</small>
          </article>
          <article>
            <span>Proposal lane</span>
            <strong>{metrics.proposals}</strong>
            <small>Proposal or agreement sent</small>
          </article>
          <article>
            <span>Monthly pipeline</span>
            <strong>${metrics.pipeline.toLocaleString()}</strong>
            <small>Expected recurring revenue</small>
          </article>
          <article>
            <span>Closed won</span>
            <strong>{metrics.won}</strong>
            <small>Converted clients</small>
          </article>
        </section>

        {showAddProspect ? (
          <section className="lr-ceo-panel lr-ceo-compact-add">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">New prospect</p>
                <h3>Add dealer</h3>
              </div>
            </div>
            <div className="lr-ceo-form-stack lr-ceo-add-prospect-form">
              <label>Dealer name<input value={newForm.dealerName} onChange={e => updateNew("dealerName", e.target.value)} placeholder="Dealer name" /></label>
              <label>Contact name<input value={newForm.contactName} onChange={e => updateNew("contactName", e.target.value)} placeholder="Primary contact" /></label>
              <label>Email<input value={newForm.contactEmail} onChange={e => updateNew("contactEmail", e.target.value)} placeholder="name@dealer.com" /></label>
              <label>Website<input value={newForm.website} onChange={e => updateNew("website", e.target.value)} placeholder="https://dealer.com" /></label>
              <label>Owner<input value={newForm.owner} onChange={e => updateNew("owner", e.target.value)} placeholder="Salesperson" /></label>
              <label>Plan
                <select value={newForm.plan} onChange={e => updateNew("plan", e.target.value)}>
                  <option>Starter</option>
                  <option>Growth</option>
                  <option>Pro</option>
                  <option>Enterprise</option>
                </select>
              </label>
              <label>Expected monthly<input value={newForm.expectedMonthly} onChange={e => updateNew("expectedMonthly", e.target.value)} placeholder="$999/month" /></label>
              <label>Next step<input value={newForm.nextStep} onChange={e => updateNew("nextStep", e.target.value)} placeholder="Next step" /></label>
              <div className="lr-ceo-action-row">
                <button type="button" onClick={createProspect} disabled={busy || !newForm.dealerName.trim()}>Create prospect</button>
                <button type="button" className="lr-ceo-secondary-btn" onClick={() => setShowAddProspect(false)} disabled={busy}>Cancel</button>
              </div>
            </div>
          </section>
        ) : null}

        <section className="lr-ceo-grid lr-ceo-sales-layout">
          <article className="lr-ceo-panel lr-ceo-panel-wide">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Pipeline</p>
                <h3>Prospect lanes</h3>
              </div>
              <span className="lr-ceo-status-ready">Live</span>
            </div>
            <div className="lr-ceo-funnel-board">
              {funnelStages.map(stage => {
                const stageRows = prospects.filter(row => row.stage === stage);
                return (
                  <section key={stage} className="lr-ceo-funnel-column">
                    <div className="lr-ceo-funnel-column-title">
                      <strong>{stageLabels[stage]}</strong>
                      <span>{stageRows.length}</span>
                    </div>
                    {stageRows.map(prospect => (
                      <button
                        key={prospect.id}
                        type="button"
                        className={`lr-ceo-prospect-card ${selected?.id === prospect.id ? "is-selected" : ""}`}
                        onClick={() => setSelectedId(prospect.id)}
                      >
                        <strong>{prospect.dealerName}</strong>
                        <span>{prospect.contactName || prospect.contactEmail || "No contact yet"}</span>
                        <small>{prospect.nextStep || "No next step"}</small>
                        <em>{formatDate(prospect.nextStepAt)}</em>
                      </button>
                    ))}
                    {!stageRows.length ? <p className="lr-ceo-note">No prospects.</p> : null}
                  </section>
                );
              })}
            </div>
          </article>
        </section>

        <section className="lr-ceo-grid">
          <article className="lr-ceo-panel lr-ceo-panel-wide">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Selected prospect</p>
                <h3>{selected?.dealerName || "No prospect selected"}</h3>
              </div>
              {selected ? <span className="lr-ceo-pill-orange">{stageLabels[selected.stage]}</span> : null}
            </div>
            {selected ? (
              <>
                <div className="lr-ceo-form-stack lr-ceo-sales-form">
                  <label>Dealer name<input value={form.dealerName} onChange={e => updateForm("dealerName", e.target.value)} /></label>
                  <label>Contact name<input value={form.contactName} onChange={e => updateForm("contactName", e.target.value)} /></label>
                  <label>Email<input value={form.contactEmail} onChange={e => updateForm("contactEmail", e.target.value)} /></label>
                  <label>Phone<input value={form.contactPhone} onChange={e => updateForm("contactPhone", e.target.value)} /></label>
                  <label>Website<input value={form.website} onChange={e => updateForm("website", e.target.value)} /></label>
                  <label>Owner<input value={form.owner} onChange={e => updateForm("owner", e.target.value)} /></label>
                  <label>Lead volume<input value={form.leadVolume} onChange={e => updateForm("leadVolume", e.target.value)} /></label>
                  <label>Plan<input value={form.plan} onChange={e => updateForm("plan", e.target.value)} /></label>
                  <label>Expected monthly<input value={form.expectedMonthly} onChange={e => updateForm("expectedMonthly", e.target.value)} /></label>
                  <label>Zoom/Fathom link<input value={form.zoomLink} onChange={e => updateForm("zoomLink", e.target.value)} placeholder="Meeting link" /></label>
                  <label>DocuSign packet<input value={form.docusignPacketId} onChange={e => updateForm("docusignPacketId", e.target.value)} placeholder="Packet id or URL" /></label>
                  <label>Onboarding email thread<input value={form.onboardingEmailThread} onChange={e => updateForm("onboardingEmailThread", e.target.value)} placeholder="onboarding@leadrider.ai thread" /></label>
                  <label>Email sender
                    <select value={form.emailSenderType} onChange={e => updateEmailSender(e.target.value as ProspectForm["emailSenderType"])}>
                      {emailSenderOptions.map(option => <option key={option.value} value={option.value}>{option.label} - {option.email}</option>)}
                    </select>
                  </label>
                  <label>Sender address<input value={form.emailSenderAddress} onChange={e => updateForm("emailSenderAddress", e.target.value)} /></label>
                  <label>Next step<textarea value={form.nextStep} onChange={e => updateForm("nextStep", e.target.value)} /></label>
                  <label>Notes<textarea value={form.notes} onChange={e => updateForm("notes", e.target.value)} /></label>
                </div>
                <div className="lr-ceo-action-row">
                  <button type="button" onClick={() => saveProspect()} disabled={busy}>Save prospect</button>
                </div>
              </>
            ) : (
              <p className="lr-ceo-note">Add a prospect to start tracking a dealer sales cycle.</p>
            )}
          </article>

          <article className="lr-ceo-panel">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Next actions</p>
                <h3>Work this prospect</h3>
              </div>
              <span className="lr-ceo-status-attention">Approval gated</span>
            </div>
            <div className="lr-ceo-agent-list lr-ceo-sales-actions">
              <div className="lr-ceo-agent-row">
                <div>
                  <strong>Research</strong>
                  <p>Find setup blockers and lead-volume clues.</p>
                </div>
                <button type="button" className="lr-ceo-secondary-btn" onClick={() => createAgentTask("research")} disabled={!selected || taskBusy}>Research</button>
              </div>
              <div className="lr-ceo-agent-row">
                <div>
                  <strong>Sales follow-up</strong>
                  <p>Draft from {form.emailSenderAddress || "joe.hartrich@leadrider.ai"}.</p>
                </div>
                <button type="button" className="lr-ceo-secondary-btn" onClick={() => createAgentTask("sales_email")} disabled={!selected || taskBusy}>Draft</button>
              </div>
              <div className="lr-ceo-agent-row">
                <div>
                  <strong>Schedule demo</strong>
                  <p>{form.zoomLink || selected?.zoomLink ? "Zoom link saved on this prospect." : "Pick a meeting time and create a Zoom link."}</p>
                  <label className="lr-ceo-inline-field">
                    Demo meeting time
                    <input type="datetime-local" value={form.nextStepAt} onChange={e => updateForm("nextStepAt", e.target.value)} />
                  </label>
                  {(form.zoomLink || selected?.zoomLink) ? <small>{form.zoomLink || selected?.zoomLink}</small> : null}
                </div>
                <button type="button" className="lr-ceo-secondary-btn" onClick={createZoomMeeting} disabled={!selected || zoomBusy || !zoomStatus?.connected || (!form.nextStepAt && !selected?.nextStepAt)}>Schedule</button>
              </div>
              <div className="lr-ceo-agent-row">
                <div>
                  <strong>Agreement</strong>
                  <p>Prepare missing legal and pricing fields.</p>
                </div>
                <button type="button" className="lr-ceo-secondary-btn" onClick={() => createAgentTask("docusign")} disabled={!selected || taskBusy}>Prepare</button>
              </div>
              <div className="lr-ceo-agent-row">
                <div>
                  <strong>Draft onboarding</strong>
                  <p>Prepare dealer onboarding copy after proposal stage.</p>
                </div>
                <button type="button" className="lr-ceo-secondary-btn" onClick={() => createAgentTask("onboarding")} disabled={!selected || taskBusy || !isAtLeastStage(selected.stage, "proposal")}>Draft</button>
              </div>
              <div className="lr-ceo-agent-row">
                <div>
                  <strong>Dealer setup</strong>
                  <p>Push a won dealer into the onboarding setup checklist.</p>
                </div>
                <button type="button" className="lr-ceo-secondary-btn" onClick={pushToDealerSetup} disabled={busy || !selected}>Push</button>
              </div>
            </div>
          </article>
        </section>
      </section>
    </main>
  );
}
