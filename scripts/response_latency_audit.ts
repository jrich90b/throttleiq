/**
 * Response-latency audit (Joe, 2026-06-13) — the gap the gate was blind to:
 * a draft can score 100 on tone and still lose the customer because it sat
 * unsent for hours. Measures TWO clocks per customer turn that got answered:
 *   agentDraft  — inbound → first draft_ai (the agent's own speed; graded)
 *   effective   — inbound → first SENT reply (what the customer experiences;
 *                 staff-gated in Suggest mode, so reported not hard-failed)
 *
 * This is also the first agent-grade vs ops-grade split: slow DRAFTS are an
 * agent/infra problem; slow SENDS are a Suggest-mode staffing decision.
 *
 * Usage:
 *   npx tsx scripts/response_latency_audit.ts [--store PATH] [--out-dir DIR] [--since-hours N]
 *   npx tsx scripts/response_latency_audit.ts --self-test
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import os from "node:os";

type AnyObj = Record<string, any>;

const MIN = 60_000;

function parseMs(input: unknown): number | null {
  const ms = Date.parse(String(input ?? ""));
  return Number.isFinite(ms) ? ms : null;
}

function isCustomerInbound(m: AnyObj): boolean {
  return (
    m?.direction === "in" &&
    (m?.provider === "twilio" || m?.provider === "web_widget") &&
    String(m?.body ?? "").trim().length > 0
  );
}

function isSentOutbound(m: AnyObj): boolean {
  return (
    m?.direction === "out" &&
    (m?.provider === "twilio" || m?.provider === "human" || m?.provider === "sendgrid") &&
    String(m?.body ?? "").trim().length > 0
  );
}

function isDraft(m: AnyObj): boolean {
  return m?.direction === "out" && m?.provider === "draft_ai";
}

/**
 * Did this SENT message start life as an agent draft? On approval the store folds the draft into
 * the outbound row — `originalDraftBody` + `draftUsed` + the `authoredBy` authorship stamp — and
 * the separate `draft_ai` row does not always survive. Measured on the live store 2026-08-17 over
 * the trailing 30 days: of 373 answered turns, 52 have NO `draft_ai` row yet their sent reply
 * carries this provenance. Those 52 are turns where the agent DID draft and staff USED it, and the
 * old single `turnsWithoutRealtimeDraft` counted every one of them as if the agent had said nothing.
 *
 * The fold keeps no draft TIMESTAMP, so these turns stay unmeasurable for speed — that is exactly
 * why they get their own counter instead of a guessed latency.
 */
function hasApprovedAgentDraft(m: AnyObj): boolean {
  return (
    String(m?.originalDraftBody ?? "").trim().length > 0 ||
    m?.draftUsed === true ||
    m?.authoredBy === "agent"
  );
}

export type LatencyPair = {
  convId: string;
  name: string;
  inboundAt: string;
  draftMin: number | null;
  sentMin: number | null;
  /**
   * Thread ownership, read from `conv.mode`. On a HUMAN-owned thread the agent stands down by
   * design, so "no draft" there is the product working, not a silent agent. This is the mode as it
   * reads NOW, not necessarily at the turn — good enough to attribute a count, never to grade one.
   */
  threadMode: string | null;
  /** The answering send carried agent-draft provenance (see hasApprovedAgentDraft). */
  approvedAgentDraft: boolean;
};

/**
 * One measurement per "the agent had to respond" event: the first inbound
 * since the last outbound, paired with the next draft and the next sent reply.
 */
