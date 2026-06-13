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

export type LatencyPair = {
  convId: string;
  name: string;
  inboundAt: string;
  draftMin: number | null;
  sentMin: number | null;
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
            sentMin: sentMs != null ? (sentMs - pendingInboundMs) / MIN : null
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
  const noRealtimeDraft = pairs.filter(
    p => p.draftMin == null || p.draftMin > REALTIME_DRAFT_WINDOW_MIN
  ).length;
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
      turnsWithoutRealtimeDraft: noRealtimeDraft
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
  console.log("PASS response latency audit self-test");
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
    "",
    "## Effective first response (what the customer feels — Suggest-mode gated)",
    `- median: ${summary.effective.medianMin ?? "n/a"} min | p90: ${summary.effective.p90Min ?? "n/a"} min`,
    `- under 5 min: ${summary.effective.under5minPct ?? "n/a"}% | over 1 hour: ${summary.effective.over1hPct ?? "n/a"}%`,
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
