/**
 * Held-drafts report — THE BRIDGE from the runtime held-gate to the agent-watch code-fix loop.
 *
 * STEP 2's gate holds a bad reply draft (fabrication / wrong-answer / unsafe) before it reaches the
 * field. STEP 3's self-heal regenerates the ones a re-draft can fix. What's LEFT held is the signal
 * that the CODE has a bug a re-roll can't patch (cause #3) — exactly what the agent-watch loop should
 * diagnose and fix parser-first. This report surfaces each currently-held draft with its diagnosis
 * context (the customer turn + the held draft + the judge's reason) so the monitor can triage it.
 *
 * Read-only, no LLM. Resolves the store via CONVERSATIONS_DB_PATH or DATA_DIR/conversations.json.
 * Run: CONVERSATIONS_DB_PATH=/path/to/conversations.json npx tsx scripts/draft_held_report.ts
 *      [DRAFT_HELD_REPORT_OUT=/path/to/out.txt]
 */
import fs from "node:fs";
import path from "node:path";

const convPath =
  process.env.CONVERSATIONS_DB_PATH ||
  (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "conversations.json") : "");

if (!convPath || !fs.existsSync(convPath)) {
  console.error("Set CONVERSATIONS_DB_PATH (or DATA_DIR) to the conversations.json to scan.");
  process.exit(2);
}

function loadConversations(p: string): any[] {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.conversations)) return raw.conversations;
  if (raw && typeof raw === "object") return Object.values(raw);
  return [];
}

type HeldRow = {
  convId: string;
  leadKey: string;
  at: string;
  reason: string;
  judgeReason: string;
  channel: string;
  inbound: string;
  draft: string;
};

const held: HeldRow[] = [];
for (const c of loadConversations(convPath)) {
  const h = c?.draftHeld;
  if (!h) continue;
  held.push({
    convId: String(c.id ?? ""),
    leadKey: String(c.leadKey ?? ""),
    at: String(h.at ?? ""),
    reason: String(h.reason ?? ""),
    judgeReason: String(h.judgeReason ?? ""),
    channel: String(h.channel ?? ""),
    inbound: String(h.inboundPreview ?? ""),
    draft: String(h.draftPreview ?? "")
  });
}
held.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

const lines: string[] = [];
lines.push(`# Held-drafts report — ${held.length} draft(s) currently held by the quality gate`);
lines.push(`# Source: ${convPath}`);
lines.push(
  "# These are candidate CODE/COMPREHENSION bugs for the agent-watch loop: a draft the gate held and"
);
lines.push(
  "# self-heal could not fix. Triage each — is it a parser/routing bug? If so, write a parser-first fix"
);
lines.push("# (approve-first PR). After the fix deploys, re-regenerate the conversation to release the hold.");
lines.push("");
if (!held.length) {
  lines.push("(no held drafts — nothing to diagnose right now)");
} else {
  for (const r of held) {
    lines.push(`## conv ${r.convId} (${r.leadKey}) — ${r.channel} — held ${r.at} [${r.reason}]`);
    lines.push(`  customer: ${r.inbound || "(inbound not captured)"}`);
    lines.push(`  held draft: ${r.draft || "(draft not captured)"}`);
    lines.push(`  judge: ${r.judgeReason || "(no reason)"}`);
    lines.push("");
  }
}

const out = lines.join("\n");
const outPath = process.env.DRAFT_HELD_REPORT_OUT;
if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, out + "\n", "utf8");
  console.log(`Wrote ${held.length} held draft(s) to ${outPath}`);
} else {
  console.log(out);
}
