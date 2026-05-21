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
  const [completedActions, setCompletedActions] = useState<string[]>([]);
  const [reopenedActions, setReopenedActions] = useState<string[]>([]);
  const [agentTasks, setAgentTasks] = useState<AgentTask[]>([]);
  const [agentTasksBusy, setAgentTasksBusy] = useState(false);
  const [draftEdits, setDraftEdits] = useState<Record<string, string>>({});
  const [draftBusy, setDraftBusy] = useState(false);
  const [currentUser, setCurrentUser] = useState<CommandUser | null>(null);

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

  const latestResearchMissingWebsite = useMemo(() => {
    const currentWebsite = form.website.trim() || selected?.website?.trim();
    return Boolean(
      currentWebsite &&
      latestResearchTask?.output?.summary?.includes("No dealer website was provided")
    );
  }, [form.website, latestResearchTask, selected?.website]);

  useEffect(() => {
    if (!selected || latestResearchTask?.kind !== "prospect_research") return;
    const shouldPoll =
      latestResearchTask.status === "queued" ||
      latestResearchTask.status === "running" ||
      (latestResearchTask.status === "completed" && !latestResearchTask.output?.summary?.trim());
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
    const shouldPoll =
      latestSalesEmailTask.status === "queued" ||
      latestSalesEmailTask.status === "running" ||
      (latestSalesEmailTask.status === "completed" && !latestSalesEmailTask.output?.summary?.trim());
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
    if (!latestSalesEmailTask?.id || !latestSalesEmailTask.output?.summary) return;
    setDraftEdits(current =>
      current[latestSalesEmailTask.id] == null
        ? { ...current, [latestSalesEmailTask.id]: latestSalesEmailTask.output?.summary ?? "" }
        : current
    );
  }, [latestSalesEmailTask?.id, latestSalesEmailTask?.output?.summary]);

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
    if (actionId === "agreement") return isAtLeastStage(selected.stage, "proposal") || Boolean(form.docusignPacketId || selected.docusignPacketId);
    if (actionId === "onboarding") return Boolean(form.onboardingEmailThread || selected.onboardingEmailThread);
    if (actionId === "dealer_setup") return selected.stage === "closed_won";
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
      setProspects(rows);
      if (rows.length && !selectedId) setSelectedId(rows[0].id);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Sales prospects could not be loaded.");
    }
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
      `Next step: ${taskSelected.nextStep || "not set"}`,
      `Next step date: ${taskSelected.nextStepAt || "not set"}`,
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
          "If the LeadRider command booking link is configured, include it naturally as the scheduling link.",
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
      if (action === "research") {
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
      if (action !== "research" && action !== "sales_email") markActionCompleted(completedActionByTask[action]);
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

  async function updateSalesDraftTask(task: AgentTask, status: AgentTask["status"], summary: string, noticeText: string) {
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
      if (status === "completed") markActionCompleted("sales_email");
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
      setNotice("Gmail draft created in the connected personal sales inbox.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Gmail draft could not be created.");
    } finally {
      setDraftBusy(false);
    }
  }

  function renderSalesDraftReview() {
    if (!latestSalesEmailTask) return null;
    const draftText = draftEdits[latestSalesEmailTask.id] ?? latestSalesEmailTask.output?.summary ?? "";
    const hasOutput = Boolean(latestSalesEmailTask.output?.summary?.trim());
    const gmailDraftCreated = latestSalesEmailTask.output?.links?.some(link => link.startsWith("personal-gmail-draft:"));
    return (
      <div className="lr-ceo-draft-review">
        <div className="lr-ceo-draft-review-head">
          <span>{latestSalesEmailTask.provider}</span>
          <strong>{taskStatusLabel(latestSalesEmailTask.status)}</strong>
          <small>Updated {formatDate(latestSalesEmailTask.updatedAt)}</small>
        </div>
        {hasOutput ? (
          <>
            <textarea
              value={draftText}
              onChange={event => setDraftEdits(current => ({ ...current, [latestSalesEmailTask.id]: event.target.value }))}
              aria-label="Sales email draft"
            />
            <div className="lr-ceo-action-row">
              <button
                type="button"
                className="lr-ceo-secondary-btn"
                onClick={() => updateSalesDraftTask(latestSalesEmailTask, "needs_approval", draftText, "Sales draft edits saved.")}
                disabled={draftBusy}
              >
                Save edits
              </button>
              <button
                type="button"
                onClick={() => createGmailDraftFromSalesTask(latestSalesEmailTask)}
                disabled={draftBusy || !(form.contactEmail || selected?.contactEmail) || gmailDraftCreated}
              >
                {gmailDraftCreated ? "Gmail draft created" : "Create Gmail draft"}
              </button>
              <button
                type="button"
                className="lr-ceo-secondary-btn"
                onClick={() => updateSalesDraftTask(latestSalesEmailTask, "completed", draftText, "Sales draft approved.")}
                disabled={draftBusy}
              >
                Approve
              </button>
              <button
                type="button"
                className="lr-ceo-link-btn"
                onClick={() =>
                  updateSalesDraftTask(
                    latestSalesEmailTask,
                    "completed",
                    `${draftText}\n\nDiscarded by operator.`,
                    "Sales draft discarded."
                  )
                }
                disabled={draftBusy}
              >
                Discard
              </button>
            </div>
          </>
        ) : (
          <p>Draft task created. The draft will appear here after Claude finishes.</p>
        )}
      </div>
    );
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
                  <label>Lead volume<input value={form.leadVolume} onChange={e => updateForm("leadVolume", e.target.value)} /></label>
                  <label>Plan<input value={form.plan} onChange={e => updateForm("plan", e.target.value)} /></label>
                  <label>Expected monthly<input value={form.expectedMonthly} onChange={e => updateForm("expectedMonthly", e.target.value)} /></label>
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
                  <strong>Schedule demo</strong>
                  <p>{form.zoomLink || selected?.zoomLink ? "Zoom link saved on this prospect." : "Pick a meeting time and create a Zoom link."}</p>
                  {(form.zoomLink || selected?.zoomLink) ? (
                    <div className="lr-ceo-action-meta">
                      <span>Zoom/Fathom link</span>
                      <small>{form.zoomLink || selected?.zoomLink}</small>
                    </div>
                  ) : null}
                  <label className="lr-ceo-inline-field">
                    Demo meeting time
                    <input type="datetime-local" value={form.nextStepAt} onChange={e => updateForm("nextStepAt", e.target.value)} />
                  </label>
                </div>
                {renderActionControl("schedule_demo", "Schedule", createZoomMeeting, !selected || zoomBusy || !zoomStatus?.connected || (!form.nextStepAt && !selected?.nextStepAt))}
              </div>
              <div className="lr-ceo-agent-row">
                <div>
                  <strong>Agreement</strong>
                  <p>Prepare missing legal and pricing fields.</p>
                  {(form.docusignPacketId || selected?.docusignPacketId) ? (
                    <div className="lr-ceo-action-meta">
                      <span>DocuSign packet</span>
                      <small>{form.docusignPacketId || selected?.docusignPacketId}</small>
                    </div>
                  ) : null}
                </div>
                {renderActionControl("agreement", "Prepare", () => createAgentTask("docusign"), !selected || taskBusy)}
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
                </div>
                {renderActionControl("onboarding", "Draft", () => createAgentTask("onboarding"), !selected || taskBusy || !isAtLeastStage(selected.stage, "proposal"))}
              </div>
              <div className="lr-ceo-agent-row">
                <div>
                  <strong>Dealer setup</strong>
                  <p>Push a won dealer into the onboarding setup checklist.</p>
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
