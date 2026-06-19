/**
 * Cross-lead data-leakage audit — flags an outbound containing ANOTHER customer's phone/email.
 *
 *   real run:  CONVERSATIONS_DB_PATH=/path/conversations.json npx tsx scripts/cross_lead_leak_audit.ts [--out FILE]
 *   self-test: npx tsx scripts/cross_lead_leak_audit.ts --self-test   (deterministic — for ci:eval)
 *
 * Read-only. High-precision (only flags a contact that is another conversation's OWN lead contact).
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { findCrossLeadLeaks, normalizePhone } from "../services/api/src/domain/crossLeadLeak.ts";

if (process.argv.includes("--self-test")) {
  assert.equal(normalizePhone("+1 (716) 523-1238"), "7165231238");
  assert.equal(normalizePhone("716.523.1238"), "7165231238");

  const conversations = [
    { id: "A", leadKey: "+17165231238", lead: { email: "alice@x.com" }, messages: [{ direction: "out", provider: "draft_ai", at: "t1", body: "Hi Alice, your bike is ready." }] },
    // B's thread leaks A's phone AND A's email
    { id: "B", leadKey: "+15852503877", lead: { email: "bob@y.com" }, messages: [{ direction: "out", provider: "twilio", at: "t2", body: "Call the other buyer at 716-523-1238 or email alice@x.com." }] },
    // C references a STOCK number that looks numeric but isn't a lead phone — must NOT flag
    { id: "C", leadKey: "+13334445555", messages: [{ direction: "out", provider: "draft_ai", at: "t3", body: "Stock STK886 is available, $21,995." }] },
    // D includes its OWN phone — must NOT flag
    { id: "D", leadKey: "+19998887777", messages: [{ direction: "out", provider: "human", at: "t4", body: "You can reach me, this is for 999-888-7777." }] }
  ] as any[];
  const leaks = findCrossLeadLeaks({ conversations });
  const inB = leaks.filter(l => l.convId === "B");
  assert.equal(leaks.length, 2, `expected 2 leaks (B leaks A's phone + email), got ${leaks.length}: ${JSON.stringify(leaks)}`);
  assert.ok(inB.some(l => l.kind === "phone" && l.leakedValue === "7165231238" && l.ownerConvId === "A"), "must flag A's phone in B");
  assert.ok(inB.some(l => l.kind === "email" && l.leakedValue === "alice@x.com" && l.ownerConvId === "A"), "must flag A's email in B");
  assert.ok(!leaks.some(l => l.convId === "C"), "stock numbers must NOT be flagged");
  assert.ok(!leaks.some(l => l.convId === "D"), "a lead's own phone must NOT be flagged");
  console.log("PASS cross lead leak audit (self-test: normalize + 4-fixture detector)");
  process.exit(0);
}

const convPath =
  process.env.CONVERSATIONS_DB_PATH ||
  (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "conversations.json") : "");
if (!convPath || !fs.existsSync(convPath)) {
  console.error("Set CONVERSATIONS_DB_PATH (or DATA_DIR) to the conversations.json to scan.");
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(convPath, "utf8"));
const conversations = Array.isArray(raw) ? raw : Array.isArray(raw?.conversations) ? raw.conversations : Object.values(raw);
const leaks = findCrossLeadLeaks({ conversations });

const lines: string[] = [];
lines.push(`# Cross-lead leakage report — ${leaks.length} outbound(s) containing ANOTHER customer's contact`);
lines.push(`# Source: ${convPath}. HIGH PRIORITY: a real customer's phone/email in the wrong thread.`);
lines.push("# Candidates for the agent-watch loop: verify, fix the leak source parser-first, and BACKFILL (redact/retract).");
lines.push("");
if (!leaks.length) lines.push("(no cross-lead leaks)");
for (const l of leaks) {
  lines.push(`## conv ${l.convId} (${l.leadKey}) leaked ${l.kind} ${l.leakedValue} — belongs to conv ${l.ownerConvId} (${l.ownerLeadKey}) — ${l.at}`);
  lines.push(`  outbound: ${l.preview}`);
  lines.push("");
}
const out = lines.join("\n");
const outPath = process.env.CROSS_LEAD_LEAK_OUT || (process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "");
if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, out + "\n", "utf8");
  console.log(`Wrote ${leaks.length} cross-lead leak(s) to ${outPath}`);
} else {
  console.log(out);
}
