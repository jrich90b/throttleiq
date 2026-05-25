"use client";

import { useEffect, useMemo, useState } from "react";

type ClientStatus = "active" | "implementation" | "paused" | "canceled";
type PaymentMethod = "ach" | "card" | "check" | "wire" | "other";

type ClientPayment = {
  id: string;
  paidAt: string;
  amount: string;
  method: PaymentMethod;
  reference?: string;
  note?: string;
  createdAt: string;
};

type ActiveClient = {
  id: string;
  dealerSetupId?: string;
  dealerName: string;
  status: ClientStatus;
  owner?: string;
  primaryContactName?: string;
  primaryContactEmail?: string;
  primaryContactPhone?: string;
  billingContactName?: string;
  billingContactEmail?: string;
  billingContactPhone?: string;
  website?: string;
  appUrl?: string;
  apiUrl?: string;
  apiHealthUrl?: string;
  apiPm2Process?: string;
  apiDataDir?: string;
  apiEnvFile?: string;
  apiDeployProfilePath?: string;
  launchStatus?: string;
  providerStatuses?: string;
  runnerStatus?: string;
  leadVolume?: string;
  dealerLines?: string;
  contractTerm?: string;
  billingStart?: string;
  onboardingThread?: string;
  agreementUrl?: string;
  agreementStatus?: string;
  agreementSignedAt?: string;
  plan?: string;
  monthlyFee?: string;
  setupFee?: string;
  achMandateStatus?: string;
  bankLast4?: string;
  paymentTerms?: string;
  notes?: string;
  payments: ClientPayment[];
  createdAt: string;
  updatedAt: string;
};

type ClientForm = Omit<ActiveClient, "id" | "payments" | "createdAt" | "updatedAt">;

type PaymentForm = {
  paidAt: string;
  amount: string;
  method: PaymentMethod;
  reference: string;
  note: string;
};

const emptyClientForm: ClientForm = {
  dealerName: "",
  status: "active",
  owner: "",
  primaryContactName: "",
  primaryContactEmail: "",
  primaryContactPhone: "",
  billingContactName: "",
  billingContactEmail: "",
  billingContactPhone: "",
  website: "",
  appUrl: "",
  apiUrl: "",
  apiHealthUrl: "",
  apiPm2Process: "",
  apiDataDir: "",
  apiEnvFile: "",
  apiDeployProfilePath: "",
  launchStatus: "",
  providerStatuses: "",
  runnerStatus: "",
  leadVolume: "",
  dealerLines: "",
  contractTerm: "",
  billingStart: "",
  onboardingThread: "",
  agreementUrl: "",
  agreementStatus: "Signed",
  agreementSignedAt: "",
  plan: "",
  monthlyFee: "",
  setupFee: "",
  achMandateStatus: "Not started",
  bankLast4: "",
  paymentTerms: "ACH monthly",
  notes: ""
};

const emptyPaymentForm: PaymentForm = {
  paidAt: new Date().toISOString().slice(0, 10),
  amount: "",
  method: "ach",
  reference: "",
  note: ""
};

const statusLabels: Record<ClientStatus, string> = {
  active: "Active",
  implementation: "Implementation",
  paused: "Paused",
  canceled: "Canceled"
};

function toForm(client: ActiveClient): ClientForm {
  return {
    dealerSetupId: client.dealerSetupId || "",
    dealerName: client.dealerName || "",
    status: client.status || "active",
    owner: client.owner || "",
    primaryContactName: client.primaryContactName || "",
    primaryContactEmail: client.primaryContactEmail || "",
    primaryContactPhone: client.primaryContactPhone || "",
    billingContactName: client.billingContactName || "",
    billingContactEmail: client.billingContactEmail || "",
    billingContactPhone: client.billingContactPhone || "",
    website: client.website || "",
    appUrl: client.appUrl || "",
    apiUrl: client.apiUrl || "",
    apiHealthUrl: client.apiHealthUrl || "",
    apiPm2Process: client.apiPm2Process || "",
    apiDataDir: client.apiDataDir || "",
    apiEnvFile: client.apiEnvFile || "",
    apiDeployProfilePath: client.apiDeployProfilePath || "",
    launchStatus: client.launchStatus || "",
    providerStatuses: client.providerStatuses || "",
    runnerStatus: client.runnerStatus || "",
    leadVolume: client.leadVolume || "",
    dealerLines: client.dealerLines || "",
    contractTerm: client.contractTerm || "",
    billingStart: client.billingStart || "",
    onboardingThread: client.onboardingThread || "",
    agreementUrl: client.agreementUrl || "",
    agreementStatus: client.agreementStatus || "",
    agreementSignedAt: client.agreementSignedAt || "",
    plan: client.plan || "",
    monthlyFee: client.monthlyFee || "",
    setupFee: client.setupFee || "",
    achMandateStatus: client.achMandateStatus || "",
    bankLast4: client.bankLast4 || "",
    paymentTerms: client.paymentTerms || "",
    notes: client.notes || ""
  };
}

