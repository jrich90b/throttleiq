/**
 * Answer-correctness audit (Joe, 2026-06-13) — the grading gap that let the
 * agent offer the wrong bike / ignore the requested time reach production,
 * caught only when Joe pasted the conversation. Replays real customer turns
 * against the agent's ACTUAL next reply and flags two high-signal classes:
 *
 *   owned_bike_offered   — customer named a bike as their CURRENT/owned/trade
 *                          ("compared to my current ultra limited") and the
 *                          agent's reply offered that bike (Todd Herian).
 *   requested_time_reasked — customer gave a concrete day/time and the agent's
 *                          reply asked for a day/time again (Chuck/Al Davis/
 *                          Dominik class).
 *
 * Heuristic but deliberately tight — validated for low false positives on prod
 * before gating. "recent" counts feed the release gate; totals show debt.
 *
 * Usage:
 *   npx tsx scripts/answer_correctness_audit.ts [--store PATH] [--out-dir DIR] [--since-hours N]
 *   npx tsx scripts/answer_correctness_audit.ts --self-test
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseRequestedDayTime, parseRequestedDateOnly } from "../services/api/src/domain/conversationStore.ts";

type AnyObj = Record<string, any>;
const TZ = "America/New_York";
const DAY_MS = 24 * 60 * 60 * 1000;

// Core Harley families, longest-first so "road glide special" wins over "road glide".
const MODELS = [
  "road glide special", "road glide limited", "road glide ultra", "road glide",
  "street glide special", "street glide limited", "street glide",
  "ultra limited", "electra glide", "tri glide", "sport glide", "wide glide",
  "road king", "fat boy", "fat bob", "low rider", "street bob",
  "heritage classic", "breakout", "nightster", "sportster", "iron 883", "softail"
];

function normalize(text: unknown): string {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Returns the owned/comparison model named in the text, if any. */
export function ownedModelInText(textRaw: string): string | null {
  const t = normalize(textRaw);
  for (const model of MODELS) {
    const idx = t.indexOf(model);
    if (idx < 0) continue;
    const before = t.slice(Math.max(0, idx - 40), idx);
    const owned =
      /\b(?:compared to|versus|vs|than|against)\s+(?:my\s+)?(?:current\s+|old\s+|existing\s+)?$/.test(before) ||
      /\bmy\s+(?:current\s+|old\s+|existing\s+)?$/.test(before) ||
      /\bi\s+(?:currently\s+)?(?:ride|own|have|drive|got)\s+(?:a\s+|an\s+|my\s+)?$/.test(before) ||
      /\b(?:trading\s+in|trade in|trading)\s+(?:my\s+|a\s+|an\s+)?(?:current\s+|old\s+)?$/.test(before);
    if (owned) return model;
  }
  return null;
}

/** Does the agent reply offer/list this specific model as available or to ride? */
export function replyOffersModel(replyRaw: string, model: string): boolean {
  const r = normalize(replyRaw);
  if (!r.includes(model)) return false;
  return (
    /\bwe have\b|\bin stock\b|\btop options?\b|\btest ride on\b|\bline up the (?:test )?ride\b|\bavailable\b/.test(r)
  );
}

// Re-asking for the DAY the customer already gave is the miss. Asking only for
// a TIME after a day-without-time is correct, so it must NOT match here.
const REASK_DAY_RE = /\b(what day|which day|what day and time|day and time works?|what day are you thinking)\b/i;

export function replyReasksDay(replyRaw: string): boolean {
  return REASK_DAY_RE.test(String(replyRaw ?? ""));
}

const WEEKDAY_RE = /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/;

/** Did the customer commit to a concrete future day? null if no day given. */
function customerGaveDay(textRaw: string): boolean {
  const t = String(textRaw ?? "").toLowerCase();
  // Ambiguous multi-option ("Friday or Tuesday") — the agent SHOULD disambiguate.
  if (/\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b[\s\S]{0,20}\bor\b/.test(t)) {
    return false;
  }
  if (parseRequestedDayTime(t, TZ)) return true;
  if (WEEKDAY_RE.test(t)) return true;
  if (parseRequestedDateOnly(t, TZ)) return true;
  return false;
}

