"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { SideNavIcon } from "../../components/UiIcon";

type Message = {
  id: string;
  direction: "in" | "out";
  from: string;
  to: string;
  body: string;
  at: string;
  provider?: string;
  actorUserId?: string;
  actorUserName?: string;
  draftStatus?: "pending" | "stale";
};

type Conversation = {
  id: string;
  leadKey: string;
  mode?: "autopilot" | "suggest" | "human";
  status?: "open" | "closed";
  closedAt?: string | null;
  closedReason?: string | null;
  messages: Message[];
};

function isPhoneLogAdfBody(text?: string | null) {
  const raw = String(text ?? "");
  if (/phone log\s*\(adf\)/i.test(raw)) return true;
  if (!/source:\s*traffic\s*log\s*pro/i.test(raw)) return false;
  return /\b(called|customer\s+called|phone\s+call|call\s+log|spoke\s+(to|with)|talked\s+(to|with)|voicemail)\b/i.test(raw);
}

function getMessageProviderDisplayLabel(
  message: Pick<Message, "direction" | "provider" | "actorUserName" | "body">
): string {
  const provider = String(message.provider ?? "").trim();
  const actorName = String(message.actorUserName ?? "").trim();
  if (provider === "payment_event") return "Payment";
  if (message.direction === "out") {
    if (provider === "draft_ai") return "AI";
    if (provider === "twilio" || provider === "human" || provider === "sendgrid") return actorName || "AI";
  }
  if (message.direction === "in") {
    if (provider === "twilio") return "Customer";
    if (provider === "web_widget") return "WEB TEXT WIDGET";
    if (provider === "sendgrid_adf") return isPhoneLogAdfBody(message.body) ? "PHONE LOG (ADF)" : "WEB LEAD (ADF)";
    if (provider === "sendgrid") return "Email";
  }
  return provider || "?";
}

function findPendingDraft(messages: Message[]): Message | null {
  let lastDraftIdx = -1;
  let lastSentIdx = -1;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.direction !== "out") continue;

    if (m.provider === "draft_ai" && m.draftStatus !== "stale") lastDraftIdx = i;
    if (m.provider === "human" || m.provider === "twilio") lastSentIdx = i;
  }

  if (lastDraftIdx > lastSentIdx) return messages[lastDraftIdx];
  return null;
}

export default function ConversationPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [conv, setConv] = useState<Conversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [sendBody, setSendBody] = useState("");
  const [closeReason, setCloseReason] = useState("sold");
  const [modeSaving, setModeSaving] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);

  const isHuman = conv?.mode === "human";

  const pendingDraft = useMemo(() => {
    if (!conv) return null;
    return findPendingDraft(conv.messages);
  }, [conv]);

  async function load() {
    if (!id) return;
    setLoading(true);
    const r = await fetch(`/api/conversations/${id}`, { cache: "no-store" });
    const data = await r.json();
    setConv(data?.conversation ?? null);
    setLoading(false);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Prefill reply box with pending draft (only if the rep hasn't started typing)
  useEffect(() => {
    if (!pendingDraft) return;
    if (sendBody.trim().length > 0) return;
    setSendBody(pendingDraft.body);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDraft?.id]);

  async function send() {
    if (!id) return;
    const body = sendBody.trim();
    if (!body) return;
    const draftId = pendingDraft?.id;

    await fetch(`/api/conversations/${id}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draftId ? { body, draftId, channel: "sms" } : { body, channel: "sms" })
    });

    setSendBody("");
    await load();
  }

  async function closeConv() {
    if (!id) return;
    await fetch(`/api/conversations/${id}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: closeReason })
    });
    await load();
  }

  async function setMode(mode: "human" | "suggest") {
    if (!id) return;
    setModeSaving(true);
    setModeError(null);
    setConv(prev => (prev ? { ...prev, mode } : prev));
    const resp = await fetch(`/api/conversations/${id}/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode })
    });
    const payload = await resp.json().catch(() => null);
    if (!resp.ok || payload?.ok === false) {
      setModeError(payload?.error ?? "Failed to update mode");
    }
    if (payload?.conversation) {
      setConv(payload.conversation);
    } else {
      await load();
    }
    setModeSaving(false);
  }

  if (loading) {
    return (
      <main className="p-6 max-w-5xl mx-auto">
        <Link href="/" className="text-sm underline">← Back</Link>
        <div className="mt-4">Loading…</div>
      </main>
    );
  }

  if (!conv) {
    return (
      <main className="p-6 max-w-5xl mx-auto">
        <Link href="/" className="text-sm underline">← Back</Link>
        <div className="mt-4">Conversation not found.</div>
      </main>
    );
  }

  return (
    <main className="p-6 max-w-5xl mx-auto">
      <Link href="/" className="text-sm underline">← Back</Link>

      <div className="mt-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{conv.leadKey}</h1>
        <div className="flex items-center gap-2">
          <button
            className={`px-2 py-1 border rounded text-sm cursor-pointer ${isHuman ? "font-semibold bg-black text-white" : "hover:bg-gray-50"}`}
            onClick={() => setMode(isHuman ? "suggest" : "human")}
            title={isHuman ? "Disable human override" : "Human takeover"}
          >
            <SideNavIcon name="user" className="w-4 h-4 inline-block align-[-3px]" />
          </button>
          {modeSaving ? <span className="text-xs text-gray-500">Saving…</span> : null}
        </div>
        {conv.status === "closed" ? (
          <span className="text-xs px-2 py-1 rounded border bg-gray-50">
            Closed{conv.closedReason ? `: ${conv.closedReason}` : ""}
          </span>
        ) : null}
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
        {conv.messages.filter(m => m.draftStatus !== "stale").map(m => {
          const isPending = pendingDraft?.id === m.id;
          const isPaymentEvent = m.provider === "payment_event";

          return (
            <div key={m.id} className={`text-sm ${m.direction === "in" || isPaymentEvent ? "" : "text-right"}`}>
              <div className="text-xs text-gray-500">
                {isPaymentEvent ? "PAYMENT" : m.direction.toUpperCase()} • {getMessageProviderDisplayLabel(m)} • {new Date(m.at).toLocaleString()}
                {isPending ? " • DRAFT (not sent)" : ""}
              </div>
              <div
                className={`inline-block mt-1 px-3 py-2 rounded border max-w-[85%] whitespace-pre-wrap ${
                  isPaymentEvent ? "bg-emerald-50 text-emerald-950 border-emerald-200" : ""
                }`}
              >
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

      {conv.status !== "closed" ? (
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
        </div>
      ) : (
        <div className="mt-4 text-xs text-gray-500">
          Closed {conv.closedAt ? `at ${new Date(conv.closedAt).toLocaleString()}` : ""}
        </div>
      )}

      <p className="mt-2 text-xs text-gray-500">
        Send is still log-only for now (no Twilio send yet). Autopilot mode affects inbound SMS auto-replies.
      </p>
    </main>
  );
}
