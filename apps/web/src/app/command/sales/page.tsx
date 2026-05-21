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
  dealerLines?: string;
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

type EsignPacket = {
  id: string;
  status: "draft" | "ready" | "sent" | "signed" | "declined" | "voided";
  signedAt?: string;
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

type CommandUser = {
  id: string;
  email: string;
  name?: string;
  commandBookingEnabled?: boolean;
  commandCalendarId?: string;
};

type SalesActionId = "research" | "sales_email" | "schedule_demo" | "agreement" | "onboarding" | "dealer_setup";

type AgentTask = {
  id: string;
  provider: "codex" | "claude";
  kind: string;
  title: string;
  clientName?: string;
  status: "queued" | "needs_approval" | "running" | "completed" | "failed" | "blocked";
  createdAt: string;
  updatedAt: string;
  output?: {
    summary?: string;
    links?: string[];
  };
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
  dealerLines: string;
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

type AgreementForm = {
  legalName: string;
  dbaName: string;
  dealerAddress: string;
  signerName: string;
  signerEmail: string;
  signerTitle: string;
  setupFee: string;
  monthlyFee: string;
  contractTerm: string;
  billingStart: string;
  agreementUrl: string;
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
  dealerLines: "1",
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

const emptyAgreementForm: AgreementForm = {
  legalName: "",
  dbaName: "",
  dealerAddress: "",
  signerName: "",
  signerEmail: "",
  signerTitle: "",
  setupFee: "",
  monthlyFee: "$999/month",
  contractTerm: "Month-to-month",
  billingStart: "",
  agreementUrl: ""
};

const planOptions = [
  { name: "Starter", monthly: "$999/month" },
  { name: "Growth", monthly: "$1,499/month" },
  { name: "Pro", monthly: "$1,999/month" },
  { name: "Enterprise", monthly: "Custom" }
];

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
const editableStages: SalesProspectStage[] = [...stageProgression, "closed_lost"];
const actionStateStorageKey = "lr.salesFunnel.actionState.v1";

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
    dealerLines: prospect.dealerLines || "1",
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

function visibleSenderAddress(prospect: SalesProspect | null, form: ProspectForm) {
  return form.emailSenderAddress || prospect?.emailSenderAddress || "joe.hartrich@leadrider.ai";
}

function parseEmailDraft(text: string) {
  const cleaned = text.trim();
  const subject =
    cleaned.match(/(?:^|\n)\s*(?:#+\s*)?(?:subject|email subject)\s*:?\s*(.+)/i)?.[1]?.trim() ||
    "LeadRider follow-up";
  const bodyStart =
    cleaned.match(/(?:^|\n)\s*(?:#+\s*)?(?:body|draft reply|email body)\s*:?\s*\n([\s\S]+)/i)?.[1]?.trim() ||
    cleaned;
  const body = bodyStart
    .replace(/(?:^|\n)\s*(?:#+\s*)?(?:short note|why this email is appropriate|approval needed)\s*:?\s*[\s\S]*$/i, "")
    .trim();
  return { subject, body };
}

function taskLinkValue(task: AgentTask, prefix: string) {
  return task.output?.links?.find(link => link.startsWith(prefix))?.slice(prefix.length);
}

function formatDate(value?: string) {
  if (!value) return "No date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatMeetingDate(value?: string) {
  return value ? formatDate(value) : "No demo time";
}

function moneyValue(value?: string) {
  const match = String(value ?? "").match(/[\d,.]+/);
  if (!match) return 0;
  return Number(match[0].replace(/,/g, "")) || 0;
}

function setupFeeForDealerLines(value?: string) {
  const lines = Math.max(1, Math.floor(Number(String(value ?? "").replace(/[^\d.]/g, "")) || 1));
  if (lines <= 1) return "$2,500";
  if (lines <= 3) return "$3,500";
  if (lines <= 6) return "$5,000";
  return "$7,500+";
}

function agreementFormForProspect(prospect: SalesProspect | null): AgreementForm {
  return {
    ...emptyAgreementForm,
    legalName: prospect?.dealerName || "",
    dbaName: prospect?.dealerName || "",
    signerName: prospect?.contactName || "",
    signerEmail: prospect?.contactEmail || "",
    setupFee: setupFeeForDealerLines(prospect?.dealerLines),
    monthlyFee: prospect?.expectedMonthly || emptyAgreementForm.monthlyFee
  };
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
  const [completedActions, setCompletedActions] = useState<string[]>([]);
  const [reopenedActions, setReopenedActions] = useState<string[]>([]);
  const [agentTasks, setAgentTasks] = useState<AgentTask[]>([]);
  const [agentTasksBusy, setAgentTasksBusy] = useState(false);
  const [draftEdits, setDraftEdits] = useState<Record<string, string>>({});
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftSendStatus, setDraftSendStatus] = useState<Record<string, string>>({});
  const [currentUser, setCurrentUser] = useState<CommandUser | null>(null);
  const [bookingLinkCopied, setBookingLinkCopied] = useState(false);
  const [agreementForm, setAgreementForm] = useState<AgreementForm>(emptyAgreementForm);
  const [agreementBusy, setAgreementBusy] = useState(false);
  const [agreementSendBusy, setAgreementSendBusy] = useState(false);
  const [dealerSetupLink, setDealerSetupLink] = useState<string>("");

  const selected = useMemo(
    () => prospects.find(prospect => prospect.id === selectedId) ?? prospects[0] ?? null,
    [prospects, selectedId]
  );

  useEffect(() => {
    void loadProspects();
    void loadZoomStatus();
    void loadAgentTasks();
    void loadCurrentUser();
  }, []);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(actionStateStorageKey) || "{}");
      setCompletedActions(Array.isArray(saved.completed) ? saved.completed : []);
      setReopenedActions(Array.isArray(saved.reopened) ? saved.reopened : []);
    } catch {
      setCompletedActions([]);
      setReopenedActions([]);
    }
  }, []);

  useEffect(() => {
    if (selected) {
      setSelectedId(selected.id);
      setForm(toForm(selected));
      setAgreementForm(agreementFormForProspect(selected));
      setDealerSetupLink("");
    }
  }, [selected?.id]);

  const metrics = useMemo(() => {
    const open = prospects.filter(row => row.stage !== "closed_won" && row.stage !== "closed_lost");
    const proposals = prospects.filter(row => row.stage === "proposal" || row.stage === "agreement_sent");
    const won = prospects.filter(row => row.stage === "closed_won");
    const pipeline = open.reduce((sum, row) => sum + moneyValue(row.expectedMonthly), 0);
    return { open: open.length, proposals: proposals.length, won: won.length, pipeline };
  }, [prospects]);

  const latestResearchTask = useMemo(() => {
    if (!selected) return null;
    const selectedName = selected.dealerName.trim().toLowerCase();
    return agentTasks.find(task =>
      task.kind === "prospect_research" &&
      (task.clientName || "").trim().toLowerCase() === selectedName
    ) ?? null;
  }, [agentTasks, selected]);

  const latestSalesEmailTask = useMemo(() => {
    if (!selected) return null;
    const selectedName = selected.dealerName.trim().toLowerCase();
    return agentTasks.find(task =>
      task.kind === "email" &&
      /^Draft sales follow-up/i.test(task.title) &&
      (task.clientName || "").trim().toLowerCase() === selectedName
    ) ?? null;
  }, [agentTasks, selected]);

  const latestOnboardingTask = useMemo(() => {
    if (!selected) return null;
    const selectedName = selected.dealerName.trim().toLowerCase();
    return agentTasks.find(task =>
      task.kind === "email" &&
      /^Draft onboarding email/i.test(task.title) &&
      (task.clientName || "").trim().toLowerCase() === selectedName
    ) ?? null;
  }, [agentTasks, selected]);

  const latestResearchMissingWebsite = useMemo(() => {
    const currentWebsite = form.website.trim() || selected?.website?.trim();
    return Boolean(
      currentWebsite &&
      latestResearchTask?.output?.summary?.includes("No dealer website was provided")
    );
  }, [form.website, latestResearchTask, selected?.website]);

  useEffect(() => {
    if (!selected || latestResearchTask?.kind !== "prospect_research") return;
    const hasSummary = Boolean(latestResearchTask.output?.summary?.trim());
    const shouldPoll =
      latestResearchTask.status === "queued" ||
      latestResearchTask.status === "running" ||
      (!hasSummary && latestResearchTask.status === "needs_approval") ||
      (latestResearchTask.status === "completed" && !hasSummary);
    if (!shouldPoll) return;

    let cancelled = false;
    const refresh = () => {
      if (!cancelled) void loadAgentTasks();
    };
    const firstRefresh = window.setTimeout(refresh, 2000);
    const interval = window.setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      window.clearTimeout(firstRefresh);
      window.clearInterval(interval);
    };
  }, [latestResearchTask?.id, latestResearchTask?.status, latestResearchTask?.output?.summary, selected?.id]);

  useEffect(() => {
    if (!selected || latestSalesEmailTask?.kind !== "email") return;
    const hasSummary = Boolean(latestSalesEmailTask.output?.summary?.trim());
    const shouldPoll =
      latestSalesEmailTask.status === "queued" ||
      latestSalesEmailTask.status === "running" ||
      (!hasSummary && latestSalesEmailTask.status === "needs_approval") ||
      (latestSalesEmailTask.status === "completed" && !hasSummary);
    if (!shouldPoll) return;

    let cancelled = false;
    const refresh = () => {
      if (!cancelled) void loadAgentTasks();
    };
    const firstRefresh = window.setTimeout(refresh, 2000);
    const interval = window.setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      window.clearTimeout(firstRefresh);
      window.clearInterval(interval);
    };
  }, [latestSalesEmailTask?.id, latestSalesEmailTask?.status, latestSalesEmailTask?.output?.summary, selected?.id]);

  useEffect(() => {
    if (!selected || latestOnboardingTask?.kind !== "email") return;
    const hasSummary = Boolean(latestOnboardingTask.output?.summary?.trim());
    const shouldPoll =
      latestOnboardingTask.status === "queued" ||
      latestOnboardingTask.status === "running" ||
      (!hasSummary && latestOnboardingTask.status === "needs_approval") ||
      (latestOnboardingTask.status === "completed" && !hasSummary);
    if (!shouldPoll) return;

    let cancelled = false;
    const refresh = () => {
      if (!cancelled) void loadAgentTasks();
    };
    const firstRefresh = window.setTimeout(refresh, 2000);
    const interval = window.setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      window.clearTimeout(firstRefresh);
      window.clearInterval(interval);
    };
  }, [latestOnboardingTask?.id, latestOnboardingTask?.status, latestOnboardingTask?.output?.summary, selected?.id]);

  useEffect(() => {
    if (!latestSalesEmailTask?.id || !latestSalesEmailTask.output?.summary) return;
    setDraftEdits(current =>
      current[latestSalesEmailTask.id] == null
        ? { ...current, [latestSalesEmailTask.id]: latestSalesEmailTask.output?.summary ?? "" }
        : current
    );
  }, [latestSalesEmailTask?.id, latestSalesEmailTask?.output?.summary]);

  useEffect(() => {
    if (!latestOnboardingTask?.id || !latestOnboardingTask.output?.summary) return;
    setDraftEdits(current =>
      current[latestOnboardingTask.id] == null
        ? { ...current, [latestOnboardingTask.id]: latestOnboardingTask.output?.summary ?? "" }
        : current
    );
  }, [latestOnboardingTask?.id, latestOnboardingTask?.output?.summary]);

  function persistActionState(nextCompleted: string[], nextReopened: string[]) {
    setCompletedActions(nextCompleted);
    setReopenedActions(nextReopened);
    window.localStorage.setItem(actionStateStorageKey, JSON.stringify({ completed: nextCompleted, reopened: nextReopened }));
  }

  function actionKey(prospectId: string, actionId: SalesActionId) {
    return `${prospectId}:${actionId}`;
  }

  function markActionCompleted(actionId: SalesActionId, prospectId = selected?.id) {
    if (!prospectId) return;
    const key = actionKey(prospectId, actionId);
    const nextCompleted = completedActions.includes(key) ? completedActions : [...completedActions, key];
    const nextReopened = reopenedActions.filter(row => row !== key);
    persistActionState(nextCompleted, nextReopened);
  }

  function reopenAction(actionId: SalesActionId) {
    if (!selected) return;
    const key = actionKey(selected.id, actionId);
    const nextReopened = reopenedActions.includes(key) ? reopenedActions : [...reopenedActions, key];
    persistActionState(completedActions, nextReopened);
    setNotice(`${selected.dealerName}: ${actionLabel(actionId)} reopened.`);
  }

  function actionLabel(actionId: SalesActionId) {
    return {
      research: "Research",
      sales_email: "Sales follow-up",
      schedule_demo: "Schedule demo",
      agreement: "Agreement",
      onboarding: "Draft onboarding",
      dealer_setup: "Dealer setup"
    }[actionId];
  }

  function isActionReopened(actionId: SalesActionId) {
    return !!selected && reopenedActions.includes(actionKey(selected.id, actionId));
  }

  function isActionCompleted(actionId: SalesActionId) {
    if (!selected || isActionReopened(actionId)) return false;
    const key = actionKey(selected.id, actionId);
    if (actionId === "research") {
      return (
        latestResearchTask?.status === "completed" &&
        Boolean(latestResearchTask.output?.summary?.trim()) &&
        !latestResearchMissingWebsite
      );
    }
    if (completedActions.includes(key)) return true;
    if (actionId === "sales_email") return Boolean(latestSalesEmailTask?.output?.summary?.trim());
    if (actionId === "schedule_demo") return Boolean(form.zoomLink || selected.zoomLink);
    if (actionId === "agreement") return Boolean(form.docusignPacketId || selected.docusignPacketId);
    if (actionId === "onboarding") return Boolean(form.onboardingEmailThread || selected.onboardingEmailThread || latestOnboardingTask?.output?.summary?.trim());
    if (actionId === "dealer_setup") return selected.stage === "closed_won" || Boolean(dealerSetupLink);
    return false;
  }

  function renderActionControl(actionId: SalesActionId, buttonLabel: string, onClick: () => void, disabled: boolean) {
    if (isActionCompleted(actionId)) {
      return (
        <div className="lr-ceo-action-complete">
          <span aria-hidden="true">✓</span>
          <strong>Done</strong>
          <button type="button" className="lr-ceo-link-btn" onClick={() => reopenAction(actionId)}>
            Reopen
          </button>
        </div>
      );
    }
    return (
      <button type="button" className="lr-ceo-secondary-btn" onClick={onClick} disabled={disabled}>
        {buttonLabel}
      </button>
    );
  }

  function commandBookingLink() {
    if (!currentUser?.id || currentUser.commandBookingEnabled === false || !currentUser.commandCalendarId) return "";
    if (typeof window === "undefined") return `/book?commandUser=${encodeURIComponent(currentUser.id)}`;
    return `${window.location.origin}/book?commandUser=${encodeURIComponent(currentUser.id)}`;
  }

  function commandBookingSetupMessage() {
    if (!currentUser) return "Checking your Command booking setup.";
    if (currentUser.commandBookingEnabled === false) return "Command booking is turned off for your user.";
    if (!currentUser.commandCalendarId) return "Add your Command calendar in Users before using booking.";
    return "Booking link is available for sales emails and manual copy.";
  }

  function currentUserLabel() {
    return currentUser?.name || currentUser?.email || "Current LeadRider user";
  }

  function bookingLinkAlreadyInSalesDraft() {
    const link = commandBookingLink();
    if (!link) return false;
    return Boolean(latestSalesEmailTask?.output?.summary?.includes(link));
  }

  async function copyCommandBookingLink() {
    const link = commandBookingLink();
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setBookingLinkCopied(true);
      setNotice("Command booking link copied.");
      window.setTimeout(() => setBookingLinkCopied(false), 1800);
    } catch {
      setNotice(link);
    }
  }

  async function loadCurrentUser() {
    try {
      const resp = await fetch("/api/auth/me", { cache: "no-store" });
      const data = await resp.json();
      if (resp.ok && data?.ok && data.user) setCurrentUser(data.user);
    } catch {
      // Non-blocking. Sales drafts can still ask for a reply time.
    }
  }

  function taskStatusLabel(status: AgentTask["status"]) {
    return status.replace(/_/g, " ");
  }

  async function loadProspects() {
    try {
      const resp = await fetch("/api/sales-prospects?limit=250", { cache: "no-store" });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(commandApiError(data?.error || "Sales prospects could not be loaded."));
      const rows = Array.isArray(data.prospects) ? data.prospects : [];
      const syncedRows = await syncSignedAgreementProspects(rows);
      setProspects(syncedRows);
      if (syncedRows.length && !selectedId) setSelectedId(syncedRows[0].id);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Sales prospects could not be loaded.");
    }
  }

  async function syncSignedAgreementProspects(rows: SalesProspect[]) {
    const agreementRows = rows.filter(row => row.stage !== "closed_won" && row.docusignPacketId);
    if (!agreementRows.length) return rows;
    const packetsResp = await fetch(`/api/esign/packets?limit=250`, { cache: "no-store" });
    const packetsData = await packetsResp.json();
    if (!packetsResp.ok || !packetsData?.ok) return rows;
    const packets = Array.isArray(packetsData.packets) ? (packetsData.packets as EsignPacket[]) : [];
    const updates = await Promise.all(
      agreementRows.map(async row => {
        try {
          const packet = packets.find(candidate => candidate.id === row.docusignPacketId);
          if (packet?.status !== "signed") return row;
          const nextStep = packet.signedAt ? `Agreement signed on ${packet.signedAt}.` : "Agreement signed.";
          const saveResp = await fetch(`/api/sales-prospects/${encodeURIComponent(row.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...toForm(row), stage: "closed_won", nextStep })
          });
          const saveData = await saveResp.json();
          return saveResp.ok && saveData?.ok ? (saveData.prospect as SalesProspect) : row;
        } catch {
          return row;
        }
      })
    );
    return rows.map(row => updates.find(updated => updated.id === row.id) ?? row);
  }

  async function loadAgentTasks() {
    setAgentTasksBusy(true);
    try {
      const resp = await fetch("/api/agent-tasks?limit=100", { cache: "no-store" });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Agent tasks could not be loaded.");
      setAgentTasks(Array.isArray(data.tasks) ? data.tasks : []);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Agent tasks could not be loaded.");
    } finally {
      setAgentTasksBusy(false);
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

  async function deleteProspect() {
    if (!selected) return;
    const dealerName = selected.dealerName || "this prospect";
    if (!window.confirm(`Delete ${dealerName} from the sales funnel? Use this only for mistaken entries.`)) return;
    setBusy(true);
    try {
      const resp = await fetch(`/api/sales-prospects/${encodeURIComponent(selected.id)}`, {
        method: "DELETE"
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Prospect could not be deleted.");
      setProspects(current => {
        const remaining = current.filter(row => row.id !== selected.id);
        setSelectedId(remaining[0]?.id ?? "");
        if (!remaining.length) setForm(emptyForm);
        return remaining;
      });
      setNotice(`${dealerName} deleted from the sales funnel.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Prospect could not be deleted.");
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
      setNotice("Set the confirmed demo time before creating a Zoom meeting.");
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
      setNotice(`Zoom meeting created for ${data.prospect.dealerName}. The link is saved in Next actions.`);
      markActionCompleted("schedule_demo", data.prospect.id);
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
      if (data.prospect) markActionCompleted("dealer_setup", data.prospect.id);
      if (data.setup?.id) setDealerSetupLink(`/command/clients/new?setup=${encodeURIComponent(data.setup.id)}`);
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
    const senderAddress =
      currentUser?.email ||
      form.emailSenderAddress ||
      selected.emailSenderAddress ||
      emailAddressForSender(senderType);
    const currentWebsite = form.website.trim() || selected.website || "";
    const bookingLink = commandBookingLink();
    if (action === "research" && !currentWebsite) {
      setNotice("Add the dealer website before running research.");
      setTaskBusy(false);
      return;
    }
    let taskSelected = selected;
    if (action === "research" && form.website.trim() && form.website.trim() !== (selected.website || "").trim()) {
      try {
        const saveResp = await fetch(`/api/sales-prospects/${encodeURIComponent(selected.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ website: form.website.trim() })
        });
        const saveData = await saveResp.json();
        if (!saveResp.ok || !saveData?.ok) throw new Error(saveData?.error || "Website could not be saved before research.");
        taskSelected = saveData.prospect;
        setProspects(current => current.map(row => (row.id === saveData.prospect.id ? saveData.prospect : row)));
        setForm(toForm(saveData.prospect));
      } catch (err) {
        setNotice(err instanceof Error ? err.message : "Website could not be saved before research.");
        setTaskBusy(false);
        return;
      }
    }
    const facts = [
      `Dealer prospect: ${taskSelected.dealerName}`,
      `Contact: ${taskSelected.contactName || "not provided"}`,
      `Email: ${taskSelected.contactEmail || "not provided"}`,
      `Phone: ${taskSelected.contactPhone || "not provided"}`,
      `Website: ${currentWebsite || "not provided"}`,
      `Stage: ${stageLabels[taskSelected.stage]}`,
      `Owner: ${taskSelected.owner || "not assigned"}`,
      `Plan: ${taskSelected.plan || "not selected"}`,
      `Expected monthly: ${taskSelected.expectedMonthly || "not set"}`,
      `Lead volume: ${taskSelected.leadVolume || "not set"}`,
      `Dealer lines: ${taskSelected.dealerLines || "not set"}`,
      `Next step: ${taskSelected.nextStep || "not set"}`,
      `Confirmed demo time: ${taskSelected.nextStepAt || "not set"}`,
      `Zoom link: ${taskSelected.zoomLink || "not set"}`,
      `DocuSign packet: ${taskSelected.docusignPacketId || "not set"}`,
      `Onboarding email thread: ${taskSelected.onboardingEmailThread || "not set"}`,
      `Selected email sender lane: ${labelForSender(senderType)} (${senderAddress})`,
      `LeadRider command booking link: ${bookingLink || "not configured"}`,
      `Notes: ${taskSelected.notes || "none"}`
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
          "Return only a clean email draft in this exact format:",
          "Subject: <subject line>",
          "",
          "Body:",
          "<email body>",
          "Do not include Summary, Recommended Action, Approval Needed, Codex/code task notes, markdown headings, checklists, or internal commentary.",
          "If the LeadRider Command booking link is configured, include it naturally as the scheduling link.",
          "If the LeadRider command booking link is not configured, ask them to reply with a time that works. Do not use placeholder links.",
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
          "Research and summarize the sales opportunity for this dealer prospect. Start with the dealer website from the prospect record when provided. If no website is provided, identify the official dealer website and clearly state how you selected it.",
          "Capture the exact dealer website URL used and any additional source URLs consulted.",
          "Count or estimate current inventory listed on the dealer website, separated into new bikes and used/pre-owned bikes. Include the timestamp/date checked and explain if the count is approximate because filters, pagination, or site loading prevented an exact count.",
          "Capture dealer location, rooftop/address, phone, brand/franchise details, and whether it appears to be single-location or part of a group.",
          "Capture all visible manufacturer/franchise lines the dealer appears to sell, including non-Harley motorcycle, powersports, side-by-side, marine, scooter, and electric brands if present.",
          "Capture dealer history and positioning: years in business if available, ownership/group clues, market served, and notable differentiators.",
          "Capture employee/team clues: managers, sales staff, finance, BDC/marketing contacts, and any leadership names visible on the website or public profiles.",
          "Capture lead-flow clues: forms, chat/text widgets, trade/sell-my-bike forms, finance/prequal flows, test ride/service forms, inventory provider, CRM/vendor clues, tracking pixels, and any visible integration blockers.",
          "Assess lead volume potential from inventory size, form surface area, paid/search/social clues if visible, and any public traffic or review signals you can reasonably cite.",
          "Summarize buying committee, likely pain points, setup blockers, recommended LeadRider plan, and next sales move.",
          "Return the output in sections: Sources Used, Inventory Count, Dealer Profile, Team/Employees, Lead Capture/Tech Stack, Opportunity Score, Setup Risks, Recommended Next Step.",
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
      setAgentTasks(current => [data.task, ...current.filter(task => task.id !== data.task.id)].slice(0, 100));
      setNotice(`Agent task created: ${data.task.title}.`);
      if (action === "research" || action === "sales_email" || action === "onboarding") {
        window.setTimeout(() => void loadAgentTasks(), 1500);
        window.setTimeout(() => void loadAgentTasks(), 5000);
      }
      const completedActionByTask: Record<typeof action, SalesActionId> = {
        sales_email: "sales_email",
        zoom: "schedule_demo",
        onboarding: "onboarding",
        docusign: "agreement",
        research: "research"
      };
      if (action !== "research" && action !== "sales_email" && action !== "onboarding") markActionCompleted(completedActionByTask[action]);
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

  function updateNewPlan(plan: string) {
    const option = planOptions.find(row => row.name === plan);
    setNewForm(current => ({
      ...current,
      plan,
      expectedMonthly: option?.monthly ?? current.expectedMonthly
    }));
  }

  function updateSelectedPlan(plan: string) {
    const option = planOptions.find(row => row.name === plan);
    setForm(current => ({
      ...current,
      plan,
      expectedMonthly: option?.monthly ?? current.expectedMonthly
    }));
    if (option?.monthly) {
      setAgreementForm(current => ({ ...current, monthlyFee: option.monthly }));
    }
  }

  function updateDealerLines(value: string) {
    setForm(current => ({ ...current, dealerLines: value }));
    setAgreementForm(current => ({ ...current, setupFee: setupFeeForDealerLines(value) }));
  }

  function updateAgreement(field: keyof AgreementForm, value: string) {
    setAgreementForm(current => ({ ...current, [field]: value }));
  }

  function missingAgreementFields() {
    return [
      !agreementForm.legalName.trim() ? "legal name" : "",
      !agreementForm.dealerAddress.trim() ? "dealer address" : "",
      !agreementForm.signerName.trim() ? "signer name" : "",
      !agreementForm.signerEmail.trim() ? "signer email" : "",
      !agreementForm.monthlyFee.trim() ? "monthly fee" : "",
      !agreementForm.contractTerm.trim() ? "contract term" : "",
      !agreementForm.agreementUrl.trim() ? "agreement PDF/link" : ""
    ].filter(Boolean);
  }

  async function createAgreementPacket() {
    if (!selected) return;
    const missing = missingAgreementFields();
    if (missing.length) {
      setNotice(`Agreement is missing: ${missing.join(", ")}.`);
      return;
    }
    setAgreementBusy(true);
    try {
      const saveResp = await fetch(`/api/sales-prospects/${encodeURIComponent(selected.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          plan: form.plan || selected.plan,
          expectedMonthly: agreementForm.monthlyFee || form.expectedMonthly,
          contactName: form.contactName || agreementForm.signerName,
          contactEmail: form.contactEmail || agreementForm.signerEmail,
          dealerLines: form.dealerLines
        })
      });
      const saveData = await saveResp.json();
      if (!saveResp.ok || !saveData?.ok) throw new Error(saveData?.error || "Agreement details could not be saved.");
      if (saveData.prospect) {
        setProspects(current => current.map(row => (row.id === saveData.prospect.id ? saveData.prospect : row)));
        setForm(toForm(saveData.prospect));
      }

      const setupResp = await fetch(`/api/sales-prospects/${encodeURIComponent(selected.id)}/dealer-setup`, { method: "POST" });
      const setupData = await setupResp.json();
      if (!setupResp.ok || !setupData?.ok) throw new Error(setupData?.error || "Dealer setup could not be prepared for agreement.");
      const setup = setupData.setup;
      if (setup?.id) setDealerSetupLink(`/command/clients/new?setup=${encodeURIComponent(setup.id)}`);

      const setupPatchResp = await fetch(`/api/dealer-setups/${encodeURIComponent(setup.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          legalName: agreementForm.legalName,
          dbaName: agreementForm.dbaName,
          dealerAddress: agreementForm.dealerAddress,
          primaryContact: [agreementForm.signerName, agreementForm.signerEmail].filter(Boolean).join(" - "),
          plan: form.plan,
          crmProvider: form.dealerLines ? `${form.dealerLines} dealer line${form.dealerLines === "1" ? "" : "s"}` : "",
          setupFee: agreementForm.setupFee,
          monthlyFee: agreementForm.monthlyFee,
          contractTerm: agreementForm.contractTerm,
          billingStart: agreementForm.billingStart,
          notes: [
            setup.notes || "",
            `Agreement signer: ${agreementForm.signerName} <${agreementForm.signerEmail}>`,
            agreementForm.signerTitle ? `Signer title: ${agreementForm.signerTitle}` : ""
          ].filter(Boolean).join("\n")
        })
      });
      const setupPatchData = await setupPatchResp.json();
      if (!setupPatchResp.ok || !setupPatchData?.ok) throw new Error(setupPatchData?.error || "Dealer setup agreement fields could not be saved.");

      const packetResp = await fetch(`/api/dealer-setups/${encodeURIComponent(setup.id)}/esign/packet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "docusign",
          agreementTitle: `${agreementForm.legalName || selected.dealerName} LeadRider Agreement`,
          signerName: agreementForm.signerName,
          signerEmail: agreementForm.signerEmail,
          signerTitle: agreementForm.signerTitle,
          agreementUrl: agreementForm.agreementUrl,
          notes: [
            `Plan: ${form.plan || "not selected"}`,
            `Dealer lines: ${form.dealerLines || "not set"}`,
            `Monthly fee: ${agreementForm.monthlyFee}`,
            agreementForm.setupFee ? `Setup fee: ${agreementForm.setupFee}` : "",
            `Contract term: ${agreementForm.contractTerm}`,
            agreementForm.billingStart ? `Billing start: ${agreementForm.billingStart}` : ""
          ].filter(Boolean).join("\n")
        })
      });
      const packetData = await packetResp.json();
      if (!packetResp.ok || !packetData?.ok) throw new Error(packetData?.error || "Agreement packet could not be created.");

      const prospectResp = await fetch(`/api/sales-prospects/${encodeURIComponent(selected.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...toForm(saveData.prospect || selected),
          docusignPacketId: packetData.packet.id,
          stage: "agreement_sent",
          nextStep: `Agreement packet ready: ${packetData.packet.id}`
        })
      });
      const prospectData = await prospectResp.json();
      if (!prospectResp.ok || !prospectData?.ok) throw new Error(prospectData?.error || "Prospect agreement status could not be saved.");
      setProspects(current => current.map(row => (row.id === prospectData.prospect.id ? prospectData.prospect : row)));
      setForm(toForm(prospectData.prospect));
      markActionCompleted("agreement", prospectData.prospect.id);
      setNotice(`Agreement packet created for ${prospectData.prospect.dealerName}. Review it before sending.`);
      await loadAgentTasks();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Agreement packet could not be created.");
    } finally {
      setAgreementBusy(false);
    }
  }

  async function sendAgreementPacket() {
    if (!selected) return;
    const packetId = form.docusignPacketId || selected.docusignPacketId;
    if (!packetId) {
      setNotice("Create the agreement packet before sending with DocuSign.");
      return;
    }
    setAgreementSendBusy(true);
    try {
      const resp = await fetch(`/api/esign/packets/${encodeURIComponent(packetId)}/docusign/send`, {
        method: "POST"
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Agreement could not be sent with DocuSign.");
      const nextStep = data.envelopeUrl
        ? `Agreement sent with DocuSign: ${data.envelopeUrl}`
        : `Agreement sent with DocuSign: ${data.envelopeId || packetId}`;
      const prospectResp = await fetch(`/api/sales-prospects/${encodeURIComponent(selected.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          stage: "agreement_sent",
          nextStep,
          docusignPacketId: packetId
        })
      });
      const prospectData = await prospectResp.json();
      if (!prospectResp.ok || !prospectData?.ok) throw new Error(prospectData?.error || "Prospect agreement send status could not be saved.");
      setProspects(current => current.map(row => (row.id === prospectData.prospect.id ? prospectData.prospect : row)));
      setForm(toForm(prospectData.prospect));
      markActionCompleted("agreement", prospectData.prospect.id);
      setNotice(`Agreement sent with DocuSign for ${prospectData.prospect.dealerName}.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Agreement could not be sent with DocuSign.");
    } finally {
      setAgreementSendBusy(false);
    }
  }

  async function updateSalesDraftTask(task: AgentTask, status: AgentTask["status"], summary: string, noticeText: string, actionId: SalesActionId = "sales_email") {
    setDraftBusy(true);
    try {
      const resp = await fetch(`/api/agent-tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, summary })
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Draft could not be updated.");
      setAgentTasks(current => current.map(row => (row.id === data.task.id ? data.task : row)));
      setDraftEdits(current => ({ ...current, [task.id]: data.task.output?.summary || summary }));
      if (status === "completed") markActionCompleted(actionId);
      setNotice(noticeText);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Draft could not be updated.");
    } finally {
      setDraftBusy(false);
    }
  }

  async function createGmailDraftFromSalesTask(task: AgentTask) {
    if (!selected) return;
    const edited = draftEdits[task.id] ?? task.output?.summary ?? "";
    const parsed = parseEmailDraft(edited);
    setDraftBusy(true);
    try {
      const resp = await fetch(`/api/agent-tasks/${encodeURIComponent(task.id)}/personal-gmail-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: form.contactEmail || selected.contactEmail,
          subject: parsed.subject,
          bodyText: parsed.body || edited
        })
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Gmail draft could not be created.");
      if (data.task) setAgentTasks(current => current.map(row => (row.id === data.task.id ? data.task : row)));
      const sentBefore = task.output?.links?.some(link => link.startsWith("personal-gmail-sent:"));
      const draftMessage = sentBefore
        ? "New Gmail draft created. It has not been sent; this task still has an earlier sent email on record."
        : "Gmail draft created in the connected personal sales inbox.";
      setDraftSendStatus(current => ({ ...current, [task.id]: draftMessage }));
      setNotice(draftMessage);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Gmail draft could not be created.");
    } finally {
      setDraftBusy(false);
    }
  }

  async function approveAndSendSalesTask(task: AgentTask, actionId: SalesActionId = "sales_email") {
    if (!selected) return;
    const edited = draftEdits[task.id] ?? task.output?.summary ?? "";
    const parsed = parseEmailDraft(edited);
    setDraftBusy(true);
    setDraftSendStatus(current => ({ ...current, [task.id]: "Sending email..." }));
    setNotice("Sending approved sales email from the connected personal Gmail inbox.");
    try {
      const resp = await fetch(`/api/agent-tasks/${encodeURIComponent(task.id)}/personal-gmail-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: form.contactEmail || selected.contactEmail,
          subject: parsed.subject,
          bodyText: parsed.body || edited,
          summary: edited
        })
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) {
        const detail = [data?.error, data?.body ? `Body: ${data.body}` : ""].filter(Boolean).join(" ");
        throw new Error(detail || "Email could not be sent.");
      }
      if (data.task) setAgentTasks(current => current.map(row => (row.id === data.task.id ? data.task : row)));
      setDraftEdits(current => ({ ...current, [task.id]: data.task?.output?.summary || edited }));
      markActionCompleted(actionId);
      setDraftSendStatus(current => ({ ...current, [task.id]: `Gmail accepted the send to ${form.contactEmail || selected.contactEmail}.` }));
      setNotice("Sales email approved and sent from the connected personal Gmail inbox.");
      await loadAgentTasks();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Email could not be sent.";
      setDraftSendStatus(current => ({ ...current, [task.id]: message }));
      setNotice(message);
    } finally {
      setDraftBusy(false);
    }
  }

  function renderEmailDraftReview(task: AgentTask | null, actionId: SalesActionId) {
    if (!task) return null;
    const draftText = draftEdits[task.id] ?? task.output?.summary ?? "";
    const hasOutput = Boolean(task.output?.summary?.trim());
    const gmailDraftCreated = task.output?.links?.some(link => link.startsWith("personal-gmail-draft:"));
    const gmailSent = task.output?.links?.some(link => link.startsWith("personal-gmail-sent:"));
    const sentTo = taskLinkValue(task, "personal-gmail-sent-to:") || form.contactEmail || selected?.contactEmail || "";
    const sentAt = taskLinkValue(task, "personal-gmail-sent-at:");
    const sentMessage = gmailSent
      ? `Gmail accepted this send${sentTo ? ` to ${sentTo}` : ""}${sentAt ? ` on ${formatDate(sentAt)}` : ""}. Creating another Gmail draft will not send another email.`
      : "";
    const sendStatus = draftSendStatus[task.id];
    return (
      <div className="lr-ceo-draft-review">
        <div className="lr-ceo-draft-review-head">
          <span>{task.provider}</span>
          <strong>{taskStatusLabel(task.status)}</strong>
          <small>Updated {formatDate(task.updatedAt)}</small>
        </div>
        {hasOutput ? (
          <>
            <textarea
              value={draftText}
              onChange={event => setDraftEdits(current => ({ ...current, [task.id]: event.target.value }))}
              aria-label="Sales email draft"
            />
            <div className="lr-ceo-action-row">
              <button
                type="button"
                className="lr-ceo-secondary-btn"
                onClick={() => updateSalesDraftTask(task, "needs_approval", draftText, "Draft edits saved.", actionId)}
                disabled={draftBusy}
              >
                Save edits
              </button>
              <button
                type="button"
                onClick={() => createGmailDraftFromSalesTask(task)}
                disabled={draftBusy || !(form.contactEmail || selected?.contactEmail)}
              >
                {gmailDraftCreated ? "Create another Gmail draft" : "Create Gmail draft"}
              </button>
              <button
                type="button"
                className="lr-ceo-secondary-btn"
                onClick={() => approveAndSendSalesTask(task, actionId)}
                disabled={draftBusy || !(form.contactEmail || selected?.contactEmail) || gmailSent}
              >
                {gmailSent ? "Sent by Gmail" : "Approve and send"}
              </button>
              <button
                type="button"
                className="lr-ceo-link-btn"
                onClick={() =>
                  updateSalesDraftTask(
                    task,
                    "completed",
                    `${draftText}\n\nDiscarded by operator.`,
                    "Draft discarded.",
                    actionId
                  )
                }
                disabled={draftBusy}
              >
                Discard
              </button>
            </div>
            {sendStatus || sentMessage ? <p className="lr-ceo-draft-send-status">{sendStatus || sentMessage}</p> : null}
          </>
        ) : (
          <p>Draft task created. The draft will appear here after Claude finishes.</p>
        )}
      </div>
    );
  }

  function renderSalesDraftReview() {
    return renderEmailDraftReview(latestSalesEmailTask, "sales_email");
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
              <label>Dealer lines<input type="number" min="1" value={newForm.dealerLines} onChange={e => updateNew("dealerLines", e.target.value)} /></label>
              <label>Plan
                <select value={newForm.plan} onChange={e => updateNewPlan(e.target.value)}>
                  {planOptions.map(option => (
                    <option key={option.name} value={option.name}>{option.name}</option>
                  ))}
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
                        <em>{formatMeetingDate(prospect.nextStepAt)}</em>
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
              {selected ? (
                <div className="lr-ceo-title-tags">
                  <span className="lr-ceo-pill-orange">{stageLabels[selected.stage]}</span>
                  {form.owner || selected.owner ? <span className="lr-ceo-pill-blue">{form.owner || selected.owner}</span> : null}
                </div>
              ) : null}
            </div>
            {selected ? (
              <>
                <div className="lr-ceo-form-stack lr-ceo-sales-form">
                  <label>Dealer name<input value={form.dealerName} onChange={e => updateForm("dealerName", e.target.value)} /></label>
                  <label>Contact name<input value={form.contactName} onChange={e => updateForm("contactName", e.target.value)} /></label>
                  <label>Email<input value={form.contactEmail} onChange={e => updateForm("contactEmail", e.target.value)} /></label>
                  <label>Phone<input value={form.contactPhone} onChange={e => updateForm("contactPhone", e.target.value)} /></label>
                  <label>Website<input value={form.website} onChange={e => updateForm("website", e.target.value)} /></label>
                  <label>Status
                    <select value={form.stage} onChange={e => updateForm("stage", e.target.value as SalesProspectStage)}>
                      {editableStages.map(stage => (
                        <option key={stage} value={stage}>{stageLabels[stage]}</option>
                      ))}
                    </select>
                  </label>
                  <label>Lead volume<input value={form.leadVolume} onChange={e => updateForm("leadVolume", e.target.value)} /></label>
                  <label>Dealer lines<input type="number" min="1" value={form.dealerLines} onChange={e => updateDealerLines(e.target.value)} /></label>
                  <label>Plan
                    <select value={form.plan} onChange={e => updateSelectedPlan(e.target.value)}>
                      <option value="">Select plan</option>
                      {planOptions.map(option => (
                        <option key={option.name} value={option.name}>{option.name}</option>
                      ))}
                    </select>
                  </label>
                  <label>Expected monthly<input value={form.expectedMonthly} onChange={e => updateForm("expectedMonthly", e.target.value)} /></label>
                  <label>Next step<textarea value={form.nextStep} onChange={e => updateForm("nextStep", e.target.value)} /></label>
                  <label>Notes<textarea value={form.notes} onChange={e => updateForm("notes", e.target.value)} /></label>
                </div>
                <div className="lr-ceo-action-row">
                  <button type="button" onClick={() => saveProspect()} disabled={busy}>Save prospect</button>
                  <button type="button" className="lr-ceo-secondary-btn" onClick={() => saveProspect({ stage: "closed_lost" })} disabled={busy}>Mark lost</button>
                  <button type="button" className="lr-ceo-danger-btn" onClick={deleteProspect} disabled={busy}>Delete bad entry</button>
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
                  {latestResearchTask ? (
                    <div className="lr-ceo-research-summary">
                      <div>
                        <span>{latestResearchTask.provider}</span>
                        <strong>{taskStatusLabel(latestResearchTask.status)}</strong>
                        <small>Updated {formatDate(latestResearchTask.updatedAt)}</small>
                      </div>
                      {latestResearchTask.output?.summary ? (
                        <p>
                          {latestResearchMissingWebsite
                            ? `${latestResearchTask.output.summary}\n\nThis result is from an older task. Run Research again to use the saved website.`
                            : latestResearchTask.output.summary}
                        </p>
                      ) : (
                        <p>Research task created. The completed summary will appear here after the task output is saved.</p>
                      )}
                    </div>
                  ) : null}
                </div>
                <div className="lr-ceo-action-stack">
                  {renderActionControl("research", "Research", () => createAgentTask("research"), !selected || taskBusy)}
                  <button type="button" className="lr-ceo-link-btn" onClick={loadAgentTasks} disabled={agentTasksBusy}>
                    Refresh
                  </button>
                </div>
              </div>
              <div className="lr-ceo-agent-row">
                <div>
                  <strong>Sales follow-up</strong>
                  <p>Draft from the prospect owner’s sales inbox.</p>
                  <div className="lr-ceo-action-meta">
                    <span>{labelForSender(form.emailSenderType || selected?.emailSenderType || "personal")}</span>
                    <small>{visibleSenderAddress(selected, form)}</small>
                  </div>
                  {renderSalesDraftReview()}
                </div>
                {renderActionControl("sales_email", "Draft", () => createAgentTask("sales_email"), !selected || taskBusy)}
              </div>
              <div className="lr-ceo-agent-row">
                <div>
                  <strong>Demo logistics</strong>
                  <p>{form.zoomLink || selected?.zoomLink ? "Zoom meeting is saved on this prospect." : "Booking link is handled in the sales email. Create a manual Zoom only when a demo time is confirmed outside the booking page."}</p>
                  <div className={`lr-ceo-action-meta ${commandBookingLink() ? "is-ready" : "is-blocked"}`}>
                    <span>Command booking</span>
                    <small>{currentUserLabel()}</small>
                    <small>{bookingLinkAlreadyInSalesDraft() ? "Included in the latest sales email." : commandBookingSetupMessage()}</small>
                    {commandBookingLink() ? (
                      <>
                        <button type="button" className="lr-ceo-link-btn" onClick={copyCommandBookingLink}>
                          {bookingLinkCopied ? "Copied" : "Copy booking link"}
                        </button>
                      </>
                    ) : currentUser ? (
                      <a className="lr-ceo-link-btn" href="/command/users">Open Users</a>
                    ) : null}
                  </div>
                  {(form.zoomLink || selected?.zoomLink) ? (
                    <div className="lr-ceo-action-meta">
                      <span>Zoom meeting</span>
                      <small>{form.zoomLink || selected?.zoomLink}</small>
                      <small>Use Fathom when joining the call so notes are captured for follow-up.</small>
                    </div>
                  ) : null}
                  <label className="lr-ceo-inline-field">
                    Manual demo time
                    <input type="datetime-local" value={form.nextStepAt} onChange={e => updateForm("nextStepAt", e.target.value)} />
                  </label>
                </div>
                {renderActionControl("schedule_demo", "Create manual Zoom", createZoomMeeting, !selected || zoomBusy || !zoomStatus?.connected || (!form.nextStepAt && !selected?.nextStepAt))}
              </div>
              <div className="lr-ceo-agent-row">
                <div>
                  <strong>Agreement</strong>
                  <p>Complete the required legal and pricing fields, then create the packet.</p>
                  <div className="lr-ceo-agreement-grid">
                    <label>Legal name<input value={agreementForm.legalName} onChange={e => updateAgreement("legalName", e.target.value)} /></label>
                    <label>DBA<input value={agreementForm.dbaName} onChange={e => updateAgreement("dbaName", e.target.value)} /></label>
                    <label>Signer name<input value={agreementForm.signerName} onChange={e => updateAgreement("signerName", e.target.value)} /></label>
                    <label>Signer email<input value={agreementForm.signerEmail} onChange={e => updateAgreement("signerEmail", e.target.value)} /></label>
                    <label>Signer title<input value={agreementForm.signerTitle} onChange={e => updateAgreement("signerTitle", e.target.value)} /></label>
                    <label>Dealer lines<input type="number" min="1" value={form.dealerLines} onChange={e => updateDealerLines(e.target.value)} /></label>
                    <label>Monthly fee<input value={agreementForm.monthlyFee} onChange={e => updateAgreement("monthlyFee", e.target.value)} /></label>
                    <label>Setup fee<input value={agreementForm.setupFee} onChange={e => updateAgreement("setupFee", e.target.value)} /></label>
                    <label>Contract term<input value={agreementForm.contractTerm} onChange={e => updateAgreement("contractTerm", e.target.value)} /></label>
                    <label>Billing start<input value={agreementForm.billingStart} onChange={e => updateAgreement("billingStart", e.target.value)} /></label>
                    <label className="is-wide">Dealer address<input value={agreementForm.dealerAddress} onChange={e => updateAgreement("dealerAddress", e.target.value)} /></label>
                    <label className="is-wide">Agreement PDF/link<input value={agreementForm.agreementUrl} onChange={e => updateAgreement("agreementUrl", e.target.value)} placeholder="https://..." /></label>
                  </div>
                  {missingAgreementFields().length ? (
                    <div className="lr-ceo-action-meta is-blocked">
                      <span>Missing</span>
                      <small>{missingAgreementFields().join(", ")}</small>
                    </div>
                  ) : (
                    <div className="lr-ceo-action-meta is-ready">
                      <span>Ready</span>
                      <small>Agreement packet can be created for approval.</small>
                    </div>
                  )}
                  {(form.docusignPacketId || selected?.docusignPacketId) ? (
                    <div className="lr-ceo-action-meta">
                      <span>DocuSign packet</span>
                      <small>{form.docusignPacketId || selected?.docusignPacketId}</small>
                      <button type="button" className="lr-ceo-link-btn" onClick={sendAgreementPacket} disabled={agreementSendBusy}>
                        Send with DocuSign
                      </button>
                    </div>
                  ) : null}
                </div>
                {renderActionControl("agreement", "Create packet", createAgreementPacket, !selected || agreementBusy || Boolean(missingAgreementFields().length))}
              </div>
              <div className="lr-ceo-agent-row">
                <div>
                  <strong>Draft onboarding</strong>
                  <p>Prepare dealer onboarding copy after proposal stage.</p>
                  {(form.onboardingEmailThread || selected?.onboardingEmailThread) ? (
                    <div className="lr-ceo-action-meta">
                      <span>Onboarding thread</span>
                      <small>{form.onboardingEmailThread || selected?.onboardingEmailThread}</small>
                    </div>
                  ) : null}
                  {renderEmailDraftReview(latestOnboardingTask, "onboarding")}
                </div>
                {renderActionControl("onboarding", "Draft", () => createAgentTask("onboarding"), !selected || taskBusy || !isAtLeastStage(selected.stage, "proposal"))}
              </div>
              <div className="lr-ceo-agent-row">
                <div>
                  <strong>Dealer setup</strong>
                  <p>Push a won dealer into the onboarding setup checklist.</p>
                  {dealerSetupLink ? (
                    <div className="lr-ceo-action-meta is-ready">
                      <span>Setup checklist</span>
                      <small>{dealerSetupLink}</small>
                      <a className="lr-ceo-link-btn" href={dealerSetupLink}>Open setup</a>
                    </div>
                  ) : null}
                </div>
                {renderActionControl("dealer_setup", "Push", pushToDealerSetup, busy || !selected)}
              </div>
            </div>
          </article>
        </section>
      </section>
    </main>
  );
}
