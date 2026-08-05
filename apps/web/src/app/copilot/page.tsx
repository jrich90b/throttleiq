"use client";

/**
 * Console Copilot (Phase 1, docs/console_copilot_phase1.md) — manager-only, READ-ONLY.
 * Hot leads + store stats come from the deterministic GET /copilot/insights; the Ask box
 * sends one question per click to POST /copilot/ask (daily-capped upstream). Explicit
 * light palette throughout (page is its own surface, not a dark-shell island) per the
 * AGENTS.md contrast guardrail.
 */

import { useEffect, useState } from "react";
import { SideNavIcon } from "../components/UiIcon";

type LeadHeatReason = { key: string; label: string; points: number };
type LeadHeat = {
  convId: string;
  name: string | null;
  phone: string | null;
  source: string | null;
  score: number;
  temperature: "hot" | "warm" | "cold";
  reasons: LeadHeatReason[];
  lastInboundAt: string | null;
};
type CopilotSnapshot = {
  generatedAt: string;
  totals: {
    openLeads: number;
    hot: number;
    warm: number;
    openTasks: number;
    overdueTasks: number;
    visitProposedNotConfirmed: number;
    activeWatches: number;
  };
  bySource: { source: string; count: number }[];
  hotLeads: LeadHeat[];
};

const TEMP_BADGE: Record<LeadHeat["temperature"], string> = {
  hot: "bg-red-600 text-white",
  warm: "bg-amber-500 text-white",
  cold: "bg-slate-400 text-white"
};

