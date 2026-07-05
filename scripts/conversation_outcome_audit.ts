/**
 * Conversation OUTCOME audit sweep — Phase 2 detection feed (docs/autonomous_coding_loop.md).
 *
 * Read-only. Scans the conversation store for deterministic STATE/side-effect contradictions across
 * every dimension (appointment / cadence / watch / held-flag / orphan-todo) and writes ONE anomaly
 * feed the self-healing loop consumes. A healthy store => 0 anomalies; any hit is a net-new bug or a
 * regression of a reconcile heal. This is the feed that replaces a human watching the agent.
 *
 * Run (local): npx tsx scripts/conversation_outcome_audit.ts
 * Run (on the box, against a dealer store):
 *   CONVERSATIONS_DB_PATH=/home/ubuntu/leadrider-runtime/americanharley/data/conversations.json \
 *   REPORT_ROOT=/home/ubuntu/leadrider-runtime/americanharley/reports \
 *   npx tsx scripts/conversation_outcome_audit.ts
 *
 * Never mutates the store or the live path. Pin DATA via CONVERSATIONS_DB_PATH so no stray store is made.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbPath = path.resolve(process.env.CONVERSATIONS_DB_PATH || "data/conversations.json");
// Read the store file directly (read-only) — the store module hydrates ASYNC on import, so a sync
// accessor read would race it; and we never want to mutate/boot the live store from a sweep.
const raw = JSON.parse(fs.readFileSync(dbPath, "utf8"));
const convs: any[] = Array.isArray(raw?.conversations) ? raw.conversations : [];
const todos: any[] = (Array.isArray(raw?.todos) ? raw.todos : []).filter((t: any) => t?.status === "open");

const { auditConversationStore } = await import("../services/api/src/domain/conversationOutcomeAudit.ts");
const { anomalies, summary } = auditConversationStore({ conversations: convs, todos, now: new Date() });

const reportRoot = process.env.REPORT_ROOT || path.resolve("reports");
const outDir = path.join(reportRoot, "outcome_audit");
fs.mkdirSync(outDir, { recursive: true });
const payload = { generatedAt: new Date().toISOString(), source: process.env.CONVERSATIONS_DB_PATH, summary, anomalies };
fs.writeFileSync(path.join(outDir, "latest.json"), JSON.stringify(payload, null, 2));

console.log(`Conversation outcome audit — scanned ${summary.conversationsScanned} conversations`);
console.log(`Anomalies: ${summary.totalAnomalies} (P1 ${summary.bySeverity.P1} / P2 ${summary.bySeverity.P2} / P3 ${summary.bySeverity.P3}); regressions (healed-dimension hits): ${summary.regressionAnomalies}`);
console.log(`By category: state ${summary.byCategory.state} / comprehension ${summary.byCategory.comprehension} / feedback ${summary.byCategory.feedback} / discovery ${summary.byCategory.discovery}`);
const dims = Object.entries(summary.byDimension).sort((a, b) => b[1] - a[1]);
for (const [dim, n] of dims) console.log(`  ${String(n).padStart(4)}  ${dim}`);
for (const a of anomalies.slice(0, 25)) console.log(`   - [${a.severity}${a.healed ? "/regression" : ""}] ${a.dimension} ${a.convId} | ${a.detail}`);
if (anomalies.length > 25) console.log(`   … and ${anomalies.length - 25} more (see ${path.join(outDir, "latest.json")})`);
console.log(`\nFeed written: ${path.join(outDir, "latest.json")}`);