export function collectLatencyPairs(conversations: AnyObj[], windowStartMs: number): LatencyPair[] {
  const pairs: LatencyPair[] = [];
  for (const conv of conversations ?? []) {
    if (!conv?.id) continue;
    const lead = conv.lead ?? {};
    const name =
      [lead.firstName, lead.lastName].map((v: any) => String(v ?? "").trim()).filter(Boolean).join(" ") ||
      String(conv.id);
    const msgs: AnyObj[] = Array.isArray(conv.messages) ? conv.messages : [];
    let pendingInboundMs: number | null = null;
    let pendingInboundAt = "";
    let draftMs: number | null = null;
    for (const m of msgs) {
      if (isCustomerInbound(m)) {
        if (pendingInboundMs == null) {
          pendingInboundMs = parseMs(m.at);
          pendingInboundAt = String(m.at ?? "");
          draftMs = null;
        }
        continue;
      }
      if (pendingInboundMs == null) continue;
      if (isDraft(m) && draftMs == null) {
        draftMs = parseMs(m.at);
        continue;
      }
      if (isSentOutbound(m)) {
        const sentMs = parseMs(m.at);
        if (pendingInboundMs >= windowStartMs) {
          pairs.push({
            convId: String(conv.id),
            name,
            inboundAt: pendingInboundAt,
            draftMin: draftMs != null ? (draftMs - pendingInboundMs) / MIN : null,
            sentMin: sentMs != null ? (sentMs - pendingInboundMs) / MIN : null,
            threadMode: conv.mode == null ? null : String(conv.mode),
            approvedAgentDraft: hasApprovedAgentDraft(m)
          });
        }
        pendingInboundMs = null;
        draftMs = null;
      }
    }
  }
  return pairs;
}

function pct(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx] * 10) / 10;
}

// A real-time webhook draft lands within minutes; anything later is a cadence
// follow-up draft (scheduler-generated), not a measure of agent response speed.
const REALTIME_DRAFT_WINDOW_MIN = 30;
// Replies more than a week out are cadence re-engagement, not a response to
// that turn — the tone audit's "missing response" already owns those.
const RESPONSE_CAP_MIN = 7 * 24 * 60;

export function summarizeLatency(pairs: LatencyPair[]) {
  // Agent speed: only real-time drafts (within the webhook window).
  const realtimeDrafts = pairs
    .map(p => p.draftMin)
    .filter((v): v is number => v != null && v >= 0 && v <= REALTIME_DRAFT_WINDOW_MIN);
  const noRealtimePairs = pairs.filter(p => p.draftMin == null || p.draftMin > REALTIME_DRAFT_WINDOW_MIN);
  const noRealtimeDraft = noRealtimePairs.length;
  // WHY there is no timed draft — because the single total reads as "the agent said nothing" and
  // mostly it is not that. This audit's own output on the live store, 2026-08-17, trailing 30d,
  // 373 answered turns, 322 with no timed draft:
  //     231  human-owned thread — staff mid-conversation, the agent standing down as designed
  //      55  a draft the staff SENT, folded into the outbound row with no timestamp left
  //      36  the real residual
  // Reporting the 322 alone invites the conclusion that the agent is silent on 86% of answered
  // turns. The honest figure is 36 — a 9x difference in how the same field reads.
  //
  // Precedence is deliberate: `approvedButUntimed` is tested FIRST, because a turn whose reply the
  // agent demonstrably wrote did NOT stand down — filing it under human-owned would be wrong even
  // when a human owns the thread. `unexplained` is therefore a true residual, and the three always
  // sum to `turnsWithoutRealtimeDraft` (pinned by the self-test).
  //
  // `turnsWithoutRealtimeDraft` itself is UNCHANGED, on purpose: the release gate grades
  // `slowOver5minCount` and `medianMin` off this same block, and re-defining a field in place is how
  // a threshold silently moves. This adds context, it moves nothing.
  const noDraftApprovedButUntimed = noRealtimePairs.filter(p => p.approvedAgentDraft).length;
  const noDraftHumanOwnedThread = noRealtimePairs.filter(
    p => !p.approvedAgentDraft && p.threadMode === "human"
  ).length;
  const noDraftUnexplained = noRealtimeDraft - noDraftApprovedButUntimed - noDraftHumanOwnedThread;
  // Effective customer-facing response: sends within the response cap.
  const sents = pairs
    .map(p => p.sentMin)
    .filter((v): v is number => v != null && v >= 0 && v <= RESPONSE_CAP_MIN);
  return {
    agentDraft: {
      n: realtimeDrafts.length,
      medianMin: pct(realtimeDrafts, 50),
      p90Min: pct(realtimeDrafts, 90),
      slowOver5minCount: realtimeDrafts.filter(v => v > 5).length,
      turnsWithoutRealtimeDraft: noRealtimeDraft,
      noDraftApprovedButUntimed,
      noDraftHumanOwnedThread,
      noDraftUnexplained
    },
    effective: {
      n: sents.length,
      medianMin: pct(sents, 50),
      p90Min: pct(sents, 90),
      under5minPct: sents.length ? Math.round((sents.filter(v => v <= 5).length / sents.length) * 100) : null,
      over1hPct: sents.length ? Math.round((sents.filter(v => v > 60).length / sents.length) * 100) : null
    }
  };
}