type Finding = {
  check: string;
  convId: string;
  name: string;
  at: string;
  inbound: string;
  reply: string;
  detail: string;
  recent: boolean;
};

function isCustomerInbound(m: AnyObj): boolean {
  return (
    m?.direction === "in" &&
    (m?.provider === "twilio" || m?.provider === "web_widget") &&
    String(m?.body ?? "").trim().length > 0
  );
}
function isAgentReply(m: AnyObj): boolean {
  // Drafts count — a wrong draft is a wrong answer staff might send.
  return (
    m?.direction === "out" &&
    (m?.provider === "draft_ai" || m?.provider === "twilio" || m?.provider === "human") &&
    String(m?.body ?? "").trim().length > 0
  );
}

export function auditConversations(conversations: AnyObj[], nowMs: number, windowStartMs: number): Finding[] {
  const findings: Finding[] = [];
  for (const conv of conversations ?? []) {
    if (!conv?.id) continue;
    const lead = conv.lead ?? {};
    const name =
      [lead.firstName, lead.lastName].map((v: any) => String(v ?? "").trim()).filter(Boolean).join(" ") ||
      String(conv.id);
    const msgs: AnyObj[] = Array.isArray(conv.messages) ? conv.messages : [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (!isCustomerInbound(m)) continue;
      const inbound = String(m.body ?? "");
      // The agent's next reply within the same turn.
      const reply = msgs.slice(i + 1, i + 3).find(isAgentReply);
      if (!reply) continue;
      const atMs = Date.parse(String(m.at ?? ""));
      const recent = Number.isFinite(atMs) && atMs >= windowStartMs;
      const replyBody = String(reply.body ?? "");

      const owned = ownedModelInText(inbound);
      if (owned && replyOffersModel(replyBody, owned)) {
        findings.push({
          check: "owned_bike_offered",
          convId: String(conv.id),
          name,
          at: String(m.at ?? "").slice(0, 16),
          inbound: inbound.slice(0, 120),
          reply: replyBody.slice(0, 120),
          detail: `agent offered the customer's owned/comparison bike: ${owned}`,
          recent
        });
        continue;
      }
      if (customerGaveDay(inbound) && replyReasksDay(replyBody)) {
        findings.push({
          check: "requested_day_reasked",
          convId: String(conv.id),
          name,
          at: String(m.at ?? "").slice(0, 16),
          inbound: inbound.slice(0, 120),
          reply: replyBody.slice(0, 120),
          detail: "customer named a day; agent asked which day again",
          recent
        });
      }
    }
  }
  return findings;
}

function summarize(findings: Finding[]) {
  const byCheck = new Map<string, { total: number; recent: number }>();
  for (const f of findings) {
    const e = byCheck.get(f.check) ?? { total: 0, recent: 0 };
    e.total += 1;
    if (f.recent) e.recent += 1;
    byCheck.set(f.check, e);
  }
  return Array.from(byCheck.entries()).map(([check, c]) => ({ check, total: c.total, recent: c.recent }));
}

