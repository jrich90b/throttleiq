import React from "react";
import Image from "next/image";
import { SideNavIcon } from "./UiIcon";
import { dueBucketFor, relativeDueLabel, taskEffectiveDueMs } from "../lib/taskTriage";
import { salesCriticalKind, SALES_REASON_META } from "../lib/taskReason";

// Turn a stored close reason ("not_interested", "wrong_number", free text) into
// a short human label for the Closed badge, so "Closed" always says WHY.
function humanizeClosedReason(reason: unknown): string {
  const raw = String(reason ?? "").trim();
  if (!raw) return "";
  const known: Record<string, string> = {
    sold: "Sold",
    not_interested: "Not interested",
    no_response: "No response",
    wrong_number: "Wrong number",
    opt_out: "Opted out",
    archive: "Archived",
    hold: "On hold",
    other: ""
  };
  const key = raw.toLowerCase().replace(/[\s-]+/g, "_");
  if (key in known) return known[key];
  const pretty = raw.replace(/_/g, " ").trim();
  if (!pretty) return "";
  const capped = pretty.charAt(0).toUpperCase() + pretty.slice(1);
  return capped.length > 24 ? `${capped.slice(0, 21)}…` : capped;
}

export function InboxSection(props: any) {
  const {
    view,
    setView,
    filteredConversations,
    openCompose,
    inboxQuery,
    setInboxQuery,
    isManager,
    canFilterOwners,
    inboxOwnerFilter,
    setInboxOwnerFilter,
    managerLeadOwnerOptions,
    inboxDealCounts,
    inboxDealFilter,
    setInboxDealFilter,
    inboxTaskCounts,
    inboxTaskFilter,
    setInboxTaskFilter,
    getInboxDealFilterButtonClass,
    groupedConversations,
    campaignInboxExpanded,
    setCampaignInboxExpanded,
    selectedId,
    openConversation,
    getDealTemperature,
    renderDealTemperatureIcon,
    setHumanModeForId,
    listActionsOpenId,
    setListActionsOpenId,
    todoInlineOpenId,
    setTodoInlineOpenId,
    todoInlineTarget,
    setTodoInlineTarget,
    reassignSalesOwnerOptions,
    todoInlineText,
    setTodoInlineText,
    submitTodoInline,
    reminderInlineOpenId,
    setReminderInlineOpenId,
    reminderInlineTarget,
    setReminderInlineTarget,
    reminderInlineText,
    setReminderInlineText,
    reminderInlineDueAt,
    setReminderInlineDueAt,
    reminderInlineLeadMinutes,
    setReminderInlineLeadMinutes,
    reminderInlineSaving,
    submitReminderInline,
    contactInlineOpenId,
    setContactInlineOpenId,
    findLinkedContactForConversation,
    contactInlineForm,
    setContactInlineForm,
    contactInlineSaving,
    submitInlineContact,
    reassignInlineOpenId,
    setReassignInlineOpenId,
    reassignInlineTarget,
    setReassignInlineTarget,
    reassignInlineSummary,
    setReassignInlineSummary,
    reassignInlineSaving,
    reassignLeadInline,
    openInlineContactFromConversation,
    openReassignLeadInline,
    authUser,
    deleteConvFromList,
    inboxTodoOwnerByConv,
    openTasksByConv,
    todoTaskTitle,
    todoTaskOwnerLabel,
    taskTriageCounts,
    onOpenTaskInbox,
    renderBookingLinkLine,
    openOutcomeFromInbox,
    loading
  } = props;
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const triage = taskTriageCounts ?? { overdue: 0, today: 0, attention: 0 };

  const isSoldConversation = (conversation: any) => {
    const status = String(conversation?.status ?? "").trim().toLowerCase();
    const closedReason = String(conversation?.closedReason ?? "").trim().toLowerCase();
    const soldByReason = closedReason === "sold" || /\bsold\b/.test(closedReason);
    const soldByCadence =
      String(conversation?.followUpCadence?.kind ?? "").trim().toLowerCase() === "post_sale";
    return !!conversation?.sale?.soldAt || soldByCadence || (status === "closed" && soldByReason);
  };

  const isPhoneLogConversation = (conversation: any) => {
    const lead = conversation?.lead ?? {};
    if (conversation?.phoneLog === true) return true;
    if (lead?.phoneLog === true || String(lead?.sourceType ?? "").trim().toLowerCase() === "phone_log") {
      return true;
    }
    const source = String(lead?.source ?? conversation?.leadSource ?? "").trim();
    if (!/traffic\s*log\s*pro/i.test(source)) return false;
    const body = [
      lead?.inquiry,
      lead?.walkInComment,
      conversation?.lastMessage?.body,
      ...(Array.isArray(conversation?.messages) ? conversation.messages.map((m: any) => m?.body) : [])
    ]
      .filter(Boolean)
      .join(" ");
    return /\b(called|customer\s+called|phone\s+call|call\s+log|spoke\s+(to|with)|talked\s+(to|with)|voicemail)\b/i.test(
      body
    );
  };

  const getInboxVehicleLine = (conversation: any) => {
    const fallback = String(conversation?.vehicleDescription ?? "").trim();
    if (!isSoldConversation(conversation)) return fallback;
    const sale = conversation?.sale ?? {};
    const soldLabel = String(sale?.label ?? "").trim();
    if (soldLabel) return soldLabel;
    const soldParts = [sale?.year, sale?.make, sale?.model, sale?.trim]
      .map((v: unknown) => String(v ?? "").trim())
      .filter(Boolean);
    if (soldParts.length) {
      const color = String(sale?.color ?? "").trim();
      return color ? `${soldParts.join(" ")} (${color})` : soldParts.join(" ");
    }
    const stockId = String(sale?.stockId ?? "").trim();
    if (stockId) return stockId;
    const vin = String(sale?.vin ?? "").trim();
    if (vin) return vin;
    return fallback;
  };

  const isEmojiOnlyAckText = (text: string) => {
    const t = String(text ?? "").trim();
    return t.length > 0 && /^[\p{Extended_Pictographic}\s]+$/u.test(t);
  };

  const isShortAckNoActionText = (text: string) => {
    const t = String(text ?? "").trim().toLowerCase();
    if (!t) return false;
    if (isEmojiOnlyAckText(t)) return true;
    if (t.length > 60) return false;
    if (/[?]/.test(t)) return false;
    if (
      /\b(price|pricing|payment|monthly|apr|term|down payment|trade|trade in|service|parts|apparel|available|availability|in stock|stock|test ride|appointment|schedule|call|video|photos?|email|watch)\b/i.test(
        t
      )
    ) {
      return false;
    }
    return /\b(thanks|thank you|thanks again|thx|ty|appreciate|got it|sounds good|sounds great|will do|ok|okay|k|kk|cool|perfect|great|all good|no problem|you bet|yep|yup|sure)\b/.test(
      t
    );
  };

  const needsCustomerResponse = (conversation: any) => {
    if (conversation?.status === "closed") return false;
    if (conversation?.pendingDraft) return true;
    const lastMessage = conversation?.lastMessage;
    if (lastMessage?.direction !== "in") return false;
    return !isShortAckNoActionText(lastMessage?.body ?? "");
  };

  const isCampaignReplyConversation = (conversation: any) => {
    const status = String(conversation?.campaignThread?.status ?? "").trim().toLowerCase();
    if (status !== "linked_open" && status !== "passed") return false;
    const lastMessage = conversation?.lastMessage;
    return (
      lastMessage?.direction === "in" &&
      String(lastMessage?.provider ?? "").trim().toLowerCase() !== "sendgrid_adf" &&
      !isShortAckNoActionText(lastMessage?.body ?? "")
    );
  };

  const hasOutcomeReminderSent = (conversation: any) => {
    if (String(conversation?.status ?? "").trim().toLowerCase() === "closed") return false;
    const notify = conversation?.appointment?.staffNotify ?? null;
    if (!notify?.followUpSentAt) return false;
    if (notify?.outcome) return false;
    return true;
  };

  const isDealerRideOutcomeTodo = (todo: any): boolean => {
    return (
      String(todo?.sourceMessageId ?? "").startsWith("dealer_ride_outcome:") ||
      /\bdealer ride outcome needed\b/i.test(String(todo?.summary ?? ""))
    );
  };

  return (
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
            className={`px-3 py-2 border border-[var(--border)] rounded cursor-pointer ${view === "campaigns" ? "font-semibold bg-[var(--accent)] text-white border-[var(--accent)]" : "hover:bg-[var(--surface-2)]"}`}
            onClick={() => setView("campaigns")}
          >
            Campaigns
          </button>
          <button
            className={`px-3 py-2 border border-[var(--border)] rounded cursor-pointer ${view === "archive" ? "font-semibold bg-[var(--accent)] text-white border-[var(--accent)]" : "hover:bg-[var(--surface-2)]"}`}
            onClick={() => setView("archive")}
          >
            Archive
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="h-9 w-9 inline-flex items-center justify-center border-2 border-[var(--accent)] text-[var(--accent)] rounded hover:bg-[var(--surface-2)]"
            onClick={openCompose}
            title="Compose SMS"
            aria-label="Compose SMS"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 5a2 2 0 0 1 2-2h8.5" />
              <path d="M4 5v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9.5" />
              <path d="m9 15.1 1.4 3.1 3.1-1.4 6.2-6.2a2 2 0 0 0-2.8-2.8l-6.2 6.2Z" />
              <path d="m15.8 8.6 2.8 2.8" />
            </svg>
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-2 md:flex-row">
        <input
          className="w-full border rounded px-3 py-2 text-sm"
          placeholder="Search name or phone..."
          value={inboxQuery}
          onChange={e => setInboxQuery(e.target.value)}
        />
        {canFilterOwners ? (
          <select
            className="w-28 self-start border rounded px-3 py-2 text-sm bg-white md:w-28"
            value={inboxOwnerFilter}
            onChange={e => setInboxOwnerFilter(e.target.value)}
            title="Filter inbox by owner"
          >
            <option value="all">Owners</option>
            {managerLeadOwnerOptions.length ? (
              <optgroup label="Salespeople">
                {managerLeadOwnerOptions.map((name: string) => (
                  <option key={`inbox-owner-${name}`} value={`owner:${encodeURIComponent(name)}`}>
                    {name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            <optgroup label="Departments">
              <option value="team:sales">Sales (Lead Owner)</option>
              <option value="team:service">Service (Department)</option>
              <option value="team:parts">Parts (Department)</option>
              <option value="team:apparel">Apparel (Department)</option>
            </optgroup>
            <option value="team:unassigned">Unassigned</option>
          </select>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-600 w-16 shrink-0">Deal status</span>
        {([
          { key: "all" as const, label: "All", title: "Every conversation in this view" },
          {
            key: "active" as const,
            label: `Active (${inboxDealCounts.active})`,
            title: "Deals still in play — not sold, not on hold"
          },
          {
            key: "hot" as const,
            label: `Hot (${inboxDealCounts.hot})`,
            title: "Engaged recently with real buying signals"
          },
          {
            key: "hold" as const,
            label: `On hold (${inboxDealCounts.hold})`,
            title: "Deposit down or bike on order — follow-ups paused"
          },
          {
            key: "sold" as const,
            label: `Sold (${inboxDealCounts.sold})`,
            title: "Customer bought — don't send them sales promotions"
          }
        ] as Array<{ key: "all" | "active" | "hot" | "sold" | "hold"; label: string; title: string }>).map(option => (
          <button
            key={`inbox-deal-filter-${option.key}`}
            className={getInboxDealFilterButtonClass(inboxDealFilter === option.key)}
            onClick={() => setInboxDealFilter(option.key)}
            title={option.title}
            aria-pressed={inboxDealFilter === option.key}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-600 w-16 shrink-0">Tasks</span>
        {([
          { key: "all" as const, label: "All", title: "Don't filter by tasks" },
          {
            key: "open_task" as const,
            label: `Has open task (${inboxTaskCounts.openTask})`,
            title: "Customers with something still to do — call, follow-up, appointment"
          },
          {
            key: "overdue" as const,
            label: `Overdue (${inboxTaskCounts.overdue})`,
            title: "Customers with a task past its due time"
          },
          {
            key: "no_task" as const,
            label: `No open tasks (${inboxTaskCounts.noTask})`,
            title: "Customers with nothing pending"
          }
        ] as Array<{ key: "all" | "open_task" | "overdue" | "no_task"; label: string; title: string }>).map(option => (
          <button
            key={`inbox-task-filter-${option.key}`}
            className={getInboxDealFilterButtonClass(inboxTaskFilter === option.key)}
            onClick={() => setInboxTaskFilter(option.key)}
            title={option.title}
            aria-pressed={inboxTaskFilter === option.key}
          >
            {option.label}
          </button>
        ))}
      </div>

      {view === "inbox" && triage.attention > 0 ? (
        <button
          type="button"
          className="lr-inbox-today-strip"
          onClick={() => onOpenTaskInbox?.()}
          title="Open the Task Inbox"
        >
          <span className="lr-inbox-today-strip-main">
            <span aria-hidden className="inline-flex">
              <SideNavIcon name="bell" className="w-4 h-4" />
            </span>
            <span className="lr-inbox-today-strip-count">
              {triage.attention} {triage.attention === 1 ? "task needs" : "tasks need"} you today
            </span>
            <span className="lr-inbox-today-strip-detail">
              {triage.overdue > 0 ? `${triage.overdue} overdue` : ""}
              {triage.overdue > 0 && triage.today > 0 ? " · " : ""}
              {triage.today > 0 ? `${triage.today} due today` : ""}
            </span>
          </span>
          <span className="lr-inbox-today-strip-cta">Review →</span>
        </button>
      ) : null}

      <div className="mt-3 space-y-3">
        {groupedConversations.map((group: any) => {
          const expanded = group.isCampaignGroup ? (campaignInboxExpanded[group.key] ?? true) : true;
          return (
            <div key={group.key}>
              {group.isCampaignGroup ? (
                <button
                  className="w-full px-1 pb-1 lr-section-label border-b border-[var(--border)] flex items-center justify-between gap-2"
                  onClick={() =>
                    setCampaignInboxExpanded((prev: Record<string, boolean>) => ({
                      ...prev,
                      [group.key]: !expanded
                    }))
                  }
                >
                  <span className="truncate text-left">{group.label}</span>
                  <span className="shrink-0">
                    {group.items.length} {group.items.length === 1 ? "lead" : "leads"} {expanded ? "▾" : "▸"}
                  </span>
                </button>
              ) : (
                <div className="px-1 pb-1 lr-section-label border-b border-[var(--border)]">
                  {group.label}
                </div>
              )}
              {expanded ? (
                <div className="mt-2 border border-[var(--border)] rounded-lg divide-y bg-[var(--surface)] lr-app-list-surface">
                  {group.items.map((c: any) => {
                    const campaignThreadStatus = String(c.campaignThread?.status ?? "")
                      .trim()
                      .toLowerCase();
                    const linkedOpenCampaign = view === "campaigns" && campaignThreadStatus === "linked_open";
                    const campaignReply = isCampaignReplyConversation(c);
                    // In the main Inbox, a thread that was texted by a campaign but hasn't replied yet
                    // gets a quiet "Campaign sent" tag (it no longer jumps to the top — see
                    // inboxActivityAt). Once they reply it becomes the green "Campaign reply" instead.
                    const campaignSent =
                      view === "inbox" &&
                      (campaignThreadStatus === "campaign" ||
                        campaignThreadStatus === "linked_open" ||
                        campaignThreadStatus === "passed") &&
                      !campaignReply;
                    const needsResponse = needsCustomerResponse(c);
                    const openTasks = openTasksByConv?.get(c.id) ?? [];
                    const primaryOpenTask = openTasks[0] ?? null;
                    const openTaskTitle = primaryOpenTask
                      ? (todoTaskTitle?.(primaryOpenTask) ?? "Open task")
                      : "";
                    const openTaskOwner = primaryOpenTask
                      ? (todoTaskOwnerLabel?.(primaryOpenTask) ?? "")
                      : "";
                    // The most time-urgent task drives the row's due chip (color +
                    // relative time), so overdue work is obvious from the list.
                    const chipTask = (() => {
                      let best: any = null;
                      let bestRank = 99;
                      let bestMs = Number.POSITIVE_INFINITY;
                      for (const t of openTasks) {
                        const b = dueBucketFor(t, nowMs);
                        const rank =
                          b === "overdue" ? 0 : b === "today" ? 1 : b === "this_week" ? 2 : b === "later" ? 3 : 4;
                        const ms = taskEffectiveDueMs(t) ?? Number.POSITIVE_INFINITY;
                        if (rank < bestRank || (rank === bestRank && ms < bestMs)) {
                          best = t;
                          bestRank = rank;
                          bestMs = ms;
                        }
                      }
                      return best;
                    })();
                    const chipBucket = chipTask ? dueBucketFor(chipTask, nowMs) : null;
                    const chipDueMs = chipTask ? taskEffectiveDueMs(chipTask) : null;
                    const chipRel = chipDueMs != null ? relativeDueLabel(chipDueMs, nowMs) : null;
                    const chipTitle = chipTask ? (todoTaskTitle?.(chipTask) ?? "Open task") : "";
                    const chipText =
                      chipBucket === "overdue"
                        ? `Overdue: ${chipTitle}${chipRel ? ` · ${chipRel}` : ""}`
                        : chipBucket === "today"
                          ? `${chipTitle}${chipRel ? ` · ${chipRel}` : ""}`
                          : chipRel
                            ? `${chipTitle} · ${chipRel}`
                            : chipTitle;
                    // Money tasks (pricing/financing/availability) color the chip by
                    // reason so the buy signal shows in the inbox, not just the due time.
                    const chipSalesKind = chipTask ? salesCriticalKind(chipTask) : null;
                    const chipReasonMeta = chipSalesKind ? SALES_REASON_META[chipSalesKind] : null;
                    const chipVariant = chipReasonMeta
                      ? `reason-${chipReasonMeta.variant}`
                      : (chipBucket ?? "no_date");
                    const chipIcon = chipReasonMeta ? chipReasonMeta.icon : "clock";
                    const chipDisplay = chipReasonMeta
                      ? `${chipBucket === "overdue" ? "Overdue: " : ""}${chipReasonMeta.label}${chipRel ? ` · ${chipRel}` : ""}`
                      : chipText;
                    const dealerRideOutcomeNeeded = openTasks.some(
                      (t: any) => isDealerRideOutcomeTodo(t) && !String(t?.dealerRideOutcomeStatus ?? "").trim()
                    );
                    const dealerRideOutcomeTodo = dealerRideOutcomeNeeded
                      ? openTasks.find(
                          (t: any) =>
                            isDealerRideOutcomeTodo(t) && !String(t?.dealerRideOutcomeStatus ?? "").trim()
                        ) ?? null
                      : null;
                    const outcomeNeeded = hasOutcomeReminderSent(c) || dealerRideOutcomeNeeded;
                    const outcomeNeededTitle = dealerRideOutcomeNeeded
                      ? "Demo ride outcome needed"
                      : "Outcome reminder SMS sent to salesperson";
                    const outcomeNeededKind = dealerRideOutcomeNeeded ? "dealer_ride" : "appointment";
                    const inboxOwner = c.leadOwner?.name || c.leadOwner?.id || inboxTodoOwnerByConv.get(c.id);
                    const updatedLabel =
                      c.status === "closed" && c.closedAt
                        ? `closed: ${new Date(c.closedAt).toLocaleString()}`
                        : `updated: ${new Date(c.updatedAt).toLocaleString()}`;
                    return (
                      <div key={c.id} className="flex items-stretch">
                        <button
                          onClick={() => openConversation(c.id)}
                          className={`lr-inbox-row flex-1 min-w-0 text-left p-4 transition-colors hover:bg-[var(--surface-hover)] focus-visible:bg-[var(--surface-hover)] ${
                            linkedOpenCampaign ? "bg-gray-50/70 opacity-70" : ""
                          } ${selectedId === c.id ? "bg-[var(--accent-tint)]" : ""}`}
                        >
                          <div className="lr-inbox-row-main">
                            <div className="min-w-0">
                              <div className="flex items-start gap-2">
                                {needsResponse ? (
                                  <span
                                    className="lr-response-needed-dot mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
                                    title="Needs response"
                                    aria-label="Needs response"
                                  />
                                ) : null}
                                <div
                                  className="min-w-0 flex-1 font-medium text-gray-900 whitespace-normal break-words line-clamp-2"
                                  title={c.leadName && c.leadName.length > 0 ? c.leadName : c.leadKey}
                                >
                                  {c.leadName && c.leadName.length > 0 ? c.leadName : c.leadKey}
                                </div>
                              </div>
                              <div className="lr-inbox-badge-row">
                                {c.walkIn && !isPhoneLogConversation(c) ? (
                                  <span
                                    className="lr-inbox-icon-pill text-[var(--status-info-text)]"
                                    title="Walk-in"
                                    aria-label="Walk-in"
                                  >
                                    <svg
                                      viewBox="0 0 24 24"
                                      width="16"
                                      height="16"
                                      fill="currentColor"
                                      aria-hidden="true"
                                    >
                                      <path d="M13.5 5.5c.83 0 1.5-.67 1.5-1.5S14.33 2.5 13.5 2.5 12 3.17 12 4s.67 1.5 1.5 1.5zM9.8 8.9L7 23h2.1l1.8-8 2.1 2v6h2V15.5l-2.1-2 .6-3c1.3 1.5 3.1 2.5 5.2 2.5V11c-1.5 0-2.8-.9-3.4-2.1l-1-1.6c-.4-.6-1.1-1-1.8-1-.3 0-.5.1-.8.1L8 9.3V12h2V9.9l1.8-1z" />
                                    </svg>
                                  </span>
                                ) : null}
                                {renderDealTemperatureIcon(getDealTemperature(c), "text-base")}
                                {c.contactPreference === "call_only" ? (
                                  <span className="lr-inbox-pill lr-inbox-pill-warn">Call only</span>
                                ) : null}
                                {c.status === "closed" ? (
                                  <span
                                    className={`lr-inbox-pill ${
                                      isSoldConversation(c) ? "lr-badge--sold" : "lr-inbox-pill-muted"
                                    }`}
                                    title={
                                      isSoldConversation(c)
                                        ? "Customer bought — excluded from sales promotions"
                                        : `Closed${humanizeClosedReason(c.closedReason) ? ` — ${humanizeClosedReason(c.closedReason)}` : ""}`
                                    }
                                  >
                                    {isSoldConversation(c)
                                      ? "Sold"
                                      : humanizeClosedReason(c.closedReason)
                                        ? `Closed · ${humanizeClosedReason(c.closedReason)}`
                                        : "Closed"}
                                  </span>
                                ) : c.followUpCadence?.pauseReason === "manual_hold" ||
                                  c.followUpCadence?.pauseReason === "unit_hold" ||
                                  c.followUpCadence?.pauseReason === "order_hold" ||
                                  c.followUpCadence?.stopReason === "unit_hold" ||
                                  c.followUpCadence?.stopReason === "order_hold" ||
                                  c.followUp?.reason === "manual_hold" ||
                                  c.followUp?.reason === "unit_hold" ||
                                  c.followUp?.reason === "order_hold" ||
                                  !!c.hold ? (
                                  <span
                                    className="lr-inbox-pill lr-badge--on-hold"
                                    title="Deposit down or bike on order — automatic follow-ups are paused"
                                  >
                                    On hold
                                  </span>
                                ) : null}
                                {linkedOpenCampaign ? (
                                  <span className="lr-inbox-pill lr-inbox-pill-muted">Open in Inbox</span>
                                ) : null}
                                {campaignReply ? (
                                  <span
                                    className="lr-inbox-pill lr-inbox-pill-good"
                                    title="Customer replied to a campaign message"
                                  >
                                    Campaign reply
                                  </span>
                                ) : null}
                                {campaignSent ? (
                                  <span
                                    className="lr-inbox-pill lr-inbox-pill-muted"
                                    title="You sent this contact a campaign message — the thread stays put until they reply"
                                  >
                                    Campaign sent
                                  </span>
                                ) : null}
                                {outcomeNeeded ? (
                                  <button
                                    type="button"
                                    className="lr-inbox-outcome-pill"
                                    title={outcomeNeededTitle}
                                    onClick={e => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      if (typeof openOutcomeFromInbox !== "function") {
                                        openConversation(c.id);
                                        return;
                                      }
                                      openOutcomeFromInbox(
                                        c.id,
                                        outcomeNeededKind,
                                        outcomeNeededKind === "dealer_ride" ? dealerRideOutcomeTodo : null
                                      );
                                    }}
                                  >
                                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--status-success-text)]" />
                                    Outcome
                                  </button>
                                ) : null}
                              </div>
                            </div>

                            <div className="lr-inbox-meta-pills">
                              {isPhoneLogConversation(c) ? (
                                <span className="lr-inbox-meta-pill" title="Phone log" aria-label="Phone log">
                                  Call
                                </span>
                              ) : null}
                              <button
                                className={`lr-inbox-meta-pill ${c.mode === "human" ? "is-human" : "is-ai"}`}
                                title={
                                  c.mode === "human"
                                    ? "You write the replies on this conversation. Click to let the AI draft them for your review."
                                    : "The AI drafts replies for your review on this conversation. Click to take over and write them yourself."
                                }
                                onClick={e => {
                                  e.stopPropagation();
                                  void setHumanModeForId(c.id, c.mode === "human" ? "suggest" : "human");
                                }}
                              >
                                {c.mode === "human" ? "Human" : "AI"}
                              </button>
                              {c.draftHeld ? (
                                c.draftHeld?.heldKind === "context_fidelity" ? (
                                  <span
                                    className="lr-inbox-meta-pill lr-badge--needs-reply"
                                    title="The AI couldn't answer this one — write the reply yourself. Sending clears this flag."
                                  >
                                    Needs your reply
                                  </span>
                                ) : (
                                  <span
                                    className="lr-inbox-meta-pill lr-badge--being-fixed"
                                    title="The quality check caught a problem with the draft and is fixing it — nothing for you to do yet"
                                  >
                                    Being fixed
                                  </span>
                                )
                              ) : c.pendingDraft ? (
                                <span
                                  className="lr-inbox-meta-pill lr-badge--draft-ready"
                                  title="A reply is drafted and waiting — open to review and send"
                                >
                                  Draft ready
                                </span>
                              ) : null}
                              <span className="lr-inbox-meta-pill" title={`${c.messageCount} messages`}>
                                {c.messageCount}
                              </span>
                            </div>
                          </div>

                          {getInboxVehicleLine(c) ? (
                            <div className="text-xs text-gray-500 mt-1 truncate">{getInboxVehicleLine(c)}</div>
                          ) : null}

                          <div className="text-sm text-gray-700 mt-2 line-clamp-2">
                            {c.draftHeld ? (
                              <span
                                style={{
                                  color:
                                    c.draftHeld?.heldKind === "context_fidelity"
                                      ? "var(--status-danger-text)"
                                      : "var(--status-warning-text)"
                                }}
                              >
                                {c.draftHeld?.heldKind === "context_fidelity"
                                  ? "Needs your reply — the AI couldn't answer this one"
                                  : "The AI's draft is being fixed — nothing for you to do yet"}
                              </span>
                            ) : c.pendingDraftPreview ? (
                              <>Draft: {renderBookingLinkLine(c.pendingDraftPreview)}</>
                            ) : (
                              renderBookingLinkLine(c.lastMessage?.body ?? "(no messages)")
                            )}
                          </div>

                          {openTasks.length ? (
                            <div
                              className="lr-inbox-task-line"
                              title={[
                                openTasks.length === 1 ? openTaskTitle : `${openTasks.length} open tasks`,
                                openTaskOwner ? `Owner: ${openTaskOwner}` : ""
                              ]
                                .filter(Boolean)
                                .join(" • ")}
                            >
                              <span className={`lr-inbox-task-chip lr-inbox-task-chip--${chipVariant}`}>
                                <span aria-hidden className="inline-flex">
                                  <SideNavIcon name={chipIcon as any} className="w-3 h-3" />
                                </span>
                                <span className="truncate">{chipDisplay}</span>
                              </span>
                              {openTasks.length > 1 ? (
                                <span className="lr-inbox-task-more">+{openTasks.length - 1}</span>
                              ) : null}
                            </div>
                          ) : null}

                          <div className="lr-inbox-card-footer">
                            <span>{updatedLabel}</span>
                            {inboxOwner ? <span>Owner: {inboxOwner}</span> : null}
                          </div>
                          {linkedOpenCampaign ? (
                            <div className="text-xs text-gray-500 mt-1">Open conversation exists in Inbox.</div>
                          ) : null}
                        </button>
                        <div className="relative border-l shrink-0 w-10 flex items-center justify-center bg-[var(--surface-2)]">
                          <button
                            className="w-8 h-8 flex items-center justify-center text-xl font-semibold text-gray-700 hover:text-gray-900"
                            aria-label="Conversation actions"
                            data-actions-button
                            onClick={e => {
                              e.stopPropagation();
                              setListActionsOpenId((prev: string | null) => (prev === c.id ? null : c.id));
                            }}
                            onMouseDown={e => e.stopPropagation()}
                          >
                            ⋮
                          </button>
                          {listActionsOpenId === c.id ? (
                            <div
                              className={`absolute right-0 mt-2 border rounded bg-white lr-light-modal shadow z-10 ${
                                todoInlineOpenId === c.id ||
                                reminderInlineOpenId === c.id ||
                                contactInlineOpenId === c.id ||
                                reassignInlineOpenId === c.id
                                  ? "w-72"
                                  : "w-40"
                              }`}
                              data-actions-menu
                              onClick={e => e.stopPropagation()}
                              onMouseDown={e => e.stopPropagation()}
                            >
                              {todoInlineOpenId === c.id ? (
                                <div className="p-2">
                                  <div className="text-[11px] text-gray-500 mb-1">To‑do note</div>
                                  {isManager ? (
                                    <select
                                      className="w-full border rounded px-2 py-1 text-xs mb-2 bg-white"
                                      value={todoInlineTarget}
                                      onChange={e => setTodoInlineTarget(e.target.value)}
                                      title="Who this To Do is for"
                                    >
                                      <option value="lead_owner">Lead owner</option>
                                      {reassignSalesOwnerOptions.length ? (
                                        <optgroup label="Salespeople">
                                          {reassignSalesOwnerOptions.map((owner: any) => (
                                            <option key={`todo-owner-${owner.id}`} value={`owner:${owner.id}`}>
                                              {owner.name}
                                            </option>
                                          ))}
                                        </optgroup>
                                      ) : null}
                                      <optgroup label="Departments">
                                        <option value="department:service">Service Department</option>
                                        <option value="department:parts">Parts Department</option>
                                        <option value="department:apparel">Apparel Department</option>
                                      </optgroup>
                                    </select>
                                  ) : null}
                                  <textarea
                                    className="w-full border rounded px-2 py-1 text-xs"
                                    rows={3}
                                    value={todoInlineText}
                                    onChange={e => setTodoInlineText(e.target.value)}
                                    placeholder="Call customer about trade appraisal"
                                  />
                                  <div className="mt-2 flex justify-end gap-2">
                                    <button
                                      className="px-2 py-1 border rounded text-xs"
                                      onClick={() => {
                                        setTodoInlineOpenId(null);
                                        setTodoInlineText("");
                                        setTodoInlineTarget(isManager ? "lead_owner" : "self");
                                      }}
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      className="px-2 py-1 border rounded text-xs"
                                      onClick={() => {
                                        void submitTodoInline(c);
                                      }}
                                    >
                                      Create
                                    </button>
                                  </div>
                                </div>
                              ) : reminderInlineOpenId === c.id ? (
                                <div className="p-2">
                                  <div className="text-[11px] text-gray-500 mb-1">Set reminder</div>
                                  {isManager ? (
                                    <select
                                      className="w-full border rounded px-2 py-1 text-xs mb-2 bg-white"
                                      value={reminderInlineTarget}
                                      onChange={e => setReminderInlineTarget(e.target.value)}
                                      title="Who should receive this reminder"
                                    >
                                      <option value="lead_owner">Lead owner</option>
                                      {reassignSalesOwnerOptions.length ? (
                                        <optgroup label="Salespeople">
                                          {reassignSalesOwnerOptions.map((owner: any) => (
                                            <option key={`reminder-owner-${owner.id}`} value={`owner:${owner.id}`}>
                                              {owner.name}
                                            </option>
                                          ))}
                                        </optgroup>
                                      ) : null}
                                      <optgroup label="Departments">
                                        <option value="department:service">Service Department</option>
                                        <option value="department:parts">Parts Department</option>
                                        <option value="department:apparel">Apparel Department</option>
                                      </optgroup>
                                    </select>
                                  ) : null}
                                  <textarea
                                    className="w-full border rounded px-2 py-1 text-xs"
                                    rows={2}
                                    value={reminderInlineText}
                                    onChange={e => setReminderInlineText(e.target.value)}
                                    placeholder="Call customer about financing update"
                                  />
                                  <label className="mt-2 block text-[11px] text-gray-500">
                                    Reminder time
                                    <input
                                      type="datetime-local"
                                      className="mt-1 w-full border rounded px-2 py-1 text-xs"
                                      value={reminderInlineDueAt}
                                      onChange={e => setReminderInlineDueAt(e.target.value)}
                                    />
                                  </label>
                                  <label className="mt-2 block text-[11px] text-gray-500">
                                    Send SMS reminder
                                    <select
                                      className="mt-1 w-full border rounded px-2 py-1 text-xs bg-white"
                                      value={reminderInlineLeadMinutes}
                                      onChange={e => setReminderInlineLeadMinutes(e.target.value)}
                                    >
                                      <option value="0">At reminder time</option>
                                      <option value="15">15 min before</option>
                                      <option value="30">30 min before</option>
                                      <option value="60">1 hour before</option>
                                    </select>
                                  </label>
                                  <div className="mt-2 flex justify-end gap-2">
                                    <button
                                      className="px-2 py-1 border rounded text-xs"
                                      onClick={() => {
                                        setReminderInlineOpenId(null);
                                        setReminderInlineText("");
                                        setReminderInlineTarget(isManager ? "lead_owner" : "self");
                                        setReminderInlineDueAt("");
                                        setReminderInlineLeadMinutes("30");
                                      }}
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      className="px-2 py-1 border rounded text-xs"
                                      disabled={reminderInlineSaving}
                                      onClick={() => {
                                        void submitReminderInline(c);
                                      }}
                                    >
                                      {reminderInlineSaving ? "Saving..." : "Create"}
                                    </button>
                                  </div>
                                </div>
                              ) : contactInlineOpenId === c.id ? (
                                <div className="p-2">
                                  <div className="text-[11px] text-gray-500 mb-1">
                                    {findLinkedContactForConversation(c) ? "Edit contact" : "New contact"}
                                  </div>
                                  <div className="grid grid-cols-2 gap-2">
                                    <input
                                      className="border rounded px-2 py-1 text-xs"
                                      value={contactInlineForm.firstName}
                                      onChange={e =>
                                        setContactInlineForm((prev: any) => ({
                                          ...prev,
                                          firstName: e.target.value
                                        }))
                                      }
                                      placeholder="First name"
                                    />
                                    <input
                                      className="border rounded px-2 py-1 text-xs"
                                      value={contactInlineForm.lastName}
                                      onChange={e =>
                                        setContactInlineForm((prev: any) => ({
                                          ...prev,
                                          lastName: e.target.value
                                        }))
                                      }
                                      placeholder="Last name"
                                    />
                                  </div>
                                  <input
                                    className="w-full border rounded px-2 py-1 text-xs mt-2"
                                    value={contactInlineForm.phone}
                                    onChange={e =>
                                      setContactInlineForm((prev: any) => ({
                                        ...prev,
                                        phone: e.target.value
                                      }))
                                    }
                                    placeholder="Phone"
                                  />
                                  <input
                                    className="w-full border rounded px-2 py-1 text-xs mt-2"
                                    value={contactInlineForm.email}
                                    onChange={e =>
                                      setContactInlineForm((prev: any) => ({
                                        ...prev,
                                        email: e.target.value
                                      }))
                                    }
                                    placeholder="Email"
                                  />
                                  <div className="mt-2 flex justify-end gap-2">
                                    <button
                                      className="px-2 py-1 border rounded text-xs"
                                      onClick={() => {
                                        setContactInlineOpenId(null);
                                        setContactInlineForm({
                                          firstName: "",
                                          lastName: "",
                                          phone: "",
                                          email: ""
                                        });
                                      }}
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      className="px-2 py-1 border rounded text-xs"
                                      disabled={contactInlineSaving}
                                      onClick={() => {
                                        void submitInlineContact(c);
                                      }}
                                    >
                                      {contactInlineSaving ? "Saving..." : "Save"}
                                    </button>
                                  </div>
                                </div>
                              ) : reassignInlineOpenId === c.id ? (
                                <div className="p-2">
                                  <div className="text-[11px] text-gray-500 mb-1">Reassign lead</div>
                                  <select
                                    className="w-full border rounded px-2 py-1 text-xs"
                                    value={reassignInlineTarget}
                                    onChange={e => setReassignInlineTarget(e.target.value)}
                                  >
                                    {reassignSalesOwnerOptions.length ? (
                                      <optgroup label="Salespeople">
                                        {reassignSalesOwnerOptions.map((owner: any) => (
                                          <option key={`reassign-owner-${owner.id}`} value={`owner:${owner.id}`}>
                                            {owner.name}
                                          </option>
                                        ))}
                                      </optgroup>
                                    ) : null}
                                    <optgroup label="Departments">
                                      <option value="department:service">Service</option>
                                      <option value="department:parts">Parts</option>
                                      <option value="department:apparel">Apparel</option>
                                    </optgroup>
                                  </select>
                                  {reassignInlineTarget.startsWith("department:") ? (
                                    <textarea
                                      className="w-full border rounded px-2 py-1 text-xs mt-2"
                                      rows={3}
                                      value={reassignInlineSummary}
                                      onChange={e => setReassignInlineSummary(e.target.value)}
                                      placeholder="Optional note for department"
                                    />
                                  ) : (
                                    <div className="mt-2 text-[11px] text-gray-500">
                                      This will reassign lead owner only.
                                    </div>
                                  )}
                                  <div className="mt-2 flex justify-end gap-2">
                                    <button
                                      className="px-2 py-1 border rounded text-xs"
                                      onClick={() => {
                                        setReassignInlineOpenId(null);
                                        setReassignInlineTarget("department:service");
                                        setReassignInlineSummary("");
                                      }}
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      className="px-2 py-1 border rounded text-xs"
                                      disabled={reassignInlineSaving}
                                      onClick={() => {
                                        void reassignLeadInline(c);
                                      }}
                                    >
                                      {reassignInlineSaving ? "Saving..." : "Save"}
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <button
                                    className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
                                    onClick={() => {
                                      setContactInlineOpenId(null);
                                      setTodoInlineOpenId(c.id);
                                      setTodoInlineText("");
                                      setTodoInlineTarget(isManager ? "lead_owner" : "self");
                                      setReminderInlineOpenId(null);
                                      setReminderInlineText("");
                                      setReminderInlineTarget(isManager ? "lead_owner" : "self");
                                      setReminderInlineDueAt("");
                                      setReminderInlineLeadMinutes("30");
                                    }}
                                  >
                                    Create To Do
                                  </button>
                                  <button
                                    className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
                                    onClick={() => {
                                      setContactInlineOpenId(null);
                                      setTodoInlineOpenId(null);
                                      setTodoInlineText("");
                                      setTodoInlineTarget(isManager ? "lead_owner" : "self");
                                      setReminderInlineOpenId(c.id);
                                      setReminderInlineText("");
                                      setReminderInlineTarget(isManager ? "lead_owner" : "self");
                                      setReminderInlineDueAt("");
                                      setReminderInlineLeadMinutes("30");
                                    }}
                                  >
                                    Set Reminder
                                  </button>
                                  <button
                                    className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
                                    onClick={() => {
                                      openInlineContactFromConversation(c);
                                    }}
                                  >
                                    {findLinkedContactForConversation(c) ? "Edit contact" : "Add new contact"}
                                  </button>
                                  {authUser?.role === "manager" || authUser?.permissions?.canAccessTodos ? (
                                    <button
                                      className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
                                      onClick={() => {
                                        openReassignLeadInline(c);
                                      }}
                                    >
                                      Reassign lead
                                    </button>
                                  ) : null}
                                </>
                              )}
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
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}

        {!loading && filteredConversations.length === 0 && (
          <div className="p-6 text-sm text-gray-600 border rounded-lg flex flex-col items-center gap-3 text-center">
            <Image
              src="/app/empty-quiet.jpg"
              alt=""
              width={416}
              height={277}
              className="w-52 h-auto rounded-lg"
            />
            <span>
              {inboxQuery.trim()
                ? "No conversations match your search."
                : view === "inbox"
                  ? "No open conversations."
                  : view === "campaigns"
                    ? "No campaign threads."
                    : "No archived conversations."}
            </span>
          </div>
        )}
      </div>
    </>
  );
}
