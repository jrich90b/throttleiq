/**
 * Held-draft → agent-watch BRIDGE eval.
 *
 * Pins the bridge from the runtime held-gate to the code-fix loop: (1) the gate records diagnosis
 * context (the customer turn + the held draft) on conv.draftHeld, and (2) the held-drafts report
 * surfaces every currently-held draft with that context so the agent-watch loop can diagnose +
 * fix the code parser-first.
 *
 * Deterministic — always runs. Run: npx tsx scripts/draft_held_bridge_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// --- 1) Source guard. ---
const store = fs.readFileSync("services/api/src/domain/conversationStore.ts", "utf8");
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.ok(/inboundPreview\?: string;/.test(store) && /draftPreview\?: string;/.test(store), "draftHeld must carry inbound + draft previews for diagnosis");
assert.ok(/inboundPreview: String\(getLastInboundBody/.test(index), "the gate must capture the inbound on hold");
assert.ok(/draftPreview: String\(invariant\.draftText/.test(index), "the gate must capture the held draft on hold");
assert.ok(fs.existsSync("scripts/draft_held_report.ts"), "the held-drafts report must exist (the bridge to agent-watch)");
const report = fs.readFileSync("scripts/draft_held_report.ts", "utf8");
assert.ok(/draftHeld/.test(report) && /CONVERSATIONS_DB_PATH/.test(report), "the report must scan draftHeld via the standard store path");
assert.ok(/agent-watch/.test(report), "the report must frame held drafts as agent-watch diagnosis candidates");

// --- 2) End-to-end: the report surfaces a held draft with its diagnosis context, skips non-held. ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "held-bridge-"));
const convFile = path.join(tmp, "conversations.json");
const fixture = [
  {
    id: "conv_held_1",
    leadKey: "+15551112222",
    draftHeld: {
      at: "2026-06-19T10:00:00.000Z",
      reason: "live_hold",
      judgeReason: "fabricates a 2025 Breakout in stock not in context",
      channel: "sms",
      inboundPreview: "Thanks Joe",
      draftPreview: "Good news — we just got a 2025 Breakout in Billiard Gray in stock. Want a time to see it?"
    }
  },
  { id: "conv_ok_2", leadKey: "+15553334444", messages: [] }
];
fs.writeFileSync(convFile, JSON.stringify(fixture));
const out = execFileSync("npx", ["tsx", "scripts/draft_held_report.ts"], {
  env: { ...process.env, CONVERSATIONS_DB_PATH: convFile },
  encoding: "utf8"
});
assert.ok(/1 draft\(s\) currently held/.test(out), `report should count 1 held draft; got:\n${out}`);
assert.ok(/conv_held_1/.test(out), "report must list the held conversation");
assert.ok(/Thanks Joe/.test(out) && /Billiard Gray/.test(out), "report must include the customer turn + the held draft for diagnosis");
assert.ok(/fabricates a 2025 Breakout/.test(out), "report must include the judge's reason");
assert.ok(!/conv_ok_2/.test(out), "report must NOT list non-held conversations");
fs.rmSync(tmp, { recursive: true, force: true });

console.log("PASS draft held-bridge eval (gate captures diagnosis context + report surfaces held drafts for agent-watch)");
