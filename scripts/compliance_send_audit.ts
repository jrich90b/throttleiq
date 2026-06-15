/**
 * Compliance send audit (2026-06-15) — the safety net for the scariest gap:
 * an outbound that should never have gone out.
 *
 * Nothing currently watches whether the agent texted/emailed a customer AFTER
 * they opted out (STOP/unsubscribe) or a customer who is call-only. Send-time
 * suppression exists, but no monitor catches it when that enforcement FAILS — and
 * a single send to an opted-out number is a TCPA/legal exposure, not just a tone
 * miss. This deterministic audit (no LLM — opt-out detection is a compliance
 * control) scans sent messages and flags:
 *   - send_after_optout: a customer-facing SEND after the customer's opt-out
 *     signal (a brief grace window allows the one opt-out confirmation).
 *   - auto_send_to_call_only: an AUTO (non-staff) SMS/email to a call_only lead.
 *
 * Gate (compliance:eval) runs --self-test (deterministic, no live data).
 * Real run (compliance:audit, nightly) scans the live store.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isShadowReplayMessage } from "../services/api/src/domain/scoringExclusions.ts";

const SENT_OUT = new Set(["twilio", "sendgrid", "human"]);
const OPTOUT_CONFIRM_GRACE_MS = 5 * 60 * 1000; // allow the single opt-out confirmation

// Standard SMS opt-out keywords + clear natural opt-outs. Deterministic
// compliance control (NOT intent comprehension).
const OPTOUT_RE =
  /^\s*(stop|stopall|unsubscribe|cancel|end|quit|optout|opt out)\s*[.!]?\s*$|\b(stop texting|stop messaging|stop contacting|remove me|take me off|do not (text|contact|message)|don'?t (text|contact|message) me|unsubscribe me)\b/i;

export function detectOptOutText(text: string): boolean {
  return OPTOUT_RE.test(String(text ?? ""));
}

export type ComplianceFinding = {
  convId: string;
  leadKey: string;
  kind: "send_after_optout" | "auto_send_to_call_only";
  at: string;
  provider: string;
  detail: string;
  body: string;
};

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const msgTime = (m: any) => Date.parse(String(m?.at ?? ""));

// PURE: scan one conversation for compliance violations.
export function auditConversationCompliance(conv: any): ComplianceFinding[] {
  const out: ComplianceFinding[] = [];
  const msgs = (conv?.messages ?? [])
    .map((m: any) => ({ ...m, t: msgTime(m) }))
    .filter((m: any) => Number.isFinite(m.t))
    .sort((a: any, b: any) => a.t - b.t);

  // Earliest opt-out signal (inbound).
  let optOutAt = Infinity;
  for (const m of msgs) {
    if (m.direction === "in" && !isShadowReplayMessage(m) && detectOptOutText(m.body)) {
      optOutAt = m.t;
      break;
    }
  }

  const callOnly = String(conv?.contactPreference ?? "").toLowerCase() === "call_only";
  const convId = String(conv?.id ?? "");
  const leadKey = String(conv?.leadKey ?? "");

  for (const m of msgs) {
    if (m.direction !== "out" || !SENT_OUT.has(m.provider)) continue;
    if (isShadowReplayMessage(m)) continue;
    if (!String(m.body ?? "").trim()) continue;
    const isStaffManual = !!String(m?.actorUserName ?? "").trim();

    // send after opt-out (grace window lets the single confirmation through).
    if (Number.isFinite(optOutAt) && m.t > optOutAt + OPTOUT_CONFIRM_GRACE_MS) {
      out.push({
        convId,
        leadKey,
        kind: "send_after_optout",
        at: String(m.at ?? ""),
        provider: m.provider,
        detail: `${isStaffManual ? "staff" : "auto"} ${m.provider} send ${Math.round((m.t - optOutAt) / 60000)} min after opt-out`,
        body: String(m.body).slice(0, 160)
      });
    }

    // auto SMS/email to a call_only lead (staff override is allowed).
    if (callOnly && !isStaffManual && (m.provider === "twilio" || m.provider === "sendgrid")) {
      out.push({
        convId,
        leadKey,
        kind: "auto_send_to_call_only",
        at: String(m.at ?? ""),
        provider: m.provider,
        detail: `auto ${m.provider} send to a call_only lead`,
        body: String(m.body).slice(0, 160)
      });
    }
  }
  return out;
}

export function summarizeCompliance(findings: ComplianceFinding[]) {
  return {
    total: findings.length,
    sendAfterOptout: findings.filter(f => f.kind === "send_after_optout").length,
    autoSendToCallOnly: findings.filter(f => f.kind === "auto_send_to_call_only").length,
    convsAffected: new Set(findings.map(f => f.convId)).size
  };
}

function selfTest() {
  const ok = (cond: boolean, label: string) => {
    if (!cond) { console.error(`SELF-TEST FAIL: ${label}`); process.exit(1); }
  };
  // detector
  for (const y of ["STOP", "stop", "Unsubscribe", "please remove me", "stop texting me", "do not text me"]) {
    ok(detectOptOutText(y), `opt-out: "${y}"`);
  }
  for (const n of ["stop by tomorrow?", "can you stop holding it", "I'll stop in Saturday", "what time do you close"]) {
    ok(!detectOptOutText(n), `not opt-out: "${n}"`);
  }

  const base = Date.parse("2026-06-15T12:00:00Z");
  const t = (min: number) => new Date(base + min * 60000).toISOString();

  // send-after-optout: cadence send 2h after STOP -> flagged; the immediate
  // confirmation (within grace) -> not flagged.
  const optOutConv = {
    id: "optout", leadKey: "+1700",
    messages: [
      { direction: "in", provider: "twilio", at: t(0), body: "STOP" },
      { direction: "out", provider: "twilio", at: t(1), body: "You're unsubscribed. Reply START to opt back in." }, // confirmation (grace)
      { direction: "out", provider: "twilio", at: t(180), body: "Hey, those limited runs move quick! Want to stop in?" } // VIOLATION
    ]
  };
  const f1 = auditConversationCompliance(optOutConv);
  ok(f1.length === 1 && f1[0].kind === "send_after_optout", `optout: 1 send_after_optout, got ${JSON.stringify(f1.map(x=>x.kind))}`);

  // call_only: auto SMS flagged; staff manual SMS allowed.
  const callOnlyConv = {
    id: "callonly", leadKey: "+1701", contactPreference: "call_only",
    messages: [
      { direction: "out", provider: "twilio", at: t(10), body: "Auto cadence text" }, // VIOLATION (no actorUserName)
      { direction: "out", provider: "twilio", at: t(20), body: "Hey it's Joe, calling you now", actorUserName: "Joe Hartrich" } // staff override, allowed
    ]
  };
  const f2 = auditConversationCompliance(callOnlyConv);
  ok(f2.length === 1 && f2[0].kind === "auto_send_to_call_only", `call_only: 1 auto violation, got ${JSON.stringify(f2.map(x=>x.kind))}`);

  // clean conv: no violations.
  const clean = { id: "clean", leadKey: "+1702", messages: [
    { direction: "in", provider: "twilio", at: t(0), body: "Is the Street Glide in stock?" },
    { direction: "out", provider: "twilio", at: t(1), body: "Yes! Want to stop by today?" }
  ]};
  ok(auditConversationCompliance(clean).length === 0, "clean conv has no violations");

  const summary = summarizeCompliance([...f1, ...f2]);
  ok(summary.total === 2 && summary.sendAfterOptout === 1 && summary.autoSendToCallOnly === 1, `summary ${JSON.stringify(summary)}`);

  console.log("PASS compliance send audit self-test");
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) { selfTest(); return; }

  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args.set(argv[i], argv[i + 1] ?? "");
  const conversationsPath =
    args.get("--conversations") ||
    process.env.CONVERSATIONS_DB_PATH ||
    (process.env.DATA_DIR
      ? path.join(process.env.DATA_DIR, "conversations.json")
      : path.resolve(process.cwd(), "services", "api", "data", "conversations.json"));
  const outDir = args.get("--out-dir") || process.env.COMPLIANCE_OUT_DIR || path.resolve(process.cwd(), "reports", "compliance");

  if (!fs.existsSync(conversationsPath)) { console.error(`Conversations file not found: ${conversationsPath}`); process.exit(1); }
  const raw = JSON.parse(fs.readFileSync(conversationsPath, "utf8"));
  const convs: any[] = Array.isArray(raw?.conversations) ? raw.conversations : [];

  const findings: ComplianceFinding[] = [];
  for (const conv of convs) findings.push(...auditConversationCompliance(conv));
  const summary = summarizeCompliance(findings);

  fs.mkdirSync(outDir, { recursive: true });
  const report = { generatedAt: new Date().toISOString(), source: { conversationsPath, conversations: convs.length }, summary, findings };
  fs.writeFileSync(path.join(outDir, "compliance_send_summary.json"), JSON.stringify({ ...report, findings: undefined }, null, 2));
  fs.writeFileSync(path.join(outDir, "compliance_send_findings.json"), JSON.stringify(report, null, 2));
  const md = [
    "# Compliance Send Audit",
    "",
    `Generated: ${report.generatedAt}`,
    `Sends after opt-out: ${summary.sendAfterOptout} | Auto sends to call-only: ${summary.autoSendToCallOnly} | Convs affected: ${summary.convsAffected}`,
    "",
    ...findings.slice(0, 50).map(f => `- [${f.kind}] ${f.convId} (${f.leadKey}) ${f.at}: ${f.detail}\n    "${f.body}"`)
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "compliance_send_report.md"), md + "\n");

  console.log(`compliance send audit: ${summary.sendAfterOptout} send-after-optout, ${summary.autoSendToCallOnly} auto-to-call-only across ${convs.length} convs; report at ${outDir}`);
  if (summary.total > 0) console.log("  ^ REVIEW: customer-facing sends that may violate opt-out/contact-preference.");
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) main();