function selfTest() {
  const now = Date.parse("2026-06-13T18:00:00.000Z");
  const mk = (id: string, ev: Array<[string, string, string]>): AnyObj => ({
    id,
    lead: { firstName: id },
    messages: ev.map(([dir, provider, at]) => ({
      direction: dir,
      provider,
      at,
      body: dir === "in" ? "hi" : "reply"
    }))
  });
  const convs = [
    // Fast agent draft (1 min), slow send (3h later) — the Suggest bottleneck.
    mk("A", [
      ["in", "twilio", "2026-06-13T10:00:00.000Z"],
      ["out", "draft_ai", "2026-06-13T10:01:00.000Z"],
      ["out", "human", "2026-06-13T13:00:00.000Z"]
    ]),
    // Auto-sent fast (2 min) — agent in AI mode.
    mk("B", [
      ["in", "twilio", "2026-06-13T11:00:00.000Z"],
      ["out", "twilio", "2026-06-13T11:02:00.000Z"]
    ]),
    // Slow DRAFT (10 min) — an agent/infra problem, must be flagged.
    mk("C", [
      ["in", "twilio", "2026-06-13T12:00:00.000Z"],
      ["out", "draft_ai", "2026-06-13T12:10:00.000Z"],
      ["out", "twilio", "2026-06-13T12:10:30.000Z"]
    ]),
    // Inbound before the window — excluded.
    mk("D", [
      ["in", "twilio", "2026-06-10T09:00:00.000Z"],
      ["out", "twilio", "2026-06-10T09:05:00.000Z"]
    ])
  ];
  const windowStart = now - 24 * 60 * MIN;
  const pairs = collectLatencyPairs(convs, windowStart);
  const fail = (m: string) => {
    console.error("SELF-TEST FAIL:", m);
    process.exit(1);
  };
  if (pairs.length !== 3) fail(`expected 3 in-window pairs, got ${pairs.length}`);
  const s = summarizeLatency(pairs);
  if (s.agentDraft.slowOver5minCount !== 1) fail(`one slow draft (conv C), got ${s.agentDraft.slowOver5minCount}`);
  if (s.effective.under5minPct == null) fail("effective under5min computed");
  // A=180min, B=2min, C=0.5min → median 2, one over-1h (A).
  if (s.effective.over1hPct !== 33) fail(`one of three over 1h = 33%, got ${s.effective.over1hPct}`);
  if (s.agentDraft.n !== 2) fail(`two draft measurements (A,C), got ${s.agentDraft.n}`);

  // WHY a turn carries no timed draft — its own fixture, so the assertions above keep grading
  // exactly what they graded before. Four shapes, one per bucket, plus the precedence case.
  const mkAttr = (id: string, mode: string | null, sendFields: AnyObj): AnyObj => ({
    id,
    mode,
    lead: { firstName: id },
    messages: [
      { direction: "in", provider: "twilio", at: "2026-06-13T14:00:00.000Z", body: "hi" },
      { direction: "out", provider: "twilio", at: "2026-06-13T14:04:00.000Z", body: "reply", ...sendFields }
    ]
  });
  const attrPairs = collectLatencyPairs(
    [
      // Staff mid-conversation on a human-owned thread: the agent stands down BY DESIGN.
      mkAttr("human-standdown", "human", {}),
      // Suggest thread, no draft row, but the send is a draft staff approved — the store folded the
      // draft in and kept no timestamp. Each of the three provenance fields must be enough alone.
      mkAttr("approved-original-body", "suggest", { originalDraftBody: "the agent wrote this" }),
      mkAttr("approved-draft-used", "suggest", { draftUsed: true }),
      mkAttr("approved-authored-by", "suggest", { authoredBy: "agent" }),
      // PRECEDENCE: human-owned AND agent-written. The agent did not stand down, so this is an
      // approved-but-untimed draft, never a human standdown.
      mkAttr("human-thread-agent-draft", "human", { originalDraftBody: "the agent wrote this too" }),
      // The residual: suggest thread, nothing from the agent at all. This is the real gap.
      mkAttr("unexplained", "suggest", {})
    ],
    windowStart
  );
  const a = summarizeLatency(attrPairs).agentDraft;
  if (attrPairs.length !== 6) fail(`attribution fixture must yield 6 pairs, got ${attrPairs.length}`);
  if (a.n !== 0) fail(`attribution fixture has no draft_ai rows, so no timed drafts; got n=${a.n}`);
  if (a.turnsWithoutRealtimeDraft !== 6) fail(`all 6 lack a timed draft, got ${a.turnsWithoutRealtimeDraft}`);
  if (a.noDraftApprovedButUntimed !== 4) {
    fail(`4 sends carry agent-draft provenance (3 field shapes + the human-thread one), got ${a.noDraftApprovedButUntimed}`);
  }
  if (a.noDraftHumanOwnedThread !== 1) {
    fail(`only the pure human standdown counts as human-owned, got ${a.noDraftHumanOwnedThread}`);
  }
  if (a.noDraftUnexplained !== 1) fail(`one true residual, got ${a.noDraftUnexplained}`);
  // The invariant is the whole guard: whatever the buckets are, they must account for the total, or
  // a future edit can quietly drop turns out of the accounting and the residual reads healthy.
  const attributed = a.noDraftApprovedButUntimed + a.noDraftHumanOwnedThread + a.noDraftUnexplained;
  if (attributed !== a.turnsWithoutRealtimeDraft) {
    fail(`buckets must sum to the total: ${attributed} vs ${a.turnsWithoutRealtimeDraft}`);
  }
  // Same invariant on the ORIGINAL fixture, where drafts DO exist — the accounting has to hold on
  // real mixed data, not only on the shapes written to exercise it.
  const mixed =
    s.agentDraft.noDraftApprovedButUntimed + s.agentDraft.noDraftHumanOwnedThread + s.agentDraft.noDraftUnexplained;
  if (mixed !== s.agentDraft.turnsWithoutRealtimeDraft) {
    fail(`buckets must sum on the mixed fixture too: ${mixed} vs ${s.agentDraft.turnsWithoutRealtimeDraft}`);
  }

  // EXECUTE the real CLI and read what it actually WROTE. The assertions above call the pure
  // helpers, so they stayed green when `trailing30d` was deleted from the emitted object — and the
  // readiness bar would then have silently fallen back to the 24h window and gone back to flipping
  // on ~10 turns. A source-text check could not prove this either; only running it can.
  //
  // Clock-safe by construction: the fixture is built relative to NOW, with one turn inside the
  // 24h window and one 10 days back, so `trailing30d` MUST see strictly more than the daily block
  // no matter what day this runs.
  const nowMs = Date.now();
  const iso = (msAgo: number) => new Date(nowMs - msAgo).toISOString();
  const HOUR = 60 * MIN;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "latency-audit-selftest-"));
  try {
    const storePath = path.join(tmp, "conversations.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify([
        mk("recent", [
          ["in", "twilio", iso(2 * HOUR)],
          ["out", "twilio", iso(2 * HOUR - 2 * MIN)]
        ]),
        mk("ten-days-back", [
          ["in", "twilio", iso(10 * 24 * HOUR)],
          ["out", "twilio", iso(10 * 24 * HOUR - 3 * MIN)]
        ])
      ])
    );
    const outDir = path.join(tmp, "out");
    execFileSync(
      process.execPath,
      [process.argv[1], "--store", storePath, "--out-dir", outDir],
      { stdio: "pipe" }
    );
    const written = JSON.parse(fs.readFileSync(path.join(outDir, "response_latency_summary.json"), "utf8"));
    if (!written.trailing30d) fail("the emitted summary must carry a trailing30d block — the readiness bar grades it");
    if (!(written.trailing30d.sinceHours > written.source.sinceHours)) {
      fail(`trailing30d must be a WIDER window than the daily one (got ${written.trailing30d.sinceHours}h vs ${written.source.sinceHours}h)`);
    }
    if (!(written.trailing30d.measured > written.source.measured)) {
      fail(`trailing30d must see the older turn the daily window cannot (got ${written.trailing30d.measured} vs ${written.source.measured})`);
    }
    if (written.trailing30d.summary?.effective?.medianMin == null) {
      fail("trailing30d must carry an effective median — that is the number the bar reads");
    }
    if (written.summary?.effective?.medianMin == null) fail("the daily summary must survive untouched — the release gate reads it");
    // The attribution has to reach the FILE, not just the pure helper — the emitted JSON is what
    // the readiness bar, the release gate and every future reader actually open.
    for (const block of [written.summary?.agentDraft, written.trailing30d?.summary?.agentDraft]) {
      for (const field of ["noDraftApprovedButUntimed", "noDraftHumanOwnedThread", "noDraftUnexplained"]) {
        if (typeof block?.[field] !== "number") {
          fail(`the emitted agentDraft block must carry ${field} — a bare turnsWithoutRealtimeDraft reads as "the agent said nothing"`);
        }
      }
    }
    const md = fs.readFileSync(path.join(outDir, "response_latency_report.md"), "utf8");
    if (!md.includes("unexplained")) fail("the markdown report must name the unexplained residual — that is the line a human reads");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log("PASS response latency audit self-test (incl. emitted trailing30d block)");
}

