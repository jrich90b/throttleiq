import React from "react";
import { SideNavIcon } from "./UiIcon";
import type { SideNavIconName } from "./UiIcon";

function followUpTickerStartIso(todo: any): string | null {
  return String(todo?.dueAt ?? "").trim() || String(todo?.createdAt ?? "").trim() || null;
}

function formatFollowUpTicker(startIso: string | null | undefined, nowMs: number): string | null {
  const startedAt = new Date(String(startIso ?? "").trim()).getTime();
  if (!Number.isFinite(startedAt)) return null;
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAt) / 1000));
  const days = Math.floor(elapsedSeconds / 86_400);
  const hours = Math.floor((elapsedSeconds % 86_400) / 3_600);
  const minutes = Math.floor((elapsedSeconds % 3_600) / 60);
  const seconds = elapsedSeconds % 60;
  // A live seconds clock only makes sense on fresh tasks; older ones read
  // better as a plain age ("19d 6h waiting" beats "19d 06:46:35").
  if (days > 0) return `${days}d ${hours}h waiting`;
  const clock = [hours, minutes, seconds].map(value => String(value).padStart(2, "0")).join(":");
  return clock;
}

function displayCaseName(raw: string): string {
  const name = String(raw ?? "").trim();
  if (!name) return name;
  // Only normalize shouty/lowercase lead-form names; mixed case is left alone.
  if (name !== name.toUpperCase() && name !== name.toLowerCase()) return name;
  return name
    .split(/\s+/)
    .map(word => (word ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word))
    .join(" ");
}