function formatWhen(iso: string | null): string {
  if (!iso) return "no reply yet";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "no reply yet";
  const mins = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function CopilotPage() {
  const [snapshot, setSnapshot] = useState<CopilotSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<{ text: string; leadRefs: string[] } | null>(null);
  const [askError, setAskError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/copilot/insights", { cache: "no-store" });
        const data = await r.json();
        if (cancelled) return;
        if (!r.ok || !data?.ok) {
          setLoadError(
            r.status === 403 ? "Copilot is manager-only." : String(data?.error ?? "Failed to load insights.")
          );
          return;
        }
        setSnapshot(data.snapshot);
      } catch {
        if (!cancelled) setLoadError("Failed to load insights.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function ask(q?: string) {
    const asked = (q ?? question).trim();
    if (!asked || asking) return;
    setAsking(true);
    setAskError(null);
    setAnswer(null);
    try {
      const r = await fetch("/api/copilot/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: asked })
      });
      const data = await r.json();
      if (!r.ok || !data?.ok) {
        setAskError(
          r.status === 429
            ? "The copilot hit today's question budget — try again tomorrow."
            : r.status === 503
              ? "The copilot's AI is unavailable right now. The stats above are still live."
              : String(data?.error ?? "Ask failed.")
        );
        return;
      }
      setAnswer({ text: String(data.answer ?? ""), leadRefs: Array.isArray(data.leadRefs) ? data.leadRefs : [] });
    } catch {
      setAskError("Ask failed.");
    } finally {
      setAsking(false);
    }
  }

  const totals = snapshot?.totals;
  const statTiles: { label: string; value: number | string }[] = totals
    ? [
        { label: "Open leads", value: totals.openLeads },
        { label: "Hot", value: totals.hot },
        { label: "Warm", value: totals.warm },
        { label: "Open tasks", value: totals.openTasks },
        { label: "Overdue tasks", value: totals.overdueTasks },
        { label: "Visits awaiting confirm", value: totals.visitProposedNotConfirmed },
        { label: "Active watches", value: totals.activeWatches }
      ]
    : [];

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <div className="max-w-5xl mx-auto px-4 py-6">
        <div className="flex items-center gap-3 mb-6">
          <span className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-slate-900 text-white">
            <SideNavIcon name="bolt" />
          </span>
          <div>
            <h1 className="text-xl font-semibold">Copilot</h1>
            <p className="text-sm text-slate-600">
              Live answers from your lead data — read-only, nothing here texts a customer.
            </p>
          </div>
          <a href="/" className="ml-auto text-sm font-medium text-slate-700 hover:text-slate-900 underline">
            Back to inbox
          </a>
        </div>

        {loadError ? (
          <div className="rounded-lg border border-red-300 bg-red-50 text-red-800 px-4 py-3 mb-6">{loadError}</div>
        ) : null}

        <div className="rounded-xl border border-slate-200 bg-white shadow-sm p-4 mb-6">
          <label htmlFor="copilot-question" className="block text-sm font-medium text-slate-700 mb-2">
            Ask about your leads
          </label>
          <div className="flex gap-2">
            <input
              id="copilot-question"
              className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-500"
              placeholder='e.g. "Who should we call first today?"'
              value={question}
              maxLength={500}
              onChange={e => setQuestion(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") ask();
              }}
            />
            <button
              className="rounded-lg bg-slate-900 text-white px-4 py-2 font-medium disabled:opacity-50"
              disabled={asking || !question.trim()}
              onClick={() => ask()}
            >
              {asking ? "Thinking…" : "Ask"}
            </button>
          </div>
          <div className="flex flex-wrap gap-2 mt-3">
            {["Who should we call first today?", "How many visits are waiting on a confirmation?", "Which sources are my open leads coming from?"].map(
              s => (
                <button
                  key={s}
                  className="text-xs rounded-full border border-slate-300 bg-slate-50 px-3 py-1 text-slate-700 hover:bg-slate-200"
                  onClick={() => {
                    setQuestion(s);
                    void ask(s);
                  }}
                >
                  {s}
                </button>
              )
            )}
          </div>
          {askError ? <div className="mt-3 text-sm text-red-700">{askError}</div> : null}
          {answer ? (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="text-sm text-slate-900 whitespace-pre-wrap">{answer.text}</div>
              {answer.leadRefs.length > 0 ? (
                <div className="flex flex-wrap gap-2 mt-2">
                  {answer.leadRefs.map(id => (
                    <a
                      key={id}
                      href={`/conversations/${encodeURIComponent(id)}`}
                      className="text-xs rounded-full bg-slate-900 text-white px-3 py-1 hover:bg-slate-700"
                    >
                      Open {id}
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {totals ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
            {statTiles.map(t => (
              <div key={t.label} className="rounded-xl border border-slate-200 bg-white shadow-sm px-3 py-3 text-center">
                <div className="text-2xl font-semibold text-slate-900">{t.value}</div>
                <div className="text-xs text-slate-600 mt-1">{t.label}</div>
              </div>
            ))}
          </div>
        ) : !loadError ? (
          <div className="text-sm text-slate-600 mb-6">Loading insights…</div>
        ) : null}

        {snapshot ? (
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200">
              <SideNavIcon name="flame" className="w-4 h-4 text-red-600" />
              <h2 className="text-sm font-semibold text-slate-900">Leads needing attention</h2>
              <span className="ml-auto text-xs text-slate-500">
                computed {formatWhen(snapshot.generatedAt)} · every score shows its reasons
              </span>
            </div>
            {snapshot.hotLeads.length === 0 ? (
              <div className="px-4 py-6 text-sm text-slate-600">Nothing urgent right now.</div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {snapshot.hotLeads.map(lead => (
                  <li key={lead.convId} className="px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span
                      className={`text-[11px] font-semibold uppercase rounded-full px-2 py-0.5 ${TEMP_BADGE[lead.temperature]}`}
                    >
                      {lead.temperature}
                    </span>
                    <a
                      href={`/conversations/${encodeURIComponent(lead.convId)}`}
                      className="font-medium text-slate-900 hover:underline"
                    >
                      {lead.name || lead.phone || lead.convId}
                    </a>
                    {lead.phone && lead.name ? <span className="text-sm text-slate-500">{lead.phone}</span> : null}
                    {lead.source ? <span className="text-xs text-slate-500">via {lead.source}</span> : null}
                    <span className="ml-auto text-xs text-slate-500">last reply {formatWhen(lead.lastInboundAt)}</span>
                    <div className="w-full flex flex-wrap gap-1.5 mt-1">
                      {lead.reasons.map(r => (
                        <span
                          key={r.key}
                          className="text-[11px] rounded-full bg-slate-100 border border-slate-200 text-slate-700 px-2 py-0.5"
                        >
                          {r.label}
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
