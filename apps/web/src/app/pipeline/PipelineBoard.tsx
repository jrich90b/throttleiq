"use client";

import { useEffect, useMemo, useState } from "react";
import { SideNavIcon } from "../components/UiIcon";

type PipelineCard = {
  convId: string;
  name: string;
  owner: string | null;
  source: string | null;
  bike: string | null;
  quotedPrice: number | null;
  stage: string;
  lastCustomerAt: string | null;
  daysSinceTouch: number | null;
  nextDueAt: string | null;
  followUpHold?: boolean;
  appointmentAt: string | null;
  creditActive: boolean;
  atRisk: boolean;
};

type PipelineStageGroup = { stage: string; label: string; count: number; cards: PipelineCard[] };

type PipelineData = {
  ok: boolean;
  generatedAt: string;
  stages: PipelineStageGroup[];
  totals: { open: number; atRisk: number; financeActive: number; wonRecent: number; lostRecent: number };
};

const OPEN_STAGES = ["new", "engaged", "quoted", "appointment", "showed", "finance"];

function touchHeat(days: number | null): "fresh" | "warm" | "cold" | "none" {
  if (days == null) return "none";
  if (days <= 2) return "fresh";
  if (days < 7) return "warm";
  return "cold";
}

function fmtMoney(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function shortSource(source: string | null): string {
  const s = String(source ?? "").trim();
  if (!s) return "";
  if (/meta/i.test(s)) return "Meta";
  if (/room58/i.test(s)) return "Room58";
  if (/traffic log|walk/i.test(s)) return "Walk-in";
  if (/trade accelerator/i.test(s)) return "Trade-in";
  if (/hdfs|coa/i.test(s)) return "HDFS";
  if (/hd\.com|test ride/i.test(s)) return "HD.com";
  return s.split(/[-–]/)[0].trim().slice(0, 14);
}

export default function PipelineBoard({
  embedded = false,
  onOpenConversation
}: {
  embedded?: boolean;
  onOpenConversation?: (convId: string) => void;
} = {}) {
  const [data, setData] = useState<PipelineData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ownerFilter, setOwnerFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [atRiskOnly, setAtRiskOnly] = useState(false);

  async function load() {
    try {
      const r = await fetch("/api/pipeline");
      const j = (await r.json()) as PipelineData;
      if (!j.ok) throw new Error("pipeline fetch failed");
      setData(j);
      setError(null);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, []);

  const owners = useMemo(() => {
    const set = new Set<string>();
    for (const s of data?.stages ?? []) for (const c of s.cards) if (c.owner) set.add(c.owner);
    return [...set].sort();
  }, [data]);

  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const s of data?.stages ?? []) for (const c of s.cards) {
      const sh = shortSource(c.source);
      if (sh) set.add(sh);
    }
    return [...set].sort();
  }, [data]);

  function visible(card: PipelineCard): boolean {
    if (ownerFilter && (card.owner ?? "") !== ownerFilter) return false;
    if (sourceFilter && shortSource(card.source) !== sourceFilter) return false;
    if (atRiskOnly && !card.atRisk) return false;
    return true;
  }

  const openStages = (data?.stages ?? []).filter(s => OPEN_STAGES.includes(s.stage));
  const wonStage = (data?.stages ?? []).find(s => s.stage === "won");
  const lostStage = (data?.stages ?? []).find(s => s.stage === "lost");
  const filteredCounts = openStages.map(s => ({ ...s, cards: s.cards.filter(visible) }));
  const maxCount = Math.max(1, ...filteredCounts.map(s => s.cards.length));

  const inner = (
      <>
        <header className="flex flex-wrap items-end justify-between gap-4 mb-6">
          <div>
            <h1 className="lr-pipeline-title">Pipeline</h1>
            <p className="lr-pipeline-subtitle">
              {data ? (
                <>
                  <span className="lr-pipeline-stat">{data.totals.open}</span> open leads
                  <span className="lr-pipeline-dot">•</span>
                  <span className="lr-pipeline-stat lr-pipeline-stat--fire">{data.totals.financeActive}</span> in
                  finance
                  <span className="lr-pipeline-dot">•</span>
                  <span className="lr-pipeline-stat lr-pipeline-stat--risk">{data.totals.atRisk}</span> at risk
                  <span className="lr-pipeline-dot">•</span>
                  <span className="lr-pipeline-stat lr-pipeline-stat--won">{data.totals.wonRecent}</span> won (60d)
                </>
              ) : (
                "Loading…"
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              className="lr-pipeline-filter"
              value={ownerFilter}
              onChange={e => setOwnerFilter(e.target.value)}
            >
              <option value="">All owners</option>
              {owners.map(o => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <select
              className="lr-pipeline-filter"
              value={sourceFilter}
              onChange={e => setSourceFilter(e.target.value)}
            >
              <option value="">All sources</option>
              {sources.map(s => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <button
              className={`lr-pipeline-toggle ${atRiskOnly ? "lr-pipeline-toggle--on" : ""}`}
              onClick={() => setAtRiskOnly(v => !v)}
            >
              At risk
            </button>
            {!embedded ? (
              <a className="lr-pipeline-filter lr-pipeline-back" href="/">
                Inbox
              </a>
            ) : null}
          </div>
        </header>

        {error ? <div className="lr-pipeline-error">Couldn’t load pipeline: {error}</div> : null}

        {/* Funnel summary */}
        {data ? (
          <div className="lr-pipeline-funnel mb-8">
            {filteredCounts.map((s, i) => (
              <div key={s.stage} className="lr-pipeline-funnel-step" style={{ zIndex: 10 - i }}>
                <div
                  className={`lr-pipeline-funnel-bar lr-pipeline-funnel-bar--${s.stage}`}
                  style={{ height: `${18 + Math.round((s.cards.length / maxCount) * 64)}px` }}
                />
                <div className="lr-pipeline-funnel-count">{s.cards.length}</div>
                <div className="lr-pipeline-funnel-label">{s.label}</div>
              </div>
            ))}
            <div className="lr-pipeline-funnel-outcomes">
              <div className="lr-pipeline-outcome lr-pipeline-outcome--won">
                <span>{wonStage?.cards.filter(visible).length ?? 0}</span> Won
              </div>
              <div className="lr-pipeline-outcome lr-pipeline-outcome--lost">
                <span>{lostStage?.cards.filter(visible).length ?? 0}</span> Lost
              </div>
            </div>
          </div>
        ) : null}

        {/* Stage columns */}
        <div className="lr-pipeline-board">
          {filteredCounts.map(s => (
            <section key={s.stage} className="lr-pipeline-col">
              <div className="lr-pipeline-col-head">
                <span className={`lr-pipeline-col-dot lr-pipeline-funnel-bar--${s.stage}`} />
                <span className="lr-pipeline-col-title">{s.label}</span>
                <span className="lr-pipeline-col-count">{s.cards.length}</span>
              </div>
              <div className="lr-pipeline-col-cards">
                {s.cards.length === 0 ? <div className="lr-pipeline-empty">No leads</div> : null}
                {s.cards.map(c => (
                  <a
                    key={c.convId}
                    href={`/?convId=${encodeURIComponent(c.convId)}`}
                    onClick={
                      onOpenConversation
                        ? e => {
                            e.preventDefault();
                            onOpenConversation(c.convId);
                          }
                        : undefined
                    }
                    className={`lr-pipeline-card ${c.atRisk ? "lr-pipeline-card--risk" : ""}`}
                  >
                    <div className="lr-pipeline-card-top">
                      <span className="lr-pipeline-card-name">{c.name}</span>
                      {c.creditActive ? (
                        <span title="Active financing" className="inline-flex text-orange-500">
                          <SideNavIcon name="flame" className="w-3.5 h-3.5" />
                        </span>
                      ) : null}
                    </div>
                    {c.bike ? <div className="lr-pipeline-card-bike">{c.bike}</div> : null}
                    <div className="lr-pipeline-card-meta">
                      {c.quotedPrice ? (
                        <span className="lr-pipeline-card-price">{fmtMoney(c.quotedPrice)}</span>
                      ) : null}
                      {c.appointmentAt ? (
                        <span className="lr-pipeline-card-appt">
                          <SideNavIcon name="calendar" className="w-3.5 h-3.5 inline-block align-[-2px] mr-1" />
                          {fmtWhen(c.appointmentAt)}
                        </span>
                      ) : c.followUpHold ? (
                        // A held follow-up freezes nextDueAt — show the hold, not a stale date.
                        <span className="lr-pipeline-card-due">on hold</span>
                      ) : c.nextDueAt ? (
                        <span className="lr-pipeline-card-due">↻ {fmtWhen(c.nextDueAt)}</span>
                      ) : null}
                    </div>
                    <div className="lr-pipeline-card-foot">
                      {c.owner ? <span className="lr-pipeline-card-owner">{c.owner.split(" ")[0]}</span> : <span />}
                      <span className={`lr-pipeline-card-touch lr-pipeline-card-touch--${touchHeat(c.daysSinceTouch)}`}>
                        {c.daysSinceTouch == null
                          ? "no reply yet"
                          : c.daysSinceTouch === 0
                            ? "today"
                            : `${c.daysSinceTouch}d ago`}
                      </span>
                    </div>
                  </a>
                ))}
              </div>
            </section>
          ))}
        </div>
      </>
  );
  if (embedded) return <div className="lr-pipeline-embedded">{inner}</div>;
  return (
    <div className="lr-app-theme min-h-screen lr-pipeline-root">
      <div className="lr-app-main-panel min-h-screen px-4 py-6 md:px-8">{inner}</div>
    </div>
  );
}