function selfTest() {
  const now = Date.parse("2026-06-13T18:00:00.000Z");
  const mk = (id: string, inbound: string, reply: string, at: string): AnyObj => ({
    id,
    lead: { firstName: id },
    messages: [
      { direction: "in", provider: "twilio", at, body: inbound },
      { direction: "out", provider: "draft_ai", at, body: reply }
    ]
  });
  const convs = [
    // Todd: owned bike offered.
    mk("todd", "as long as it's a roadglide compared to my current ultra limited",
       "We have 2 Ultra Limited units in stock right now. Top options: ...", "2026-06-13T10:43:00.000Z"),
    // Chuck/Dominik: day given, agent re-asks.
    mk("chuck", "Monday, 15 June around 10am", "What day and time works best?", "2026-06-13T11:00:00.000Z"),
    // Clean: owned bike named but agent did NOT offer it.
    mk("clean1", "i ride a street glide now, want to try a road glide",
       "We have 12 Road Glides in stock. Want to set up a ride?", "2026-06-13T12:00:00.000Z"),
    // Clean: day given, agent confirms (no re-ask).
    mk("clean2", "saturday at 2 works", "Perfect, Saturday at 2 it is. See you then!", "2026-06-13T12:30:00.000Z")
  ];
  const windowStart = now - 24 * 60 * 60 * 1000;
  const findings = auditConversations(convs, now, windowStart);
  const checks = findings.map(f => `${f.convId}:${f.check}`).sort();
  const fail = (m: string) => { console.error("SELF-TEST FAIL:", m, "\n got:", checks); process.exit(1); };
  if (!checks.includes("todd:owned_bike_offered")) fail("Todd's owned-bike miss must flag");
  if (!checks.includes("chuck:requested_day_reasked")) fail("Chuck's day re-ask must flag");
  if (checks.some(c => c.startsWith("clean1") || c.startsWith("clean2"))) fail("clean turns must not flag");
  if (findings.length !== 2) fail(`exactly 2 findings expected, got ${findings.length}`);
  // Day-without-time + agent asks only for TIME is correct, must not flag.
  const timeOnly = auditConversations(
    [{ id: "x", lead: {}, messages: [
      { direction: "in", provider: "twilio", at: "2026-06-13T12:00:00.000Z", body: "may come tomorrow" },
      { direction: "out", provider: "draft_ai", at: "2026-06-13T12:00:00.000Z", body: "What time works for you tomorrow?" }
    ] }],
    now, now - 24 * 60 * 60 * 1000
  );
  if (timeOnly.length !== 0) fail(`asking only for TIME after a day must not flag, got ${timeOnly.length}`);
  // "Friday or Tuesday" disambiguation is correct, must not flag.
  const ambiguous = auditConversations(
    [{ id: "y", lead: {}, messages: [
      { direction: "in", provider: "twilio", at: "2026-06-13T12:00:00.000Z", body: "friday or tuesday next" },
      { direction: "out", provider: "draft_ai", at: "2026-06-13T12:00:00.000Z", body: "let me know which day works better" }
    ] }],
    now, now - 24 * 60 * 60 * 1000
  );
  if (ambiguous.length !== 0) fail(`multi-option disambiguation must not flag, got ${ambiguous.length}`);
  console.log("PASS answer correctness audit self-test");
}

function main() {
  const argv = process.argv.slice(2);
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--self-test") { selfTest(); return; }
    if (argv[i].startsWith("--")) args.set(argv[i], argv[i + 1] ?? "");
  }
  const storePath =
    args.get("--store") ||
    process.env.CORRECTNESS_AUDIT_STORE_PATH ||
    path.join(process.env.DATA_DIR || path.resolve(process.cwd(), "data"), "conversations.json");
  const reportRoot = process.env.REPORT_ROOT || path.resolve(process.cwd(), "reports");
  const outDir = args.get("--out-dir") || process.env.CORRECTNESS_AUDIT_OUT_DIR || path.join(reportRoot, "answer_correctness");
  const sinceHours = Number(args.get("--since-hours") || process.env.CORRECTNESS_AUDIT_SINCE_HOURS || 24) || 24;

  const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
  const conversations: AnyObj[] = Array.isArray(raw) ? raw : raw?.conversations ?? [];
  const nowMs = Date.now();
  const findings = auditConversations(conversations, nowMs, nowMs - sinceHours * 60 * 60 * 1000);
  const byCheck = summarize(findings);

  fs.mkdirSync(outDir, { recursive: true });
  const out = {
    ok: true,
    generatedAt: new Date().toISOString(),
    source: { storePath, sinceHours, conversationCount: conversations.length },
    summary: { byCheck },
    findings: findings.slice(0, 80)
  };
  fs.writeFileSync(path.join(outDir, "answer_correctness_summary.json"), JSON.stringify(out, null, 2) + "\n");

  const md = [
    "# Answer Correctness",
    "",
    `Generated: ${out.generatedAt} — ${conversations.length} conversations, last ${sinceHours}h graded`,
    "",
    ...byCheck.flatMap(c => [
      `## ${c.check} — total ${c.total}, recent ${c.recent}`,
      ...findings.filter(f => f.check === c.check).slice(0, 10).map(
        f => `- ${f.name} (${f.convId})${f.recent ? " [recent]" : ""}: ${f.detail}\n  IN: ${f.inbound}\n  OUT: ${f.reply}`
      ),
      ""
    ])
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "answer_correctness_report.md"), md + "\n");

  console.log(JSON.stringify({ ok: true, outDir, byCheck }));
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) main();
