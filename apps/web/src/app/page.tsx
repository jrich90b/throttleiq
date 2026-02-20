"use client";

import { useEffect, useMemo, useState } from "react";

type SystemMode = "suggest" | "autopilot";

type ConversationListItem = {
  id: string;
  leadKey: string;
  mode?: "suggest" | "human";
  status?: "open" | "closed";
  closedAt?: string | null;
  closedReason?: string | null;
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

type SuppressionItem = {
  phone: string;
  addedAt: string;
  reason?: string;
  source?: string;
};

export default function Home() {
  const [mode, setMode] = useState<SystemMode>("suggest");
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [suppressions, setSuppressions] = useState<SuppressionItem[]>([]);
  const [newSuppression, setNewSuppression] = useState("");
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"inbox" | "archive">("inbox");
  const [section, setSection] = useState<"inbox" | "todos" | "suppressions">("inbox");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedConv, setSelectedConv] = useState<ConversationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [sendBody, setSendBody] = useState("");
  const [editPromptOpen, setEditPromptOpen] = useState(false);
  const [editNote, setEditNote] = useState("");
  const [pendingSend, setPendingSend] = useState<{ body: string; draftId?: string } | null>(null);
  const [closeReason, setCloseReason] = useState("sold");
  const [modeSaving, setModeSaving] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);

  async function load() {
    setLoading(true);

    const [s, c] = await Promise.all([
      fetch("/api/settings", { cache: "no-store" }),
      fetch("/api/conversations", { cache: "no-store" })
    ]);
    const [t, sup] = await Promise.all([
      fetch("/api/todos", { cache: "no-store" }),
      fetch("/api/suppressions", { cache: "no-store" })
    ]);

    const settings = await s.json();
    const convs = await c.json();
    const todosResp = await t.json();
    const suppressionsResp = await sup.json();

    setMode((settings?.mode as SystemMode) ?? "suggest");
    setConversations(
      (convs?.conversations as ConversationListItem[])?.map(c => ({
        ...c,
        mode: c.mode ?? "suggest"
      })) ?? []
    );
    setTodos((todosResp?.todos as TodoItem[]) ?? []);
    setSuppressions((suppressionsResp?.suppressions as SuppressionItem[]) ?? []);
    setLoading(false);
  }

  async function loadConversation(id: string) {
    setDetailLoading(true);
    const r = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { cache: "no-store" });
    const data = await r.json();
    setSelectedConv(data?.conversation ?? null);
    setDetailLoading(false);
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

  useEffect(() => {
    if (!pendingDraft) return;
    if (sendBody.trim().length > 0) return;
    setSendBody(pendingDraft.body);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDraft?.id]);

  async function markTodoDone(todo: TodoItem) {
    await fetch("/api/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ convId: todo.convId, todoId: todo.id })
    });
    await load();
  }

  async function doSend(payload: { body: string; draftId?: string; editNote?: string }) {
    if (!selectedConv) return;
    const resp = await fetch(`/api/conversations/${encodeURIComponent(selectedConv.id)}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await resp.json().catch(() => null);
    setSendBody("");
    if (data?.conversation) {
      const conv = data.conversation;
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
    const body = sendBody.trim();
    if (!body) return;
    const draftId = pendingDraft?.id;
    const edited = !!pendingDraft && pendingDraft.body.trim() !== body.trim();
    if (edited) {
      setPendingSend({ body, draftId });
      setEditNote("");
      setEditPromptOpen(true);
      return;
    }
    await doSend(draftId ? { body, draftId } : { body });
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

  async function setHumanMode(next: "human" | "suggest") {
    if (!selectedConv) return;
    setModeSaving(true);
    setModeError(null);
    setSelectedConv(prev => (prev ? { ...prev, mode: next } : prev));
    const resp = await fetch(`/api/conversations/${encodeURIComponent(selectedConv.id)}/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: next })
    });
    const payload = await resp.json().catch(() => null);
    if (!resp.ok || payload?.ok === false) {
      setModeError(payload?.error ?? "Failed to update mode");
    }
    if (payload?.conversation) setSelectedConv(payload.conversation);
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

  return (
    <main className="h-screen flex bg-white">
      <aside className="w-16 border-r flex flex-col items-center py-4 gap-4">
        <div className="text-lg font-semibold">TI</div>
        <button
          className={`w-10 h-10 rounded flex items-center justify-center border ${section === "inbox" ? "bg-gray-100" : ""}`}
          title="Inbox"
          onClick={() => setSection("inbox")}
        >
          📥
        </button>
        <button
          className={`w-10 h-10 rounded flex items-center justify-center border ${section === "todos" ? "bg-gray-100" : ""}`}
          title="To-Dos"
          onClick={() => setSection("todos")}
        >
          ✅
        </button>
        <button
          className={`w-10 h-10 rounded flex items-center justify-center border ${section === "suppressions" ? "bg-gray-100" : ""}`}
          title="Suppressions"
          onClick={() => setSection("suppressions")}
        >
          ⛔
        </button>
        <div className="mt-auto text-xs text-gray-500">{loading ? "…" : ""}</div>
      </aside>

      <section className="w-96 border-r p-4 overflow-y-auto">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">
              {section === "inbox" ? "Inbox" : section === "todos" ? "To-Do Inbox" : "Suppression List"}
            </h1>
            <p className="text-xs text-gray-600 mt-1">
              {section === "inbox"
                ? `${conversations.length} conversations`
                : section === "todos"
                  ? `${todos.length} open`
                  : `${suppressions.length} suppressed`}
            </p>
          </div>
          <div className="border rounded-lg p-2">
            <div className="text-[10px] text-gray-500">System Mode</div>
            <div className="mt-1 flex gap-1">
              <button
                className={`px-2 py-1 border rounded text-xs ${mode === "suggest" ? "font-semibold" : ""}`}
                onClick={() => updateMode("suggest")}
              >
                Suggest
              </button>
              <button
                className={`px-2 py-1 border rounded text-xs ${mode === "autopilot" ? "font-semibold" : ""}`}
                onClick={() => updateMode("autopilot")}
                title="Autopilot will auto-reply on inbound SMS"
              >
                AI
              </button>
            </div>
          </div>
        </div>

        {section === "inbox" ? (
          <>
            <div className="mt-4 flex items-center justify-between">
              <div className="flex gap-2">
                <button
                  className={`px-3 py-2 border rounded ${view === "inbox" ? "font-semibold" : ""}`}
                  onClick={() => setView("inbox")}
                >
                  Inbox
                </button>
                <button
                  className={`px-3 py-2 border rounded ${view === "archive" ? "font-semibold" : ""}`}
                  onClick={() => setView("archive")}
                >
                  Archive
                </button>
              </div>
              <div className="text-xs text-gray-500">
                {view === "inbox"
                  ? `Open: ${conversations.filter(c => !(c.status === "closed" || c.closedAt)).length}`
                  : `Closed: ${conversations.filter(c => c.status === "closed" || c.closedAt).length}`}
              </div>
            </div>

            <div className="mt-3 border rounded-lg divide-y">
              {conversations
                .filter(c =>
                  view === "inbox"
                    ? !(c.status === "closed" || c.closedAt)
                    : c.status === "closed" || c.closedAt
                )
                .map(c => (
                  <div key={c.id} className="flex items-stretch">
                    <button
                      onClick={() => setSelectedId(c.id)}
                      className={`block w-full text-left p-4 hover:bg-gray-50 ${selectedId === c.id ? "bg-gray-50" : ""}`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="font-medium flex items-center gap-2">
                            <span>{c.leadName && c.leadName.length > 0 ? c.leadName : c.leadKey}</span>
                            {c.status === "closed" ? (
                              <span className="text-xs px-2 py-1 rounded border bg-gray-50">Closed</span>
                            ) : null}
                          </div>
                          {c.vehicleDescription ? (
                            <div className="text-xs text-gray-500 mt-1">{c.vehicleDescription}</div>
                          ) : null}
                        </div>

                        <div className="flex items-center gap-2">
                          {c.mode === "human" ? <span title="Human override">👤</span> : null}
                          {c.pendingDraft ? <span className="text-xs px-2 py-1 rounded border">Draft</span> : null}
                          <span className="text-xs px-2 py-1 rounded border">{c.messageCount}</span>
                        </div>
                      </div>

                      <div className="text-sm text-gray-700 mt-2 line-clamp-2">
                        {c.pendingDraftPreview
                          ? `Draft: ${c.pendingDraftPreview}`
                          : (c.lastMessage?.body ?? "(no messages)")}
                      </div>

                      <div className="text-xs text-gray-500 mt-2">
                        {c.status === "closed" && c.closedAt
                          ? `closed: ${new Date(c.closedAt).toLocaleString()}`
                          : `updated: ${new Date(c.updatedAt).toLocaleString()}`}
                      </div>
                    </button>
                    <button
                      className="px-3 border-l text-sm text-red-600 hover:bg-red-50"
                      title="Delete conversation"
                      onClick={e => {
                        e.stopPropagation();
                        void deleteConvFromList(c.id);
                      }}
                    >
                      🗑️
                    </button>
                  </div>
                ))}

              {!loading &&
                conversations.filter(c =>
                  view === "inbox" ? !(c.status === "closed" || c.closedAt) : c.status === "closed" || c.closedAt
                ).length === 0 && (
                  <div className="p-4 text-sm text-gray-600">
                    {view === "inbox" ? "No open conversations." : "No archived conversations."}
                  </div>
                )}
            </div>
          </>
        ) : null}

        {section === "todos" ? (
          <div className="mt-3 border rounded-lg divide-y">
            {todos.map(t => (
              <div key={t.id} className="p-4 flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-medium">{t.leadKey}</div>
                  <div className="text-xs text-gray-500 mt-1">
                    {t.reason} • {new Date(t.createdAt).toLocaleString()}
                  </div>
                  <div className="text-sm text-gray-700 mt-2 line-clamp-3">{t.summary}</div>
                  <button
                    className="text-xs text-blue-600 mt-2 inline-block"
                    onClick={() => {
                      setSection("inbox");
                      setSelectedId(t.convId);
                    }}
                  >
                    Open conversation
                  </button>
                </div>
                <button className="px-3 py-2 border rounded text-sm" onClick={() => markTodoDone(t)}>
                  Done
                </button>
              </div>
            ))}
            {!loading && todos.length === 0 && (
              <div className="p-4 text-sm text-gray-600">No open To-Dos.</div>
            )}
          </div>
        ) : null}

        {section === "suppressions" ? (
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

      <section className="flex-1 p-6 overflow-y-auto">
        {section !== "inbox" ? (
          <div className="text-gray-500">Select “Inbox” to view a conversation.</div>
        ) : !selectedId ? (
          <div className="text-gray-500">Select a conversation to view details.</div>
        ) : detailLoading ? (
          <div className="text-gray-500">Loading…</div>
        ) : selectedConv ? (
          <div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-2xl font-semibold">{selectedConv.leadKey}</div>
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
                <button
                  className={`px-2 py-1 border rounded text-sm cursor-pointer ${selectedConv.mode === "human" ? "font-semibold bg-black text-white" : "hover:bg-gray-50"}`}
                  onClick={() => setHumanMode(selectedConv.mode === "human" ? "suggest" : "human")}
                  title={selectedConv.mode === "human" ? "Disable human override" : "Human takeover"}
                >
                  <span className="mr-1">👤</span>
                </button>
                {modeSaving ? <span className="text-xs text-gray-500">Saving…</span> : null}
              </div>
            </div>
            {modeError ? <div className="text-xs text-red-600 mt-1">{modeError}</div> : null}

            {pendingDraft ? (
              <div className="mt-4 border rounded-lg p-3 text-sm">
                <div className="font-medium">Draft ready to send</div>
                <div className="text-gray-600 mt-1">
                  The reply box below is prefilled. Edit if needed, then hit Send.
                </div>
              </div>
            ) : null}

            <div className="mt-6 border rounded-lg p-4 space-y-3">
              {selectedConv.messages
                .filter(m => m.draftStatus !== "stale")
                .map(m => {
                  const isPending = pendingDraft?.id === m.id;
                  return (
                    <div key={m.id} className={`text-sm ${m.direction === "in" ? "" : "text-right"}`}>
                      <div className="text-xs text-gray-500">
                        {m.direction.toUpperCase()} • {m.provider ?? "?"} •{" "}
                        {new Date(m.at).toLocaleString()}
                        {isPending ? " • DRAFT (not sent)" : ""}
                      </div>
                      <div className="inline-block mt-1 px-3 py-2 rounded border max-w-[85%] whitespace-pre-wrap">
                        {m.body}
                      </div>
                    </div>
                  );
                })}
            </div>

            <div className="mt-6 flex gap-2">
              <input
                value={sendBody}
                onChange={e => setSendBody(e.target.value)}
                className="flex-1 border rounded px-3 py-2"
                placeholder={pendingDraft ? "Edit draft then Send…" : "Type a message…"}
              />
              <button className="px-4 py-2 border rounded" onClick={send}>
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
    </main>
  );
}
