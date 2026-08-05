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

type MarketingListFilters = {
  channel: "sms" | "email";
  modelQuery: string | null;
  condition: string | null;
  source: string | null;
  activeWithinDays: number | null;
  includeClosed: boolean;
};
type MarketingListRow = {
  convId: string;
  leadKey: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  source: string | null;
  modelInterest: string | null;
  lastInboundAt: string | null;
  status: "open" | "closed";
};
type MarketingListResult = {
  generatedAt: string;
  channel: "sms" | "email";
  totalConsidered: number;
  rows: MarketingListRow[];
  excluded: { missingContact: number; optedOut: number; suppressed: number; watchOptOut: number };
};

const EMPTY_FILTERS: MarketingListFilters = {
  channel: "sms",
  modelQuery: null,
  condition: null,
  source: null,
  activeWithinDays: 90,
  includeClosed: false
};

function csvEscape(value: string | null): string {
  const s = value ?? "";
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(result: MarketingListResult) {
  const header = "name,phone,email,model_interest,source,last_reply,status";
  const lines = result.rows.map(r =>
    [r.name, r.phone, r.email, r.modelInterest, r.source, r.lastInboundAt, r.status]
      .map(csvEscape)
      .join(",")
  );
  const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `marketing-list-${result.channel}-${result.generatedAt.slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

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
  const [mlDescribe, setMlDescribe] = useState("");
  const [mlFilters, setMlFilters] = useState<MarketingListFilters>(EMPTY_FILTERS);
  const [mlBuilding, setMlBuilding] = useState(false);
  const [mlError, setMlError] = useState<string | null>(null);
  const [mlResult, setMlResult] = useState<MarketingListResult | null>(null);

  async function buildList(body: { describe: string } | { filters: MarketingListFilters }) {
    if (mlBuilding) return;
    setMlBuilding(true);
    setMlError(null);
    setMlResult(null);
    try {
      const r = await fetch("/api/copilot/marketing-list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await r.json();
      if (!r.ok || !data?.ok) {
        setMlError(
          r.status === 429
            ? "The copilot hit today's AI budget — build the list with the manual filters instead."
            : r.status === 503
              ? "The copilot's AI is unavailable — build the list with the manual filters instead."
              : String(data?.error ?? "List build failed.")
        );
        return;
      }
      if (data.filters) setMlFilters({ ...EMPTY_FILTERS, ...data.filters });
      setMlResult(data.result);
    } catch {
      setMlError("List build failed.");
    } finally {
      setMlBuilding(false);
    }
  }

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

        <div className="rounded-xl border border-slate-200 bg-white shadow-sm mt-6">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200">
            <SideNavIcon name="tag" className="w-4 h-4 text-slate-700" />
            <h2 className="text-sm font-semibold text-slate-900">Marketing lists</h2>
            <span className="ml-auto text-xs text-slate-500">
              builds a list only — nothing is ever sent from here
            </span>
          </div>
          <div className="p-4">
            <label htmlFor="ml-describe" className="block text-sm font-medium text-slate-700 mb-2">
              Describe the list
            </label>
            <div className="flex gap-2 mb-4">
              <input
                id="ml-describe"
                className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-500"
                placeholder='e.g. "everyone interested in a used Street Glide in the last 90 days"'
                value={mlDescribe}
                maxLength={500}
                onChange={e => setMlDescribe(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && mlDescribe.trim()) void buildList({ describe: mlDescribe.trim() });
                }}
              />
              <button
                className="rounded-lg bg-slate-900 text-white px-4 py-2 font-medium disabled:opacity-50"
                disabled={mlBuilding || !mlDescribe.trim()}
                onClick={() => void buildList({ describe: mlDescribe.trim() })}
              >
                {mlBuilding ? "Building…" : "Build with AI"}
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-3">
              <label className="text-xs text-slate-600">
                Channel
                <select
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
                  value={mlFilters.channel}
                  onChange={e => setMlFilters(f => ({ ...f, channel: e.target.value as "sms" | "email" }))}
                >
                  <option value="sms">Text (SMS)</option>
                  <option value="email">Email</option>
                </select>
              </label>
              <label className="text-xs text-slate-600">
                Model contains
                <input
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
                  placeholder="street glide"
                  value={mlFilters.modelQuery ?? ""}
                  onChange={e => setMlFilters(f => ({ ...f, modelQuery: e.target.value || null }))}
                />
              </label>
              <label className="text-xs text-slate-600">
                Condition
                <select
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
                  value={mlFilters.condition ?? ""}
                  onChange={e => setMlFilters(f => ({ ...f, condition: e.target.value || null }))}
                >
                  <option value="">Any</option>
                  <option value="new">New</option>
                  <option value="used">Used</option>
                </select>
              </label>
              <label className="text-xs text-slate-600">
                Source contains
                <input
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
                  placeholder="Facebook"
                  value={mlFilters.source ?? ""}
                  onChange={e => setMlFilters(f => ({ ...f, source: e.target.value || null }))}
                />
              </label>
              <label className="text-xs text-slate-600">
                Active within (days)
                <input
                  type="number"
                  min={1}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
                  value={mlFilters.activeWithinDays ?? ""}
                  onChange={e =>
                    setMlFilters(f => ({
                      ...f,
                      activeWithinDays: e.target.value ? Number(e.target.value) : null
                    }))
                  }
                />
              </label>
              <label className="text-xs text-slate-600 flex flex-col">
                Include closed leads
                <span className="mt-2 inline-flex items-center gap-2 text-sm text-slate-900">
                  <input
                    type="checkbox"
                    checked={mlFilters.includeClosed}
                    onChange={e => setMlFilters(f => ({ ...f, includeClosed: e.target.checked }))}
                  />
                  yes
                </span>
              </label>
            </div>
            <button
              className="rounded-lg border border-slate-400 bg-slate-100 text-slate-900 px-4 py-2 text-sm font-medium disabled:opacity-50"
              disabled={mlBuilding}
              onClick={() => void buildList({ filters: mlFilters })}
            >
              Build from filters
            </button>

            {mlError ? <div className="mt-3 text-sm text-red-700">{mlError}</div> : null}
            {mlResult ? (
              <div className="mt-4">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="text-sm font-medium text-slate-900">
                    {mlResult.rows.length} lead{mlResult.rows.length === 1 ? "" : "s"} on the list
                  </div>
                  <div className="text-xs text-slate-600">
                    kept out for compliance: {mlResult.excluded.optedOut} opted out ·{" "}
                    {mlResult.excluded.suppressed} on the STOP list · {mlResult.excluded.watchOptOut} asked to
                    stop alerts · {mlResult.excluded.missingContact} missing contact info
                  </div>
                  <button
                    className="ml-auto rounded-lg bg-slate-900 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                    disabled={mlResult.rows.length === 0}
                    onClick={() => downloadCsv(mlResult)}
                  >
                    Download CSV
                  </button>
                </div>
                {mlResult.rows.length === 0 ? (
                  <div className="mt-3 text-sm text-slate-600">No leads match these filters.</div>
                ) : (
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                          <th className="py-1.5 pr-3 font-medium">Name</th>
                          <th className="py-1.5 pr-3 font-medium">Contact</th>
                          <th className="py-1.5 pr-3 font-medium">Model interest</th>
                          <th className="py-1.5 pr-3 font-medium">Source</th>
                          <th className="py-1.5 font-medium">Last reply</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {mlResult.rows.slice(0, 50).map(row => (
                          <tr key={row.leadKey}>
                            <td className="py-1.5 pr-3">
                              <a
                                href={`/conversations/${encodeURIComponent(row.convId)}`}
                                className="text-slate-900 hover:underline"
                              >
                                {row.name || row.phone || row.email || row.convId}
                              </a>
                            </td>
                            <td className="py-1.5 pr-3 text-slate-600">
                              {mlResult.channel === "sms" ? row.phone : row.email}
                            </td>
                            <td className="py-1.5 pr-3 text-slate-600">{row.modelInterest ?? "—"}</td>
                            <td className="py-1.5 pr-3 text-slate-600">{row.source ?? "—"}</td>
                            <td className="py-1.5 text-slate-600">{formatWhen(row.lastInboundAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {mlResult.rows.length > 50 ? (
                      <div className="mt-2 text-xs text-slate-500">
                        Showing 50 of {mlResult.rows.length} — the CSV has them all.
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
