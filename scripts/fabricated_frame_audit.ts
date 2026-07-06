/**
 * fabricated_frame:audit — nightly read-only detector for the "fabricated conversational frame"
 * miss class: an agent reply that opens by inventing a frame the customer's turn doesn't warrant —
 * "You're welcome" with no thanks, or "Totally fair question" on a statement/form. These are
 * fluent, on-topic, and often go out UNEDITED, so the edit-feedback miner and intent_handled judge
 * both miss them (no edit; the reply addresses the ask). This audit closes that blind spot.
 *
 * Deterministic + read-only (no LLM, no customer impact). Pairs each agent reply with the most
 * recent customer inbound before it and runs detectFabricatedFrame (leadInGuards.ts).
 *
 * Usage:
 *   CONVERSATIONS_DB_PATH=/path npx tsx scripts/fabricated_frame_audit.ts [--since-hours N] [--max N]
 *   npx tsx scripts/fabricated_frame_audit.ts --self-test     # deterministic, no IO, for ci:eval
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { detectFabricatedFrame } from "../services/api/src/domain/leadInGuards.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? String(process.argv[i + 1]) : fallback;
}

const CUSTOMER_IN = (m: any) =>
  m?.direction === "in" && (m?.provider === "twilio" || m?.provider === "web_widget") && String(m?.body ?? "").trim();
// Agent replies that reached / are queued for the customer. Exclude ADF-form
// echoes + internal, AND draftStatus "stale" drafts: a stale draft was
// dismissed/superseded and the console hides it (getLatestPendingDraft), so it
// never reached the customer — flagging its frame is a phantom (Zachary Bushey
// class, 2026-07-05). A live pending draft still counts (staff may send it).
const AGENT_OUT = (m: any) =>
  m?.direction === "out" &&
  (m?.provider === "twilio" || m?.provider === "human" || m?.provider === "sendgrid" ||
    (m?.provider === "draft_ai" && m?.draftStatus !== "stale")) &&
  String(m?.body ?? "").trim();

type Finding = {
  convId: string;
  name: string;
  at: string;
  replyKind: "sent" | "draft";
  type: "gratitude" | "question";
  customer: string;
  replyOpener: string;
};

function scanConversation(conv: any, sinceMs: number): Finding[] {
  const msgs: any[] = Array.isArray(conv?.messages) ? conv.messages : [];
  const out: Finding[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!AGENT_OUT(m)) continue;
    const atMs = Date.parse(String(m?.at ?? ""));
    if (!Number.isFinite(atMs) || atMs < sinceMs) continue;
    // most recent customer inbound before this reply
    let cust: any = null;
    for (let j = i - 1; j >= 0; j--) {
      if (CUSTOMER_IN(msgs[j])) { cust = msgs[j]; break; }
      if (AGENT_OUT(msgs[j])) break; // stop at the previous agent turn
    }
    if (!cust) continue;
    const verdict = detectFabricatedFrame(String(m.body ?? ""), String(cust.body ?? ""));
    if (!verdict.fabricated || !verdict.type) continue;
    const l = conv?.lead ?? {};
    out.push({
      convId: String(conv?.id ?? conv?.leadKey ?? ""),
      name: [l.firstName, l.lastName].filter(Boolean).join(" ").trim() || String(conv?.leadKey ?? conv?.id ?? "lead"),
      at: String(m?.at ?? ""),
      replyKind: m.provider === "draft_ai" ? "draft" : "sent",
      type: verdict.type,
      customer: String(cust.body ?? "").replace(/\s+/g, " ").slice(0, 120),
      replyOpener: String(m.body ?? "").replace(/\s+/g, " ").slice(0, 90)
    });
  }
  return out;
}

function selfTest(): void {
  // The two reproduced misses.
  assert.deepEqual(
    detectFabricatedFrame("You're welcome. Which bike are you looking at so I can run it correctly?", "I have to be honest I absolutely love my bike, was more curiosity of what the value is"),
    { fabricated: true, type: "gratitude" },
    "mike jaglowski: fabricated gratitude"
  );
  assert.deepEqual(
    detectFabricatedFrame("Totally fair question. I have you on a 2008 Suzuki. We can start with an estimate.", "Trade-In: 2008 Suzuki C50K8 Boulevard"),
    { fabricated: true, type: "question" },
    "ADF form -> fabricated question frame"
  );
  // Legitimate — must NOT flag.
  assert.equal(detectFabricatedFrame("You're welcome! Anything else?", "thanks so much").fabricated, false, "real thanks -> not flagged");
  assert.equal(detectFabricatedFrame("Totally fair question. The OTD is $24,995.", "what's the out the door price?").fabricated, false, "real question -> not flagged");
  assert.equal(detectFabricatedFrame("Great question — let me check.", "how much for the road glide").fabricated, false, "real question -> not flagged");
  assert.equal(detectFabricatedFrame("Sounds good — what day works?", "I love my bike").fabricated, false, "no fabricated frame -> not flagged");
  // The frame must be in the OPENER, not buried mid-reply.
  assert.equal(detectFabricatedFrame("Here are the specs. Happy to help anytime.", "send me the specs").fabricated, false, "gratitude phrase mid-reply (not opener) -> not flagged");

  // Conversation scan + pairing.
  const conv = {
    id: "+17163350819", lead: { firstName: "mike", lastName: "jaglowski" },
    messages: [
      { direction: "in", provider: "twilio", at: "2026-06-16T13:56:00Z", body: "I absolutely love my bike, was more curiosity of what the value is" },
      { direction: "out", provider: "twilio", at: "2026-06-16T14:23:00Z", body: "You're welcome. Which bike are you looking at so I can run it correctly?" }
    ]
  };
  const found = scanConversation(conv, Date.parse("2026-06-16T00:00:00Z"));
  assert.equal(found.length, 1, "scan finds the one fabricated-gratitude reply");
  assert.equal(found[0].type, "gratitude");
  assert.equal(found[0].replyKind, "sent");
  // Window filter excludes older replies.
  assert.equal(scanConversation(conv, Date.parse("2026-06-17T00:00:00Z")).length, 0, "outside window -> nothing");

  // Unified-feed adapter: a SENT fabricated frame becomes one comprehension anomaly;
  // a DRAFT (caught pre-send) is NOT promoted to an autonomous work order.
  const anomalies = fabricatedFrameAnomalies(found);
  assert.equal(anomalies.length, 1, "a SENT fabricated frame becomes one feed anomaly");
  assert.equal(anomalies[0].dimension, "fabricated_frame", "anomaly carries the fabricated_frame dimension");
  assert.equal(anomalies[0].category, "comprehension", "fabricated frame classifies as comprehension (→ parser_fix_candidate)");
  assert.equal(fabricatedFrameAnomalies([{ ...found[0], replyKind: "draft" }]).length, 0, "a DRAFT fabricated frame is NOT promoted to the feed");

  // A dismissed (stale) draft that fabricated a frame must NOT be scanned — the
  // console hides it, so it never reached the customer (Zachary Bushey class, 7/5).
  const staleConv = {
    id: "+stale", lead: { firstName: "z" },
    messages: [
      { direction: "in", provider: "twilio", at: "2026-06-16T13:56:00Z", body: "I absolutely love my bike, was more curiosity of what the value is" },
      { direction: "out", provider: "draft_ai", at: "2026-06-16T14:23:00Z", body: "You're welcome. Which bike are you looking at so I can run it correctly?", draftStatus: "stale" }
    ]
  };
  assert.equal(scanConversation(staleConv, Date.parse("2026-06-16T00:00:00Z")).length, 0, "a dismissed (stale) draft frame must not be flagged");
  // A LIVE (non-stale) draft with the same frame is still flagged, as a draft.
  const liveDraftConv = {
    id: "+live", lead: { firstName: "z" },
    messages: [
      { direction: "in", provider: "twilio", at: "2026-06-16T13:56:00Z", body: "I absolutely love my bike, was more curiosity of what the value is" },
      { direction: "out", provider: "draft_ai", at: "2026-06-16T14:23:00Z", body: "You're welcome. Which bike are you looking at so I can run it correctly?" }
    ]
  };
  const liveFound = scanConversation(liveDraftConv, Date.parse("2026-06-16T00:00:00Z"));
  assert.equal(liveFound.length, 1, "a live pending draft frame is still flagged");
  assert.equal(liveFound[0].replyKind, "draft", "live pending draft frame flagged as a draft");

  console.log("PASS fabricated-frame audit self-test (gratitude + question detection + scan/pairing + window + stale-draft exclusion + unified-feed adapter)");
}

// Adapter: SENT fabricated-frame replies → OutcomeAnomaly entries for the unified
// feed (anomaly_loop_detect merges reports/fabricated_frame/latest.json). A sent
// fabricated frame is a customer-facing comprehension miss fixable by a guard/
// few-shot, so it is category "comprehension" (→ parser_fix_candidate, Tier 1,
// approve-first, notify). DRAFT findings are caught pre-send, so they stay in the
// findings file for the digest and are NOT promoted to an autonomous work order.
function fabricatedFrameAnomalies(findings: Finding[]): Array<{
  convId: string;
  dimension: "fabricated_frame";
  category: "comprehension";
  severity: "P2";
  detail: string;
}> {
  return findings
    .filter(f => f.replyKind === "sent")
    .map(f => ({
      convId: f.convId,
      dimension: "fabricated_frame" as const,
      category: "comprehension" as const,
      severity: "P2" as const,
      detail: `sent reply opened with a fabricated ${f.type} frame — customer: ${JSON.stringify(
        f.customer
      )} | opener: ${JSON.stringify(f.replyOpener)}`
    }));
}

function main(): void {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }
  const sinceHours = Number(arg("--since-hours", "24")) || 24;
  const maxExamples = Number(arg("--max", "40")) || 40;
  const sinceMs = Date.now() - sinceHours * 60 * 60 * 1000;

  const conversationsPath =
    process.env.CONVERSATIONS_DB_PATH ||
    (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "conversations.json") : path.resolve(process.cwd(), "services", "api", "data", "conversations.json"));
  const raw = JSON.parse(fs.readFileSync(conversationsPath, "utf8"));
  const conversations: any[] = Array.isArray(raw) ? raw : raw?.conversations ?? [];

  const findings: Finding[] = [];
  for (const conv of conversations) findings.push(...scanConversation(conv, sinceMs));
  findings.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const sent = findings.filter(f => f.replyKind === "sent");
  const summary = {
    sinceHours,
    total: findings.length,
    sent: sent.length,
    draft: findings.length - sent.length,
    gratitude: findings.filter(f => f.type === "gratitude").length,
    question: findings.filter(f => f.type === "question").length
  };
  const report = { generatedAt: new Date().toISOString(), summary, findings: findings.slice(0, maxExamples) };

  const outDir = arg("--out-dir", "") || process.env.FABRICATED_FRAME_OUT_DIR || path.resolve(process.cwd(), "reports", "fabricated_frame");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "fabricated_frame_findings.json"), JSON.stringify(report, null, 2));

  // Also emit the OutcomeAnomaly-shaped feed the unified anomaly loop merges, so a
  // SENT fabricated frame reaches the same single work order the autonomous loop and
  // the daily PR-review consume (it was previously visible only in the morning digest).
  const anomalies = fabricatedFrameAnomalies(findings);
  fs.writeFileSync(
    path.join(outDir, "latest.json"),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), source: conversationsPath, summary: { sent: sent.length, anomalies: anomalies.length }, anomalies },
      null,
      2
    )
  );

  console.log(`Fabricated-frame audit — last ${sinceHours}h: ${summary.total} (${summary.sent} sent, ${summary.draft} draft) | gratitude ${summary.gratitude} / question ${summary.question}`);
  for (const f of findings.slice(0, 12)) {
    console.log(`  [${f.replyKind}/${f.type}] ${f.name} (${f.convId})`);
    console.log(`     cust: ${JSON.stringify(f.customer)}`);
    console.log(`     repl: ${JSON.stringify(f.replyOpener)}`);
  }
  console.log(`  Report: ${path.join(outDir, "fabricated_frame_findings.json")}`);
}

main();
