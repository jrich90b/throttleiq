"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const BOOKING_LINK_RE =
  /(Book here|You can choose a time here|You can book an appointment here):\s*(https?:\/\/[^\s<]+)/i;
const BOOKING_LABEL_ONLY_RE =
  /\b(Book here|You can choose a time here|You can book an appointment here)\b/i;

function renderBookingLinkLine(line: string) {
  const match = line.match(BOOKING_LINK_RE);
  if (!match) return line;
  const label = match[1];
  const url = match[2];
  const idx = match.index ?? 0;
  const before = line.slice(0, idx);
  const after = line.slice(idx + match[0].length);
  const prefix = String(label).replace(/\s*here$/i, "").trim();
  const prefixWithSpace = prefix.length ? `${prefix} ` : "";
  return (
    <>
      {before}
      {prefixWithSpace}
      <a className="underline" href={url} target="_blank" rel="noreferrer">
        here
      </a>
      {after}
    </>
  );
}

function renderMessageBody(text?: string | null) {
  if (!text) return null;
  const lines = text.split("\n");
  return lines.map((line, idx) => (
    <span key={idx}>
      {renderBookingLinkLine(line)}
      {idx < lines.length - 1 ? <br /> : null}
    </span>
  ));
}

function maskBookingLink(text?: string | null) {
  if (!text) return "";
  return text.replace(BOOKING_LINK_RE, (m, label) => {
    const prefix = String(label).replace(/\s*here$/i, "").trim();
    const prefixWithSpace = prefix.length ? `${prefix} ` : "";
    return `${prefixWithSpace}here`;
  });
}

function extractBookingUrl(text?: string | null) {
  if (!text) return null;
  const match = text.match(BOOKING_LINK_RE);
  return match?.[2] ?? null;
}

function injectBookingUrl(body: string, url: string) {
  if (BOOKING_LINK_RE.test(body)) return body;
  if (BOOKING_LABEL_ONLY_RE.test(body)) {
    return body.replace(BOOKING_LABEL_ONLY_RE, (label) => `${label}: ${url}`);
  }
  return `${body}\n\nYou can book an appointment here: ${url}`;
}

type SystemMode = "suggest" | "autopilot";

type ConversationListItem = {
  id: string;
  leadKey: string;
  mode?: "suggest" | "human";
  status?: "open" | "closed";
  closedAt?: string | null;
  closedReason?: string | null;
  contactPreference?: "call_only";
  leadName?: string | null;
  vehicleDescription?: string | null;
  updatedAt: string;
  messageCount: number;
  lastMessage?: { direction: "in" | "out"; body: string; provider?: string } | null;
  pendingDraft?: boolean;
  pendingDraftPreview?: string | null;
};

type Message = {
  id: string;
  direction: "in" | "out";
  from: string;
  to: string;
  body: string;
  mediaUrls?: string[];
  at: string;
  provider?: string;
  draftStatus?: "pending" | "stale";
};

type ConversationDetail = {
  id: string;
  leadKey: string;
  mode?: "suggest" | "human";
  status?: "open" | "closed";
  closedAt?: string | null;
  closedReason?: string | null;
  contactPreference?: "call_only";
  lead?: { leadRef?: string };
  messages: Message[];
};

type TodoItem = {
  id: string;
  convId: string;
  leadKey: string;
  reason: string;
  summary: string;
  createdAt: string;
};

type QuestionItem = {
  id: string;
  convId: string;
  leadKey: string;
  text: string;
  createdAt: string;
  type?: string;
  outcome?: string;
  followUpAction?: string;
};

function todoActionLabel(todo: TodoItem): string {
  const reason = (todo.reason ?? "").toLowerCase();
  const summary = (todo.summary ?? "").toLowerCase();
  const text = `${reason} ${summary}`;
  if (/(call only|phone only|no text|do not text)/.test(text)) return "Call customer (call-only).";
  if (/(credit|prequal|finance)/.test(text)) return "Business manager follow-up (credit app).";
  if (/(trade|appraisal|trade[- ]in)/.test(text)) return "Discuss trade appraisal and next steps.";
  if (/(inventory|verify|check stock|not seeing|live feed)/.test(text)) return "Verify inventory and follow up.";
  if (/(video|walkaround|photos)/.test(text)) return "Send a walkaround video or photos.";
  if (/(appointment|schedule|book)/.test(text)) return "Schedule an appointment.";
  if (/(pricing|price|quote|payment)/.test(text)) return "Provide pricing or payment details.";
  return "Follow up with the customer.";
}

type SuppressionItem = {
  phone: string;
  addedAt: string;
  reason?: string;
  source?: string;
};

type ContactItem = {
  id: string;
  leadKey?: string;
  conversationId?: string;
  leadRef?: string;
  leadSource?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  phone?: string;
  vehicleDescription?: string;
  stockId?: string;
  vin?: string;
  year?: string;
  vehicle?: string;
  inquiry?: string;
  updatedAt?: string;
  status?: "active" | "archived" | "suppressed";
};