function formatWhenIso(iso: string, withWeekday = false): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString([], {
    ...(withWeekday ? { weekday: "short" as const } : {}),
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function daysAgoLabel(iso: string, nowMs: number): string | null {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms >= nowMs) return null;
  const days = Math.floor((nowMs - ms) / 86_400_000);
  if (days <= 0) return "earlier today";
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function isDealerRideOutcomeTodo(todo: any): boolean {
  return (
    String(todo?.sourceMessageId ?? "").startsWith("dealer_ride_outcome:") ||
    /\bdealer ride outcome needed\b/i.test(String(todo?.summary ?? ""))
  );
}

function isApprovalTodo(todo: any): boolean {
  const reason = String(todo?.reason ?? "").trim().toLowerCase();
  const text = [todo?.reason, todo?.summary, todo?.action].map(value => String(value ?? "")).join(" ").toLowerCase();
  return (
    reason === "approval" ||
    reason === "payments" ||
    reason === "pricing" ||
    reason === "manager" ||
    /\b(credit|prequal|pre-qual|approval|finance|financing|payment|business manager)\b/.test(text)
  );
}

export function TaskInboxSection(props: any) {
  const {
    todoQuery,
    setTodoQuery,
    isManager,
    canFilterOwners,
    todoLeadOwnerFilter,
    setTodoLeadOwnerFilter,
    managerLeadOwnerOptions,
    todoTaskTypeFilter,
    setTodoTaskTypeFilter,
    todoSectionDefs,
    groupedTodos,
    getTodoSectionTheme,
    conversationsById,
    todoInboxSection,
    todoActionLabel,
    todoRequestedCallTimeLabel,
    todoAppointmentTimeLabel,
    formatAppointmentOutcomeDisplay,
    reassignInlineOpenId,
    reassignInlineTarget,
    setReassignInlineTarget,
    reassignSalesOwnerOptions,
    reassignInlineSummary,
    setReassignInlineSummary,
    setReassignInlineOpenId,
    reassignInlineSaving,
    reassignLeadInline,
    openConversation,
    authUser,
    openReassignLeadInline,
    openCallFromTodo,
    openApprovalTodoOutcome,
    setAppointmentCloseTarget,
    setAppointmentClosePrimaryOutcome,
    setAppointmentCloseSecondaryOutcome,
    setAppointmentCloseNote,
    setAppointmentCloseOpen,
    markTodoDone,
    reportTodoIssue,
    renderDealTemperatureIcon,
    getDealTemperature,
    loading,
    filteredTodos
  } = props;
  const [nowMs, setNowMs] = React.useState(() => Date.now());

  React.useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <>
      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-gray-800">Task Inbox</div>
        <button
          className="px-3 py-2 border rounded text-sm text-red-700 bg-red-50"
          onClick={() => {
            void reportTodoIssue?.();
          }}
          title="Report a routing, task, cadence, or UI problem"
        >
          Report issue
        </button>
      </div>
      <div className="mt-3 space-y-2">
        <input
          className="w-full border rounded px-3 py-2 text-sm"
          placeholder="Search customer..."
          value={todoQuery}
          onChange={e => setTodoQuery(e.target.value)}
        />
        <div className="flex flex-col gap-2 md:flex-row">
          {canFilterOwners ? (
            <select
              className="w-full md:w-44 border rounded px-3 py-2 text-sm bg-white"
              value={todoLeadOwnerFilter}
              onChange={e => setTodoLeadOwnerFilter(e.target.value)}
              title="Filter by owner"
            >
              <option value="all">Owners</option>
              {managerLeadOwnerOptions.length ? (
                <optgroup label="Salespeople">
                  {managerLeadOwnerOptions.map((name: string) => (
                    <option key={`todo-owner-${name}`} value={`owner:${encodeURIComponent(name)}`}>
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
          <select
            className="w-full md:w-44 border rounded px-3 py-2 text-sm bg-white"
            value={todoTaskTypeFilter}
            onChange={e => setTodoTaskTypeFilter(e.target.value)}
            title="Filter by task type"
          >
            <option value="all">Task Type: All</option>
            <option value="followup">Task Type: Follow-up</option>
            <option value="todo">Task Type: To Do</option>
            <option value="reminder">Task Type: Reminder</option>
            <option value="appointment">Task Type: Appointment</option>
          </select>
        </div>
      </div>
      <div className="mt-3 space-y-3">
        {(() => {
          // One card per customer with every open task inside it (Joe,
          // 2026-06-12: "no doubles — keep it under the same card").
          // Customers appear at the position of their highest-priority task;
          // tasks within a card keep section-priority order.
          const orderedTodos: any[] = [];
          for (const sectionDef of todoSectionDefs) {
            for (const t of groupedTodos[sectionDef.key] ?? []) orderedTodos.push(t);
          }
          const groups: Array<{ convId: string; tasks: any[] }> = [];
          const byConv = new Map<string, { convId: string; tasks: any[] }>();
          for (const t of orderedTodos) {
            let g = byConv.get(t.convId);
            if (!g) {
              g = { convId: t.convId, tasks: [] };
              byConv.set(t.convId, g);
              groups.push(g);
            }
            g.tasks.push(t);
          }
          return groups.map(group => {
            const rowConv = conversationsById.get(group.convId);
            const first = group.tasks[0];
            const vehicleLine = String(rowConv?.vehicleDescription ?? "").trim();
            const hold = rowConv?.hold ?? null;
            const highlightLine =
              [String(hold?.color ?? "").trim(), String(hold?.trim ?? "").trim()]
                .filter(Boolean)
                .join(", ") ||
              String(hold?.label ?? "").trim() ||
              (rowConv?.walkIn ? "Walk-in" : "");
            const ownerDisplay = String(
              first.ownerDisplayName ?? first.ownerName ?? first.leadOwnerName ?? ""
            ).trim();
            const callTask = group.tasks.find(
              (t: any) => !/(^|\b)note(\b|$)/.test(String(t.reason ?? "").toLowerCase())
            );
            return (
              <div key={group.convId} className="lr-task-card">
                <div className="min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div
                      className="lr-task-card-name"
                      onClick={() => {
                        openConversation(group.convId);
                      }}
                      title="Open conversation"
                    >
                      {displayCaseName(first.leadName || "") || first.leadKey}
                      {renderDealTemperatureIcon(
                        rowConv ? getDealTemperature(rowConv) : null,
                        "text-base"
                      )}
                    </div>
                    {group.tasks.length > 1 ? (
                      <span className="lr-task-card-count">{group.tasks.length} open tasks</span>
                    ) : null}
                  </div>
                  {vehicleLine ? <div className="lr-task-card-vehicle">{vehicleLine}</div> : null}
                  {highlightLine ? <div className="lr-task-card-highlight">{highlightLine}</div> : null}
                  {first.leadName ? <div className="lr-task-card-phone">{first.leadKey}</div> : null}
                  {group.tasks.map((t: any) => {
                    const reason = (t.reason ?? "").toLowerCase();
                    const sectionType = todoInboxSection(t);
                    const taskLabel =
                      sectionType === "followup"
                        ? "Follow-up"
                        : sectionType === "appointment"
                          ? "Appointment"
                          : sectionType === "reminder"
                            ? "Reminder"
                            : "To Do";
                    const isApprovalTodoTask = isApprovalTodo(t);
                    const actionLabel = todoActionLabel(t);
                    const requestedCallTime =
                      todoRequestedCallTimeLabel(t) || String(t.callbackTimeLabel ?? "").trim() || null;
                    const appointmentTime = sectionType === "appointment" ? todoAppointmentTimeLabel(t) : null;
                    const actionAlreadyHasRequestedTime = /\brequested(?::| call time:)/i.test(actionLabel);
                    const showRequestedCallTime =
                      sectionType !== "appointment" && !!requestedCallTime && !actionAlreadyHasRequestedTime;
                    const appointmentOutcomeLabel = formatAppointmentOutcomeDisplay({
                      primary: String(t.appointmentOutcomePrimaryStatus ?? "").trim() || null,
                      secondary: String(t.appointmentOutcomeSecondaryStatus ?? "").trim() || null,
                      legacy: String(t.appointmentOutcomeStatus ?? "").trim() || null
                    });
                    const dealerRideOutcomeNeeded =
                      isDealerRideOutcomeTodo(t) && !String(t.dealerRideOutcomeStatus ?? "").trim();
                    const dealerRideDefaultOutcome = rowConv?.hold ? "no_change" : "needs_follow_up";
                    const appointmentReminderSent =
                      sectionType === "appointment" &&
                      !appointmentOutcomeLabel &&
                      Boolean(String(rowConv?.appointment?.staffNotify?.followUpSentAt ?? "").trim());
                    const followUpTickerStart = sectionType === "followup" ? followUpTickerStartIso(t) : null;
                    const followUpTicker = formatFollowUpTicker(followUpTickerStart, nowMs);
                    const apptIso = String(t.appointmentWhenIso ?? "").trim();
                    const whenLabel =
                      sectionType === "appointment" && (apptIso || appointmentTime)
                        ? "Appointment"
                        : requestedCallTime
                          ? "Requested call"
                          : String(t.dueAt ?? "").trim()
                            ? "Due"
                            : "Created";
                    const requestedCallPretty =
                      requestedCallTime && Number.isFinite(new Date(requestedCallTime).getTime())
                        ? formatWhenIso(requestedCallTime, true)
                        : requestedCallTime;
                    const whenValue =
                      sectionType === "appointment" && (apptIso || appointmentTime)
                        ? apptIso
                          ? formatWhenIso(apptIso, true)
                          : appointmentTime
                        : requestedCallPretty ||
                          (String(t.dueAt ?? "").trim()
                            ? formatWhenIso(t.dueAt, true)
                            : formatWhenIso(t.createdAt));
                    // A long-past appointment or requested call must read as
                    // overdue history, not an upcoming commitment (Raymond
                    // Mangold: a March 25 appointment looked current in June).
                    const whenAgo =
                      sectionType === "appointment" && apptIso && !appointmentOutcomeLabel
                        ? daysAgoLabel(apptIso, nowMs)
                        : whenLabel === "Requested call" && requestedCallTime
                          ? daysAgoLabel(requestedCallTime, nowMs)
                          : null;
                    const actionDisplay =
                      sectionType === "appointment" || whenLabel === "Requested call"
                        ? String(actionLabel ?? "").replace(/\s*\(requested:[^)]*\)\.?\s*$/i, ".")
                        : actionLabel;
                    const summaryDuplicatesAction =
                      String(t.summary ?? "").replace(/\s+/g, " ").trim().toLowerCase() ===
                      String(actionDisplay ?? "").replace(/\s+/g, " ").trim().toLowerCase();
                    const pillVariant =
                      sectionType === "followup"
                        ? "lr-task-card-pill--followup"
                        : sectionType === "appointment"
                          ? "lr-task-card-pill--appointment"
                          : sectionType === "reminder"
                            ? "lr-task-card-pill--reminder"
                            : "lr-task-card-pill--todo";
                    const pillIcon: SideNavIconName =
                      sectionType === "appointment" ? "calendar" : sectionType === "reminder" ? "clock" : "bell";
                    return (
                      <div key={t.id} className="lr-task-card-task">
                        <div className="lr-task-card-pillrow">
                          <span className={`lr-task-card-pill ${pillVariant}`}>
                            <span aria-hidden className="inline-flex">
                              <SideNavIcon name={pillIcon} className="w-3.5 h-3.5" />
                            </span>
                            {taskLabel}
                          </span>
                          {appointmentReminderSent || dealerRideOutcomeNeeded ? (
                            <button
                              type="button"
                              className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/40 bg-emerald-400/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-700 shadow-[0_0_0_1px_rgba(52,211,153,0.10)] animate-pulse hover:bg-emerald-400/25"
                              title={dealerRideOutcomeNeeded ? "Record demo ride outcome" : "Record appointment outcome"}
                              onClick={() => {
                                setAppointmentCloseTarget(t);
                                setAppointmentClosePrimaryOutcome("showed");
                                setAppointmentCloseSecondaryOutcome(
                                  dealerRideOutcomeNeeded ? dealerRideDefaultOutcome : "needs_follow_up"
                                );
                                setAppointmentCloseNote("");
                                setAppointmentCloseOpen(true);
                              }}
                            >
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                              Outcome needed
                            </button>
                          ) : null}
                          {followUpTicker ? (
                            <span
                              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300/50 bg-[#06140f] px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums tracking-wide text-emerald-200 shadow-[inset_0_0_0_1px_rgba(52,211,153,0.12),0_0_12px_rgba(52,211,153,0.16)]"
                              title={String(t.dueAt ?? "").trim() ? "How long since this follow-up became due" : "How long this follow-up has been open"}
                            >
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,0.85)]" />
                              {followUpTicker}
                            </span>
                          ) : null}
                          <span className="ml-auto" />
                          {appointmentReminderSent || dealerRideOutcomeNeeded ? null : isApprovalTodoTask ? (
                            <button
                              className="lr-task-btn"
                              onClick={() => openApprovalTodoOutcome(t)}
                              title="Record the outcome and close this To Do"
                            >
                              Outcome
                            </button>
                          ) : (
                            <button
                              className="lr-task-btn"
                              onClick={() => {
                                if (sectionType === "appointment" && !appointmentOutcomeLabel) {
                                  setAppointmentCloseTarget(t);
                                  setAppointmentClosePrimaryOutcome("showed");
                                  setAppointmentCloseSecondaryOutcome("needs_follow_up");
                                  setAppointmentCloseNote("");
                                  setAppointmentCloseOpen(true);
                                  return;
                                }
                                void markTodoDone(t, "dismiss");
                              }}
                              title="Close this To Do"
                            >
                              {sectionType === "appointment" && !appointmentOutcomeLabel ? "Record outcome" : "Close"}
                            </button>
                          )}
                        </div>
                        <div className="lr-task-card-boxes">
                          <div className="lr-task-card-box">
                            <div className="lr-task-card-box-label">
                              <span aria-hidden className="inline-flex">
                                <SideNavIcon name="clock" className="w-3.5 h-3.5" />
                              </span>
                              {whenLabel}
                            </div>
                            <div className="lr-task-card-box-value">
                              {whenValue}
                              {whenAgo ? <span className="lr-task-card-late"> • {whenAgo}</span> : null}
                            </div>
                          </div>
                          <div className="lr-task-card-box">
                            <div className="lr-task-card-box-label">
                              <span aria-hidden className="inline-flex">
                                <SideNavIcon name="bolt" className="w-3.5 h-3.5" />
                              </span>
                              Action
                            </div>
                            <div className="lr-task-card-box-value">{actionDisplay}</div>
                          </div>
                        </div>
                        {!summaryDuplicatesAction || showRequestedCallTime || appointmentOutcomeLabel ? (
                          <div className="lr-task-card-summary">
                            <div className="flex items-center justify-between gap-2">
                              <div className="lr-task-card-summary-title">Summary</div>
                              <div className="text-[11px] text-gray-500">
                                {t.reason} • {new Date(t.createdAt).toLocaleDateString()}
                              </div>
                            </div>
                            {!summaryDuplicatesAction ? (
                              <div className="lr-task-card-summary-row">
                                <span className="lr-task-card-check" aria-hidden>✓</span>
                                <span className="break-words">{t.summary}</span>
                              </div>
                            ) : null}
                            {showRequestedCallTime && sectionType !== "followup" ? (
                              <div className="lr-task-card-summary-row">
                                <span className="lr-task-card-check" aria-hidden>✓</span>
                                <span>Requested call time: {requestedCallTime}</span>
                              </div>
                            ) : null}
                            {sectionType === "appointment" && appointmentOutcomeLabel ? (
                              <div className="lr-task-card-summary-row">
                                <span className="lr-task-card-check" aria-hidden>✓</span>
                                <span>Outcome: {appointmentOutcomeLabel}</span>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                  {reassignInlineOpenId === group.convId && rowConv ? (
                    <div className="mt-3 lr-task-card-box" data-actions-menu>
                      <div className="text-[11px] text-gray-500 mb-1">Reassign lead</div>
                      <select
                        className="w-full border rounded px-2 py-1 text-xs bg-white"
                        value={reassignInlineTarget}
                        onChange={e => setReassignInlineTarget(e.target.value)}
                      >
                        {reassignSalesOwnerOptions.length ? (
                          <optgroup label="Salespeople">
                            {reassignSalesOwnerOptions.map((owner: any) => (
                              <option key={`task-reassign-owner-${owner.id}`} value={`owner:${owner.id}`}>
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
                          className="w-full border rounded px-2 py-1 text-xs mt-2 bg-white"
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
                            void reassignLeadInline(rowConv);
                          }}
                        >
                          {reassignInlineSaving ? "Saving..." : "Save"}
                        </button>
                      </div>
                    </div>
                  ) : null}
                  <div className="lr-task-card-foot">
                    <div className="lr-task-card-owner">
                      {ownerDisplay ? <>Owner: {ownerDisplay}</> : <>Unassigned</>}
                      <button
                        className="ml-3 text-[11px] text-blue-400 hover:text-blue-300"
                        onClick={() => {
                          openConversation(group.convId);
                        }}
                      >
                        Open conversation →
                      </button>
                    </div>
                    <div className="lr-task-card-actions">
                      {(authUser?.role === "manager" || authUser?.permissions?.canAccessTodos) && rowConv ? (
                        <button
                          className="lr-task-btn"
                          onClick={() => {
                            openReassignLeadInline(rowConv);
                          }}
                          title="Reassign lead"
                        >
                          Reassign
                        </button>
                      ) : null}
                      {callTask ? (
                        <button
                          className="lr-task-btn lr-task-btn--primary"
                          onClick={() => openCallFromTodo(callTask)}
                          title="Call customer"
                        >
                          <SideNavIcon name="phone" className="w-4 h-4 inline-block align-[-3px] mr-1.5" />
                          Call
                        </button>
                      ) : null}
                      <button
                        className="lr-task-btn lr-task-btn--danger"
                        onClick={() => {
                          void reportTodoIssue?.(first);
                        }}
                        title="Report a routing, task, cadence, or UI problem"
                      >
                        Report issue
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          });
        })()}
        {!loading && filteredTodos.length === 0 ? (
          <div className="p-4 text-sm text-gray-600">
            {todoQuery.trim() ? "No To Dos match your search." : "No open To Dos."}
          </div>
        ) : null}
      </div>
    </>
  );
}