function moneyValue(value?: string) {
  const cleaned = String(value ?? "").replace(/[^0-9.-]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function currency(value: number) {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function statusClass(status: ClientStatus) {
  if (status === "active") return "is-ready";
  if (status === "implementation") return "is-working";
  return "is-blocked";
}

export default function ActiveClientsPage() {
  const [clients, setClients] = useState<ActiveClient[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [form, setForm] = useState<ClientForm>(emptyClientForm);
  const [newForm, setNewForm] = useState<ClientForm>(emptyClientForm);
  const [paymentForm, setPaymentForm] = useState<PaymentForm>(emptyPaymentForm);
  const [notice, setNotice] = useState("Active Clients is ready.");
  const [busy, setBusy] = useState(false);

  const selected = useMemo(
    () => clients.find(client => client.id === selectedId) ?? clients[0] ?? null,
    [clients, selectedId]
  );

  const totals = useMemo(() => {
    const active = clients.filter(client => client.status === "active").length;
    const mrr = clients
      .filter(client => client.status === "active")
      .reduce((sum, client) => sum + moneyValue(client.monthlyFee), 0);
    const paid = clients.reduce(
      (sum, client) => sum + (client.payments || []).reduce((paymentSum, payment) => paymentSum + moneyValue(payment.amount), 0),
      0
    );
    const achReady = clients.filter(client => /ready|active|approved/i.test(client.achMandateStatus || "")).length;
    return { active, mrr, paid, achReady };
  }, [clients]);

  const selectedPaid = useMemo(
    () => (selected?.payments || []).reduce((sum, payment) => sum + moneyValue(payment.amount), 0),
    [selected]
  );

  useEffect(() => {
    void loadClients();
  }, []);

  useEffect(() => {
    if (!selected) return;
    setSelectedId(selected.id);
    setForm(toForm(selected));
  }, [selected?.id]);

  async function loadClients() {
    setBusy(true);
    try {
      const resp = await fetch("/api/active-clients?limit=250", { cache: "no-store" });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Active clients could not be loaded.");
      const rows = Array.isArray(data.clients) ? data.clients : [];
      setClients(rows);
      if (rows.length && !selectedId) setSelectedId(rows[0].id);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Active clients could not be loaded.");
    } finally {
      setBusy(false);
    }
  }

  function updateForm(field: keyof ClientForm, value: string) {
    setForm(current => ({ ...current, [field]: value }));
  }

  function updateNewForm(field: keyof ClientForm, value: string) {
    setNewForm(current => ({ ...current, [field]: value }));
  }

  async function createClient() {
    if (!newForm.dealerName.trim()) {
      setNotice("Dealer name is required.");
      return;
    }
    setBusy(true);
    try {
      const resp = await fetch("/api/active-clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newForm)
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Client could not be created.");
      setClients(current => [data.client, ...current]);
      setSelectedId(data.client.id);
      setNewForm(emptyClientForm);
      setNotice(`${data.client.dealerName} added to Active Clients.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Client could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function saveClient() {
    if (!selected) return;
    setBusy(true);
    try {
      const resp = await fetch(`/api/active-clients/${encodeURIComponent(selected.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form)
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Client could not be saved.");
      setClients(current => current.map(client => (client.id === data.client.id ? data.client : client)));
      setForm(toForm(data.client));
      setNotice(`${data.client.dealerName} saved.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Client could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function addPayment() {
    if (!selected) return;
    if (!paymentForm.amount.trim()) {
      setNotice("Payment amount is required.");
      return;
    }
    setBusy(true);
    try {
      const resp = await fetch(`/api/active-clients/${encodeURIComponent(selected.id)}/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(paymentForm)
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Payment could not be saved.");
      setClients(current => current.map(client => (client.id === data.client.id ? data.client : client)));
      setPaymentForm(emptyPaymentForm);
      setNotice(`Payment saved for ${data.client.dealerName}.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Payment could not be saved.");
    } finally {
      setBusy(false);
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
          <a href="/command/approvals">Approvals</a>
          <a href="/command/personal-email">Personal Email</a>
          <a href="/command/clients" className="is-active">Active Clients</a>
          <a href="/command/clients/new">Dealer Setup</a>
          <a href="/command/users">Users</a>
          <a href="/command">Agreements</a>
          <a href="/command">Billing</a>
        </nav>
        <section className="lr-ceo-side-panel">
          <p className="lr-ceo-kicker">Client base</p>
          <strong>{totals.active} active clients</strong>
          <span>{currency(totals.mrr)} MRR</span>
        </section>
      </aside>

      <section className="lr-ceo-main">
        <header className="lr-ceo-header">
          <div>
            <p className="lr-ceo-kicker">Client operations</p>
            <h2>Active Clients</h2>
            <p>Keep signed agreements, contacts, ACH setup, and payment history in one Command record.</p>
          </div>
          <div className="lr-ceo-header-actions">
            <button type="button" className="lr-ceo-secondary-btn" onClick={loadClients} disabled={busy}>Refresh</button>
          </div>
        </header>

        <section className="lr-ceo-notice" aria-live="polite">{notice}</section>

        <section className="lr-ceo-metrics">
          <div><span>Active</span><strong>{totals.active}</strong><small>Live client accounts</small></div>
          <div><span>MRR</span><strong>{currency(totals.mrr)}</strong><small>Active monthly fees</small></div>
          <div><span>Paid</span><strong>{currency(totals.paid)}</strong><small>Recorded payment history</small></div>
          <div><span>ACH ready</span><strong>{totals.achReady}</strong><small>Mandate active or approved</small></div>
        </section>

        <section className="lr-ceo-grid">
          <article className="lr-ceo-panel">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">New client</p>
                <h3>Add active client</h3>
              </div>
            </div>
            <div className="lr-ceo-form-stack">
              <label>Dealer name<input value={newForm.dealerName} onChange={e => updateNewForm("dealerName", e.target.value)} /></label>
              <label>Primary contact<input value={newForm.primaryContactName} onChange={e => updateNewForm("primaryContactName", e.target.value)} /></label>
              <label>Contact email<input value={newForm.primaryContactEmail} onChange={e => updateNewForm("primaryContactEmail", e.target.value)} /></label>
              <label>Plan<input value={newForm.plan} onChange={e => updateNewForm("plan", e.target.value)} /></label>
              <label>Monthly fee<input value={newForm.monthlyFee} onChange={e => updateNewForm("monthlyFee", e.target.value)} placeholder="$999" /></label>
              <label>ACH status<input value={newForm.achMandateStatus} onChange={e => updateNewForm("achMandateStatus", e.target.value)} /></label>
              <button type="button" onClick={createClient} disabled={busy}>Create client</button>
            </div>
          </article>

          <article className="lr-ceo-panel lr-ceo-panel-wide">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Directory</p>
                <h3>Client accounts</h3>
              </div>
            </div>
            <div className="lr-ceo-client-list">
              {clients.map(client => (
                <button
                  type="button"
                  key={client.id}
                  className={`lr-ceo-active-client-row ${selected?.id === client.id ? "is-selected" : ""}`}
                  onClick={() => setSelectedId(client.id)}
                >
                  <strong>{client.dealerName}</strong>
                  <span>{statusLabels[client.status]}</span>
                  <small>{client.plan || "No plan"} · {client.monthlyFee || "No monthly fee"}</small>
                  <em>{currency((client.payments || []).reduce((sum, payment) => sum + moneyValue(payment.amount), 0))} paid</em>
                </button>
              ))}
              {!clients.length ? <p className="lr-ceo-empty">No active clients yet.</p> : null}
            </div>
          </article>
        </section>

        {selected ? (
          <section className="lr-ceo-grid">
            <article className="lr-ceo-panel lr-ceo-panel-wide">
              <div className="lr-ceo-panel-title">
                <div>
                  <p className="lr-ceo-kicker">Selected client</p>
                  <h3>{selected.dealerName}</h3>
                </div>
                <span className={`lr-ceo-status-pill ${statusClass(selected.status)}`}>{statusLabels[selected.status]}</span>
              </div>
              <dl className="lr-ceo-facts">
                <div><dt>Web app</dt><dd>{selected.appUrl || selected.website || "Not captured"}</dd></div>
                <div><dt>API</dt><dd>{selected.apiUrl || "Not captured"}</dd></div>
                <div><dt>Health</dt><dd>{selected.apiHealthUrl || "Not captured"}</dd></div>
                <div><dt>Launch</dt><dd>{selected.launchStatus || "Not captured"}</dd></div>
              </dl>
              <div className="lr-ceo-form-stack lr-ceo-active-client-form">
                <label>Dealer name<input value={form.dealerName} onChange={e => updateForm("dealerName", e.target.value)} /></label>
                <label>Status
                  <select value={form.status} onChange={e => updateForm("status", e.target.value as ClientStatus)}>
                    <option value="active">Active</option>
                    <option value="implementation">Implementation</option>
                    <option value="paused">Paused</option>
                    <option value="canceled">Canceled</option>
                  </select>
                </label>
                <label>Owner<input value={form.owner} onChange={e => updateForm("owner", e.target.value)} /></label>
                <label>Primary contact<input value={form.primaryContactName} onChange={e => updateForm("primaryContactName", e.target.value)} /></label>
              <label>Primary email<input value={form.primaryContactEmail} onChange={e => updateForm("primaryContactEmail", e.target.value)} /></label>
              <label>Primary phone<input value={form.primaryContactPhone} onChange={e => updateForm("primaryContactPhone", e.target.value)} /></label>
              <label>Billing contact<input value={form.billingContactName} onChange={e => updateForm("billingContactName", e.target.value)} /></label>
              <label>Billing email<input value={form.billingContactEmail} onChange={e => updateForm("billingContactEmail", e.target.value)} /></label>
              <label>Billing phone<input value={form.billingContactPhone} onChange={e => updateForm("billingContactPhone", e.target.value)} /></label>
              <label>Website<input value={form.website} onChange={e => updateForm("website", e.target.value)} /></label>
              <label>Web app URL<input value={form.appUrl} onChange={e => updateForm("appUrl", e.target.value)} /></label>
              <label>API URL<input value={form.apiUrl} onChange={e => updateForm("apiUrl", e.target.value)} /></label>
              <label>API health URL<input value={form.apiHealthUrl} onChange={e => updateForm("apiHealthUrl", e.target.value)} /></label>
              <label>PM2 process<input value={form.apiPm2Process} onChange={e => updateForm("apiPm2Process", e.target.value)} /></label>
              <label>API data dir<input value={form.apiDataDir} onChange={e => updateForm("apiDataDir", e.target.value)} /></label>
              <label>API env file<input value={form.apiEnvFile} onChange={e => updateForm("apiEnvFile", e.target.value)} /></label>
              <label>Deploy profile<input value={form.apiDeployProfilePath} onChange={e => updateForm("apiDeployProfilePath", e.target.value)} /></label>
              <label>Launch status<input value={form.launchStatus} onChange={e => updateForm("launchStatus", e.target.value)} /></label>
              <label>Runner status<input value={form.runnerStatus} onChange={e => updateForm("runnerStatus", e.target.value)} /></label>
              <label>Lead volume<input value={form.leadVolume} onChange={e => updateForm("leadVolume", e.target.value)} /></label>
              <label>Dealer lines<input value={form.dealerLines} onChange={e => updateForm("dealerLines", e.target.value)} /></label>
              <label>Agreement link<input value={form.agreementUrl} onChange={e => updateForm("agreementUrl", e.target.value)} /></label>
              <label>Agreement status<input value={form.agreementStatus} onChange={e => updateForm("agreementStatus", e.target.value)} /></label>
              <label>Signed date<input value={form.agreementSignedAt} onChange={e => updateForm("agreementSignedAt", e.target.value)} /></label>
              <label>Plan<input value={form.plan} onChange={e => updateForm("plan", e.target.value)} /></label>
              <label>Monthly fee<input value={form.monthlyFee} onChange={e => updateForm("monthlyFee", e.target.value)} /></label>
              <label>Setup fee<input value={form.setupFee} onChange={e => updateForm("setupFee", e.target.value)} /></label>
              <label>Contract term<input value={form.contractTerm} onChange={e => updateForm("contractTerm", e.target.value)} /></label>
              <label>Billing start<input value={form.billingStart} onChange={e => updateForm("billingStart", e.target.value)} /></label>
              <label>Onboarding thread<input value={form.onboardingThread} onChange={e => updateForm("onboardingThread", e.target.value)} /></label>
              <label>ACH status<input value={form.achMandateStatus} onChange={e => updateForm("achMandateStatus", e.target.value)} /></label>
                <label>Bank last 4<input value={form.bankLast4} onChange={e => updateForm("bankLast4", e.target.value)} /></label>
                <label>Payment terms<input value={form.paymentTerms} onChange={e => updateForm("paymentTerms", e.target.value)} /></label>
                <label>Provider statuses<textarea value={form.providerStatuses} onChange={e => updateForm("providerStatuses", e.target.value)} /></label>
                <label>Notes<textarea value={form.notes} onChange={e => updateForm("notes", e.target.value)} /></label>
              </div>
              <div className="lr-ceo-action-row">
                <button type="button" onClick={saveClient} disabled={busy}>Save client</button>
                {form.agreementUrl ? <a className="lr-ceo-button-link" href={form.agreementUrl} target="_blank" rel="noreferrer">Open agreement</a> : null}
              </div>
            </article>

            <article className="lr-ceo-panel">
              <div className="lr-ceo-panel-title">
                <div>
                  <p className="lr-ceo-kicker">Payments</p>
                  <h3>{currency(selectedPaid)} total paid</h3>
                </div>
              </div>
              <div className="lr-ceo-form-stack">
                <label>Date<input value={paymentForm.paidAt} onChange={e => setPaymentForm(current => ({ ...current, paidAt: e.target.value }))} /></label>
                <label>Amount<input value={paymentForm.amount} onChange={e => setPaymentForm(current => ({ ...current, amount: e.target.value }))} placeholder="$999" /></label>
                <label>Method
                  <select value={paymentForm.method} onChange={e => setPaymentForm(current => ({ ...current, method: e.target.value as PaymentMethod }))}>
                    <option value="ach">ACH</option>
                    <option value="card">Card</option>
                    <option value="check">Check</option>
                    <option value="wire">Wire</option>
                    <option value="other">Other</option>
                  </select>
                </label>
                <label>Reference<input value={paymentForm.reference} onChange={e => setPaymentForm(current => ({ ...current, reference: e.target.value }))} /></label>
                <label>Note<textarea value={paymentForm.note} onChange={e => setPaymentForm(current => ({ ...current, note: e.target.value }))} /></label>
                <button type="button" onClick={addPayment} disabled={busy}>Add payment</button>
              </div>
              <div className="lr-ceo-payment-list">
                {(selected.payments || []).map(payment => (
                  <div key={payment.id} className="lr-ceo-payment-row">
                    <strong>{payment.amount}</strong>
                    <span>{payment.method.toUpperCase()} · {payment.paidAt}</span>
                    {payment.reference ? <small>{payment.reference}</small> : null}
                    {payment.note ? <small>{payment.note}</small> : null}
                  </div>
                ))}
                {!selected.payments?.length ? <p className="lr-ceo-empty">No payments recorded yet.</p> : null}
              </div>
            </article>
          </section>
        ) : null}
      </section>
    </main>
  );
}
