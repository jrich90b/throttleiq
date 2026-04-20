import React from "react";

export function TaskInboxSection(props: any) {
  const {
    todoQuery,
    setTodoQuery,
    isManager,
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
    setAppointmentCloseTarget,
    setAppointmentClosePrimaryOutcome,
    setAppointmentCloseSecondaryOutcome,
    setAppointmentCloseNote,
    setAppointmentCloseOpen,
    markTodoDone,
    renderDealTemperatureIcon,
    getDealTemperature,
    loading,
    filteredTodos
  } = props;

  return (
    <>
      <div className="mt-3 text-sm font-semibold text-gray-800">Task Inbox</div>
      <div className="mt-3 space-y-2">
        <input
          className="w-full border rounded px-3 py-2 text-sm"
          placeholder="Search customer..."
          value={todoQuery}
          onChange={e => setTodoQuery(e.target.value)}
        />
        <div className="flex flex-col gap-2 md:flex-row">
          {isManager ? (
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
        {todoSectionDefs.map((sectionDef: any) => {
          const rows = groupedTodos[sectionDef.key];
          const sectionTheme = getTodoSectionTheme(sectionDef.key);
          return (
            <div key={sectionDef.key} className="border rounded-lg overflow-hidden lr-app-list-surface">
              <div className={`px-4 py-2 flex items-center justify-between ${sectionTheme.header}`}>
                <div className={`text-xs font-semibold uppercase tracking-wide ${sectionTheme.title}`}>
                  {sectionDef.label}
                </div>
                <div className={`text-xs ${sectionTheme.title}`}>{rows.length}</div>
              </div>
              {rows.length
                ? rows.map((t: any, rowIdx: number) => {
                    const rowConv = conversationsById.get(t.convId);
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
                    const taskTagClass =
                      sectionType === "followup"
                        ? "border-[color:rgba(251,127,4,0.88)] bg-[var(--accent)] text-[#101522]"
                        : sectionType === "appointment"
                          ? "border-[color:rgba(16,185,129,0.55)] bg-[color:rgba(16,185,129,0.22)] text-[#d8ffef]"
                          : sectionType === "reminder"
                            ? "border-[color:rgba(234,179,8,0.62)] bg-[color:rgba(234,179,8,0.20)] text-[#fff4c6]"
                            : "border-[color:rgba(59,130,246,0.52)] bg-[color:rgba(59,130,246,0.18)] text-[#dce9ff]";
                    const isInternalNoteTodo = /(^|\\b)note(\\b|$)/.test(reason);
                    const showCallButton = !isInternalNoteTodo;
                    const actionLabel = todoActionLabel(t);
                    const requestedCallTime =
                      todoRequestedCallTimeLabel(t) || String(t.callbackTimeLabel ?? "").trim() || null;
                    const appointmentTime = sectionType === "appointment" ? todoAppointmentTimeLabel(t) : null;
                    const actionAlreadyHasRequestedTime = /\brequested(?::| call time:)/i.test(actionLabel);
                    const showRequestedCallTime =
                      sectionType !== "appointment" && !!requestedCallTime && !actionAlreadyHasRequestedTime;
                    const ownerDisplay = String(t.ownerDisplayName ?? t.ownerName ?? t.leadOwnerName ?? "").trim();
                    const appointmentOutcomeStatus = String(t.appointmentOutcomeStatus ?? "").trim();
                    const appointmentOutcomePrimaryStatus = String(t.appointmentOutcomePrimaryStatus ?? "").trim();
                    const appointmentOutcomeSecondaryStatus = String(
                      t.appointmentOutcomeSecondaryStatus ?? ""
                    ).trim();
                    const appointmentOutcomeLabel = formatAppointmentOutcomeDisplay({
                      primary: appointmentOutcomePrimaryStatus || null,
                      secondary: appointmentOutcomeSecondaryStatus || null,
                      legacy: appointmentOutcomeStatus || null
                    });
                    return (
                      <div
                        key={t.id}
                        className={`p-4 flex items-start justify-between gap-4 ${rowIdx > 0 ? "border-t" : ""}`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${taskTagClass}`}>
                              {taskLabel}
                            </span>
                          </div>
                          {t.leadName ? (
                            <>
                              <div className="text-sm font-medium mt-2 flex items-center gap-1">
                                {t.leadName}
                                {renderDealTemperatureIcon(
                                  rowConv ? getDealTemperature(rowConv) : null,
                                  "text-base"
                                )}
                              </div>
                              <div className="text-sm text-gray-600 break-all">{t.leadKey}</div>
                            </>
                          ) : (
                            <div className="text-sm font-medium break-all mt-2 flex items-center gap-1">
                              {t.leadKey}
                              {renderDealTemperatureIcon(
                                rowConv ? getDealTemperature(rowConv) : null,
                                "text-base"
                              )}
                            </div>
                          )}
                          <div className="text-xs text-gray-500 mt-1">
                            {t.reason} • {new Date(t.createdAt).toLocaleString()}
                          </div>
                          <div className="text-sm text-gray-700 mt-2 line-clamp-3 break-words">{t.summary}</div>
                          <div className="text-sm font-semibold text-[var(--accent)] mt-2">Action: {actionLabel}</div>
                          {ownerDisplay ? <div className="text-xs text-gray-600 mt-1">Owner: {ownerDisplay}</div> : null}
                          {showRequestedCallTime ? (
                            <div className="text-xs text-gray-600 mt-1">Requested call time: {requestedCallTime}</div>
                          ) : null}
                          {appointmentTime ? (
                            <div className="text-xs text-gray-600 mt-1">Appointment time: {appointmentTime}</div>
                          ) : null}
                          {sectionType === "appointment" && appointmentOutcomeLabel ? (
                            <div className="text-xs text-gray-600 mt-1">Outcome: {appointmentOutcomeLabel}</div>
                          ) : null}
                          {reassignInlineOpenId === t.convId && rowConv ? (
                            <div className="mt-3 border rounded p-2 bg-gray-50">
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
                          <button
                            className="text-xs text-blue-600 mt-2 inline-block"
                            onClick={() => {
                              openConversation(t.convId);
                            }}
                          >
                            Open conversation
                          </button>
                        </div>
                        <div className="shrink-0 flex flex-col items-end gap-2">
                          {(authUser?.role === "manager" || authUser?.permissions?.canAccessTodos) && rowConv ? (
                            <button
                              className="px-3 py-2 border rounded text-sm"
                              onClick={() => {
                                openReassignLeadInline(rowConv);
                              }}
                              title="Reassign lead"
                            >
                              Reassign
                            </button>
                          ) : null}
                          {showCallButton ? (
                            <button
                              className="px-3 py-2 border rounded text-sm"
                              onClick={() => openCallFromTodo(t)}
                              title="Call customer"
                            >
                              <span className="mr-1">📞</span>
                              Call
                            </button>
                          ) : null}
                          <button
                            className="px-3 py-2 border rounded text-sm text-gray-600"
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
                            Close
                          </button>
                        </div>
                      </div>
                    );
                  })
                : (
                  <div className="px-4 py-3 text-xs text-gray-500">No {sectionDef.label.toLowerCase()}.</div>
                )}
            </div>
          );
        })}
        {!loading && filteredTodos.length === 0 ? (
          <div className="p-4 text-sm text-gray-600">
            {todoQuery.trim() ? "No To Dos match your search." : "No open To Dos."}
          </div>
        ) : null}
      </div>
    </>
  );
}
