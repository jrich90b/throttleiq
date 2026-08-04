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
import { collectDealerContacts, findCrossLeadLeaks, normalizePhone } from "../services/api/src/domain/crossLeadLeak.ts";

if (process.argv.includes("--self-test")) {
  assert.equal(normalizePhone("+1 (716) 523-1238"), "7165231238");
  assert.equal(normalizePhone("716.523.1238"), "7165231238");

  // The dealer's OWN roster + profile — same shape as users.json / dealer_profile.json.
  const dealerContacts = collectDealerContacts({
    users: [{ name: "Gio", email: "gio@dealer-hd.com", phone: "7168608050" }],
    dealerProfile: { fromEmail: "sales@dealer-hd.com", phone: "(716) 692-7200", website: "https://dealer-hd.com" }
  });
  assert.ok(dealerContacts.emailDomains.has("dealer-hd.com"), "dealer domain must come from the dealer's own records");

  const conversations = [
    { id: "A", leadKey: "+17165231238", lead: { email: "alice@x.com" }, messages: [{ direction: "out", provider: "draft_ai", at: "t1", body: "Hi Alice, your bike is ready." }] },
    // B's thread leaks A's phone AND A's email
    { id: "B", leadKey: "+15852503877", lead: { email: "bob@y.com" }, messages: [{ direction: "out", provider: "twilio", at: "t2", body: "Call the other buyer at 716-523-1238 or email alice@x.com." }] },
    // C references a STOCK number that looks numeric but isn't a lead phone — must NOT flag
    { id: "C", leadKey: "+13334445555", messages: [{ direction: "out", provider: "draft_ai", at: "t3", body: "Stock STK886 is available, $21,995." }] },
    // D includes its OWN phone — must NOT flag
    { id: "D", leadKey: "+19998887777", messages: [{ direction: "out", provider: "human", at: "t4", body: "You can reach me, this is for 999-888-7777." }] },
    // E: the live 2026-08-04 case — the lead FEED dropped a rep's work email into a CUSTOMER's record.
    // That must not make the rep's address this customer's contact.
    { id: "E", leadKey: "+17169083217", lead: { email: "gio@dealer-hd.com", phone: "+17169083217" }, messages: [] },
    // F: a rep hands a customer their own work email, a shared store box, and the desk line — all intended.
    { id: "F", leadKey: "+17163852815", messages: [{ direction: "out", provider: "human", at: "t6", body: "Email me at gio@dealer-hd.com or the store at sales@dealer-hd.com, or call (716) 692-7200." }] }
  ] as any[];

  const leaks = findCrossLeadLeaks({ conversations, dealerContacts });
  const inB = leaks.filter(l => l.convId === "B");
  assert.equal(leaks.length, 2, `expected 2 leaks (B leaks A's phone + email), got ${leaks.length}: ${JSON.stringify(leaks)}`);
  assert.ok(inB.some(l => l.kind === "phone" && l.leakedValue === "7165231238" && l.ownerConvId === "A"), "must flag A's phone in B");
  assert.ok(inB.some(l => l.kind === "email" && l.leakedValue === "alice@x.com" && l.ownerConvId === "A"), "must flag A's email in B");
  assert.ok(!leaks.some(l => l.convId === "C"), "stock numbers must NOT be flagged");
  assert.ok(!leaks.some(l => l.convId === "D"), "a lead's own phone must NOT be flagged");
  assert.ok(!leaks.some(l => l.convId === "F"), "a rep's own work email / store box / desk line is NOT a cross-lead leak");

  // Fail-direction: the exclusion is scoped to the dealer's own contacts, never a blanket mute. With no
  // roster the detector keeps its old (noisy) behavior rather than going quiet on real leaks.
  const unscoped = findCrossLeadLeaks({ conversations });
  assert.ok(unscoped.some(l => l.convId === "F"), "with no dealer roster the detector must NOT self-mute");
  assert.ok(unscoped.some(l => l.convId === "B" && l.kind === "email"), "a real customer leak stays flagged in both modes");

  console.log("PASS cross lead leak audit (self-test: normalize + 6-fixture detector + dealer-contact scoping)");
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

// The dealer's own roster/profile live beside conversations.json. Missing files degrade to the
// unscoped (old) behavior — noisier, never quieter.
const dataDir = process.env.DATA_DIR || path.dirname(convPath);
const readJson = (file: string): any => {
  try {
    const p = path.join(dataDir, file);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : undefined;
  } catch {
    return undefined;
  }
};
const dealerContacts = collectDealerContacts({ users: readJson("users.json"), dealerProfile: readJson("dealer_profile.json") });
const leaks = findCrossLeadLeaks({ conversations, dealerContacts });

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