function main() {
  const argv = process.argv.slice(2);
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--self-test") {
      selfTest();
      return;
    }
    if (argv[i].startsWith("--")) args.set(argv[i], argv[i + 1] ?? "");
  }
  const storePath =
    args.get("--store") ||
    process.env.LATENCY_AUDIT_STORE_PATH ||
    path.join(process.env.DATA_DIR || path.resolve(process.cwd(), "data"), "conversations.json");
  const reportRoot = process.env.REPORT_ROOT || path.resolve(process.cwd(), "reports");
  const outDir = args.get("--out-dir") || process.env.LATENCY_AUDIT_OUT_DIR || path.join(reportRoot, "response_latency");
  const sinceHours = Number(args.get("--since-hours") || process.env.LATENCY_AUDIT_SINCE_HOURS || 24) || 24;

  const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
  const conversations: AnyObj[] = Array.isArray(raw) ? raw : raw?.conversations ?? [];
  const windowStartMs = Date.now() - sinceHours * 60 * MIN;
  const pairs = collectLatencyPairs(conversations, windowStartMs);
  const summary = summarizeLatency(pairs);

  // A SECOND, WIDER window — added, never replacing the one above.
  //
  // The daily window is the right lens for ops (the release gate grades agent draft speed on it,
  // and "did we get slow TODAY" is the question it asks). It is the wrong lens for the readiness
  // bar, which asks "is this dealership's first response fast enough" — a standing property.
  // Measured 2026-08-07 on the live store, same instant:
  //     24h  -> n=9    effective median 80.6 min
  //     7d   -> n=110  effective median 20.0 min
  //     30d  -> n=337  effective median 30.2 min
  // The store answers roughly two messages an hour, so a day carries ~10 turns and the median
  // swings on one slow lead: the bar read 7 min (MET) on 8/6, 39.5 min on 8/7 morning and 80.6 min
  // that afternoon, off the same unchanged system. The three funnel rates beside it are already
  // measured over 30 days behind a `minEngagedSample` floor; this row simply never got the same
  // discipline. Widening it does NOT move the verdict — 30.2 min is still over the 15 min target —
  // it just stops the row flipping on noise.
  const trailing30dHours = 24 * 30;
  const trailing30dPairs = collectLatencyPairs(conversations, Date.now() - trailing30dHours * 60 * MIN);
  const trailing30d = {
    sinceHours: trailing30dHours,
    measured: trailing30dPairs.length,
    summary: summarizeLatency(trailing30dPairs)
  };

  const slowest = [...pairs]
    .filter(p => p.sentMin != null)
    .sort((a, b) => (b.sentMin ?? 0) - (a.sentMin ?? 0))
    .slice(0, 10)
    .map(p => ({ name: p.name, convId: p.convId, inboundAt: p.inboundAt, sentMin: Math.round(p.sentMin ?? 0) }));

  fs.mkdirSync(outDir, { recursive: true });
  const out = {
    ok: true,
    generatedAt: new Date().toISOString(),
    source: { storePath, sinceHours, conversationCount: conversations.length, measured: pairs.length },
    summary,
    trailing30d,
    slowestEffective: slowest
  };
  fs.writeFileSync(path.join(outDir, "response_latency_summary.json"), JSON.stringify(out, null, 2) + "\n");

  const md = [
    "# Response Latency",
    "",
    `Generated: ${out.generatedAt} — ${pairs.length} answered turns in the last ${sinceHours}h`,
    "",
    "## Agent draft speed (the agent's job — graded)",
    `- median: ${summary.agentDraft.medianMin ?? "n/a"} min | p90: ${summary.agentDraft.p90Min ?? "n/a"} min | slow (>5min): ${summary.agentDraft.slowOver5minCount}`,
    `- no timed draft: ${summary.agentDraft.turnsWithoutRealtimeDraft} — of which ${summary.agentDraft.noDraftHumanOwnedThread} human-owned thread (agent stands down by design), ${summary.agentDraft.noDraftApprovedButUntimed} a draft staff SENT but the store kept no draft timestamp, ${summary.agentDraft.noDraftUnexplained} unexplained (the number to look at)`,
    "",
    "## Effective first response (what the customer feels — Suggest-mode gated)",
    `- median: ${summary.effective.medianMin ?? "n/a"} min | p90: ${summary.effective.p90Min ?? "n/a"} min`,
    `- under 5 min: ${summary.effective.under5minPct ?? "n/a"}% | over 1 hour: ${summary.effective.over1hPct ?? "n/a"}%`,
    "",
    "## Trailing 30 days (what the readiness bar reads — a day is too few turns to grade)",
    `- ${trailing30d.measured} answered turns | effective median: ${trailing30d.summary.effective.medianMin ?? "n/a"} min | p90: ${trailing30d.summary.effective.p90Min ?? "n/a"} min`,
    "",
    "## Slowest effective responses",
    ...(slowest.length
      ? slowest.map(s => `- ${s.name} (${s.convId}): ${s.sentMin} min`)
      : ["- none"])
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "response_latency_report.md"), md + "\n");

  console.log(JSON.stringify({ ok: true, outDir, ...summary }));
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) main();