export default function Home() {
  const [mode, setMode] = useState<SystemMode>("suggest");
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [questions, setQuestions] = useState<QuestionItem[]>([]);
  const [questionOutcomeById, setQuestionOutcomeById] = useState<Record<string, string>>({});
  const [questionFollowUpById, setQuestionFollowUpById] = useState<Record<string, string>>({});
  const [suppressions, setSuppressions] = useState<SuppressionItem[]>([]);
  const [contacts, setContacts] = useState<ContactItem[]>([]);
  const [newSuppression, setNewSuppression] = useState("");
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"inbox" | "archive">("inbox");
  const [section, setSection] = useState<
    | "inbox"
    | "todos"
    | "questions"
    | "suppressions"
    | "contacts"
    | "inventory"
    | "settings"
    | "calendar"
  >("inbox");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedConv, setSelectedConv] = useState<ConversationDetail | null>(null);
  const [selectedContact, setSelectedContact] = useState<ContactItem | null>(null);
  const [contactEdit, setContactEdit] = useState(false);
  const [contactForm, setContactForm] = useState({
    firstName: "",
    lastName: "",
    name: "",
    email: "",
    phone: ""
  });
  const [contactQuery, setContactQuery] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [sendBody, setSendBody] = useState("");
  const [sendBodySource, setSendBodySource] = useState<"draft" | "user" | "system">("system");
  const [lastDraftId, setLastDraftId] = useState<string | null>(null);
  const [editPromptOpen, setEditPromptOpen] = useState(false);
  const [editNote, setEditNote] = useState("");
  const [pendingSend, setPendingSend] = useState<{ body: string; draftId?: string } | null>(null);
  const [closeReason, setCloseReason] = useState("sold");
  const [listActionsOpenId, setListActionsOpenId] = useState<string | null>(null);
  const [todoPromptOpen, setTodoPromptOpen] = useState(false);
  const [todoPromptText, setTodoPromptText] = useState("");
  const [todoPromptConvId, setTodoPromptConvId] = useState<string | null>(null);
  const sendBoxRef = useRef<HTMLTextAreaElement | null>(null);
  const streamRef = useRef<EventSource | null>(null);
  const lastStreamRefreshRef = useRef(0);
  const loadRef = useRef<() => Promise<void>>(async () => {});
  const loadConversationRef = useRef<(id: string) => Promise<void>>(async () => {});
  const selectedIdRef = useRef<string | null>(null);
  const refreshConversationsRef = useRef<() => Promise<void>>(async () => {});
  const refreshSelectedRef = useRef<(id: string) => Promise<void>>(async () => {});
  const lastConversationsSigRef = useRef<string>("");
  const lastSelectedSigRef = useRef<string>("");
  const [modeSaving, setModeSaving] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"dealer" | "scheduler" | "users">("dealer");
  const [authUser, setAuthUser] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [loginForm, setLoginForm] = useState({ email: "", password: "", name: "" });
  const [usersList, setUsersList] = useState<any[]>([]);
  const [userForm, setUserForm] = useState({
    email: "",
    password: "",
    name: "",
    phone: "",
    extension: "",
    role: "salesperson",
    calendarId: "",
    permissions: {
      canEditAppointments: false,
      canToggleHumanOverride: false,
      canAccessTodos: false,
      canAccessSuppressions: false
    }
  });
  const [userPasswords, setUserPasswords] = useState<Record<string, string>>({});
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [showNewUserForm, setShowNewUserForm] = useState(false);
  const [dealerProfile, setDealerProfile] = useState<any>(null);
  const [dealerProfileForm, setDealerProfileForm] = useState({
    dealerName: "",
    agentName: "",
    crmProvider: "",
    websiteProvider: "",
    fromEmail: "",
    replyToEmail: "",
    emailSignature: "",
    logoUrl: "",
    bookingUrl: "",
    bookingToken: "",
    phone: "",
    website: "",
    addressLine1: "",
    city: "",
    state: "",
    zip: "",
    testRideEnabled: true,
    testRideMonths: [4, 5, 6, 7, 8, 9, 10]
  });
  const [dealerHours, setDealerHours] = useState<Record<string, { open: string | null; close: string | null }>>(
    {}
  );
  const [schedulerConfig, setSchedulerConfig] = useState<any>(null);
  const [messageFilter, setMessageFilter] = useState<"sms" | "email" | "calls">("sms");
  const [schedulerForm, setSchedulerForm] = useState({
    timezone: "America/New_York",
    assignmentMode: "preferred",
    minLeadTimeHours: "4",
    minGapBetweenAppointmentsMinutes: "60",
    weekdayEarliest: "09:30",
    weekdayLatest: "17:00",
    saturdayEarliest: "09:30",
    saturdayLatest: "14:00"
  });
  const [schedulerHours, setSchedulerHours] = useState<
    Record<string, { open: string | null; close: string | null }>
  >({});
  const [availabilityBlocks, setAvailabilityBlocks] = useState<Record<string, any[]>>({});
  const [salespeopleList, setSalespeopleList] = useState<
    Array<{ id: string; name: string; calendarId: string }>
  >([]);
  const [preferredOrderIds, setPreferredOrderIds] = useState<string[]>([]);
  const [appointmentTypesList, setAppointmentTypesList] = useState<
    Array<{ key: string; durationMinutes: string }>
  >([{ key: "inventory_visit", durationMinutes: "60" }]);
  const [appointmentTypeToAdd, setAppointmentTypeToAdd] = useState("inventory_visit");
  const [newSalespersonName, setNewSalespersonName] = useState("");
  const [creatingCalendar, setCreatingCalendar] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [calendarView, setCalendarView] = useState<"day" | "week">("day");
  const [calendarDate, setCalendarDate] = useState<Date>(new Date());
  const [calendarEvents, setCalendarEvents] = useState<any[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [calendarSalespeople, setCalendarSalespeople] = useState<string[]>([]);
  const [calendarFilterOpen, setCalendarFilterOpen] = useState(false);
  const [calendarEdit, setCalendarEdit] = useState<any | null>(null);
  const [calendarRowHeight, setCalendarRowHeight] = useState(40);
  const [inventoryItems, setInventoryItems] = useState<any[]>([]);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryQuery, setInventoryQuery] = useState("");
  const [inventoryNotes, setInventoryNotes] = useState<Record<string, any[]>>({});
  const [inventorySaving, setInventorySaving] = useState<string | null>(null);
  const [inventoryExpandedNote, setInventoryExpandedNote] = useState<string | null>(null);
  const inventoryNoteSuggestions = useMemo(() => {
    const labels = new Set<string>();
    const notes = new Set<string>();
    Object.values(inventoryNotes).forEach(list => {
      (list ?? []).forEach((n: any) => {
        const l = String(n?.label ?? "").trim();
        const t = String(n?.note ?? "").trim();
        if (l) labels.add(l);
        if (t) notes.add(t);
      });
    });
    return {
      labels: Array.from(labels).slice(0, 50),
      notes: Array.from(notes).slice(0, 50)
    };
  }, [inventoryNotes]);
  const [calendarEditForm, setCalendarEditForm] = useState({
    summary: "",
    startDate: "",
    startTime: "",
    endDate: "",
    endTime: "",
    status: "scheduled",
    reason: ""
  });
  const [calendarEditSalespersonId, setCalendarEditSalespersonId] = useState("");
  const [todoResolveOpen, setTodoResolveOpen] = useState(false);
  const [todoResolveTarget, setTodoResolveTarget] = useState<TodoItem | null>(null);
  const [todoResolution, setTodoResolution] = useState("resume");
  const [saveToast, setSaveToast] = useState<string | null>(null);
  const [callBusy, setCallBusy] = useState(false);
  const [callMethod, setCallMethod] = useState<"cell" | "extension">("cell");
  const [callPickerOpen, setCallPickerOpen] = useState(false);
  const calendarColumnRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const calendarEventsRef = useRef<any[]>([]);
  const calendarGridRef = useRef<HTMLDivElement | null>(null);
  const dragGuardRef = useRef<{ blockUntil: number }>({ blockUntil: 0 });
  const dragStateRef = useRef<{
    mode: "move" | "resize" | null;
    event: any | null;
    startY: number;
    origStartMin: number;
    origEndMin: number;
    openWindow: number;
    closeWindow: number;
    didMove?: boolean;
  }>({ mode: null, event: null, startY: 0, origStartMin: 0, origEndMin: 0, openWindow: 0, closeWindow: 0 });
  const [blockForm, setBlockForm] = useState({
    salespersonId: "",
    title: "",
    days: ["monday"],
    start: "12:00",
    end: "13:00",
    allDay: false
  });

  async function load() {
    setLoading(true);

    const authResp = await fetch("/api/auth/me", { cache: "no-store" });
    const authJson = await authResp.json();
    if (!authResp.ok || !authJson?.ok) {
      setAuthUser(null);
      setAuthLoading(false);
      setNeedsBootstrap(false);
      setLoading(false);
      return;
    }
    if (authJson?.needsBootstrap) {
      setNeedsBootstrap(true);
      setAuthUser(null);
      setAuthLoading(false);
      setLoading(false);
      return;
    }
    setNeedsBootstrap(false);
    setAuthUser(authJson?.user ?? null);

    const [s, c, contactsResp] = await Promise.all([
      fetch("/api/settings", { cache: "no-store" }),
      fetch("/api/conversations", { cache: "no-store" }),
      fetch("/api/contacts", { cache: "no-store" })
    ]);
    const [t, q, sup] = await Promise.all([
      fetch("/api/todos", { cache: "no-store" }),
      fetch("/api/questions", { cache: "no-store" }),
      fetch("/api/suppressions", { cache: "no-store" })
    ]);

    const settings = await s.json();
    const convs = await c.json();
    const contactsJson = await contactsResp.json();
    const todosResp = await t.json();
    const questionsResp = await q.json();
    const suppressionsResp = await sup.json();

    setMode((settings?.mode as SystemMode) ?? "suggest");
    setConversations(
      (convs?.conversations as ConversationListItem[])?.map(c => ({
        ...c,
        mode: c.mode ?? "suggest"
      })) ?? []
    );
    setTodos((todosResp?.todos as TodoItem[]) ?? []);
    setQuestions((questionsResp?.questions as QuestionItem[]) ?? []);
    setSuppressions((suppressionsResp?.suppressions as SuppressionItem[]) ?? []);
    setContacts((contactsJson?.contacts as ContactItem[]) ?? []);
    setLoading(false);
    setAuthLoading(false);
  }

  useEffect(() => {
    calendarEventsRef.current = calendarEvents;
  }, [calendarEvents]);

  useEffect(() => {
    if (section !== "calendar") return;
    const compute = () => {
      const el = calendarGridRef.current;
      if (!el) return;
      const height = el.getBoundingClientRect().height;
      const tz = schedulerConfig?.timezone ?? "America/New_York";
      const dayName = calendarDate.toLocaleDateString("en-US", { weekday: "long", timeZone: tz }).toLowerCase();
      const hours = schedulerConfig?.businessHours?.[dayName];
      const parseTime = (t?: string | null) => {
        if (!t) return null;
        const [h, m] = t.split(":").map(Number);
        return h * 60 + (m || 0);
      };
      let open = parseTime(hours?.open);
      let close = parseTime(hours?.close);
      if (open == null || close == null || close <= open) {
        open = 9 * 60;
        close = 18 * 60;
      }
      const totalMinutes = close - open;
      const rowCount = Math.max(1, Math.ceil(totalMinutes / 60));
      const nextHeight = Math.max(32, Math.floor(height / rowCount));
      setCalendarRowHeight(nextHeight);
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [section, schedulerConfig?.businessHours, schedulerConfig?.timezone, calendarDate]);

  async function loadConversation(id: string) {
    setDetailLoading(true);
    const r = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { cache: "no-store" });
    const data = await r.json();
    setSelectedConv(data?.conversation ?? null);
    setDetailLoading(false);
  }

  async function refreshConversations() {
    if (document.visibilityState === "hidden") return;
    const r = await fetch("/api/conversations", { cache: "no-store" });
    const data = await r.json();
    const next =
      (data?.conversations as ConversationListItem[])?.map(c => ({
        ...c,
        mode: c.mode ?? "suggest"
      })) ?? [];
    const sig = next
      .map(c => `${c.id}:${c.updatedAt}:${c.messageCount}:${c.lastMessage?.body ?? ""}`)
      .join("|");
    if (sig && sig === lastConversationsSigRef.current) return;
    lastConversationsSigRef.current = sig;
    setConversations(next);
  }

  async function refreshSelectedConversation(id: string) {
    if (document.visibilityState === "hidden") return;
    const r = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { cache: "no-store" });
    const data = await r.json();
    const conv = data?.conversation ?? null;
    const sig = conv
      ? `${conv.id}:${conv.updatedAt ?? ""}:${conv.messages?.length ?? 0}:` +
        `${conv.messages?.[conv.messages?.length - 1]?.id ?? ""}`
      : "";
    if (sig && sig === lastSelectedSigRef.current) return;
    lastSelectedSigRef.current = sig;
    setSelectedConv(conv);
  }

  async function updateMode(next: SystemMode) {
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: next })
    });
    await load();
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (selectedId) void loadConversation(selectedId);
  }, [selectedId]);

  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    loadConversationRef.current = loadConversation;
  });

  useEffect(() => {
    refreshConversationsRef.current = refreshConversations;
  });

  useEffect(() => {
    refreshSelectedRef.current = refreshSelectedConversation;
  });

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    if (!authUser) return;
    if (typeof EventSource === "undefined") return;
    if (streamRef.current) return;

    const connect = () => {
      const es = new EventSource("/api/stream");
      streamRef.current = es;

      const refresh = () => {
        const now = Date.now();
        if (now - lastStreamRefreshRef.current < 2000) return;
        lastStreamRefreshRef.current = now;
        void refreshConversationsRef.current();
        const id = selectedIdRef.current;
        if (id) void refreshSelectedRef.current(id);
      };

      es.addEventListener("ping", refresh);
      es.onmessage = refresh;
      es.onerror = () => {
        es.close();
        if (streamRef.current === es) {
          streamRef.current = null;
        }
        setTimeout(() => {
          if (!streamRef.current && authUser) connect();
        }, 5000);
      };
    };

    connect();
    return () => {
      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }
    };
  }, [authUser]);

  useEffect(() => {
    if (section !== "contacts") setSelectedContact(null);
  }, [section]);

  useEffect(() => {
    if (section !== "settings") return;
    setSettingsError(null);
    void (async () => {
      try {
        const [dealerResp, schedResp, usersResp] = await Promise.all([
          fetch("/api/dealer-profile", { cache: "no-store" }),
          fetch("/api/scheduler-config", { cache: "no-store" }),
          fetch("/api/users", { cache: "no-store" })
        ]);
        const dealerJson = await dealerResp.json();
        const schedJson = await schedResp.json();
        const usersJson = await usersResp.json();
        const profile = dealerJson?.profile ?? {};
        const followUp = profile.followUp ?? {};
        const followUpMonths = Array.isArray(followUp.testRideMonths) ? followUp.testRideMonths : [4, 5, 6, 7, 8, 9, 10];
        setDealerProfile(profile);
        setDealerProfileForm({
          dealerName: profile.dealerName ?? "",
          agentName: profile.agentName ?? "",
          crmProvider: profile.crmProvider ?? "",
          websiteProvider: profile.websiteProvider ?? "",
          fromEmail: profile.fromEmail ?? "",
          replyToEmail: profile.replyToEmail ?? "",
          emailSignature: profile.emailSignature ?? "",
          logoUrl: profile.logoUrl ?? "",
          bookingUrl: profile.bookingUrl ?? "",
          bookingToken: profile.bookingToken ?? "",
          phone: profile.phone ?? "",
          website: profile.website ?? "",
          addressLine1: profile.address?.line1 ?? "",
          city: profile.address?.city ?? "",
          state: profile.address?.state ?? "",
          zip: profile.address?.zip ?? "",
          testRideEnabled: followUp.testRideEnabled !== false,
          testRideMonths: followUpMonths
        });
        setDealerHours(profile.hours ?? {});

        const cfg = schedJson?.config ?? {};
        setSchedulerConfig(cfg);
        setSchedulerForm({
          timezone: cfg.timezone ?? "America/New_York",
          assignmentMode: cfg.assignmentMode ?? "preferred",
          minLeadTimeHours: String(cfg.minLeadTimeHours ?? 4),
          minGapBetweenAppointmentsMinutes: String(cfg.minGapBetweenAppointmentsMinutes ?? 60),
          weekdayEarliest: cfg.bookingWindows?.weekday?.earliestStart ?? "09:30",
          weekdayLatest: cfg.bookingWindows?.weekday?.latestStart ?? "17:00",
          saturdayEarliest: cfg.bookingWindows?.saturday?.earliestStart ?? "09:30",
          saturdayLatest: cfg.bookingWindows?.saturday?.latestStart ?? "14:00"
        });
        setSchedulerHours(cfg.businessHours ?? {});
        setSalespeopleList(cfg.salespeople ?? []);
        setAvailabilityBlocks(cfg.availabilityBlocks ?? {});
        setPreferredOrderIds(cfg.preferredSalespeople ?? []);
      setUsersList(usersJson?.users ?? []);
        const at = cfg.appointmentTypes ?? { inventory_visit: { durationMinutes: 60 } };
        setAppointmentTypesList(
          Object.entries(at).map(([key, val]: any) => ({
            key,
            durationMinutes: String(val?.durationMinutes ?? 60)
          }))
        );
        const firstSp =
          (usersJson?.users ?? []).find((u: any) => u.role === "salesperson")?.id ??
          (cfg.salespeople ?? [])[0]?.id;
        setBlockForm(prev => ({ ...prev, salespersonId: prev.salespersonId || firstSp || "" }));
      } catch (err: any) {
        setSettingsError(err?.message ?? "Failed to load settings");
      }
    })();
  }, [section]);

  useEffect(() => {
    if (!dealerProfileForm.bookingToken) return;
    if (dealerProfileForm.bookingUrl) return;
    if (typeof window === "undefined") return;
    const token = dealerProfileForm.bookingToken.trim();
    if (!token) return;
    const url = `${window.location.origin}/book?token=${encodeURIComponent(token)}`;
    setDealerProfileForm(prev => (prev.bookingUrl ? prev : { ...prev, bookingUrl: url }));
  }, [dealerProfileForm.bookingToken, dealerProfileForm.bookingUrl]);

  const calendarUsers = useMemo(
    () => (usersList ?? []).filter((u: any) => !!u.calendarId),
    [usersList]
  );

  useEffect(() => {
    if (section !== "calendar") return;
    if (schedulerConfig) return;
    void (async () => {
      try {
        const resp = await fetch("/api/scheduler-config", { cache: "no-store" });
        const json = await resp.json();
        const cfg = json?.config ?? {};
        setSchedulerConfig(cfg);
        if (!calendarSalespeople.length && calendarUsers.length) {
          setCalendarSalespeople(calendarUsers.map(u => u.id));
        }
      } catch {
        // ignore
      }
    })();
  }, [section, schedulerConfig, calendarSalespeople.length, calendarUsers]);

  useEffect(() => {
    if (section !== "calendar") return;
    if (usersList.length) return;
    void (async () => {
      try {
        const resp = await fetch("/api/users", { cache: "no-store" });
        const json = await resp.json();
        setUsersList(json?.users ?? []);
      } catch {
        // ignore
      }
    })();
  }, [section, usersList.length]);

  useEffect(() => {
    if (section !== "calendar") return;
    if (calendarSalespeople.length) return;
    if (!calendarUsers.length) return;
    setCalendarSalespeople(calendarUsers.map(u => u.id));
  }, [section, calendarSalespeople.length, calendarUsers]);

  useEffect(() => {
    if (section !== "calendar") return;
    if (!schedulerConfig?.timezone) return;
    const loadEvents = async () => {
      setCalendarLoading(true);
      try {
        const start = new Date(calendarDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        if (calendarView === "week") {
          end.setDate(end.getDate() + 7);
        } else {
          end.setDate(end.getDate() + 1);
        }
        const params = new URLSearchParams();
        params.set("start", start.toISOString());
        params.set("end", end.toISOString());
        if (calendarSalespeople.length) {
          params.set("userIds", calendarSalespeople.join(","));
        }
        const resp = await fetch(`/api/calendar/events?${params.toString()}`, { cache: "no-store" });
        const json = await resp.json();
        setCalendarEvents(buildCalendarEvents(json));
      } catch {
        setCalendarEvents([]);
      } finally {
        setCalendarLoading(false);
      }
    };
    void loadEvents();
  }, [section, schedulerConfig, calendarDate, calendarView, calendarSalespeople]);

  async function saveInventoryNote(stockId?: string, vin?: string) {
    const key = String(stockId ?? vin ?? "").trim().toLowerCase();
    if (!key) return;
    setInventorySaving(key);
    try {
      const notes = Array.isArray(inventoryNotes[key]) ? inventoryNotes[key] : [];
      const resp = await fetch("/api/inventory", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stockId, vin, notes })
      });
      const json = await resp.json();
      if (!resp.ok || json?.ok === false) {
        throw new Error(json?.error ?? "Failed to save note");
      }
      setInventoryItems(prev =>
        prev.map(it => {
          const k = String(it.stockId ?? it.vin ?? "").trim().toLowerCase();
          if (k !== key) return it;
          return { ...it, notes };
        })
      );
      setSaveToast("Inventory note saved");
      setTimeout(() => setSaveToast(null), 2000);
    } catch (err: any) {
      setSettingsError(err?.message ?? "Failed to save note");
    } finally {
      setInventorySaving(null);
    }
  }

  useEffect(() => {
    if (section !== "inventory") return;
    if (inventoryItems.length) return;
    void (async () => {
      setInventoryLoading(true);
      try {
        const resp = await fetch("/api/inventory", { cache: "no-store" });
        const json = await resp.json();
        const items = Array.isArray(json?.items) ? json.items : [];
        setInventoryItems(items);
        const noteMap: Record<string, any[]> = {};
        items.forEach((it: any) => {
          const key = String(it.stockId ?? it.vin ?? "").trim().toLowerCase();
          if (key) noteMap[key] = Array.isArray(it.notes) ? it.notes : [];
        });
        setInventoryNotes(noteMap);
      } catch {
        setInventoryItems([]);
      } finally {
        setInventoryLoading(false);
      }
    })();
  }, [section, inventoryItems.length]);

  useEffect(() => {
    if (!calendarEdit) return;
    const tz = schedulerConfig?.timezone ?? "America/New_York";
    const startIso = calendarEdit.start ?? "";
    const endIso = calendarEdit.end ?? "";
    const start = startIso ? new Date(startIso) : null;
    const end = endIso ? new Date(endIso) : null;
    const toTzParts = (d: Date | null) => {
      if (!d) return null;
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).formatToParts(d);
      const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
      return {
        date: `${get("year")}-${get("month")}-${get("day")}`,
        time: `${get("hour")}:${get("minute")}`
      };
    };
    const minutesToTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const localDay = calendarDate.toLocaleDateString("en-CA", { timeZone: tz });
    const dragStart = typeof calendarEdit._dragStart === "number" ? calendarEdit._dragStart : null;
    const dragEnd = typeof calendarEdit._dragEnd === "number" ? calendarEdit._dragEnd : null;
    const startParts = dragStart != null ? { date: localDay, time: minutesToTime(dragStart) } : toTzParts(start);
    const endParts = dragEnd != null ? { date: localDay, time: minutesToTime(dragEnd) } : toTzParts(end);
    setCalendarEditForm({
      summary: calendarEdit.summary ?? "",
      startDate: startParts?.date ?? "",
      startTime: startParts?.time ?? "",
      endDate: endParts?.date ?? "",
      endTime: endParts?.time ?? "",
      status: "scheduled",
      reason: ""
    });
    if (calendarEdit.calendarId) {
      const sp = calendarUsers.find((u: any) => u.calendarId === calendarEdit.calendarId) ??
        calendarUsers.find((u: any) => u.id === calendarEdit.salespersonId);
      setCalendarEditSalespersonId(sp?.id ?? "");
    }
  }, [calendarEdit, calendarDate, schedulerConfig?.timezone, calendarUsers]);

  useEffect(() => {
    if (!selectedContact) return;
    setContactEdit(false);
    setContactForm({
      firstName: selectedContact.firstName ?? "",
      lastName: selectedContact.lastName ?? "",
      name: selectedContact.name ?? "",
      email: selectedContact.email ?? "",
      phone: selectedContact.phone ?? ""
    });
  }, [selectedContact?.id]);

  const isManager = authUser?.role === "manager";

  useEffect(() => {
    if (blockForm.salespersonId) return;
    const first = usersList.find(u => u.role === "salesperson")?.id;
    if (first) setBlockForm(prev => ({ ...prev, salespersonId: first }));
  }, [blockForm.salespersonId, usersList]);

  useEffect(() => {
    if (!editingUserId) return;
    setBlockForm(prev => ({ ...prev, salespersonId: editingUserId }));
  }, [editingUserId]);

  useEffect(() => {
    if (!saveToast) return;
    const t = setTimeout(() => setSaveToast(null), 2000);
    return () => clearTimeout(t);
  }, [saveToast]);
  useEffect(() => {
    if (authUser?.phone) {
      setCallMethod("cell");
    } else if (authUser?.extension) {
      setCallMethod("extension");
    }
  }, [authUser?.phone, authUser?.extension]);

  const pendingDraft = useMemo(() => {
    if (!selectedConv) return null;
    let lastDraftIdx = -1;
    let lastSentIdx = -1;
    for (let i = 0; i < selectedConv.messages.length; i++) {
      const m = selectedConv.messages[i];
      if (m.direction !== "out") continue;
      if (m.provider === "draft_ai" && m.draftStatus !== "stale") lastDraftIdx = i;
      if (m.provider === "human" || m.provider === "twilio") lastSentIdx = i;
    }
    if (lastDraftIdx > lastSentIdx) return selectedConv.messages[lastDraftIdx];
    return null;
  }, [selectedConv]);
  const emailDraft = useMemo(() => {
    return (selectedConv as any)?.emailDraft ?? null;
  }, [selectedConv]);
  const displaySendBody = useMemo(() => {
    if (sendBodySource === "user") return sendBody;
    if (messageFilter === "calls") return "";
    if (messageFilter === "email") {
      if (emailDraft) return maskBookingLink(emailDraft);
      return sendBody;
    }
    if (pendingDraft?.body) return pendingDraft.body;
    return sendBody;
  }, [sendBodySource, sendBody, pendingDraft?.body, messageFilter, emailDraft]);

  useEffect(() => {
    const el = sendBoxRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [displaySendBody]);

  useEffect(() => {
    if (!listActionsOpenId) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-actions-menu]") || target.closest("[data-actions-button]")) {
        return;
      }
      setListActionsOpenId(null);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [listActionsOpenId]);

  useEffect(() => {
    if (!selectedId) return;
    if (pendingDraft) return;
    const listItem = conversations.find(c => c.id === selectedId);
    if (!listItem?.pendingDraft) return;
    void loadConversation(selectedId);
  }, [conversations, selectedId, pendingDraft]);

  const filteredContacts = useMemo(() => {
    const q = contactQuery.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(c => {
      const haystack = [
        c.name,
        c.firstName,
        c.lastName,
        c.email,
        c.phone,
        c.leadSource,
        c.leadRef,
        c.vehicleDescription,
        c.vehicle,
        c.stockId,
        c.vin,
        c.year,
        c.inquiry,
        c.leadKey,
        c.conversationId
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    return haystack.includes(q);
  });
  }, [contacts, contactQuery]);

  const visibleConversations = useMemo(() => {
    return conversations.filter(c =>
      view === "inbox" ? !(c.status === "closed" || c.closedAt) : c.status === "closed" || c.closedAt
    );
  }, [conversations, view]);

  const groupedConversations = useMemo(() => {
    const groups: Array<{ label: string; items: ConversationListItem[] }> = [];
    let lastLabel = "";
    for (const c of visibleConversations) {
      const label = new Date(c.updatedAt).toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric"
      });
      if (label !== lastLabel) {
        groups.push({ label, items: [c] });
        lastLabel = label;
      } else {
        groups[groups.length - 1].items.push(c);
      }
    }
    return groups;
  }, [visibleConversations]);

  const days = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
  const followUpMonths = [
    { value: 1, label: "Jan" },
    { value: 2, label: "Feb" },
    { value: 3, label: "Mar" },
    { value: 4, label: "Apr" },
    { value: 5, label: "May" },
    { value: 6, label: "Jun" },
    { value: 7, label: "Jul" },
    { value: 8, label: "Aug" },
    { value: 9, label: "Sep" },
    { value: 10, label: "Oct" },
    { value: 11, label: "Nov" },
    { value: 12, label: "Dec" }
  ];
  const defaultAppointmentTypes = [
    "inventory_visit",
    "test_ride",
    "trade_appraisal",
    "finance_discussion"
  ];
  const isUsTimeZone = (tz?: string) => (tz ?? "").startsWith("America/");
  const formatTimeLabel = (t: string, tz?: string) => {
    if (!isUsTimeZone(tz)) return t;
    const [h, m] = t.split(":").map(Number);
    const hour12 = ((h + 11) % 12) + 1;
    const ampm = h >= 12 ? "PM" : "AM";
    return `${hour12}:${String(m).padStart(2, "0")} ${ampm}`;
  };
  const availableAppointmentTypes = useMemo(() => {
    return defaultAppointmentTypes.filter(
      key => !appointmentTypesList.some(row => row.key.trim().toLowerCase() === key.toLowerCase())
    );
  }, [appointmentTypesList]);
  const canViewConversation = section === "inbox" || section === "todos" || section === "questions";
  const preferredOrder = useMemo(() => {
    const base = preferredOrderIds.length ? preferredOrderIds : salespeopleList.map(sp => sp.id);
    return [...base, ...salespeopleList.map(sp => sp.id).filter(id => !base.includes(id))];
  }, [preferredOrderIds, salespeopleList]);

  const buildCalendarEvents = (json: any) => {
    if (Array.isArray(json?.events)) {
      return json.events.filter((e: any) => e?.status !== "cancelled");
    }
    const byId = new Map(calendarUsers.map(u => [u.id, u]));
    const busyByUserId = json?.busyByUserId ?? {};
    const events: any[] = [];
    for (const [userId, blocks] of Object.entries(busyByUserId)) {
      const user = byId.get(userId);
      if (!user) continue;
      const list = Array.isArray(blocks) ? blocks : [];
      for (const block of list) {
        const startIso = block?.start ?? null;
        const endIso = block?.end ?? null;
        if (!startIso || !endIso) continue;
        events.push({
          id: `${userId}-${startIso}`,
          summary: "Busy",
          start: startIso,
          end: endIso,
          status: "busy",
          calendarId: user.calendarId,
          salespersonId: userId,
          salespersonName: user.name || user.email || user.id,
          readOnly: true
        });
      }
    }
    return events;
  };
  const getEventTitle = (ev: any) => ev?.fullName || ev?.customerName || ev?.summary || "Busy";
  const getEventDetails = (ev: any) => {
    const parts = [];
    if (ev?.phone) parts.push(`Phone: ${ev.phone}`);
    if (ev?.email) parts.push(`Email: ${ev.email}`);
    if (ev?.stock) parts.push(`Stock: ${ev.stock}`);
    if (ev?.vin) parts.push(`VIN: ${ev.vin}`);
    if (ev?.source) parts.push(`Source: ${ev.source}`);
    return parts.join(" • ");
  };

  useEffect(() => {
    if (appointmentTypeToAdd === "custom") return;
    if (availableAppointmentTypes.length === 0) return;
    if (!availableAppointmentTypes.includes(appointmentTypeToAdd)) {
      setAppointmentTypeToAdd(availableAppointmentTypes[0]);
    }
  }, [availableAppointmentTypes, appointmentTypeToAdd]);
  const timeZones = [
    "Africa/Abidjan","Africa/Accra","Africa/Addis_Ababa","Africa/Algiers","Africa/Asmara","Africa/Bamako","Africa/Bangui","Africa/Banjul","Africa/Bissau","Africa/Blantyre","Africa/Brazzaville","Africa/Bujumbura","Africa/Cairo","Africa/Casablanca","Africa/Ceuta","Africa/Conakry","Africa/Dakar","Africa/Dar_es_Salaam","Africa/Djibouti","Africa/Douala","Africa/El_Aaiun","Africa/Freetown","Africa/Gaborone","Africa/Harare","Africa/Johannesburg","Africa/Juba","Africa/Kampala","Africa/Khartoum","Africa/Kigali","Africa/Kinshasa","Africa/Lagos","Africa/Libreville","Africa/Lome","Africa/Luanda","Africa/Lubumbashi","Africa/Lusaka","Africa/Malabo","Africa/Maputo","Africa/Maseru","Africa/Mbabane","Africa/Mogadishu","Africa/Monrovia","Africa/Nairobi","Africa/Ndjamena","Africa/Niamey","Africa/Nouakchott","Africa/Ouagadougou","Africa/Porto-Novo","Africa/Sao_Tome","Africa/Tripoli","Africa/Tunis","Africa/Windhoek",
    "America/Adak","America/Anchorage","America/Anguilla","America/Antigua","America/Araguaina","America/Argentina/Buenos_Aires","America/Argentina/Catamarca","America/Argentina/Cordoba","America/Argentina/Jujuy","America/Argentina/La_Rioja","America/Argentina/Mendoza","America/Argentina/Rio_Gallegos","America/Argentina/Salta","America/Argentina/San_Juan","America/Argentina/San_Luis","America/Argentina/Tucuman","America/Argentina/Ushuaia","America/Aruba","America/Asuncion","America/Atikokan","America/Bahia","America/Bahia_Banderas","America/Barbados","America/Belem","America/Belize","America/Blanc-Sablon","America/Boa_Vista","America/Bogota","America/Boise","America/Cambridge_Bay","America/Campo_Grande","America/Cancun","America/Caracas","America/Cayenne","America/Cayman","America/Chicago","America/Chihuahua","America/Costa_Rica","America/Creston","America/Cuiaba","America/Curacao","America/Danmarkshavn","America/Dawson","America/Dawson_Creek","America/Denver","America/Detroit","America/Dominica","America/Edmonton","America/Eirunepe","America/El_Salvador","America/Fort_Nelson","America/Fortaleza","America/Glace_Bay","America/Godthab","America/Goose_Bay","America/Grand_Turk","America/Grenada","America/Guadeloupe","America/Guatemala","America/Guayaquil","America/Guyana","America/Halifax","America/Havana","America/Hermosillo","America/Indiana/Indianapolis","America/Indiana/Knox","America/Indiana/Marengo","America/Indiana/Petersburg","America/Indiana/Tell_City","America/Indiana/Vevay","America/Indiana/Vincennes","America/Indiana/Winamac","America/Inuvik","America/Iqaluit","America/Jamaica","America/Juneau","America/Kentucky/Louisville","America/Kentucky/Monticello","America/Kralendijk","America/La_Paz","America/Lima","America/Los_Angeles","America/Lower_Princes","America/Maceio","America/Managua","America/Manaus","America/Marigot","America/Martinique","America/Matamoros","America/Mazatlan","America/Menominee","America/Merida","America/Metlakatla","America/Mexico_City","America/Miquelon","America/Moncton","America/Monterrey","America/Montevideo","America/Montserrat","America/Nassau","America/New_York","America/Nipigon","America/Nome","America/Noronha","America/North_Dakota/Beulah","America/North_Dakota/Center","America/North_Dakota/New_Salem","America/Nuuk","America/Ojinaga","America/Panama","America/Pangnirtung","America/Paramaribo","America/Phoenix","America/Port-au-Prince","America/Port_of_Spain","America/Porto_Velho","America/Puerto_Rico","America/Punta_Arenas","America/Rainy_River","America/Rankin_Inlet","America/Recife","America/Regina","America/Resolute","America/Rio_Branco","America/Santarem","America/Santiago","America/Santo_Domingo","America/Sao_Paulo","America/Scoresbysund","America/Sitka","America/St_Barthelemy","America/St_Johns","America/St_Kitts","America/St_Lucia","America/St_Thomas","America/St_Vincent","America/Swift_Current","America/Tegucigalpa","America/Thule","America/Thunder_Bay","America/Tijuana","America/Toronto","America/Tortola","America/Vancouver","America/Whitehorse","America/Winnipeg","America/Yakutat","America/Yellowknife",
    "Antarctica/Casey","Antarctica/Davis","Antarctica/DumontDUrville","Antarctica/Macquarie","Antarctica/Mawson","Antarctica/McMurdo","Antarctica/Palmer","Antarctica/Rothera","Antarctica/Syowa","Antarctica/Troll","Antarctica/Vostok",
    "Asia/Aden","Asia/Almaty","Asia/Amman","Asia/Anadyr","Asia/Aqtau","Asia/Aqtobe","Asia/Ashgabat","Asia/Atyrau","Asia/Baghdad","Asia/Bahrain","Asia/Baku","Asia/Bangkok","Asia/Barnaul","Asia/Beirut","Asia/Bishkek","Asia/Brunei","Asia/Chita","Asia/Choibalsan","Asia/Colombo","Asia/Damascus","Asia/Dhaka","Asia/Dili","Asia/Dubai","Asia/Dushanbe","Asia/Famagusta","Asia/Gaza","Asia/Hebron","Asia/Ho_Chi_Minh","Asia/Hong_Kong","Asia/Hovd","Asia/Irkutsk","Asia/Jakarta","Asia/Jayapura","Asia/Jerusalem","Asia/Kabul","Asia/Kamchatka","Asia/Karachi","Asia/Kathmandu","Asia/Khandyga","Asia/Kolkata","Asia/Krasnoyarsk","Asia/Kuala_Lumpur","Asia/Kuching","Asia/Kuwait","Asia/Macau","Asia/Magadan","Asia/Makassar","Asia/Manila","Asia/Muscat","Asia/Nicosia","Asia/Novokuznetsk","Asia/Novosibirsk","Asia/Omsk","Asia/Oral","Asia/Phnom_Penh","Asia/Pontianak","Asia/Pyongyang","Asia/Qatar","Asia/Qostanay","Asia/Qyzylorda","Asia/Riyadh","Asia/Sakhalin","Asia/Samarkand","Asia/Seoul","Asia/Shanghai","Asia/Singapore","Asia/Srednekolymsk","Asia/Taipei","Asia/Tashkent","Asia/Tbilisi","Asia/Tehran","Asia/Thimphu","Asia/Tokyo","Asia/Tomsk","Asia/Ulaanbaatar","Asia/Urumqi","Asia/Ust-Nera","Asia/Vientiane","Asia/Vladivostok","Asia/Yakutsk","Asia/Yangon","Asia/Yekaterinburg","Asia/Yerevan",
    "Atlantic/Azores","Atlantic/Bermuda","Atlantic/Canary","Atlantic/Cape_Verde","Atlantic/Faroe","Atlantic/Madeira","Atlantic/Reykjavik","Atlantic/South_Georgia","Atlantic/St_Helena","Atlantic/Stanley",
    "Australia/Adelaide","Australia/Brisbane","Australia/Broken_Hill","Australia/Darwin","Australia/Eucla","Australia/Hobart","Australia/Lindeman","Australia/Lord_Howe","Australia/Melbourne","Australia/Perth","Australia/Sydney",
    "Europe/Amsterdam","Europe/Andorra","Europe/Astrakhan","Europe/Athens","Europe/Belgrade","Europe/Berlin","Europe/Brussels","Europe/Bucharest","Europe/Budapest","Europe/Chisinau","Europe/Copenhagen","Europe/Dublin","Europe/Gibraltar","Europe/Helsinki","Europe/Istanbul","Europe/Kaliningrad","Europe/Kiev","Europe/Kirov","Europe/Lisbon","Europe/London","Europe/Luxembourg","Europe/Madrid","Europe/Malta","Europe/Minsk","Europe/Monaco","Europe/Moscow","Europe/Oslo","Europe/Paris","Europe/Prague","Europe/Riga","Europe/Rome","Europe/Samara","Europe/Saratov","Europe/Simferopol","Europe/Sofia","Europe/Stockholm","Europe/Tallinn","Europe/Tirane","Europe/Ulyanovsk","Europe/Uzhgorod","Europe/Vienna","Europe/Vilnius","Europe/Volgograd","Europe/Warsaw","Europe/Zaporozhye","Europe/Zurich",
    "Indian/Chagos","Indian/Christmas","Indian/Cocos","Indian/Comoro","Indian/Kerguelen","Indian/Mahe","Indian/Maldives","Indian/Mauritius","Indian/Mayotte","Indian/Reunion",
    "Pacific/Apia","Pacific/Auckland","Pacific/Bougainville","Pacific/Chatham","Pacific/Chuuk","Pacific/Easter","Pacific/Efate","Pacific/Enderbury","Pacific/Fakaofo","Pacific/Fiji","Pacific/Funafuti","Pacific/Galapagos","Pacific/Gambier","Pacific/Guadalcanal","Pacific/Guam","Pacific/Honolulu","Pacific/Kanton","Pacific/Kiritimati","Pacific/Kosrae","Pacific/Kwajalein","Pacific/Majuro","Pacific/Marquesas","Pacific/Midway","Pacific/Nauru","Pacific/Niue","Pacific/Norfolk","Pacific/Noumea","Pacific/Pago_Pago","Pacific/Palau","Pacific/Pitcairn","Pacific/Pohnpei","Pacific/Port_Moresby","Pacific/Rarotonga","Pacific/Saipan","Pacific/Tahiti","Pacific/Tarawa","Pacific/Tongatapu","Pacific/Wake","Pacific/Wallis"
  ];
  const timeOptions = useMemo(() => {
    const out: string[] = [];
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m += 30) {
        out.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
      }
    }
    return out;
  }, []);

  function updateHours(
    setter: (next: Record<string, { open: string | null; close: string | null }> | ((prev: Record<string, { open: string | null; close: string | null }>) => Record<string, { open: string | null; close: string | null }>)) => void,
    day: string,
    field: "open" | "close",
    value: string
  ) {
    setter(prev => ({
      ...prev,
      [day]: {
        open: field === "open" ? (value || null) : (prev?.[day]?.open ?? null),
        close: field === "close" ? (value || null) : (prev?.[day]?.close ?? null)
      }
    }));
  }

  useEffect(() => {
    if (messageFilter === "calls") {
      setSendBody("");
      setSendBodySource("system");
      setLastDraftId(null);
      return;
    }
    if (messageFilter === "email") {
      if (emailDraft) {
        setSendBody(emailDraft);
        setSendBodySource("draft");
      } else if (sendBodySource !== "user") {
        setSendBody("");
        setSendBodySource("system");
      }
      setLastDraftId(null);
      return;
    }
    if (!pendingDraft) return;
    const hasUserEdits = sendBodySource === "user" && sendBody.trim().length > 0;
    if (hasUserEdits && pendingDraft.id !== lastDraftId) return;
    setSendBody(pendingDraft.body);
    setSendBodySource("draft");
    setLastDraftId(pendingDraft.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDraft?.id, messageFilter, emailDraft]);

  useEffect(() => {
    if (messageFilter === "calls") {
      setSendBody("");
      setSendBodySource("system");
      setLastDraftId(null);
      return;
    }
    if (messageFilter === "email") {
      if (emailDraft) {
        setSendBody(emailDraft);
        setSendBodySource("draft");
      } else {
        setSendBody("");
        setSendBodySource("system");
      }
      setLastDraftId(null);
      return;
    }
    if (pendingDraft) {
      setSendBody(pendingDraft.body);
      setSendBodySource("draft");
      setLastDraftId(pendingDraft.id ?? null);
      return;
    }
    setSendBody("");
    setSendBodySource("system");
    setLastDraftId(null);
  }, [selectedConv?.id, pendingDraft?.id, messageFilter, emailDraft]);

  async function markTodoDone(todo: TodoItem, resolution = "resume") {
    await fetch("/api/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ convId: todo.convId, todoId: todo.id, resolution })
    });
    await load();
  }

  async function markQuestionDone(q: QuestionItem) {
    const outcome = questionOutcomeById[q.id] ?? q.outcome ?? "";
    const followUpAction = questionFollowUpById[q.id] ?? q.followUpAction ?? "";
    await fetch("/api/questions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        convId: q.convId,
        questionId: q.id,
        outcome: outcome || undefined,
        followUpAction: followUpAction || undefined
      })
    });
    await load();
  }

  async function createQuestion(convId: string, text: string) {
    await fetch("/api/questions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ convId, text })
    });
    await load();
  }

  async function retryCrmLog(q: QuestionItem) {
    try {
      const convResp = await fetch(`/api/conversations/${encodeURIComponent(q.convId)}`);
      const convData = await convResp.json().catch(() => null);
      const leadRef =
        convData?.conversation?.lead?.leadRef ?? convData?.conversation?.leadRef ?? null;
      if (!leadRef) {
        window.alert("Missing leadRef for this conversation.");
        return;
      }
      const resp = await fetch("/api/crm/tlp/log-contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadRef, conversationId: q.convId })
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        window.alert(data?.error ?? "CRM update failed");
        return;
      }
      if (data?.skipped) {
        window.alert("No new messages to log to CRM.");
        return;
      }
      await markQuestionDone(q);
      setSaveToast("CRM updated");
    } catch {
      window.alert("CRM update failed");
    }
  }

  async function doSend(payload: { body: string; draftId?: string; editNote?: string; manualTakeover?: boolean }) {
    if (!selectedConv) return;
    const resp = await fetch(`/api/conversations/${encodeURIComponent(selectedConv.id)}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        manualTakeover: payload.manualTakeover ?? !payload.draftId,
        channel: messageFilter
      })
    });
    const data = await resp.json().catch(() => null);
    setSendBody("");
    if (data?.conversation) {
      const conv = data.conversation;
      if (payload.draftId && Array.isArray(conv.messages)) {
        const msg = conv.messages.find((m: any) => m.id === payload.draftId);
        if (msg) {
          msg.body = payload.body;
          msg.provider = data?.sent === true ? "twilio" : msg.provider ?? "human";
          msg.draftStatus = undefined;
          msg.at = new Date().toISOString();
        }
      }
      setSelectedConv(conv);
      setConversations(prev =>
        prev.map(c => {
          if (c.id !== conv.id) return c;
          const last = conv.messages?.[conv.messages.length - 1];
          return {
            ...c,
            updatedAt: conv.updatedAt ?? c.updatedAt,
            lastMessage: last?.body ?? c.lastMessage,
            messageCount: conv.messages?.length ?? c.messageCount,
            pendingDraft: false,
            pendingDraftPreview: null,
            mode: conv.mode ?? c.mode
          };
        })
      );
    } else {
      await loadConversation(selectedConv.id);
    }
    await load();
  }

  async function send() {
    if (!selectedConv) return;
    if (messageFilter === "calls") return;
    if (messageFilter === "sms" && selectedConv.contactPreference === "call_only") {
      return;
    }
    const useEmailDraft = messageFilter === "email" && !!emailDraft;
    const effectiveDraft = messageFilter === "email" ? null : pendingDraft;
    const bodySource =
      sendBodySource === "user"
        ? sendBody
        : useEmailDraft
          ? emailDraft
          : (pendingDraft?.body ?? sendBody);
    let body = bodySource.trim();
    if (messageFilter === "email") {
      const bookingUrl = extractBookingUrl(emailDraft);
      if (bookingUrl && !/https?:\/\//i.test(body)) {
        body = injectBookingUrl(body, bookingUrl);
      }
    }
    if (!body) return;
    const draftId = effectiveDraft?.id;
    const edited = !!effectiveDraft && effectiveDraft.body.trim() !== body.trim();
    if (edited) {
      setPendingSend({ body, draftId });
      setEditNote("");
      setEditPromptOpen(true);
      return;
    }
    const manualTakeover = messageFilter === "email" ? !emailDraft : !draftId;
    await doSend(draftId ? { body, draftId, manualTakeover } : { body, manualTakeover });
  }

  async function startCall(method?: "cell" | "extension") {
    if (!selectedConv || callBusy) return;
    if (!authUser?.phone && !authUser?.extension) {
      window.alert("No phone or extension configured for your user.");
      return;
    }
    setCallBusy(true);
    try {
      const methodToUse = method ?? callMethod;
      const resp = await fetch(`/api/conversations/${encodeURIComponent(selectedConv.id)}/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ useExtension: methodToUse === "extension" })
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        window.alert(data?.error ?? "Call failed");
      } else {
        setSaveToast("Call started");
      }
    } catch {
      window.alert("Call failed");
    } finally {
      setCallBusy(false);
    }
  }

  async function clearContactPreference() {
    if (!selectedConv) return;
    const ok = window.confirm(
      "This lead requested call only. Allow SMS for this lead?"
    );
    if (!ok) return;
    await fetch(
      `/api/conversations/${encodeURIComponent(selectedConv.id)}/contact-preference`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactPreference: null })
      }
    );
    await loadConversation(selectedConv.id);
    await load();
  }

  async function closeConv() {
    if (!selectedConv) return;
    await fetch(`/api/conversations/${encodeURIComponent(selectedConv.id)}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: closeReason })
    });
    await loadConversation(selectedConv.id);
    await load();
  }

  async function deleteConv() {
    if (!selectedConv) return;
    const ok = window.confirm(
      "Delete this conversation permanently? This cannot be undone."
    );
    if (!ok) return;
    await fetch(`/api/conversations/${encodeURIComponent(selectedConv.id)}`, {
      method: "DELETE"
    });
    setSelectedConv(null);
    setSelectedId(null);
    setConversations(prev => prev.filter(c => c.id !== selectedConv.id));
    await load();
  }

  async function deleteConvFromList(id: string) {
    const ok = window.confirm("Delete this conversation permanently? This cannot be undone.");
    if (!ok) return;
    await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (selectedId === id) {
      setSelectedConv(null);
      setSelectedId(null);
    }
    setConversations(prev => prev.filter(c => c.id !== id));
    await load();
  }

  function openTodoPrompt(convId: string) {
    setTodoPromptConvId(convId);
    setTodoPromptText("");
    setTodoPromptOpen(true);
  }

  async function submitTodoPrompt() {
    if (!todoPromptConvId) return;
    const summary = todoPromptText.trim();
    if (!summary) {
      window.alert("Please enter what the salesperson should do.");
      return;
    }
    const resp = await fetch("/api/todos/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        convId: todoPromptConvId,
        summary,
        reason: "other"
      })
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || data?.ok === false) {
      window.alert(data?.error ?? "Failed to create to-do");
      return;
    }
    setTodoPromptOpen(false);
    setTodoPromptConvId(null);
    setTodoPromptText("");
    await load();
  }

  async function setHumanMode(next: "human" | "suggest") {
    if (!selectedConv) return;
    await setHumanModeForId(selectedConv.id, next, true);
  }

  async function setHumanModeForId(id: string, next: "human" | "suggest", updateSelected = false) {
    setModeSaving(true);
    setModeError(null);
    if (updateSelected) {
      setSelectedConv(prev => (prev ? { ...prev, mode: next } : prev));
    }
    const resp = await fetch(`/api/conversations/${encodeURIComponent(id)}/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: next })
    });
    const payload = await resp.json().catch(() => null);
    if (!resp.ok || payload?.ok === false) {
      setModeError(payload?.error ?? "Failed to update mode");
    }
    if (payload?.conversation && updateSelected) setSelectedConv(payload.conversation);
    await load();
    setModeSaving(false);
  }

  async function addSuppression() {
    const phone = newSuppression.trim();
    if (!phone) return;
    await fetch("/api/suppressions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, reason: "manual" })
    });
    setNewSuppression("");
    await load();
  }

  async function removeSuppression(phone: string) {
    await fetch(`/api/suppressions?phone=${encodeURIComponent(phone)}`, { method: "DELETE" });
    await load();
  }

  async function saveContact() {
    if (!selectedContact) return;
    const resp = await fetch(`/api/contacts/${encodeURIComponent(selectedContact.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(contactForm)
    });
    const payload = await resp.json().catch(() => null);
    if (payload?.contact) {
      const updated = payload.contact as ContactItem;
      setSelectedContact(updated);
      setContacts(prev => prev.map(c => (c.id === updated.id ? { ...c, ...updated } : c)));
      setContactEdit(false);
      setEditingUserId(null);
      setShowNewUserForm(false);
      setSection("inbox");
      setSaveToast("Saved");
    }
  }

  async function deleteContact() {
    if (!selectedContact) return;
    const ok = window.confirm("Delete this contact permanently? This cannot be undone.");
    if (!ok) return;
    await fetch(`/api/contacts/${encodeURIComponent(selectedContact.id)}`, { method: "DELETE" });
    setContacts(prev => prev.filter(c => c.id !== selectedContact.id));
    setSelectedContact(null);
  }


  async function saveDealerProfile() {
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      const hours = dealerHours ?? {};
      const payload = {
        dealerName: dealerProfileForm.dealerName.trim(),
        agentName: dealerProfileForm.agentName.trim(),
        crmProvider: dealerProfileForm.crmProvider.trim(),
        websiteProvider: dealerProfileForm.websiteProvider.trim(),
        fromEmail: dealerProfileForm.fromEmail.trim(),
        replyToEmail: dealerProfileForm.replyToEmail.trim(),
        emailSignature: dealerProfileForm.emailSignature,
        logoUrl: dealerProfileForm.logoUrl.trim(),
        bookingUrl: dealerProfileForm.bookingUrl.trim(),
        bookingToken: dealerProfileForm.bookingToken.trim(),
        phone: dealerProfileForm.phone.trim(),
        website: dealerProfileForm.website.trim(),
        address: {
          line1: dealerProfileForm.addressLine1.trim(),
          city: dealerProfileForm.city.trim(),
          state: dealerProfileForm.state.trim(),
          zip: dealerProfileForm.zip.trim()
        },
        hours,
        followUp: {
          testRideEnabled: !!dealerProfileForm.testRideEnabled,
          testRideMonths: dealerProfileForm.testRideMonths ?? [4, 5, 6, 7, 8, 9, 10]
        }
      };
      const resp = await fetch("/api/dealer-profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error ?? "Failed to save dealer profile");
      const saved = json?.profile ?? payload;
      setDealerProfile(saved);
      setDealerHours(saved?.hours ?? hours);
      setEditingUserId(null);
      setShowNewUserForm(false);
      setSelectedContact(null);
      setSection("inbox");
      setSaveToast("Saved");
    } catch (err: any) {
      setSettingsError(err?.message ?? "Failed to save dealer profile");
    } finally {
      setSettingsSaving(false);
    }
  }

  async function saveSchedulerConfig() {
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      const businessHours = normalizeBusinessHours(schedulerHours ?? {});
      const invalidDays = Object.entries(businessHours)
        .filter(([, v]) => v.open && v.close && v.close <= v.open)
        .map(([day]) => day);
      if (invalidDays.length) {
        setSettingsError(`Close time must be after open time: ${invalidDays.join(", ")}`);
        setSettingsSaving(false);
        return;
      }
      const salespeople = (usersList ?? [])
        .filter((u: any) => u.role === "salesperson" && u.calendarId)
        .map((u: any) => ({
          id: String(u.id),
          name: String(u.name || u.email || u.id),
          calendarId: String(u.calendarId || "")
        }))
        .filter((s: any) => s.id && s.name && s.calendarId);
      const appointmentTypes = appointmentTypesList.reduce<Record<string, { durationMinutes: number }>>(
        (acc, row) => {
          const key = row.key.trim();
          if (!key) return acc;
          const mins = Number(row.durationMinutes || 0);
          acc[key] = { durationMinutes: mins > 0 ? mins : 60 };
          return acc;
        },
        {}
      );
      const payload = {
        ...(schedulerConfig ?? {}),
        timezone: schedulerForm.timezone.trim(),
        assignmentMode: schedulerForm.assignmentMode,
        minLeadTimeHours: Number(schedulerForm.minLeadTimeHours || 0),
        minGapBetweenAppointmentsMinutes: Number(schedulerForm.minGapBetweenAppointmentsMinutes || 0),
        bookingWindows: {
          weekday: {
            earliestStart: schedulerForm.weekdayEarliest.trim(),
            latestStart: schedulerForm.weekdayLatest.trim()
          },
          saturday: {
            earliestStart: schedulerForm.saturdayEarliest.trim(),
            latestStart: schedulerForm.saturdayLatest.trim()
          }
        },
        businessHours,
        salespeople,
        preferredSalespeople: preferredOrderIds,
        appointmentTypes,
        availabilityBlocks
      };
      const resp = await fetch("/api/scheduler-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error ?? "Failed to save scheduler config");
      const saved = json?.config ?? payload;
      setSchedulerConfig(saved);
      setSchedulerHours(saved?.businessHours ?? businessHours);
      setSchedulerForm({
        timezone: saved.timezone ?? schedulerForm.timezone,
        assignmentMode: saved.assignmentMode ?? schedulerForm.assignmentMode,
        minLeadTimeHours: String(saved.minLeadTimeHours ?? schedulerForm.minLeadTimeHours),
        minGapBetweenAppointmentsMinutes: String(
          saved.minGapBetweenAppointmentsMinutes ?? schedulerForm.minGapBetweenAppointmentsMinutes
        ),
        weekdayEarliest: saved.bookingWindows?.weekday?.earliestStart ?? schedulerForm.weekdayEarliest,
        weekdayLatest: saved.bookingWindows?.weekday?.latestStart ?? schedulerForm.weekdayLatest,
        saturdayEarliest: saved.bookingWindows?.saturday?.earliestStart ?? schedulerForm.saturdayEarliest,
        saturdayLatest: saved.bookingWindows?.saturday?.latestStart ?? schedulerForm.saturdayLatest
      });
      setSalespeopleList(saved?.salespeople ?? salespeople);
      setPreferredOrderIds(saved?.preferredSalespeople ?? []);
      setAvailabilityBlocks(saved?.availabilityBlocks ?? availabilityBlocks);
      const at = saved?.appointmentTypes ?? {};
      setAppointmentTypesList(
        Object.entries(at).map(([key, val]: any) => ({
          key,
          durationMinutes: String(val?.durationMinutes ?? 60)
        }))
      );
      setEditingUserId(null);
      setShowNewUserForm(false);
      setSelectedContact(null);
      setSection("inbox");
      setSaveToast("Saved");
    } catch (err: any) {
      setSettingsError(err?.message ?? "Failed to save scheduler config");
    } finally {
      setSettingsSaving(false);
    }
  }

  const dayToRrule: Record<string, string> = {
    monday: "MO",
    tuesday: "TU",
    wednesday: "WE",
    thursday: "TH",
    friday: "FR",
    saturday: "SA",
    sunday: "SU"
  };

  function toggleBlockDay(day: string) {
    setBlockForm(prev => {
      const has = prev.days.includes(day);
      const nextDays = has ? prev.days.filter(d => d !== day) : [...prev.days, day];
      return { ...prev, days: nextDays.length ? nextDays : [day] };
    });
  }

  function normalizeBusinessHours(hours: Record<string, { open: string | null; close: string | null }>) {
    const next: Record<string, { open: string | null; close: string | null }> = {};
    for (const [day, val] of Object.entries(hours ?? {})) {
      const open = val?.open ?? null;
      let close = val?.close ?? null;
      if (open && close && close <= open) {
        const [h, m] = close.split(":").map(Number);
        if (!Number.isNaN(h)) {
          const bumped = h + 12;
          if (bumped <= 23) {
            const mm = String(m ?? 0).padStart(2, "0");
            close = `${String(bumped).padStart(2, "0")}:${mm}`;
          }
        }
      }
      next[day] = { open, close };
    }
    return next;
  }

  async function addAvailabilityBlock() {
    setSettingsError(null);
    const salespersonId = blockForm.salespersonId.trim();
    if (!salespersonId) {
      setSettingsError("Select a salesperson for the availability block.");
      return;
    }
    const daysSelected = blockForm.days.filter(Boolean);
    if (!daysSelected.length) {
      setSettingsError("Select at least one day.");
      return;
    }
    const title = blockForm.title.trim() || "Busy";
    const byDay = daysSelected.map(d => dayToRrule[d]).filter(Boolean);
    const rrule = `RRULE:FREQ=WEEKLY;BYDAY=${byDay.join(",")}`;
    const start = blockForm.allDay ? "00:00" : blockForm.start;
    const end = blockForm.allDay ? "23:59" : blockForm.end;
    try {
      const resp = await fetch("/api/scheduler/availability-blocks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ salespersonId, title, rrule, start, end, days: daysSelected })
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error ?? "Failed to add block");
      setAvailabilityBlocks(json?.config?.availabilityBlocks ?? availabilityBlocks);
      setSaveToast("Saved");
    } catch (err: any) {
      setSettingsError(err?.message ?? "Failed to add block");
    }
  }

  async function deleteAvailabilityBlock(salespersonId: string, eventId: string) {
    try {
      console.log("[availability] delete", { salespersonId, eventId });
      const resp = await fetch(
        `/api/scheduler/availability-blocks/${encodeURIComponent(salespersonId)}/${encodeURIComponent(eventId)}`,
        { method: "DELETE" }
      );
      const json = await resp.json();
      console.log("[availability] delete response", json);
      if (!resp.ok) throw new Error(json?.error ?? "Failed to delete block");
      if (json?.config?.availabilityBlocks) {
        setAvailabilityBlocks(json.config.availabilityBlocks);
        setSaveToast("Saved");
        return;
      }
      setAvailabilityBlocks(prev => ({
        ...prev,
        [salespersonId]: (prev[salespersonId] ?? []).filter(b => b.id !== eventId)
      }));
      setSaveToast("Saved");
    } catch (err: any) {
      setSettingsError(err?.message ?? "Failed to delete block");
    }
  }

  async function reloadUsers() {
    try {
      const resp = await fetch("/api/users", { cache: "no-store" });
      const json = await resp.json();
      if (resp.ok) setUsersList(json?.users ?? []);
    } catch {
      // ignore
    }
  }

  async function reloadScheduler() {
    try {
      const resp = await fetch("/api/scheduler-config", { cache: "no-store" });
      const json = await resp.json();
      if (!resp.ok) return;
      const cfg = json?.config ?? {};
      setSchedulerConfig(cfg);
      if (section === "calendar" && Array.isArray(cfg.salespeople)) {
        setCalendarSalespeople(cfg.salespeople.map((s: any) => s.id));
      }
    } catch {
      // ignore
    }
  }

  async function addUser() {
    setSettingsError(null);
    try {
      const resp = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(userForm)
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error ?? "Failed to add user");
      setUsersList(prev => [...prev, json.user]);
      await reloadScheduler();
      setEditingUserId(json.user?.id ?? null);
      setShowNewUserForm(false);
      if (json.user?.id) {
        setBlockForm(prev => ({ ...prev, salespersonId: json.user.id }));
      }
      setUserForm({
        email: "",
        password: "",
        name: "",
        phone: "",
        extension: "",
        role: "salesperson",
        calendarId: "",
        permissions: {
          canEditAppointments: false,
          canToggleHumanOverride: false,
          canAccessTodos: false,
          canAccessSuppressions: false
        }
      });
      setEditingUserId(null);
      setShowNewUserForm(false);
      setSelectedContact(null);
      setSection("inbox");
      setSaveToast("Saved");
    } catch (err: any) {
      setSettingsError(err?.message ?? "Failed to add user");
    }
  }

  async function updateUserRow(userId: string, patch: any) {
    setSettingsError(null);
    try {
      const resp = await fetch(`/api/users/${encodeURIComponent(userId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error ?? "Failed to update user");
      setUsersList(prev => prev.map(u => (u.id === userId ? json.user : u)));
      await reloadScheduler();
      setEditingUserId(null);
      setShowNewUserForm(false);
      setSelectedContact(null);
      setSection("inbox");
      setSaveToast("Saved");
    } catch (err: any) {
      setSettingsError(err?.message ?? "Failed to update user");
    }
  }

  async function deleteUserRow(userId: string) {
    setSettingsError(null);
    try {
      const resp = await fetch(`/api/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error ?? "Failed to delete user");
      setUsersList(prev => prev.filter(u => u.id !== userId));
      await reloadScheduler();
      setEditingUserId(null);
      setShowNewUserForm(false);
      setSelectedContact(null);
      setSection("inbox");
      setSaveToast("Saved");
    } catch (err: any) {
      setSettingsError(err?.message ?? "Failed to delete user");
    }
  }

  async function submitLogin() {
    setAuthError(null);
    try {
      const resp = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: loginForm.email, password: loginForm.password })
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error ?? "Login failed");
      setAuthUser(json?.user ?? null);
      setLoginForm({ email: "", password: "", name: "" });
      await load();
    } catch (err: any) {
      setAuthError(err?.message ?? "Login failed");
    }
  }

  async function saveCalendarEdit() {
    if (!calendarEdit?.calendarId) return;
    const isCreate = !calendarEdit?.id;
    try {
      const url = isCreate
        ? "/api/calendar/events"
        : `/api/calendar/events/${encodeURIComponent(calendarEdit.calendarId)}/${encodeURIComponent(
            calendarEdit.id
          )}`;
      const resp = await fetch(url, {
        method: isCreate ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...calendarEditForm,
          timeZone: schedulerConfig?.timezone ?? "America/New_York",
          calendarId: calendarEditSalespersonId
            ? calendarUsers.find((u: any) => u.id === calendarEditSalespersonId)?.calendarId
            : calendarEdit.calendarId
        })
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error ?? "Failed to update event");
      setCalendarEdit(null);
      setCalendarEditForm({
        summary: "",
        startDate: "",
        startTime: "",
        endDate: "",
        endTime: "",
        status: "scheduled",
        reason: ""
      });
      // refresh calendar
      const start = new Date(calendarDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      if (calendarView === "week") {
        end.setDate(end.getDate() + 7);
      } else {
        end.setDate(end.getDate() + 1);
      }
      const params = new URLSearchParams();
      params.set("start", start.toISOString());
      params.set("end", end.toISOString());
      if (calendarSalespeople.length) {
        params.set("userIds", calendarSalespeople.join(","));
      }
      const refresh = await fetch(`/api/calendar/events?${params.toString()}`, { cache: "no-store" });
      const refreshJson = await refresh.json();
      setCalendarEvents(buildCalendarEvents(refreshJson));
      setSaveToast("Saved");
    } catch (err: any) {
      setSettingsError(err?.message ?? "Failed to update event");
    }
  }

  async function updateCalendarEventTime(ev: any, startMin: number, endMin: number) {
    if (!schedulerConfig?.timezone) return;
    const day = calendarDate.toLocaleDateString("en-CA", { timeZone: schedulerConfig.timezone });
    const toHHMM = (m: number) => {
      const h = Math.floor(m / 60);
      const min = m % 60;
      return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    };
    const payload = {
      summary: ev.summary ?? "",
      startDate: day,
      startTime: toHHMM(startMin),
      endDate: day,
      endTime: toHHMM(endMin),
      status: "scheduled",
      reason: "",
      timeZone: schedulerConfig.timezone
    };
    try {
      const resp = await fetch(
        `/api/calendar/events/${encodeURIComponent(ev.calendarId)}/${encodeURIComponent(ev.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }
      );
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error ?? "Failed to update event");
      setSaveToast("Saved");
      setCalendarEvents(prev =>
        prev.map(item =>
          item.id === ev.id
            ? { ...item, _dragStart: undefined, _dragEnd: undefined }
            : item
        )
      );
      // refresh events
      const start = new Date(calendarDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      if (calendarView === "week") {
        end.setDate(end.getDate() + 7);
      } else {
        end.setDate(end.getDate() + 1);
      }
      const params = new URLSearchParams();
      params.set("start", start.toISOString());
      params.set("end", end.toISOString());
      if (calendarSalespeople.length) {
        params.set("userIds", calendarSalespeople.join(","));
      }
      const refresh = await fetch(`/api/calendar/events?${params.toString()}`, { cache: "no-store" });
      const refreshJson = await refresh.json();
      setCalendarEvents(buildCalendarEvents(refreshJson));
    } catch (err: any) {
      setSettingsError(err?.message ?? "Failed to update event");
    }
  }

  function applyDragAt(clientY: number) {
    const state = dragStateRef.current;
    if (!state.mode || !state.event) return;
    const spId = state.event.salespersonId;
    const rect = calendarColumnRefs.current[spId]?.getBoundingClientRect();
    if (!rect) return;
    const totalMinutes = state.closeWindow - state.openWindow;
    const y = clientY - rect.top;
    const minutesFromTop = Math.max(0, Math.min(totalMinutes, (y / rect.height) * totalMinutes));
    const snap = 30;
    state.didMove = true;
    if (state.mode === "move") {
      const deltaMinutes = minutesFromTop - (state.origStartMin - state.openWindow);
      const rawStart = state.origStartMin + deltaMinutes;
      const duration = state.origEndMin - state.origStartMin;
      let nextStart = Math.round(rawStart / snap) * snap;
      let nextEnd = nextStart + duration;
      if (nextStart < state.openWindow) {
        nextStart = state.openWindow;
        nextEnd = nextStart + duration;
      }
      if (nextEnd > state.closeWindow) {
        nextEnd = state.closeWindow;
        nextStart = nextEnd - duration;
      }
      setCalendarEvents(prev =>
        prev.map(ev =>
          ev.id === state.event.id
            ? { ...ev, _dragStart: nextStart, _dragEnd: nextEnd }
            : ev
        )
      );
    } else if (state.mode === "resize") {
      const snapEnd = Math.round((state.openWindow + minutesFromTop) / snap) * snap;
      let nextEnd = Math.max(snapEnd, state.origStartMin + snap);
      if (nextEnd > state.closeWindow) nextEnd = state.closeWindow;
      setCalendarEvents(prev =>
        prev.map(ev =>
          ev.id === state.event.id
            ? { ...ev, _dragStart: state.origStartMin, _dragEnd: nextEnd }
            : ev
        )
      );
    }
  }

  function finalizeDrag() {
    const state = dragStateRef.current;
    if (!state.mode || !state.event) return;
    const current = calendarEventsRef.current.find(e => e.id === state.event.id);
    const startMin = current?._dragStart ?? state.origStartMin;
    const endMin = current?._dragEnd ?? state.origEndMin;
    dragStateRef.current = {
      mode: null,
      event: null,
      startY: 0,
      origStartMin: 0,
      origEndMin: 0,
      openWindow: state.openWindow,
      closeWindow: state.closeWindow,
      didMove: false
    };
    dragGuardRef.current.blockUntil = Date.now() + 400;
    updateCalendarEventTime(state.event, startMin, endMin);
  }

  useEffect(() => {
    function handleMove(e: MouseEvent) {
      applyDragAt(e.clientY);
    }
    function handleUp() {
      finalizeDrag();
    }
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, []);

  async function submitBootstrap() {
    setAuthError(null);
    try {
      const resp = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: loginForm.email,
          password: loginForm.password,
          name: loginForm.name,
          role: "manager"
        })
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error ?? "Failed to create user");
      setNeedsBootstrap(false);
      await submitLogin();
    } catch (err: any) {
      setAuthError(err?.message ?? "Failed to create user");
    }
  }


  if (authLoading) {
    return (
      <main className="h-screen flex items-center justify-center text-sm text-gray-600 bg-white">
        Loading…
      </main>
    );
  }

  if (needsBootstrap || !authUser) {
    return (
      <main className="h-screen flex items-center justify-center bg-white">
        <div className="w-full max-w-sm border rounded-lg p-6 space-y-4">
          <div className="text-lg font-semibold">
            {needsBootstrap ? "Create manager account" : "Sign in"}
          </div>
          {needsBootstrap ? (
            <input
              className="w-full border rounded px-3 py-2 text-sm"
              placeholder="Name"
              value={loginForm.name}
              onChange={e => setLoginForm({ ...loginForm, name: e.target.value })}
            />
          ) : null}
          <input
            className="w-full border rounded px-3 py-2 text-sm"
            placeholder="Email"
            value={loginForm.email}
            onChange={e => setLoginForm({ ...loginForm, email: e.target.value })}
          />
          <input
            className="w-full border rounded px-3 py-2 text-sm"
            placeholder="Password"
            type="password"
            value={loginForm.password}
            onChange={e => setLoginForm({ ...loginForm, password: e.target.value })}
          />
          {authError ? <div className="text-xs text-red-600">{authError}</div> : null}
          <button
            className="w-full px-3 py-2 border rounded text-sm"
            onClick={needsBootstrap ? submitBootstrap : submitLogin}
          >
            {needsBootstrap ? "Create account" : "Sign in"}
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="h-screen flex bg-[var(--background)] text-[var(--foreground)]">
      {saveToast ? (
        <div className="fixed top-4 right-4 z-[60] px-3 py-2 rounded border bg-white text-sm shadow">
          {saveToast}
        </div>
      ) : null}
      <aside className="w-16 border-r border-[var(--palette-graphite)] bg-[var(--palette-graphite)] text-white flex flex-col items-center py-4 gap-4 cursor-pointer relative">
        <div className="text-lg font-semibold">TI</div>
        <button
          className={`w-10 h-10 rounded flex items-center justify-center border border-white/20 ${section === "inbox" ? "bg-white/10" : "hover:bg-white/5"}`}
          title="Inbox"
          onClick={() => {
            setSection("inbox");
            setEditingUserId(null);
            setShowNewUserForm(false);
            setSelectedContact(null);
          }}
        >
          📥
        </button>
        {(authUser?.role === "manager" || authUser?.permissions?.canAccessTodos) ? (
          <button
            className={`relative w-10 h-10 rounded flex items-center justify-center border border-white/20 ${section === "todos" ? "bg-white/10" : "hover:bg-white/5"}`}
            title="To-Dos"
            onClick={() => setSection("todos")}
          >
            ✅
            {todos.length > 0 ? (
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-semibold flex items-center justify-center border border-white">
                {todos.length > 99 ? "99+" : todos.length}
              </span>
            ) : null}
          </button>
        ) : null}
        <button
          className={`w-10 h-10 rounded flex items-center justify-center border border-white/20 ${section === "contacts" ? "bg-white/10" : "hover:bg-white/5"}`}
          title="Contacts"
          onClick={() => setSection("contacts")}
        >
          👥
        </button>
        {(authUser?.role === "manager" || authUser?.permissions?.canAccessSuppressions) ? (
          <button
            className={`w-10 h-10 rounded flex items-center justify-center border border-white/20 ${section === "suppressions" ? "bg-white/10" : "hover:bg-white/5"}`}
            title="Suppressions"
            onClick={() => setSection("suppressions")}
          >
            ⛔
          </button>
        ) : null}
        {(authUser?.role === "manager" || authUser?.permissions?.canEditAppointments) ? (
          <button
            className={`w-10 h-10 rounded flex items-center justify-center border border-white/20 ${section === "calendar" ? "bg-white/10" : "hover:bg-white/5"}`}
            title="Calendar"
            onClick={() => setSection("calendar")}
          >
            📅
          </button>
        ) : null}
        <button
          className={`w-10 h-10 rounded flex items-center justify-center border border-white/20 ${section === "inventory" ? "bg-white/10" : "hover:bg-white/5"}`}
          title="Inventory"
          onClick={() => setSection("inventory")}
        >
          📦
        </button>
        <button
          className={`relative w-10 h-10 rounded flex items-center justify-center border border-white/20 ${section === "questions" ? "bg-white/10" : "hover:bg-white/5"}`}
          title="Questions"
          onClick={() => setSection("questions")}
        >
          🔔
          {questions.length > 0 ? (
            <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-semibold flex items-center justify-center border border-white">
              {questions.length > 99 ? "99+" : questions.length}
            </span>
          ) : null}
        </button>
        <div className="mt-auto flex flex-col items-center gap-3">
          <div className="text-xs text-white/60">{loading ? "…" : ""}</div>
          {isManager ? (
            <div className="relative">
              <button
                className="w-10 h-10 rounded flex items-center justify-center border border-white/20 hover:bg-white/5"
                title="Settings"
                onClick={() => setSettingsOpen(v => !v)}
              >
                ⚙️
              </button>
              {settingsOpen ? (
                <div className="absolute bottom-12 left-12 w-56 bg-white border rounded-lg shadow-lg p-2 z-50">
                  <div className="text-xs font-semibold text-gray-600 px-2 py-1">Settings</div>
                  <button
                    className="w-full text-left px-2 py-2 rounded hover:bg-gray-50 text-sm"
                    onClick={() => {
                      setSettingsTab("dealer");
                      setSection("settings");
                      setSettingsOpen(false);
                    }}
                  >
                    Dealer Profile
                  </button>
                  <button
                    className="w-full text-left px-2 py-2 rounded hover:bg-gray-50 text-sm"
                    onClick={() => {
                      setSettingsTab("users");
                      setSection("settings");
                      setSettingsOpen(false);
                    }}
                  >
                    Users
                  </button>
                  <button
                    className="w-full text-left px-2 py-2 rounded hover:bg-gray-50 text-sm"
                    onClick={() => {
                      setSettingsTab("scheduler");
                      setSection("settings");
                      setSettingsOpen(false);
                    }}
                  >
                    Scheduling
                  </button>
                  <button
                    className="w-full text-left px-2 py-2 rounded hover:bg-gray-50 text-sm text-red-600"
                    onClick={async () => {
                      await fetch("/api/auth/logout", { method: "POST" });
                      setSettingsOpen(false);
                      setAuthUser(null);
                    }}
                  >
                    Sign out
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </aside>

      <section
        className={`w-96 border-r border-[var(--border)] bg-[var(--surface)] p-4 overflow-y-auto shadow-[0_10px_30px_rgba(0,0,0,0.08)] ${section === "calendar" ? "hidden" : ""}`}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">
              {section === "inbox"
                ? "Inbox"
                : section === "todos"
                  ? "To-Do Inbox"
                  : section === "questions"
                    ? "Internal Questions"
                : section === "contacts"
                  ? "Contacts"
                  : section === "inventory"
                    ? "Inventory"
                    : section === "calendar"
                      ? "Calendar"
                        : section === "settings"
                          ? "Settings"
                          : "Suppression List"}
            </h1>
            <p className="text-xs text-gray-600 mt-1">
              {section === "inbox"
                ? `${conversations.length} conversations`
                : section === "todos"
                  ? `${todos.length} open`
                  : section === "questions"
                    ? `${questions.length} open`
                : section === "contacts"
                  ? `${contacts.length} contacts`
                  : section === "inventory"
                    ? `${inventoryItems.length} bikes`
                    : section === "calendar"
                      ? "Google Calendar view"
                        : section === "settings"
                          ? "Configure dealer & scheduling"
                          : `${suppressions.length} suppressed`}
            </p>
          </div>
          <div className="border border-[var(--border)] rounded-lg p-2 bg-[var(--surface-2)]">
            <div className="text-[10px] text-[var(--palette-graphite)]">System Mode</div>
            <div className="mt-1 flex gap-1">
                <button
                  className={`px-2 py-1 border border-[var(--border)] rounded text-xs cursor-pointer ${mode === "suggest" ? "font-semibold bg-[var(--accent)] text-white border-[var(--accent)]" : "hover:bg-white"}`}
                onClick={() => updateMode("suggest")}
              >
                Suggest
              </button>
                <button
                  className={`px-2 py-1 border border-[var(--border)] rounded text-xs cursor-pointer ${mode === "autopilot" ? "font-semibold bg-[var(--accent)] text-white border-[var(--accent)]" : "hover:bg-white"}`}
                onClick={() => updateMode("autopilot")}
                title="Autopilot will auto-reply on inbound SMS"
              >
                AI
              </button>
            </div>
          </div>
        </div>

        {section === "inventory" ? (
          <div className="mt-4 space-y-3">
            <input
              className="w-full border rounded px-3 py-2 text-sm"
              placeholder="Search inventory..."
              value={inventoryQuery}
              onChange={e => setInventoryQuery(e.target.value)}
            />
            {inventoryLoading ? (
              <div className="text-sm text-gray-500">Loading inventory...</div>
            ) : inventoryItems.length === 0 ? (
              <div className="text-sm text-gray-500">No inventory loaded.</div>
            ) : (
              <div className="text-xs text-gray-500">
                Showing {inventoryItems.length} bikes
              </div>
            )}
          </div>
        ) : section === "inbox" ? (
          <>
            <div className="mt-4 flex items-center justify-between">
              <div className="flex gap-2">
                <button
                  className={`px-3 py-2 border border-[var(--border)] rounded cursor-pointer ${view === "inbox" ? "font-semibold bg-[var(--accent)] text-white border-[var(--accent)]" : "hover:bg-[var(--surface-2)]"}`}
                  onClick={() => setView("inbox")}
                >
                  Inbox
                </button>
                <button
                  className={`px-3 py-2 border border-[var(--border)] rounded cursor-pointer ${view === "archive" ? "font-semibold bg-[var(--accent)] text-white border-[var(--accent)]" : "hover:bg-[var(--surface-2)]"}`}
                  onClick={() => setView("archive")}
                >
                  Archive
                </button>
              </div>
              <div className="text-xs text-[var(--palette-graphite)]">
                {view === "inbox"
                  ? `Open: ${visibleConversations.length}`
                  : `Closed: ${visibleConversations.length}`}
              </div>
            </div>

            <div className="mt-3 space-y-3">
              {groupedConversations.map(group => (
                <div key={group.label}>
                  <div className="px-1 pb-1 text-xs font-semibold text-[var(--accent)] border-b border-[var(--border)]">
                    {group.label}
                  </div>
                  <div className="mt-2 border border-[var(--border)] rounded-lg divide-y bg-[var(--surface)]">
                    {group.items.map(c => (
                      <div key={c.id} className="flex items-stretch">
                        <button
                          onClick={() => setSelectedId(c.id)}
                          className={`flex-1 min-w-0 text-left p-4 hover:bg-[var(--surface-2)] ${
                            selectedId === c.id ? "bg-[var(--surface-2)]" : ""
                          }`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-medium flex items-center gap-2">
                                <span className="truncate">
                                  {c.leadName && c.leadName.length > 0 ? c.leadName : c.leadKey}
                                </span>
                                {c.contactPreference === "call_only" ? (
                                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-200">
                                    Call Only
                                  </span>
                                ) : null}
                                {c.status === "closed" ? (
                                  <span className="text-xs px-2 py-1 rounded border bg-gray-50">Closed</span>
                                ) : null}
                              </div>
                              {c.vehicleDescription ? (
                                <div className="text-xs text-gray-500 mt-1 truncate">{c.vehicleDescription}</div>
                              ) : null}
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              {c.mode === "human" ? <span title="Human override">👤</span> : null}
                              <button
                                className={`text-xs px-2 py-1 rounded border ${
                                  c.mode === "human" ? "bg-gray-100" : "bg-blue-50"
                                }`}
                                title={c.mode === "human" ? "Switch to AI" : "Switch to Human"}
                                onClick={e => {
                                  e.stopPropagation();
                                  void setHumanModeForId(c.id, c.mode === "human" ? "suggest" : "human");
                                }}
                              >
                                {c.mode === "human" ? "Human" : "AI"}
                              </button>
                              {c.pendingDraft ? <span className="text-xs px-2 py-1 rounded border">Draft</span> : null}
                              <span className="text-xs px-2 py-1 rounded border">{c.messageCount}</span>
                            </div>
                          </div>

                          <div className="text-sm text-gray-700 mt-2 line-clamp-2">
                            {c.pendingDraftPreview ? (
                              <>
                                Draft: {renderBookingLinkLine(c.pendingDraftPreview)}
                              </>
                            ) : (
                              renderBookingLinkLine(c.lastMessage?.body ?? "(no messages)")
                            )}
                          </div>

                          <div className="text-xs text-gray-500 mt-2">
                            {c.status === "closed" && c.closedAt
                              ? `closed: ${new Date(c.closedAt).toLocaleString()}`
                              : `updated: ${new Date(c.updatedAt).toLocaleString()}`}
                          </div>
                        </button>
                        <div className="relative border-l shrink-0">
                          <button
                            className="px-3 h-full text-lg leading-none text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                            aria-label="Conversation actions"
                            data-actions-button
                            onClick={e => {
                              e.stopPropagation();
                              setListActionsOpenId(prev => (prev === c.id ? null : c.id));
                            }}
                            onMouseDown={e => e.stopPropagation()}
                          >
                            ...
                          </button>
                          {listActionsOpenId === c.id ? (
                            <div
                              className="absolute right-0 mt-2 w-40 border rounded bg-white shadow z-10"
                              data-actions-menu
                              onClick={e => e.stopPropagation()}
                              onMouseDown={e => e.stopPropagation()}
                            >
                                    <button
                                      className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
                                      onClick={() => {
                                        setListActionsOpenId(null);
                                        openTodoPrompt(c.id);
                                      }}
                                    >
                                      Create to-do
                                    </button>
                              <button
                                className="w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                                onClick={() => {
                                  setListActionsOpenId(null);
                                  void deleteConvFromList(c.id);
                                }}
                              >
                                Delete
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {!loading && visibleConversations.length === 0 && (
                <div className="p-4 text-sm text-gray-600 border rounded-lg">
                  {view === "inbox" ? "No open conversations." : "No archived conversations."}
                </div>
              )}
            </div>
          </>
        ) : null}

        {section === "todos" && (authUser?.role === "manager" || authUser?.permissions?.canAccessTodos) ? (
          <div className="mt-3 border rounded-lg divide-y">
            {todos.map(t => (
              <div key={t.id} className="p-4 flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-medium">{t.leadKey}</div>
                  <div className="text-xs text-gray-500 mt-1">
                    {t.reason} • {new Date(t.createdAt).toLocaleString()}
                  </div>
                  <div className="text-sm text-gray-700 mt-2 line-clamp-3">{t.summary}</div>
                  <div className="text-sm font-semibold text-red-600 mt-2">
                    Action: {todoActionLabel(t)}
                  </div>
                  <button
                    className="text-xs text-blue-600 mt-2 inline-block"
                    onClick={() => {
                      setSelectedId(t.convId);
                    }}
                  >
                    Open conversation
                  </button>
                </div>
                <button
                  className="px-3 py-2 border rounded text-sm"
                  onClick={() => {
                    setTodoResolveTarget(t);
                    setTodoResolution("resume");
                    setTodoResolveOpen(true);
                  }}
                >
                  Done
                </button>
              </div>
            ))}
            {!loading && todos.length === 0 && (
              <div className="p-4 text-sm text-gray-600">No open To-Dos.</div>
            )}
          </div>
        ) : null}

        {section === "questions" ? (
          <div className="mt-3 border rounded-lg divide-y">
            {questions.map(q => (
              <div key={q.id} className="p-4 flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-medium">{q.leadKey}</div>
                  <div className="text-xs text-gray-500 mt-1">
                    {new Date(q.createdAt).toLocaleString()}
                  </div>
                  <div className="text-sm text-gray-700 mt-2 line-clamp-3">{q.text}</div>
                  {q.type === "attendance" ? (
                    <div className="mt-3 grid grid-cols-1 gap-2">
                      <label className="text-xs text-gray-600">
                        Outcome
                        <select
                          className="mt-1 w-full border rounded px-2 py-1 text-sm"
                          value={questionOutcomeById[q.id] ?? q.outcome ?? ""}
                          onChange={e =>
                            setQuestionOutcomeById(prev => ({ ...prev, [q.id]: e.target.value }))
                          }
                        >
                          <option value="">Select outcome…</option>
                          <option value="sold">Sold</option>
                          <option value="hold">On hold</option>
                          <option value="undecided">Undecided</option>
                          <option value="no_show">No show</option>
                        </select>
                      </label>
                      <label className="text-xs text-gray-600">
                        Follow-up Action
                        <select
                          className="mt-1 w-full border rounded px-2 py-1 text-sm"
                          value={questionFollowUpById[q.id] ?? q.followUpAction ?? ""}
                          onChange={e =>
                            setQuestionFollowUpById(prev => ({ ...prev, [q.id]: e.target.value }))
                          }
                        >
                          <option value="">Auto (based on outcome)</option>
                          <option value="resume">Resume cadence</option>
                          <option value="pause_24h">Pause 24h</option>
                          <option value="pause_72h">Pause 72h</option>
                          <option value="pause_indef">Pause indefinitely</option>
                          <option value="archive">Archive</option>
                          <option value="none">No change</option>
                        </select>
                      </label>
                    </div>
                  ) : null}
                  <button
                    className="text-xs text-blue-600 mt-2 inline-block"
                    onClick={() => {
                      setSelectedId(q.convId);
                    }}
                  >
                    Open conversation
                  </button>
                </div>
                {(() => {
                  const isCrmFailure = /tlp log failed/i.test(q.text ?? "");
                  if (isCrmFailure) {
                    return (
                      <div className="flex flex-col gap-2">
                        <button
                          className="px-3 py-2 border rounded text-sm"
                          onClick={() => retryCrmLog(q)}
                        >
                          Try again
                        </button>
                        <button
                          className="px-3 py-2 border rounded text-sm"
                          onClick={() => markQuestionDone(q)}
                        >
                          Update manually
                        </button>
                      </div>
                    );
                  }
                  return (
                    <button className="px-3 py-2 border rounded text-sm" onClick={() => markQuestionDone(q)}>
                      Done
                    </button>
                  );
                })()}
              </div>
            ))}
            {!loading && questions.length === 0 ? (
              <div className="p-4 text-sm text-gray-600">No open questions.</div>
            ) : null}
          </div>
        ) : null}

        {section === "contacts" ? (
          <>
            <div className="mt-3">
              <input
                className="w-full border rounded px-3 py-2 text-sm"
                placeholder="Filter contacts (name, phone, stock, VIN, ref...)"
                value={contactQuery}
                onChange={e => setContactQuery(e.target.value)}
              />
              {contactQuery ? (
                <button
                  className="mt-2 text-xs text-gray-600 hover:text-gray-900"
                  onClick={() => setContactQuery("")}
                >
                  Clear filter
                </button>
              ) : null}
            </div>
            <div className="mt-3 border rounded-lg divide-y">
            {filteredContacts.map(c => (
              <div key={c.id} className="p-4 flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-medium flex items-center gap-2">
                    <span>
                      {c.name || [c.firstName, c.lastName].filter(Boolean).join(" ") || c.phone || c.email || "Unknown"}
                    </span>
                    <span className="text-[10px] px-2 py-0.5 rounded border">
                      {c.status ?? "active"}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {c.phone ? `Phone: ${c.phone}` : null}
                    {c.phone && c.email ? " • " : null}
                    {c.email ? `Email: ${c.email}` : null}
                  </div>
                  {c.vehicleDescription ? (
                    <div className="text-xs text-gray-500 mt-1">{c.vehicleDescription}</div>
                  ) : null}
                  <div className="text-xs text-gray-500 mt-1">
                    {c.leadSource ? `Source: ${c.leadSource}` : "Source: unknown"}
                    {c.leadRef ? ` • Ref: ${c.leadRef}` : ""}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <button
                    className="px-3 py-2 border rounded text-sm"
                    onClick={() => {
                      setSelectedContact(c);
                    }}
                  >
                    Open
                  </button>
                </div>
              </div>
            ))}
            {!loading && filteredContacts.length === 0 && (
              <div className="p-4 text-sm text-gray-600">No contacts match this filter.</div>
            )}
          </div>
          </>
        ) : null}

        {todoResolveOpen && todoResolveTarget ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
            <div className="bg-white rounded-lg shadow-lg w-full max-w-md p-4">
              <div className="text-sm font-medium">Resolve To-Do</div>
              <div className="text-xs text-gray-500 mt-1">
                Choose what should happen to follow-ups for this conversation.
              </div>
              <div className="mt-3">
                <select
                  className="w-full border rounded px-3 py-2 text-sm"
                  value={todoResolution}
                  onChange={e => setTodoResolution(e.target.value)}
                >
                  <option value="resume">Resume follow-ups now</option>
                  <option value="pause_7">Pause for 7 days</option>
                  <option value="pause_30">Pause for 30 days</option>
                  <option value="pause_indef">Pause indefinitely</option>
                  <option value="appointment_set">Appointment set manually</option>
                  <option value="archive">Archive conversation</option>
                </select>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  className="px-3 py-2 border rounded text-sm"
                  onClick={() => {
                    setTodoResolveOpen(false);
                    setTodoResolveTarget(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  className="px-3 py-2 border rounded text-sm"
                  onClick={async () => {
                    if (!todoResolveTarget) return;
                    await markTodoDone(todoResolveTarget, todoResolution);
                    setTodoResolveOpen(false);
                    setTodoResolveTarget(null);
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {section === "settings" && authUser?.role === "manager" ? (
          <div className="mt-3 border rounded-lg divide-y">
            <button
              className={`w-full text-left px-4 py-3 hover:bg-gray-50 ${
                settingsTab === "dealer" ? "bg-gray-50 font-medium" : ""
              }`}
              onClick={() => setSettingsTab("dealer")}
            >
              Dealer Profile
            </button>
            <button
              className={`w-full text-left px-4 py-3 hover:bg-gray-50 ${
                settingsTab === "users" ? "bg-gray-50 font-medium" : ""
              }`}
              onClick={() => setSettingsTab("users")}
            >
              Users
            </button>
            <button
              className={`w-full text-left px-4 py-3 hover:bg-gray-50 ${
                settingsTab === "scheduler" ? "bg-gray-50 font-medium" : ""
              }`}
              onClick={() => setSettingsTab("scheduler")}
            >
              Scheduling
            </button>
          </div>
        ) : null}

        {section === "calendar" ? (
          <div className="mt-3 border rounded-lg p-4 text-sm text-gray-600">
            View and filter schedules in the main panel.
          </div>
        ) : null}

        {section === "suppressions" && (authUser?.role === "manager" || authUser?.permissions?.canAccessSuppressions) ? (
          <>
            <div className="mt-3 flex gap-2">
              <input
                className="flex-1 border rounded px-3 py-2 text-sm"
                placeholder="Add phone (+15551234567)"
                value={newSuppression}
                onChange={e => setNewSuppression(e.target.value)}
              />
              <button className="px-3 py-2 border rounded text-sm" onClick={addSuppression}>
                Add
              </button>
            </div>
            <div className="mt-3 border rounded-lg divide-y">
              {suppressions.map(s => (
                <div key={s.phone} className="p-4 flex items-start justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium">{s.phone}</div>
                    <div className="text-xs text-gray-500 mt-1">
                      {new Date(s.addedAt).toLocaleString()}
                      {s.reason ? ` • ${s.reason}` : ""}
                    </div>
                  </div>
                  <button className="px-3 py-2 border rounded text-sm" onClick={() => removeSuppression(s.phone)}>
                    Remove
                  </button>
                </div>
              ))}
              {!loading && suppressions.length === 0 && (
                <div className="p-4 text-sm text-gray-600">No suppressed numbers.</div>
              )}
            </div>
          </>
        ) : null}
      </section>

      <section
        className={`flex-1 bg-[var(--surface)] shadow-[inset_0_1px_0_rgba(255,255,255,0.6)] ${
          section === "calendar" ? "p-2 overflow-hidden" : "p-6 overflow-y-auto"
        }`}
      >
        {section === "calendar" ? (
          <div className="flex flex-col h-full">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <button
                  className={`px-3 py-2 border rounded text-sm ${calendarView === "day" ? "font-semibold bg-gray-100" : ""}`}
                  onClick={() => setCalendarView("day")}
                >
                  Day
                </button>
                <button
                  className={`px-3 py-2 border rounded text-sm ${calendarView === "week" ? "font-semibold bg-gray-100" : ""}`}
                  onClick={() => setCalendarView("week")}
                >
                  Week
                </button>
              </div>
              <div className="flex items-center gap-2">
                <div className="text-sm text-gray-600">
                  {calendarDate.toLocaleDateString("en-US", {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    year: "numeric"
                  })}
                </div>
                <button
                  className="px-2 py-1 border rounded text-sm"
                  onClick={() => {
                    const d = new Date(calendarDate);
                    d.setDate(d.getDate() + (calendarView === "week" ? -7 : -1));
                    setCalendarDate(d);
                  }}
                >
                  ◀
                </button>
                <button
                  className="px-3 py-1 border rounded text-sm"
                  onClick={() => setCalendarDate(new Date())}
                >
                  Today
                </button>
                <button
                  className="px-2 py-1 border rounded text-sm"
                  onClick={() => {
                    const d = new Date(calendarDate);
                    d.setDate(d.getDate() + (calendarView === "week" ? 7 : 1));
                    setCalendarDate(d);
                  }}
                >
                  ▶
                </button>
                <input
                  type="date"
                  className="border rounded px-2 py-1 text-sm"
                  value={calendarDate.toISOString().slice(0, 10)}
                  onChange={e => {
                    const next = new Date(calendarDate);
                    const [y, m, d] = e.target.value.split("-").map(Number);
                    if (y && m && d) {
                      next.setFullYear(y, m - 1, d);
                      setCalendarDate(next);
                    }
                  }}
                />
              </div>
              <div className="relative">
                <button
                  className="px-3 py-2 border rounded text-sm"
                  onClick={() => setCalendarFilterOpen(v => !v)}
                >
                  Filter calendars
                </button>
                {calendarFilterOpen ? (
                  <div className="absolute right-0 mt-2 w-64 bg-white border rounded-lg shadow-lg p-3 z-50">
                    <div className="text-xs font-semibold text-gray-600 mb-2">Show calendars</div>
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {calendarUsers.map((u: any) => (
                        <label key={u.id} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={calendarSalespeople.includes(u.id)}
                            onChange={e => {
                              if (e.target.checked) {
                                setCalendarSalespeople(prev => [...prev, u.id]);
                              } else {
                                setCalendarSalespeople(prev => prev.filter(id => id !== u.id));
                              }
                            }}
                          />
                          <span>{u.name || u.email || u.id} {u.role ? `(${u.role})` : ""}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-auto" ref={calendarGridRef}>
              {calendarLoading ? (
                <div className="text-sm text-gray-500">Loading calendar…</div>
              ) : (
                (() => {
                  const tz = schedulerConfig?.timezone ?? "America/New_York";
                const salespeople = calendarUsers.filter((u: any) =>
                  calendarSalespeople.length ? calendarSalespeople.includes(u.id) : true
                );
                const dayName = calendarDate
                  .toLocaleDateString("en-US", { weekday: "long", timeZone: tz })
                  .toLowerCase();
                const hours = schedulerConfig?.businessHours?.[dayName];
                const parseTime = (t?: string | null) => {
                  if (!t) return null;
                  const [h, m] = t.split(":").map(Number);
                  return h * 60 + (m || 0);
                };
                const openMin = parseTime(hours?.open) ?? null;
                const closeMin = parseTime(hours?.close) ?? null;
                const booking = dayName === "saturday"
                  ? schedulerConfig?.bookingWindows?.saturday
                  : schedulerConfig?.bookingWindows?.weekday;
                const bookingOpen = parseTime(booking?.earliestStart ?? null);
                const bookingLatest = parseTime(booking?.latestStart ?? null);

                if (calendarView === "day") {
                  let openWindow: number | null = openMin ?? null;
                  let closeWindow: number | null = closeMin ?? null;
                  if (openWindow == null || closeWindow == null || closeWindow <= openWindow) {
                    if (bookingOpen != null && bookingLatest != null && bookingLatest >= bookingOpen) {
                      openWindow = bookingOpen;
                      closeWindow = bookingLatest + 60;
                    }
                  }
                  const eventsBySp = salespeople.map((sp: any) =>
                    calendarEvents.filter(e => e.salespersonId === sp.id)
                  );
                  const getTzMinutes = (date: Date) => {
                    const parts = new Intl.DateTimeFormat("en-US", {
                      timeZone: tz,
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false
                    }).formatToParts(date);
                    const hour = Number(parts.find(p => p.type === "hour")?.value ?? "0");
                    const minute = Number(parts.find(p => p.type === "minute")?.value ?? "0");
                    return hour * 60 + minute;
                  };
                  if (openWindow == null || closeWindow == null || closeWindow <= openWindow) {
                    let minEvent = Infinity;
                    let maxEvent = -Infinity;
                    eventsBySp.flat().forEach((ev: any) => {
                      const start = ev.start ? new Date(ev.start) : null;
                      const end = ev.end ? new Date(ev.end) : null;
                      if (!start || !end) return;
                      const s = getTzMinutes(start);
                      const e = getTzMinutes(end);
                      minEvent = Math.min(minEvent, s);
                      maxEvent = Math.max(maxEvent, e);
                    });
                    if (Number.isFinite(minEvent) && Number.isFinite(maxEvent)) {
                      openWindow = Math.max(0, minEvent);
                      closeWindow = Math.min(24 * 60, maxEvent);
                    }
                  }
                  const isClosed = openWindow == null || closeWindow == null || closeWindow <= openWindow;
                  if (isClosed) {
                    openWindow = 9 * 60;
                    closeWindow = 18 * 60;
                  }
                  if (openWindow == null || closeWindow == null || closeWindow <= openWindow) {
                    return <div className="text-sm text-gray-600">Closed today.</div>;
                  }
                  const totalMinutes = closeWindow - openWindow;
                  const rowHeight = calendarRowHeight;
                  const slots = [];
                  for (let m = openWindow; m < closeWindow; m += 60) {
                    const h = Math.floor(m / 60);
                    const raw = `${String(h).padStart(2, "0")}:00`;
                    slots.push(formatTimeLabel(raw, tz));
                  }
                  const dayStart = new Date(calendarDate);
                  dayStart.setHours(0, 0, 0, 0);

                  return (
                    <div className="border rounded-lg overflow-hidden">
                      <div className="grid" style={{ gridTemplateColumns: `80px repeat(${salespeople.length || 1}, minmax(180px, 1fr))` }}>
                        <div className="bg-gray-50 border-r p-2 text-xs text-gray-500">Time</div>
                        {salespeople.map((sp: any) => (
                          <div key={sp.id} className="bg-gray-50 border-r p-2 text-sm font-medium">
                            {sp.name}
                          </div>
                        ))}
                      </div>
                      <div className="grid" style={{ gridTemplateColumns: `80px repeat(${salespeople.length || 1}, minmax(180px, 1fr))` }}>
                        <div className="border-r">
                          {slots.map(label => (
                            <div key={label} className="border-b px-2 text-xs text-gray-500 flex items-start" style={{ height: rowHeight }}>
                              {label}
                            </div>
                          ))}
                        </div>
                        {salespeople.map((sp: any, idx: number) => {
                          const events = eventsBySp[idx] ?? calendarEvents.filter(e => e.salespersonId === sp.id);
                          const columnHeight = (totalMinutes / 60) * rowHeight;
                          return (
                            <div
                              key={sp.id}
                              className="relative border-r"
                              style={{
                                height: columnHeight,
                                backgroundImage: `repeating-linear-gradient(to bottom, transparent, transparent ${rowHeight - 1}px, rgba(0,0,0,0.14) ${rowHeight}px)`
                              }}
                              ref={el => {
                                calendarColumnRefs.current[sp.id] = el;
                              }}
                              onClick={e => {
                                if (Date.now() < dragGuardRef.current.blockUntil) return;
                                if (dragStateRef.current.mode) return;
                                if (e.target instanceof HTMLElement && e.target.closest("[data-cal-event]")) return;
                                const rect = calendarColumnRefs.current[sp.id]?.getBoundingClientRect();
                                if (!rect) return;
                                const y = e.clientY - rect.top;
                                const minutesFromTop = Math.max(0, Math.min(totalMinutes, (y / rect.height) * totalMinutes));
                                const snap = 30;
                                const startMin = Math.round((openWindow + minutesFromTop) / snap) * snap;
                                const duration = 60;
                                let endMin = startMin + duration;
                                if (endMin > closeWindow) {
                                  endMin = closeWindow;
                                }
                                const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
                                const day = calendarDate.toLocaleDateString("en-CA", { timeZone: tz });
                                setCalendarEdit({ calendarId: sp.calendarId });
                                setCalendarEditForm({
                                  summary: "",
                                  startDate: day,
                                  startTime: toHHMM(startMin),
                                  endDate: day,
                                  endTime: toHHMM(endMin),
                                  status: "scheduled",
                                  reason: ""
                                });
                              }}
                              onMouseMove={e => {
                                const state = dragStateRef.current;
                                if (!state.mode || !state.event || state.event.salespersonId !== sp.id) return;
                                applyDragAt(e.clientY);
                              }}
                            >
                              {events.map((ev: any) => {
                                const start = ev.start ? new Date(ev.start) : null;
                                const end = ev.end ? new Date(ev.end) : null;
                                if (!start || !end) return null;
                                const startMin = getTzMinutes(start);
                                const endMin = getTzMinutes(end);
                                const draggedStart = typeof ev._dragStart === "number" ? ev._dragStart : startMin;
                                const draggedEnd = typeof ev._dragEnd === "number" ? ev._dragEnd : endMin;
                                const renderStart = Math.max(draggedStart, openWindow);
                                const renderEnd = Math.min(draggedEnd, closeWindow);
                                if (renderEnd <= renderStart) return null;
                                const top = ((renderStart - openWindow) / totalMinutes) * 100;
                                const height = Math.max(((renderEnd - renderStart) / totalMinutes) * 100, 5);
                                const minToLabel = (m: number) => {
                                  const h = Math.floor(m / 60);
                                  const mm = m % 60;
                                  return formatTimeLabel(`${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`, tz);
                                };
                                const timeLabel = `${minToLabel(renderStart)}–${minToLabel(renderEnd)}`;
                                const detail = getEventDetails(ev);
                                return (
                                  <div
                                    key={ev.id}
                                    data-cal-event
                                    className="absolute left-2 right-2 bg-blue-100 text-blue-900 border border-blue-200 rounded px-2 py-1 text-xs overflow-hidden cursor-pointer"
                                    style={{ top: `${top}%`, height: `${height}%` }}
                                    title={detail || ev.summary}
                                    onMouseDown={e => {
                                      e.stopPropagation();
                                      if (ev.readOnly) return;
                                      if (e.button !== 0) return;
                                      dragStateRef.current = {
                                        mode: "move",
                                        event: ev,
                                        startY: e.clientY,
                                        origStartMin: startMin,
                                        origEndMin: endMin,
                                        openWindow,
                                        closeWindow
                                      };
                                    }}
                                  >
                                    <div className="flex items-start justify-between gap-2">
                                      <div className="min-w-0">
                                        <div className="font-medium truncate">{getEventTitle(ev)}</div>
                                        <div className="text-[10px] text-blue-900/70 mt-1">{timeLabel}</div>
                                        {detail ? (
                                          <div className="text-[10px] text-blue-900/60 mt-1 truncate">
                                            {detail}
                                          </div>
                                        ) : null}
                                      </div>
                                      {ev.readOnly ? null : (
                                        <button
                                          className="text-[10px] px-1.5 py-0.5 rounded border border-blue-300 bg-white/70 hover:bg-white"
                                          onMouseDown={e => {
                                            e.stopPropagation();
                                            e.preventDefault();
                                          }}
                                          onClick={e => {
                                            e.stopPropagation();
                                            if (Date.now() < dragGuardRef.current.blockUntil) return;
                                            setCalendarEdit({ ...ev, calendarId: ev.calendarId });
                                          }}
                                        >
                                          Edit
                                        </button>
                                      )}
                                    </div>
                                    {ev.readOnly ? null : (
                                      <div
                                        className="absolute left-0 right-0 bottom-0 h-2 cursor-ns-resize bg-blue-200/60"
                                        onMouseDown={e => {
                                          e.stopPropagation();
                                          if (e.button !== 0) return;
                                          dragStateRef.current = {
                                            mode: "resize",
                                            event: ev,
                                            startY: e.clientY,
                                            origStartMin: startMin,
                                            origEndMin: endMin,
                                            openWindow,
                                            closeWindow
                                          };
                                        }}
                                      />
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                }

                // week view
                const daysToShow = Array.from({ length: 7 }).map((_, i) => {
                  const d = new Date(calendarDate);
                  d.setDate(d.getDate() + i);
                  return d;
                });
                return (
                  <div className="space-y-3">
                    {daysToShow.map(d => {
                      const dName = d.toLocaleDateString("en-US", { weekday: "long", timeZone: tz }).toLowerCase();
                      const dHours = schedulerConfig?.businessHours?.[dName];
                      const closed = !dHours?.open || !dHours?.close;
                      return (
                        <div key={d.toISOString()} className="border rounded-lg p-3">
                          <div className="text-sm font-semibold">
                            {d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}
                            {closed ? " • Closed" : ""}
                          </div>
                          {!closed ? (
                            <div className="grid mt-2" style={{ gridTemplateColumns: `repeat(${salespeople.length || 1}, minmax(180px, 1fr))` }}>
                              {salespeople.map((sp: any) => {
                                const events = calendarEvents.filter((e: any) => {
                                  if (e.salespersonId !== sp.id) return false;
                                  if (!e.start) return false;
                                  const ed = new Date(e.start);
                                  return (
                                    ed.getFullYear() === d.getFullYear() &&
                                    ed.getMonth() === d.getMonth() &&
                                    ed.getDate() === d.getDate()
                                  );
                                });
                                return (
                                  <div key={`${sp.id}-${d.toISOString()}`} className="px-2">
                                    <div className="text-xs text-gray-500 mb-1">{sp.name}</div>
                                    <div className="space-y-1">
                                      {events.length === 0 ? (
                                        <div className="text-xs text-gray-400">No events</div>
                                      ) : (
                                        events.map((ev: any) => (
                                          <div
                                            key={ev.id}
                                            className="text-xs bg-blue-100 border border-blue-200 rounded px-2 py-1 cursor-pointer"
                                            title={getEventDetails(ev) || ev.summary}
                                            onClick={() => {
                                              if (ev.readOnly) return;
                                              setCalendarEdit({ ...ev, calendarId: ev.calendarId });
                                            }}
                                          >
                                            {getEventTitle(ev)}
                                          </div>
                                        ))
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                );
                })()
              )}
            </div>
            {calendarEdit ? (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
                <div className="bg-white w-full max-w-xl rounded-lg shadow-lg p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="text-lg font-semibold">Edit appointment</div>
                    <button className="px-2 py-1 border rounded text-sm" onClick={() => setCalendarEdit(null)}>
                      Close
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2">
                      <div className="text-xs text-gray-500 mb-1">Calendar owner</div>
                      <select
                        className="border rounded px-3 py-2 text-sm w-full"
                        value={calendarEditSalespersonId}
                        onChange={e => setCalendarEditSalespersonId(e.target.value)}
                      >
                        <option value="">(no change)</option>
                        {calendarUsers.map((u: any) => (
                          <option key={u.id} value={u.id}>
                            {u.name || u.email || u.id} {u.role ? `(${u.role})` : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                    <input
                      className="border rounded px-3 py-2 text-sm col-span-2"
                      placeholder="Title"
                      value={calendarEditForm.summary}
                      onChange={e => setCalendarEditForm({ ...calendarEditForm, summary: e.target.value })}
                    />
                    <input
                      className="border rounded px-3 py-2 text-sm"
                      type="date"
                      value={calendarEditForm.startDate}
                      onChange={e => setCalendarEditForm({ ...calendarEditForm, startDate: e.target.value })}
                    />
                    <input
                      className="border rounded px-3 py-2 text-sm"
                      type="time"
                      value={calendarEditForm.startTime}
                      onChange={e => setCalendarEditForm({ ...calendarEditForm, startTime: e.target.value })}
                    />
                    <input
                      className="border rounded px-3 py-2 text-sm"
                      type="date"
                      value={calendarEditForm.endDate}
                      onChange={e => setCalendarEditForm({ ...calendarEditForm, endDate: e.target.value })}
                    />
                    <input
                      className="border rounded px-3 py-2 text-sm"
                      type="time"
                      value={calendarEditForm.endTime}
                      onChange={e => setCalendarEditForm({ ...calendarEditForm, endTime: e.target.value })}
                    />
                    <select
                      className="border rounded px-3 py-2 text-sm col-span-2"
                      value={calendarEditForm.status}
                      onChange={e => setCalendarEditForm({ ...calendarEditForm, status: e.target.value })}
                    >
                      <option value="scheduled">Scheduled</option>
                      <option value="cancelled">Cancelled</option>
                      <option value="no_show">No show</option>
                    </select>
                    <textarea
                      className="border rounded px-3 py-2 text-sm col-span-2"
                      placeholder="Reason (optional)"
                      rows={3}
                      value={calendarEditForm.reason}
                      onChange={e => setCalendarEditForm({ ...calendarEditForm, reason: e.target.value })}
                    />
                  </div>
                  <div className="flex gap-2">
                    <button className="px-3 py-2 border rounded text-sm" onClick={saveCalendarEdit}>
                      Save
                    </button>
                    <button className="px-3 py-2 border rounded text-sm" onClick={() => setCalendarEdit(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        ) : section === "inventory" ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="text-lg font-semibold">Inventory</div>
              <button
                className="px-3 py-2 border rounded text-sm"
                onClick={async () => {
                  setInventoryItems([]);
                  setInventoryNotes({});
                  setInventoryQuery("");
                  setInventoryLoading(true);
                  try {
                    const resp = await fetch("/api/inventory", { cache: "no-store" });
                    const json = await resp.json();
                    const items = Array.isArray(json?.items) ? json.items : [];
                    setInventoryItems(items);
                    const noteMap: Record<string, any[]> = {};
                    items.forEach((it: any) => {
                      const key = String(it.stockId ?? it.vin ?? "").trim().toLowerCase();
                      if (key) noteMap[key] = Array.isArray(it.notes) ? it.notes : [];
                    });
                    setInventoryNotes(noteMap);
                  } catch {
                    setInventoryItems([]);
                  } finally {
                    setInventoryLoading(false);
                  }
                }}
              >
                Refresh
              </button>
            </div>
            {inventoryLoading ? (
              <div className="text-sm text-gray-500">Loading inventory...</div>
            ) : (
              <>
                <datalist id="inventory-note-labels">
                  {inventoryNoteSuggestions.labels.map(label => (
                    <option key={label} value={label} />
                  ))}
                </datalist>
                <datalist id="inventory-note-texts">
                  {inventoryNoteSuggestions.notes.map(note => (
                    <option key={note} value={note} />
                  ))}
                </datalist>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {inventoryItems
                  .filter((it: any) => {
                    const q = inventoryQuery.trim().toLowerCase();
                    if (!q) return true;
                    const hay = [
                      it.stockId,
                      it.vin,
                      it.year,
                      it.make,
                      it.model,
                      it.color
                    ]
                      .filter(Boolean)
                      .join(" ")
                      .toLowerCase();
                    return hay.includes(q);
                  })
                  .map((it: any) => {
                    const key = String(it.stockId ?? it.vin ?? "").trim().toLowerCase();
                    return (
                      <div key={key || it.url || Math.random()} className="border rounded-lg p-3 space-y-2">
                        {it.images?.[0] ? (
                          <img
                            src={it.images[0]}
                            alt={it.model ?? it.stockId ?? "Bike"}
                            className="w-full h-40 object-contain bg-gray-50 rounded"
                          />
                        ) : (
                          <div className="w-full h-40 bg-gray-100 rounded flex items-center justify-center text-xs text-gray-400">
                            No image
                          </div>
                        )}
                        <div className="text-sm font-semibold">
                          {[it.year, it.make, it.model].filter(Boolean).join(" ")}
                        </div>
                        <div className="text-xs text-gray-500">
                          {it.stockId ? `Stock ${it.stockId}` : it.vin ? `VIN ${it.vin}` : "No stock/VIN"}
                        </div>
                        <div className="text-xs text-gray-500">
                          {it.color ? `Color: ${it.color}` : "Color: —"}{" "}
                          {it.price ? `• $${Number(it.price).toLocaleString()}` : ""}
                        </div>
                        {it.url ? (
                          <a className="text-xs text-blue-600 underline" href={it.url} target="_blank" rel="noreferrer">
                            View listing
                          </a>
                        ) : null}
                        <div className="space-y-2">
                          {(inventoryNotes[key] ?? []).map((n: any, idx: number) => {
                            const expired = n?.expiresAt && n.expiresAt < new Date().toISOString().slice(0, 10);
                            const noteId = String(n.id ?? `${key}-${idx}`);
                            const isOpen = inventoryExpandedNote === noteId;
                            const label = String(n.label ?? "").trim() || "Note";
                            const notePreview = String(n.note ?? "").trim();
                            const preview =
                              notePreview.length > 80 ? `${notePreview.slice(0, 80)}…` : notePreview;
                            return (
                              <div key={noteId} className={`border rounded ${expired ? "opacity-50" : ""}`}>
                                <button
                                  className="w-full text-left px-2 py-2 text-xs flex items-center justify-between gap-2"
                                  onClick={() => setInventoryExpandedNote(isOpen ? null : noteId)}
                                >
                                  <div className="min-w-0">
                                    <div className="font-semibold truncate">{label}</div>
                                    {preview ? (
                                      <div className="text-gray-500 truncate">{preview}</div>
                                    ) : (
                                      <div className="text-gray-400 truncate">No details</div>
                                    )}
                                  </div>
                                  <div className="text-gray-400 text-[10px]">
                                    {n.expiresAt ? `Exp ${n.expiresAt}` : "No expiry"}
                                  </div>
                                </button>
                                {isOpen ? (
                                  <div className="px-2 pb-2 space-y-2">
                                    <input
                                      className="w-full border rounded px-2 py-1 text-xs"
                                      placeholder="Label (e.g., Accessories, Finance Special)"
                                      list="inventory-note-labels"
                                      value={n.label ?? ""}
                                      onChange={e =>
                                        setInventoryNotes(prev => {
                                          const next = [...(prev[key] ?? [])];
                                          next[idx] = { ...next[idx], label: e.target.value };
                                          return { ...prev, [key]: next };
                                        })
                                      }
                                    />
                                    <input
                                      className="w-full border rounded px-2 py-2 text-xs"
                                      placeholder="Note details"
                                      list="inventory-note-texts"
                                      value={n.note ?? ""}
                                      onChange={e =>
                                        setInventoryNotes(prev => {
                                          const next = [...(prev[key] ?? [])];
                                          next[idx] = { ...next[idx], note: e.target.value };
                                          return { ...prev, [key]: next };
                                        })
                                      }
                                    />
                                    <div className="flex items-center gap-2">
                                      <input
                                        className="border rounded px-2 py-1 text-xs"
                                        type="date"
                                        value={n.expiresAt ?? ""}
                                        onChange={e =>
                                          setInventoryNotes(prev => {
                                            const next = [...(prev[key] ?? [])];
                                            next[idx] = { ...next[idx], expiresAt: e.target.value };
                                            return { ...prev, [key]: next };
                                          })
                                        }
                                      />
                                      <button
                                        className="px-2 py-1 border rounded text-xs"
                                        onClick={() =>
                                          setInventoryNotes(prev => {
                                            const next = [...(prev[key] ?? [])];
                                            next.splice(idx, 1);
                                            return { ...prev, [key]: next };
                                          })
                                        }
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            );
                          })}
                          <button
                            className="px-2 py-1 border rounded text-xs"
                            onClick={() =>
                              setInventoryNotes(prev => {
                                const next = [...(prev[key] ?? [])];
                                next.push({ id: `note_${Date.now()}_${Math.random()}`, label: "", note: "", expiresAt: "" });
                                return { ...prev, [key]: next };
                              })
                            }
                          >
                            Add note
                          </button>
                        </div>
                        <button
                          className="px-3 py-2 border rounded text-xs"
                          onClick={() => saveInventoryNote(it.stockId, it.vin)}
                          disabled={!key || inventorySaving === key}
                        >
                          {inventorySaving === key ? "Saving..." : "Save note"}
                        </button>
                      </div>
                    );
                  })}
              </div>
              </>
            )}
          </div>
        ) : section === "settings" ? (
          <div className="max-w-3xl space-y-6">
            {settingsError ? (
              <div className="text-sm text-red-600">{settingsError}</div>
            ) : null}
            {settingsTab === "dealer" ? (
              <div className="border rounded-lg p-4 space-y-4">
                <div className="text-lg font-semibold">Dealer Profile</div>
                <div className="grid grid-cols-2 gap-3">
                  <input
                    className="border rounded px-3 py-2 text-sm"
                    placeholder="Dealer name"
                    value={dealerProfileForm.dealerName}
                    onChange={e => setDealerProfileForm({ ...dealerProfileForm, dealerName: e.target.value })}
                  />
                  <input
                    className="border rounded px-3 py-2 text-sm"
                    placeholder="Agent name"
                    value={dealerProfileForm.agentName}
                    onChange={e => setDealerProfileForm({ ...dealerProfileForm, agentName: e.target.value })}
                  />
                  <select
                    className="border rounded px-3 py-2 text-sm"
                    value={dealerProfileForm.crmProvider}
                    onChange={e => setDealerProfileForm({ ...dealerProfileForm, crmProvider: e.target.value })}
                  >
                    <option value="">CRM provider (optional)</option>
                    <option value="tlp">TLP</option>
                    <option value="vin">VIN</option>
                    <option value="elead">eLead</option>
                    <option value="dealersocket">DealerSocket</option>
                    <option value="adf">Generic ADF</option>
                  </select>
                  <select
                    className="border rounded px-3 py-2 text-sm"
                    value={dealerProfileForm.websiteProvider}
                    onChange={e => setDealerProfileForm({ ...dealerProfileForm, websiteProvider: e.target.value })}
                  >
                    <option value="">Website provider (optional)</option>
                    <option value="dx1">DX1</option>
                    <option value="foxdealer">Fox Dealer</option>
                    <option value="room58">Room 58</option>
                    <option value="dealerspike">Dealer Spike</option>
                    <option value="dealereprocess">Dealer eProcess</option>
                    <option value="motive">Motive</option>
                  </select>
                  <input
                    className="border rounded px-3 py-2 text-sm"
                    placeholder="Phone"
                    value={dealerProfileForm.phone}
                    onChange={e => setDealerProfileForm({ ...dealerProfileForm, phone: e.target.value })}
                  />
                  <input
                    className="border rounded px-3 py-2 text-sm"
                    placeholder="Website"
                    value={dealerProfileForm.website}
                    onChange={e => setDealerProfileForm({ ...dealerProfileForm, website: e.target.value })}
                  />
                  <div className="flex items-center gap-2">
                    <input
                      className="border rounded px-3 py-2 text-sm flex-1"
                      placeholder="Booking token (public)"
                      value={dealerProfileForm.bookingToken}
                      onChange={e => setDealerProfileForm({ ...dealerProfileForm, bookingToken: e.target.value })}
                    />
                    <button
                      className="px-3 py-2 border rounded text-sm"
                      type="button"
                      onClick={() => {
                        const token =
                          (typeof window !== "undefined" && window.crypto?.randomUUID?.()) ||
                          Math.random().toString(36).slice(2);
                        setDealerProfileForm(prev => ({ ...prev, bookingToken: token }));
                      }}
                    >
                      Generate
                    </button>
                  </div>
                  <input
                    className="border rounded px-3 py-2 text-sm"
                    placeholder="Booking link (for email follow-ups)"
                    value={dealerProfileForm.bookingUrl}
                    onChange={e => setDealerProfileForm({ ...dealerProfileForm, bookingUrl: e.target.value })}
                  />
                  <input
                    className="border rounded px-3 py-2 text-sm"
                    placeholder="From email (outbound)"
                    value={dealerProfileForm.fromEmail}
                    onChange={e => setDealerProfileForm({ ...dealerProfileForm, fromEmail: e.target.value })}
                  />
                  <input
                    className="border rounded px-3 py-2 text-sm"
                    placeholder="Reply-to email (optional)"
                    value={dealerProfileForm.replyToEmail}
                    onChange={e => setDealerProfileForm({ ...dealerProfileForm, replyToEmail: e.target.value })}
                  />
                  <textarea
                    className="border rounded px-3 py-2 text-sm col-span-2 min-h-[90px]"
                    placeholder="Email signature (optional)"
                    value={dealerProfileForm.emailSignature}
                    onChange={e =>
                      setDealerProfileForm({ ...dealerProfileForm, emailSignature: e.target.value })
                    }
                  />
                  <div className="col-span-2 border rounded p-3">
                    <div className="text-xs text-gray-600 mb-2">Logo (email signature)</div>
                    {dealerProfileForm.logoUrl ? (
                      <div className="flex items-center gap-3 mb-2">
                        <img
                          src={dealerProfileForm.logoUrl}
                          alt="Dealer logo"
                          className="h-12 object-contain border rounded bg-white"
                        />
                        <button
                          className="px-2 py-1 border rounded text-xs"
                          onClick={() => setDealerProfileForm({ ...dealerProfileForm, logoUrl: "" })}
                        >
                          Remove
                        </button>
                      </div>
                    ) : null}
                    <label className="inline-flex items-center gap-2 px-3 py-2 border rounded text-sm cursor-pointer hover:bg-gray-50">
                      <span>Upload logo</span>
                      <input
                        className="hidden"
                        type="file"
                        accept="image/*"
                        onChange={async e => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const fd = new FormData();
                        fd.append("file", file);
                        const resp = await fetch("/api/dealer-profile/logo", {
                          method: "POST",
                          body: fd
                        });
                          const payload = await resp.json().catch(() => null);
                          if (resp.ok && payload?.profile) {
                            setDealerProfileForm(prev => ({
                              ...prev,
                              logoUrl: payload.profile.logoUrl ?? payload.url ?? ""
                            }));
                          }
                        }}
                      />
                    </label>
                  </div>
                  <input
                    className="border rounded px-3 py-2 text-sm col-span-2"
                    placeholder="Address line 1"
                    value={dealerProfileForm.addressLine1}
                    onChange={e => setDealerProfileForm({ ...dealerProfileForm, addressLine1: e.target.value })}
                  />
                  <input
                    className="border rounded px-3 py-2 text-sm"
                    placeholder="City"
                    value={dealerProfileForm.city}
                    onChange={e => setDealerProfileForm({ ...dealerProfileForm, city: e.target.value })}
                  />
                  <input
                    className="border rounded px-3 py-2 text-sm"
                    placeholder="State"
                    value={dealerProfileForm.state}
                    onChange={e => setDealerProfileForm({ ...dealerProfileForm, state: e.target.value })}
                  />
                  <input
                    className="border rounded px-3 py-2 text-sm"
                    placeholder="Zip"
                    value={dealerProfileForm.zip}
                    onChange={e => setDealerProfileForm({ ...dealerProfileForm, zip: e.target.value })}
                  />
                </div>
                <div>
                  <div className="text-sm font-medium mb-2">Business hours</div>
                  <div className="space-y-2">
                    {days.map(day => {
                      const current = dealerHours?.[day] ?? { open: null, close: null };
                      return (
                        <div key={day} className="grid grid-cols-3 gap-2 items-center text-sm">
                          <div className="capitalize">{day}</div>
                          <select
                            className="border rounded px-2 py-1 text-sm"
                            value={current.open ?? ""}
                            onChange={e => updateHours(setDealerHours, day, "open", e.target.value)}
                          >
                            <option value="">Closed</option>
                            {timeOptions.map(t => (
                              <option key={`open-${day}-${t}`} value={t}>
                                {formatTimeLabel(t, schedulerForm.timezone)}
                              </option>
                            ))}
                          </select>
                          <select
                            className="border rounded px-2 py-1 text-sm"
                            value={current.close ?? ""}
                            onChange={e => updateHours(setDealerHours, day, "close", e.target.value)}
                          >
                            <option value="">Closed</option>
                            {timeOptions.map(t => (
                              <option key={`close-${day}-${t}`} value={t}>
                                {formatTimeLabel(t, schedulerForm.timezone)}
                              </option>
                            ))}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <div className="text-sm font-medium mb-2">Follow-up: Test Ride</div>
                  <label className="flex items-center gap-2 text-sm mb-3">
                    <input
                      type="checkbox"
                      checked={!!dealerProfileForm.testRideEnabled}
                      onChange={e =>
                        setDealerProfileForm({ ...dealerProfileForm, testRideEnabled: e.target.checked })
                      }
                    />
                    Enable test ride follow-ups
                  </label>
                  <div className="text-xs text-gray-500 mb-2">Months to offer test rides</div>
                  <div className="grid grid-cols-6 gap-2 text-sm">
                    {followUpMonths.map(m => {
                      const checked = (dealerProfileForm.testRideMonths ?? []).includes(m.value);
                      return (
                        <label key={`month-${m.value}`} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!dealerProfileForm.testRideEnabled}
                            onChange={e => {
                              const next = new Set(dealerProfileForm.testRideMonths ?? []);
                              if (e.target.checked) next.add(m.value);
                              else next.delete(m.value);
                              setDealerProfileForm({
                                ...dealerProfileForm,
                                testRideMonths: Array.from(next).sort((a, b) => a - b)
                              });
                            }}
                          />
                          {m.label}
                        </label>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <button
                    className="px-3 py-2 border rounded text-sm"
                    onClick={saveDealerProfile}
                    disabled={settingsSaving}
                  >
                    {settingsSaving ? "Saving…" : "Save Dealer Profile"}
                  </button>
                </div>
              </div>
            ) : settingsTab === "users" ? (
              <div className="border rounded-lg p-4 space-y-6">
                <div className="text-lg font-semibold">Users</div>
                <div className="space-y-3">
                  {usersList.map(user => (
                    <div key={user.id} className="border rounded-lg p-3 flex items-center justify-between">
                      <div>
                        <div className="text-sm font-medium">{user.name || user.email || "Unnamed"}</div>
                                <div className="text-xs text-gray-600">
                                  {user.email || "No email"} • {user.role}
                                  {user.phone ? ` • ${user.phone}` : ""}
                                  {user.extension ? ` • ext ${user.extension}` : ""}
                                </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          className="px-2 py-1 border rounded text-xs"
                          onClick={() => setEditingUserId(user.id)}
                        >
                          Edit
                        </button>
                        <button
                          className="px-2 py-1 border rounded text-xs text-red-600 border-red-200 hover:bg-red-50"
                          onClick={() => deleteUserRow(user.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <button
                  className="px-3 py-2 border rounded text-sm"
                  onClick={() => {
                    setShowNewUserForm(true);
                    setEditingUserId(null);
                  }}
                >
                  Add user
                </button>

                {editingUserId || showNewUserForm ? (
                  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
                    <div className="bg-white w-full max-w-2xl rounded-lg shadow-lg p-4 space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="text-lg font-semibold">
                          {editingUserId ? "Edit user" : "Add user"}
                        </div>
                        <button
                          className="text-sm px-2 py-1 border rounded"
                          onClick={() => {
                            setEditingUserId(null);
                            setShowNewUserForm(false);
                          }}
                        >
                          Close
                        </button>
                      </div>

                      {editingUserId
                        ? usersList
                            .filter(u => u.id === editingUserId)
                            .map(user => (
                              <div key={user.id} className="space-y-2">
                                <div className="grid grid-cols-2 gap-2">
                                  <input
                                    className="border rounded px-2 py-1 text-sm"
                                    value={user.name ?? ""}
                                    placeholder="Name"
                                    onChange={e =>
                                      setUsersList(prev =>
                                        prev.map(u => (u.id === user.id ? { ...u, name: e.target.value } : u))
                                      )
                                    }
                                  />
                                  <input
                                    className="border rounded px-2 py-1 text-sm"
                                    value={user.email ?? ""}
                                    placeholder="Email"
                                    onChange={e =>
                                      setUsersList(prev =>
                                        prev.map(u => (u.id === user.id ? { ...u, email: e.target.value } : u))
                                      )
                                    }
                                  />
                                  <select
                                    className="border rounded px-2 py-1 text-sm"
                                    value={user.role ?? "salesperson"}
                                    onChange={e =>
                                      setUsersList(prev =>
                                        prev.map(u => (u.id === user.id ? { ...u, role: e.target.value } : u))
                                      )
                                    }
                                  >
                                    <option value="salesperson">Salesperson</option>
                                    <option value="manager">Manager</option>
                                  </select>
                                  <input
                                    className="border rounded px-2 py-1 text-sm"
                                    placeholder="Calendar ID"
                                    value={user.calendarId ?? ""}
                                    onChange={e =>
                                      setUsersList(prev =>
                                        prev.map(u => (u.id === user.id ? { ...u, calendarId: e.target.value } : u))
                                      )
                                    }
                                  />
                                  <input
                                    className="border rounded px-2 py-1 text-sm"
                                    placeholder="Phone (for calls)"
                                    value={user.phone ?? ""}
                                    onChange={e =>
                                      setUsersList(prev =>
                                        prev.map(u => (u.id === user.id ? { ...u, phone: e.target.value } : u))
                                      )
                                    }
                                  />
                                  <input
                                    className="border rounded px-2 py-1 text-sm"
                                    placeholder="Extension / dial digits"
                                    value={user.extension ?? ""}
                                    onChange={e =>
                                      setUsersList(prev =>
                                        prev.map(u => (u.id === user.id ? { ...u, extension: e.target.value } : u))
                                      )
                                    }
                                  />
                                  <input
                                    className="border rounded px-2 py-1 text-sm col-span-2"
                                    placeholder="Set new password"
                                    type="password"
                                    value={userPasswords[user.id] ?? ""}
                                    onChange={e =>
                                      setUserPasswords(prev => ({
                                        ...prev,
                                        [user.id]: e.target.value
                                      }))
                                    }
                                  />
                                  <div className="col-span-2 grid grid-cols-2 gap-2 text-xs">
                                    <label className="flex items-center gap-2">
                                      <input
                                        type="checkbox"
                                        checked={!!user.permissions?.canEditAppointments}
                                        onChange={e =>
                                          setUsersList(prev =>
                                            prev.map(u =>
                                              u.id === user.id
                                                ? {
                                                    ...u,
                                                    permissions: {
                                                      ...(u.permissions ?? {}),
                                                      canEditAppointments: e.target.checked
                                                    }
                                                  }
                                                : u
                                            )
                                          )
                                        }
                                      />
                                      Edit appointments
                                    </label>
                                    <label className="flex items-center gap-2">
                                      <input
                                        type="checkbox"
                                        checked={!!user.permissions?.canToggleHumanOverride}
                                        onChange={e =>
                                          setUsersList(prev =>
                                            prev.map(u =>
                                              u.id === user.id
                                                ? {
                                                    ...u,
                                                    permissions: {
                                                      ...(u.permissions ?? {}),
                                                      canToggleHumanOverride: e.target.checked
                                                    }
                                                  }
                                                : u
                                            )
                                          )
                                        }
                                      />
                                      Human override
                                    </label>
                                    <label className="flex items-center gap-2">
                                      <input
                                        type="checkbox"
                                        checked={!!user.permissions?.canAccessTodos}
                                        onChange={e =>
                                          setUsersList(prev =>
                                            prev.map(u =>
                                              u.id === user.id
                                                ? {
                                                    ...u,
                                                    permissions: {
                                                      ...(u.permissions ?? {}),
                                                      canAccessTodos: e.target.checked
                                                    }
                                                  }
                                                : u
                                            )
                                          )
                                        }
                                      />
                                      To‑Do inbox
                                    </label>
                                    <label className="flex items-center gap-2">
                                      <input
                                        type="checkbox"
                                        checked={!!user.permissions?.canAccessSuppressions}
                                        onChange={e =>
                                          setUsersList(prev =>
                                            prev.map(u =>
                                              u.id === user.id
                                                ? {
                                                    ...u,
                                                    permissions: {
                                                      ...(u.permissions ?? {}),
                                                      canAccessSuppressions: e.target.checked
                                                    }
                                                  }
                                                : u
                                            )
                                          )
                                        }
                                      />
                                      Suppression list
                                    </label>
                                  </div>
                                </div>
                                <div className="flex items-center gap-2">
                                  <button
                                    className="px-3 py-2 border rounded text-sm"
                                    onClick={() => {
                                      const password = userPasswords[user.id];
                                      updateUserRow(user.id, {
                                        email: user.email,
                                        name: user.name,
                                        role: user.role,
                                        calendarId: user.calendarId,
                                        phone: user.phone,
                                        extension: user.extension,
                                        permissions: user.permissions,
                                        ...(password ? { password } : {})
                                      });
                                      if (password) {
                                        setUserPasswords(prev => ({ ...prev, [user.id]: "" }));
                                      }
                                    }}
                                  >
                                    Save
                                  </button>
                                  {(user.role === "salesperson" || user.role === "manager") ? (
                                    <button
                                      className="px-3 py-2 border rounded text-sm"
                                      disabled={creatingCalendar || !(user.name || user.email)}
                                      onClick={async () => {
                                        const name = String(user.name || user.email || "").trim();
                                        if (!name) return;
                                        setCreatingCalendar(true);
                                        try {
                                          const resp = await fetch("/api/calendar/create", {
                                            method: "POST",
                                            headers: { "Content-Type": "application/json" },
                                            body: JSON.stringify({ name })
                                          });
                                          const json = await resp.json();
                                          if (!resp.ok) throw new Error(json?.error ?? "Failed to create calendar");
                                          const id = json?.calendar?.id ?? "";
                                          await updateUserRow(user.id, { calendarId: id });
                                        } catch (err: any) {
                                          setSettingsError(err?.message ?? "Failed to create calendar");
                                        } finally {
                                          setCreatingCalendar(false);
                                        }
                                      }}
                                    >
                                      {creatingCalendar ? "Creating…" : "Create calendar"}
                                    </button>
                                  ) : null}
                                </div>
                              </div>
                            ))
                        : (
                          <div className="space-y-2">
                            <div className="text-xs text-gray-500">
                              Save the user to set availability blocks.
                            </div>
                          <div className="grid grid-cols-2 gap-3">
                            <input
                              className="border rounded px-3 py-2 text-sm"
                              placeholder="Name"
                              value={userForm.name}
                              onChange={e => setUserForm({ ...userForm, name: e.target.value })}
                              />
                              <input
                                className="border rounded px-3 py-2 text-sm"
                                placeholder="Email"
                                value={userForm.email}
                                onChange={e => setUserForm({ ...userForm, email: e.target.value })}
                              />
                              <input
                                className="border rounded px-3 py-2 text-sm"
                                placeholder="Phone (for calls)"
                                value={(userForm as any).phone ?? ""}
                                onChange={e => setUserForm({ ...userForm, phone: e.target.value })}
                              />
                              <input
                                className="border rounded px-3 py-2 text-sm"
                                placeholder="Extension / dial digits"
                                value={(userForm as any).extension ?? ""}
                                onChange={e => setUserForm({ ...userForm, extension: e.target.value })}
                              />
                              <input
                                className="border rounded px-3 py-2 text-sm"
                                placeholder="Password"
                                type="password"
                                value={userForm.password}
                                onChange={e => setUserForm({ ...userForm, password: e.target.value })}
                              />
                            <select
                              className="border rounded px-3 py-2 text-sm"
                              value={userForm.role}
                              onChange={e => setUserForm({ ...userForm, role: e.target.value })}
                            >
                              <option value="salesperson">Salesperson</option>
                              <option value="manager">Manager</option>
                            </select>
                            <div className="col-span-2 grid grid-cols-2 gap-2 text-xs">
                              <label className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={!!userForm.permissions?.canEditAppointments}
                                  onChange={e =>
                                    setUserForm({
                                      ...userForm,
                                      permissions: { ...userForm.permissions, canEditAppointments: e.target.checked }
                                    })
                                  }
                                />
                                Edit appointments
                              </label>
                              <label className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={!!userForm.permissions?.canToggleHumanOverride}
                                  onChange={e =>
                                    setUserForm({
                                      ...userForm,
                                      permissions: { ...userForm.permissions, canToggleHumanOverride: e.target.checked }
                                    })
                                  }
                                />
                                Human override
                              </label>
                              <label className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={!!userForm.permissions?.canAccessTodos}
                                  onChange={e =>
                                    setUserForm({
                                      ...userForm,
                                      permissions: { ...userForm.permissions, canAccessTodos: e.target.checked }
                                    })
                                  }
                                />
                                To‑Do inbox
                              </label>
                              <label className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={!!userForm.permissions?.canAccessSuppressions}
                                  onChange={e =>
                                    setUserForm({
                                      ...userForm,
                                      permissions: { ...userForm.permissions, canAccessSuppressions: e.target.checked }
                                    })
                                  }
                                />
                                Suppression list
                              </label>
                            </div>
                              <div className="col-span-2 flex gap-2">
                                <input
                                  className="border rounded px-3 py-2 text-sm flex-1"
                                  placeholder="Calendar ID (salespeople only)"
                                  value={userForm.calendarId}
                                  onChange={e => setUserForm({ ...userForm, calendarId: e.target.value })}
                                />
                                <button
                                  className="px-3 py-2 border rounded text-sm"
                                  disabled={
                                    creatingCalendar || !(userForm.name.trim() || userForm.email.trim())
                                  }
                                  onClick={async () => {
                                    const name = (userForm.name || userForm.email).trim();
                                    if (!name) return;
                                    setCreatingCalendar(true);
                                    try {
                                      const resp = await fetch("/api/calendar/create", {
                                        method: "POST",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ name })
                                      });
                                      const json = await resp.json();
                                      if (!resp.ok) throw new Error(json?.error ?? "Failed to create calendar");
                                      const id = json?.calendar?.id ?? "";
                                      setUserForm(prev => ({ ...prev, calendarId: id }));
                                    } catch (err: any) {
                                      setSettingsError(err?.message ?? "Failed to create calendar");
                                    } finally {
                                      setCreatingCalendar(false);
                                    }
                                  }}
                                >
                                  {creatingCalendar ? "Creating…" : "Create calendar"}
                                </button>
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <button className="px-3 py-2 border rounded text-sm" onClick={addUser}>
                                Save user
                              </button>
                              <button
                                className="px-3 py-2 border rounded text-sm"
                                onClick={() => setShowNewUserForm(false)}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}

                      {editingUserId ? (
                        <div className="border-t pt-4">
                          <div className="text-sm font-medium mb-2">Availability blocks</div>
                          <div className="space-y-3">
                            <div className="grid grid-cols-2 gap-2">
                              <select
                                className="border rounded px-2 py-1 text-sm"
                                value={blockForm.salespersonId}
                                onChange={e => setBlockForm({ ...blockForm, salespersonId: e.target.value })}
                              >
                                <option value="">Select salesperson</option>
                                {usersList
                                  .filter(u => u.role === "salesperson")
                                  .map(sp => (
                                    <option key={sp.id} value={sp.id}>
                                      {sp.name || sp.email || sp.id}
                                    </option>
                                  ))}
                              </select>
                              <input
                                className="border rounded px-2 py-1 text-sm"
                                placeholder="Block title (e.g., Lunch)"
                                value={blockForm.title}
                                onChange={e => setBlockForm({ ...blockForm, title: e.target.value })}
                              />
                            </div>
                            <div className="flex flex-wrap gap-2 text-xs">
                              {days.map(day => {
                                const active = blockForm.days.includes(day);
                                return (
                                  <button
                                    key={day}
                                    className={`px-2 py-1 border rounded ${active ? "bg-gray-100" : ""}`}
                                    onClick={() => toggleBlockDay(day)}
                                  >
                                    {day.slice(0, 3).toUpperCase()}
                                  </button>
                                );
                              })}
                            </div>
                            <div className="flex items-center gap-2 text-sm">
                              <label className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={blockForm.allDay}
                                  onChange={e => setBlockForm({ ...blockForm, allDay: e.target.checked })}
                                />
                                All day
                              </label>
                              <select
                                className="border rounded px-2 py-1 text-sm"
                                value={blockForm.start}
                                disabled={blockForm.allDay}
                                onChange={e => setBlockForm({ ...blockForm, start: e.target.value })}
                              >
                                {timeOptions.map(t => (
                                  <option key={`block-start-${t}`} value={t}>
                                    {formatTimeLabel(t, schedulerForm.timezone)}
                                  </option>
                                ))}
                              </select>
                              <span className="text-xs text-gray-500">to</span>
                              <select
                                className="border rounded px-2 py-1 text-sm"
                                value={blockForm.end}
                                disabled={blockForm.allDay}
                                onChange={e => setBlockForm({ ...blockForm, end: e.target.value })}
                              >
                                {timeOptions.map(t => (
                                  <option key={`block-end-${t}`} value={t}>
                                    {formatTimeLabel(t, schedulerForm.timezone)}
                                  </option>
                                ))}
                              </select>
                              <button className="px-3 py-2 border rounded text-sm" onClick={addAvailabilityBlock}>
                                Add block
                              </button>
                            </div>
                            {blockForm.salespersonId ? (
                              <div className="space-y-2">
                                {(availabilityBlocks[blockForm.salespersonId] ?? []).map(block => (
                                  <div
                                    key={block.id}
                                    className="flex items-center justify-between border rounded px-2 py-1 text-xs"
                                  >
                                    <div className="flex flex-col">
                                      <span className="font-medium">{block.title}</span>
                                      <span className="text-gray-500">
                                        {(block.days ?? [])
                                          .map((d: string) => d.slice(0, 3).toUpperCase())
                                          .join(", ")}
                                        {block.start && block.end ? ` • ${block.start}-${block.end}` : ""}
                                      </span>
                                    </div>
                                    <button
                                      className="px-2 py-1 border rounded text-xs text-red-600"
                                      onClick={() => deleteAvailabilityBlock(blockForm.salespersonId, block.id)}
                                    >
                                      Remove
                                    </button>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="border rounded-lg p-4 space-y-4">
                <div className="text-lg font-semibold">Scheduling</div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs text-gray-500 mb-1">Time zone</div>
                    <select
                      className="border rounded px-3 py-2 text-sm w-full"
                      value={schedulerForm.timezone}
                      onChange={e => setSchedulerForm({ ...schedulerForm, timezone: e.target.value })}
                    >
                      {timeZones.map(tz => (
                        <option key={tz} value={tz}>
                          {tz}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-1">Assignment mode</div>
                    <select
                      className="border rounded px-3 py-2 text-sm w-full"
                      value={schedulerForm.assignmentMode}
                      onChange={e => setSchedulerForm({ ...schedulerForm, assignmentMode: e.target.value })}
                    >
                      <option value="preferred">Preferred order</option>
                      <option value="round_robin">Round robin</option>
                    </select>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-1">Min lead time (hours)</div>
                    <input
                      className="border rounded px-3 py-2 text-sm w-full"
                      value={schedulerForm.minLeadTimeHours}
                      onChange={e => setSchedulerForm({ ...schedulerForm, minLeadTimeHours: e.target.value })}
                    />
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-1">Min gap (minutes)</div>
                    <input
                      className="border rounded px-3 py-2 text-sm w-full"
                      value={schedulerForm.minGapBetweenAppointmentsMinutes}
                      onChange={e =>
                        setSchedulerForm({ ...schedulerForm, minGapBetweenAppointmentsMinutes: e.target.value })
                      }
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs text-gray-500 mb-1">Weekday earliest</div>
                    <input
                      className="border rounded px-3 py-2 text-sm w-full"
                      value={schedulerForm.weekdayEarliest}
                      onChange={e => setSchedulerForm({ ...schedulerForm, weekdayEarliest: e.target.value })}
                    />
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-1">Weekday latest</div>
                    <input
                      className="border rounded px-3 py-2 text-sm w-full"
                      value={schedulerForm.weekdayLatest}
                      onChange={e => setSchedulerForm({ ...schedulerForm, weekdayLatest: e.target.value })}
                    />
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-1">Saturday earliest</div>
                    <input
                      className="border rounded px-3 py-2 text-sm w-full"
                      value={schedulerForm.saturdayEarliest}
                      onChange={e => setSchedulerForm({ ...schedulerForm, saturdayEarliest: e.target.value })}
                    />
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-1">Saturday latest</div>
                    <input
                      className="border rounded px-3 py-2 text-sm w-full"
                      value={schedulerForm.saturdayLatest}
                      onChange={e => setSchedulerForm({ ...schedulerForm, saturdayLatest: e.target.value })}
                    />
                  </div>
                </div>
                {schedulerForm.assignmentMode === "preferred" ? (
                  <div>
                    <div className="text-sm font-medium mb-2">Preferred salesperson order</div>
                    <div className="space-y-2">
                      {preferredOrder
                        .map(id => salespeopleList.find(sp => sp.id === id))
                        .filter(Boolean)
                        .map((sp: any, idx: number) => (
                        <div key={sp.id} className="flex items-center gap-2">
                          <div className="flex-1 border rounded px-3 py-2 text-sm bg-white">
                            {sp.name} <span className="text-xs text-gray-500">({sp.id.slice(0, 6)})</span>
                          </div>
                          <div className="flex flex-col">
                            {idx > 0 ? (
                              <button
                                className="px-2 py-1 border rounded text-xs"
                                type="button"
                                onClick={() => {
                                  const ids = [...preferredOrder];
                                  const i = ids.indexOf(sp.id);
                                  if (i <= 0) return;
                                  [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
                                  setPreferredOrderIds(ids);
                                }}
                              >
                                ↑
                              </button>
                            ) : null}
                            {idx < preferredOrder.length - 1 ? (
                              <button
                                className={`${idx > 0 ? "mt-1 " : ""}px-2 py-1 border rounded text-xs`}
                                type="button"
                                onClick={() => {
                                  const ids = [...preferredOrder];
                                  const i = ids.indexOf(sp.id);
                                  if (i === -1 || i >= ids.length - 1) return;
                                  [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]];
                                  setPreferredOrderIds(ids);
                                }}
                              >
                                ↓
                              </button>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div>
                  <div className="text-sm font-medium mb-2">Appointment types</div>
                  <div className="space-y-2">
                    {appointmentTypesList.map((row, idx) => (
                      <div key={`${row.key}-${idx}`} className="grid grid-cols-2 gap-2 items-center">
                        <input
                          className="border rounded px-2 py-1 text-sm"
                          placeholder="Type key (e.g., inventory_visit)"
                          value={row.key}
                          onChange={e => {
                            const next = [...appointmentTypesList];
                            next[idx] = { ...row, key: e.target.value };
                            setAppointmentTypesList(next);
                          }}
                        />
                        <div className="flex gap-2">
                          <input
                            className="border rounded px-2 py-1 text-sm flex-1"
                            placeholder="Duration (minutes)"
                            value={row.durationMinutes}
                            onChange={e => {
                              const next = [...appointmentTypesList];
                              next[idx] = { ...row, durationMinutes: e.target.value };
                              setAppointmentTypesList(next);
                            }}
                          />
                          <button
                            className="px-2 py-1 border rounded text-xs text-red-600"
                            onClick={() => setAppointmentTypesList(prev => prev.filter((_, i) => i !== idx))}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ))}
                    <div className="flex gap-2 items-center">
                      <select
                        className="border rounded px-2 py-1 text-sm"
                        value={appointmentTypeToAdd}
                        onChange={e => setAppointmentTypeToAdd(e.target.value)}
                      >
                        {availableAppointmentTypes.map(key => (
                          <option key={key} value={key}>
                            {key}
                          </option>
                        ))}
                        <option value="custom">Custom</option>
                      </select>
                      <button
                        className="px-3 py-2 border rounded text-sm"
                        onClick={() => {
                          if (appointmentTypeToAdd === "custom") {
                            setAppointmentTypesList(prev => [...prev, { key: "", durationMinutes: "60" }]);
                            return;
                          }
                          const key = availableAppointmentTypes.includes(appointmentTypeToAdd)
                            ? appointmentTypeToAdd
                            : availableAppointmentTypes[0];
                          if (!key) return;
                          setAppointmentTypesList(prev => [...prev, { key, durationMinutes: "60" }]);
                        }}
                      >
                        Add
                      </button>
                    </div>
                  </div>
                </div>
                <div>
                  <div className="text-sm font-medium mb-2">Business hours</div>
                  <div className="space-y-2">
                    {days.map(day => {
                      const current = schedulerHours?.[day] ?? { open: null, close: null };
                      return (
                        <div key={day} className="grid grid-cols-3 gap-2 items-center text-sm">
                          <div className="capitalize">{day}</div>
                          <select
                            className="border rounded px-2 py-1 text-sm"
                            value={current.open ?? ""}
                            onChange={e => updateHours(setSchedulerHours, day, "open", e.target.value)}
                          >
                            <option value="">Closed</option>
                            {timeOptions.map(t => (
                              <option key={`sched-open-${day}-${t}`} value={t}>
                                {formatTimeLabel(t, schedulerForm.timezone)}
                              </option>
                            ))}
                          </select>
                          <select
                            className="border rounded px-2 py-1 text-sm"
                            value={current.close ?? ""}
                            onChange={e => updateHours(setSchedulerHours, day, "close", e.target.value)}
                          >
                            <option value="">Closed</option>
                            {timeOptions.map(t => (
                              <option key={`sched-close-${day}-${t}`} value={t}>
                                {formatTimeLabel(t, schedulerForm.timezone)}
                              </option>
                            ))}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <button
                    className="px-3 py-2 border rounded text-sm"
                    onClick={saveSchedulerConfig}
                    disabled={settingsSaving}
                  >
                    {settingsSaving ? "Saving…" : "Save Scheduling"}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : section === "contacts" ? (
          selectedContact ? (
            <div className="border rounded-lg p-4 space-y-3 max-w-2xl">
              <div className="flex items-start justify-between gap-4">
                <div className="text-lg font-semibold flex items-center gap-2">
                  <span>
                    {selectedContact.name ||
                      [selectedContact.firstName, selectedContact.lastName].filter(Boolean).join(" ") ||
                      selectedContact.phone ||
                      selectedContact.email ||
                      "Unknown"}
                  </span>
                  <span className="text-xs px-2 py-1 rounded border">
                    {selectedContact.status ?? "active"}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {selectedContact.conversationId || selectedContact.leadKey ? (
                    <button
                      className="px-2 py-1 border rounded text-xs"
                      title="Open chat"
                      onClick={() => {
                        setSection("inbox");
                        const id = selectedContact.conversationId ?? selectedContact.leadKey ?? null;
                        if (id) setSelectedId(id);
                      }}
                    >
                      💬
                    </button>
                  ) : null}
                  <button
                    className="px-2 py-1 border rounded text-xs"
                    onClick={() => setContactEdit(v => !v)}
                    title={contactEdit ? "Cancel edit" : "Edit contact"}
                  >
                    ✏️
                  </button>
                  <button
                    className="px-2 py-1 border rounded text-xs text-red-600 border-red-200 hover:bg-red-50"
                    onClick={deleteContact}
                    title="Delete contact"
                  >
                    🗑️
                  </button>
                </div>
              </div>

              {selectedContact.vehicleDescription ? (
                <div className="text-sm text-gray-600">{selectedContact.vehicleDescription}</div>
              ) : null}

              {contactEdit ? (
                <div className="grid grid-cols-2 gap-3">
                  <input
                    className="border rounded px-3 py-2 text-sm"
                    placeholder="First name"
                    value={contactForm.firstName}
                    onChange={e => setContactForm({ ...contactForm, firstName: e.target.value })}
                  />
                  <input
                    className="border rounded px-3 py-2 text-sm"
                    placeholder="Last name"
                    value={contactForm.lastName}
                    onChange={e => setContactForm({ ...contactForm, lastName: e.target.value })}
                  />
                  <input
                    className="border rounded px-3 py-2 text-sm"
                    placeholder="Display name"
                    value={contactForm.name}
                    onChange={e => setContactForm({ ...contactForm, name: e.target.value })}
                  />
                  <input
                    className="border rounded px-3 py-2 text-sm"
                    placeholder="Phone"
                    value={contactForm.phone}
                    onChange={e => setContactForm({ ...contactForm, phone: e.target.value })}
                  />
                  <input
                    className="border rounded px-3 py-2 text-sm col-span-2"
                    placeholder="Email"
                    value={contactForm.email}
                    onChange={e => setContactForm({ ...contactForm, email: e.target.value })}
                  />
                  <div className="col-span-2">
                    <button className="px-3 py-2 border rounded text-sm" onClick={saveContact}>
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="text-sm">
                    {selectedContact.phone ? `Phone: ${selectedContact.phone}` : "Phone: —"}
                  </div>
                  <div className="text-sm">
                    {selectedContact.email ? `Email: ${selectedContact.email}` : "Email: —"}
                  </div>
                  {selectedContact.leadSource ||
                  selectedContact.leadRef ||
                  selectedContact.vehicleDescription ||
                  selectedContact.stockId ||
                  selectedContact.vin ||
                  selectedContact.year ||
                  selectedContact.inquiry ? (
                    <div className="mt-3 border rounded-lg p-3 text-sm bg-gray-50">
                      <div className="font-medium text-gray-800">WEB LEAD (ADF)</div>
                      <div className="mt-2 space-y-1 text-gray-700">
                        <div>
                          Source: {selectedContact.leadSource ?? "unknown"}
                        </div>
                        {selectedContact.leadRef ? <div>Ref: {selectedContact.leadRef}</div> : null}
                        <div>
                          Name:{" "}
                          {selectedContact.name ||
                            [selectedContact.firstName, selectedContact.lastName].filter(Boolean).join(" ") ||
                            "Unknown"}
                        </div>
                        <div>Email: {selectedContact.email ?? "—"}</div>
                        <div>Phone: {selectedContact.phone ?? "—"}</div>
                        {selectedContact.stockId ? <div>Stock: {selectedContact.stockId}</div> : null}
                        {selectedContact.vin ? <div>VIN: {selectedContact.vin}</div> : null}
                        {selectedContact.year ? <div>Year: {selectedContact.year}</div> : null}
                        {selectedContact.vehicleDescription || selectedContact.vehicle ? (
                          <div>
                            Vehicle: {selectedContact.vehicleDescription ?? selectedContact.vehicle}
                          </div>
                        ) : null}
                        {selectedContact.inquiry ? (
                          <div className="pt-2">
                            <div className="text-gray-600">Inquiry:</div>
                            <div className="whitespace-pre-wrap">{selectedContact.inquiry}</div>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </>
              )}

            </div>
          ) : (
            <div className="text-gray-500">Select a contact to view details.</div>
          )
        ) : !canViewConversation ? (
          <div className="text-gray-500">Select “Inbox” to view a conversation.</div>
        ) : !selectedId ? (
          <div className="text-gray-500">Select a conversation to view details.</div>
        ) : detailLoading ? (
          <div className="text-gray-500">Loading…</div>
        ) : selectedConv ? (
          <div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-2xl font-semibold flex items-center gap-2">
                  <span>{selectedConv.leadKey}</span>
                  {selectedConv.contactPreference === "call_only" ? (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-200">
                      Call Only
                    </span>
                  ) : null}
                </div>
                {selectedConv.lead?.leadRef ? (
                  <div className="text-xs text-gray-500 mt-1">Lead Ref: {selectedConv.lead.leadRef}</div>
                ) : null}
                <div className="text-xs text-gray-500 mt-1">
                  {selectedConv.status === "closed" && selectedConv.closedAt
                    ? `closed: ${new Date(selectedConv.closedAt).toLocaleString()}`
                    : "active"}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {(authUser?.phone || authUser?.extension) ? (
                  <div className="flex items-center gap-2">
                    <button
                      className={`px-2 py-1 border rounded text-sm cursor-pointer ${callBusy ? "opacity-60" : "hover:bg-gray-50"}`}
                      onClick={() => {
                        if (authUser?.phone && authUser?.extension) {
                          setCallPickerOpen(true);
                          return;
                        }
                        if (authUser?.extension && !authUser?.phone) {
                          startCall("extension");
                          return;
                        }
                        startCall("cell");
                      }}
                      disabled={callBusy}
                      title="Call customer"
                    >
                      <span className="mr-1">📞</span>
                      Call
                    </button>
                  </div>
                ) : null}
                {(authUser?.role === "manager" || authUser?.permissions?.canToggleHumanOverride) ? (
                  <button
                    className={`px-2 py-1 border rounded text-sm cursor-pointer ${selectedConv.mode === "human" ? "font-semibold bg-black text-white" : "hover:bg-gray-50"}`}
                    onClick={() => setHumanMode(selectedConv.mode === "human" ? "suggest" : "human")}
                    title={selectedConv.mode === "human" ? "Disable human override" : "Human takeover"}
                  >
                    <span className="mr-1">👤</span>
                  </button>
                ) : null}
                {(authUser?.role === "manager" || authUser?.permissions?.canAccessTodos) ? (
                  <button
                    className="px-2 py-1 border rounded text-sm"
                    onClick={async () => {
                      const text = window.prompt("Internal question for this conversation:");
                      if (!text || !selectedConv) return;
                      await createQuestion(selectedConv.id, text.trim());
                    }}
                    title="Create internal question"
                  >
                    Ask
                  </button>
                ) : null}
                {modeSaving ? <span className="text-xs text-gray-500">Saving…</span> : null}
              </div>
            </div>
            {modeError ? <div className="text-xs text-red-600 mt-1">{modeError}</div> : null}

            {callPickerOpen ? (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
                <div className="w-80 rounded-lg bg-white shadow-lg border p-4">
                  <div className="text-sm font-semibold">Place call with</div>
                  <div className="mt-3 flex gap-2">
                    {authUser?.phone ? (
                      <button
                        className="flex-1 px-3 py-2 rounded border hover:bg-gray-50 text-sm"
                        disabled={callBusy}
                        onClick={() => {
                          setCallMethod("cell");
                          setCallPickerOpen(false);
                          startCall("cell");
                        }}
                      >
                        Cell
                      </button>
                    ) : null}
                    {authUser?.extension ? (
                      <button
                        className="flex-1 px-3 py-2 rounded border hover:bg-gray-50 text-sm"
                        disabled={callBusy}
                        onClick={() => {
                          setCallMethod("extension");
                          setCallPickerOpen(false);
                          startCall("extension");
                        }}
                      >
                        Extension
                      </button>
                    ) : null}
                  </div>
                  <div className="mt-3 text-right">
                    <button
                      className="text-xs text-gray-500 hover:text-gray-700"
                      onClick={() => setCallPickerOpen(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {pendingDraft ? (
              <div className="mt-4 border rounded-lg p-3 text-sm">
                <div className="font-medium">Draft ready to send</div>
                <div className="text-gray-600 mt-1">
                  The reply box below is prefilled. Edit if needed, then hit Send.
                </div>
              </div>
            ) : null}

            <div className="mt-6 border rounded-lg p-4 space-y-3">
              <div className="flex items-center gap-2 mb-2">
                <button
                  className={`px-2 py-1 border rounded text-xs ${messageFilter === "sms" ? "font-semibold bg-gray-100" : ""}`}
                  onClick={() => setMessageFilter("sms")}
                >
                  SMS
                </button>
                <button
                  className={`px-2 py-1 border rounded text-xs ${messageFilter === "email" ? "font-semibold bg-gray-100" : ""}`}
                  onClick={() => setMessageFilter("email")}
                >
                  Email
                </button>
                <button
                  className={`px-2 py-1 border rounded text-xs ${messageFilter === "calls" ? "font-semibold bg-gray-100" : ""}`}
                  onClick={() => setMessageFilter("calls")}
                >
                  Calls
                </button>
              </div>
              {messageFilter === "sms" && selectedConv.contactPreference === "call_only" ? (
                <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
                  Call only — SMS disabled.
                  <button
                    className="ml-2 underline"
                    onClick={clearContactPreference}
                  >
                    Allow SMS
                  </button>
                </div>
              ) : null}
              {selectedConv.messages
                .filter(m => m.draftStatus !== "stale")
                .filter(m => {
                  const provider = m.provider ?? "";
                  const isEmail = provider === "sendgrid";
                  const isCall = provider === "voice_call" || provider === "voice_transcript";
                  const isSms =
                    provider === "twilio" ||
                    provider === "human" ||
                    provider === "draft_ai" ||
                    provider === "sendgrid_adf";
                  if (messageFilter === "email") return isEmail;
                  if (messageFilter === "calls") return isCall;
                  return isSms;
                })
                .map(m => {
                  const isPending = pendingDraft?.id === m.id;
                  const providerLabel =
                    m.provider === "voice_call"
                      ? "call"
                      : m.provider === "voice_transcript"
                        ? "call transcript"
                        : (m.provider ?? "?");
                  return (
                    <div key={m.id} className={`text-sm ${m.direction === "in" ? "" : "text-right"}`}>
                      <div className="text-xs text-gray-500">
                        {m.direction.toUpperCase()} • {providerLabel} •{" "}
                        {new Date(m.at).toLocaleString()}
                        {isPending ? " • DRAFT (not sent)" : ""}
                      </div>
                      <div
                        className={`inline-block mt-1 px-3 py-2 rounded-2xl border max-w-[85%] whitespace-pre-wrap text-base font-medium ${
                          m.direction === "in"
                            ? "bg-gray-100 text-gray-900 border-gray-200"
                            : "bg-blue-600 text-white border-blue-600"
                        }`}
                      >
                        {renderMessageBody(m.body)}
                      </div>
                      {m.direction === "in" &&
                      (m.provider === "sendgrid_adf" || /web lead \\(adf\\)/i.test(m.body || "")) ? (
                        <div className="mt-1">
                          <a
                            className="text-xs text-blue-600 underline"
                            href={`/lead/${encodeURIComponent(selectedConv.id)}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View lead
                          </a>
                        </div>
                      ) : null}
                      {m.mediaUrls && m.mediaUrls.length ? (
                        <div
                          className={`mt-2 flex flex-wrap gap-2 ${m.direction === "in" ? "" : "justify-end"}`}
                        >
                          {m.mediaUrls.map(url => (
                            <img
                              key={url}
                              src={url}
                              alt="MMS attachment"
                              className="max-w-[240px] rounded border"
                              loading="lazy"
                            />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
            </div>

            <div className="mt-6 flex gap-2 items-start">
              <textarea
                ref={sendBoxRef}
                value={displaySendBody}
                onChange={e => {
                  if (messageFilter === "calls") return;
                  setSendBody(e.target.value);
                  setSendBodySource("user");
                }}
                onInput={e => {
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = `${el.scrollHeight}px`;
                }}
                rows={1}
                className={`flex-1 border rounded px-3 py-3.5 min-h-[60px] resize-none leading-7 overflow-hidden box-border ${
                  messageFilter === "calls" ? "bg-gray-50 text-gray-500" : ""
                }`}
                placeholder={
                  messageFilter === "calls"
                    ? "Calls view only."
                    : pendingDraft
                      ? "Edit draft then Send…"
                      : "Type a message…"
                }
                disabled={messageFilter === "calls"}
              />
              <button
                className={`px-4 py-2 border rounded ${
                  messageFilter === "calls" || (messageFilter === "sms" && selectedConv.contactPreference === "call_only")
                    ? "opacity-50 cursor-not-allowed"
                    : ""
                }`}
                onClick={send}
                disabled={messageFilter === "calls" || (messageFilter === "sms" && selectedConv.contactPreference === "call_only")}
              >
                Send
              </button>
            </div>

            {editPromptOpen && pendingSend ? (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
                <div className="bg-white rounded-lg shadow-lg w-full max-w-md p-4">
                  <div className="text-sm font-medium">Quick note for tuning (optional)</div>
                  <div className="text-xs text-gray-500 mt-1">
                    What should the agent do differently next time?
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {[
                      "Too long",
                      "Wrong tone",
                      "Missing info",
                      "Wrong facts",
                      "Too pushy",
                      "Other"
                    ].map(tag => (
                      <button
                        key={tag}
                        className="px-2 py-1 border rounded text-xs"
                        onClick={() =>
                          setEditNote(prev => (prev ? `${prev}; ${tag}` : tag))
                        }
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                  <textarea
                    className="mt-3 w-full border rounded px-3 py-2 text-sm"
                    rows={3}
                    placeholder="Optional note…"
                    value={editNote}
                    onChange={e => setEditNote(e.target.value)}
                  />
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      className="px-3 py-2 border rounded text-sm"
                      onClick={() => {
                        setEditPromptOpen(false);
                        setPendingSend(null);
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      className="px-3 py-2 border rounded text-sm"
                      onClick={async () => {
                        const note = editNote.trim();
                        const payload = pendingSend.draftId
                          ? { ...pendingSend, editNote: note }
                          : { body: pendingSend.body, editNote: note };
                        setEditPromptOpen(false);
                        setPendingSend(null);
                        await doSend(payload);
                      }}
                    >
                      Send
                    </button>
                    <button
                      className="px-3 py-2 border rounded text-sm text-gray-600"
                      onClick={async () => {
                        const payload = pendingSend.draftId
                          ? pendingSend
                          : { body: pendingSend.body };
                        setEditPromptOpen(false);
                        setPendingSend(null);
                        await doSend(payload);
                      }}
                    >
                      Skip note
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {selectedConv.status !== "closed" ? (
              <div className="mt-4 flex items-center gap-2">
                <select
                  className="border rounded px-2 py-2 text-sm"
                  value={closeReason}
                  onChange={e => setCloseReason(e.target.value)}
                >
                  <option value="sold">Sold</option>
                  <option value="not_interested">Not interested</option>
                  <option value="no_response">No response</option>
                  <option value="other">Other</option>
                </select>
                <button className="px-3 py-2 border rounded text-sm" onClick={closeConv}>
                  Mark Closed
                </button>
                <button
                  className="px-3 py-2 border rounded text-sm text-red-600 border-red-200 hover:bg-red-50"
                  onClick={deleteConv}
                >
                  Delete
                </button>
              </div>
            ) : (
              <div className="mt-4 flex items-center gap-2">
                <button
                  className="px-3 py-2 border rounded text-sm text-red-600 border-red-200 hover:bg-red-50"
                  onClick={deleteConv}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="text-gray-500">Conversation not found.</div>
        )}
      </section>

      {todoPromptOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-white rounded-lg shadow-lg w-full max-w-md p-4">
            <div className="text-sm font-medium">Create to-do</div>
            <div className="text-xs text-gray-500 mt-1">
              What should the salesperson do?
            </div>
            <textarea
              className="mt-3 w-full border rounded px-3 py-2 text-sm"
              rows={3}
              value={todoPromptText}
              onChange={e => setTodoPromptText(e.target.value)}
              placeholder="e.g., Call customer about trade appraisal"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                className="px-3 py-2 border rounded text-sm"
                onClick={() => {
                  setTodoPromptOpen(false);
                  setTodoPromptConvId(null);
                  setTodoPromptText("");
                }}
              >
                Cancel
              </button>
              <button
                className="px-3 py-2 border rounded text-sm"
                onClick={submitTodoPrompt}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
