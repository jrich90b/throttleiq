import React from "react";

export function InboxSection(props: any) {
  const {
    view,
    setView,
    filteredConversations,
    openCompose,
    inboxQuery,
    setInboxQuery,
    isManager,
    inboxOwnerFilter,
    setInboxOwnerFilter,
    managerLeadOwnerOptions,
    inboxDealCounts,
    inboxDealFilter,
    setInboxDealFilter,
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
    renderBookingLinkLine,
    loading
  } = props;

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
          <div className="text-xs text-[var(--palette-graphite)]">
            {view === "inbox"
              ? `Open: ${filteredConversations.length}`
              : view === "campaigns"
                ? `Campaign leads: ${filteredConversations.length}`
                : `Archived: ${filteredConversations.length}`}
          </div>
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
        {isManager ? (
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

      <div className="mt-2 flex items-center gap-2">
        <span className="text-xs text-gray-600">Deal status</span>
        {([
          { key: "all" as const, label: "All" },
          { key: "hot" as const, label: `Hot deals (${inboxDealCounts.hot})` },
          { key: "hold" as const, label: `Hold deals (${inboxDealCounts.hold})` },
          { key: "sold" as const, label: `Sold deals (${inboxDealCounts.sold})` }
        ] as Array<{ key: "all" | "hot" | "sold" | "hold"; label: string }>).map(option => (
          <button
            key={`inbox-deal-filter-${option.key}`}
            className={getInboxDealFilterButtonClass(inboxDealFilter === option.key)}
            onClick={() => setInboxDealFilter(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="mt-3 space-y-3">
        {groupedConversations.map((group: any) => {
          const expanded = group.isCampaignGroup ? (campaignInboxExpanded[group.key] ?? true) : true;
          return (
            <div key={group.key}>
              {group.isCampaignGroup ? (
                <button
                  className="w-full px-1 pb-1 text-xs font-semibold text-[var(--accent)] border-b border-[var(--border)] flex items-center justify-between gap-2"
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
                <div className="px-1 pb-1 text-xs font-semibold text-[var(--accent)] border-b border-[var(--border)]">
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
                    return (
                      <div key={c.id} className="flex items-stretch">
                        <button
                          onClick={() => openConversation(c.id)}
                          className={`lr-inbox-row flex-1 min-w-0 text-left p-4 transition-colors hover:bg-[color:rgba(251,127,4,0.16)] focus-visible:bg-[color:rgba(251,127,4,0.16)] ${
                            linkedOpenCampaign ? "bg-gray-50/70 opacity-70" : ""
                          } ${selectedId === c.id ? "bg-[color:rgba(63,126,255,0.18)]" : ""}`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-medium flex items-center gap-2">
                                <span className="truncate">
                                  {c.leadName && c.leadName.length > 0 ? c.leadName : c.leadKey}
                                </span>
                                {c.walkIn ? (
                                  <span
                                    className="text-blue-600 text-lg leading-none"
                                    title="Walk-in"
                                    aria-label="Walk-in"
                                  >
                                    <svg
                                      viewBox="0 0 24 24"
                                      width="18"
                                      height="18"
                                      fill="currentColor"
                                      aria-hidden="true"
                                    >
                                      <path d="M13.5 5.5c.83 0 1.5-.67 1.5-1.5S14.33 2.5 13.5 2.5 12 3.17 12 4s.67 1.5 1.5 1.5zM9.8 8.9L7 23h2.1l1.8-8 2.1 2v6h2V15.5l-2.1-2 .6-3c1.3 1.5 3.1 2.5 5.2 2.5V11c-1.5 0-2.8-.9-3.4-2.1l-1-1.6c-.4-.6-1.1-1-1.8-1-.3 0-.5.1-.8.1L8 9.3V12h2V9.9l1.8-1z" />
                                    </svg>
                                  </span>
                                ) : null}
                                {renderDealTemperatureIcon(getDealTemperature(c), "text-lg")}
                                {c.contactPreference === "call_only" ? (
                                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-200">
                                    Prefers Call
                                  </span>
                                ) : null}
                                {c.status === "closed" ? (
                                  <span
                                    className={`text-xs px-2 py-1 rounded border ${
                                      c.closedReason === "sold"
                                        ? "bg-blue-50 text-blue-700 border-blue-200"
                                        : "bg-gray-50"
                                    }`}
                                  >
                                    {c.closedReason === "sold" ? "Sold" : "Closed"}
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
                                  <span className="text-xs px-2 py-1 rounded border bg-red-100 text-red-700 border-red-200">
                                    Hold
                                  </span>
                                ) : null}
                                {linkedOpenCampaign ? (
                                  <span className="text-xs px-2 py-1 rounded border bg-gray-100 text-gray-700 border-gray-300">
                                    Open in Inbox
                                  </span>
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
                              <>Draft: {renderBookingLinkLine(c.pendingDraftPreview)}</>
                            ) : (
                              renderBookingLinkLine(c.lastMessage?.body ?? "(no messages)")
                            )}
                          </div>

                          <div className="text-xs text-gray-500 mt-2">
                            {c.status === "closed" && c.closedAt
                              ? `closed: ${new Date(c.closedAt).toLocaleString()}`
                              : `updated: ${new Date(c.updatedAt).toLocaleString()}`}
                          </div>
                          {(() => {
                            const inboxOwner =
                              c.leadOwner?.name || c.leadOwner?.id || inboxTodoOwnerByConv.get(c.id);
                            return inboxOwner ? (
                              <div className="text-xs text-[var(--accent)] mt-1">Owner: {inboxOwner}</div>
                            ) : null;
                          })()}
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
                              className={`absolute right-0 mt-2 border rounded bg-white shadow z-10 ${
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
          <div className="p-4 text-sm text-gray-600 border rounded-lg">
            {inboxQuery.trim()
              ? "No conversations match your search."
              : view === "inbox"
                ? "No open conversations."
                : view === "campaigns"
                  ? "No campaign threads."
                  : "No archived conversations."}
          </div>
        )}
      </div>
    </>
  );
}
