/**
 * Stale-handoff audit (2026-06-15) — the "we promised, then nothing happened" net.
 *
 * The agent creates a staff task whenever it hands off (pricing/payment numbers,
 * finance/credit, callback, reservation steps, lien docs, a reminder). Today
 * `followup_task_consistency_audit` catches DUPLICATES and cadence-vs-todo
 * mismatches, and `task_escalation` nudges the manager — but only within a 48h
 * lookback. A handoff/reminder task left OPEN for days past that falls through
 * every net: the customer is waiting on a promise no one kept, silently.
 *
 * This deterministic audit flags open handoff/reminder tasks aged past a
 * threshold on still-open conversations. Cadence-generated follow-ups and
 * appointment tasks are excluded (those are owned by other audits / are
 * future-dated by design).
 *
 * Gate (stale_handoff:eval) runs --self-test. Real run (stale_handoff:audit)
 * reads the live store; added to the nightly loop.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DONE_STATUS = /done|complete|cancel/i;
// Handoff/promise themes carried in a task's reason/summary.
const HANDOFF_RE =
  /pricing|payment|finance|credit|callback|call back|lien|reservation|reserve|quote|appraisal|number|prequal|application|trade[- ]?in|docs?\b/i;

export type StaleHandoffFinding = {
  todoId: string;
  convId: string;
  leadKey: string;
  reason: string;
  taskClass: string;
  ageDays: number;
  owner: string;
  summary: string;
};

const norm = (s: unknown) => String(s ?? "").toLowerCase();

function isOpen(t: any): boolean {
  return !DONE_STATUS.test(norm(t?.status || "open"));
}

// A handoff/reminder task a human is supposed to action (not a cadence auto-touch
// and not an appointment slot).
export function isHandoffTask(t: any): boolean {
  const cls = norm(t?.taskClass);
  if (cls === "appointment") return false; // future-dated by design
  if (cls === "followup") return false; // cadence auto-touches — owned by followup_task_consistency
  if (cls === "reminder") return true; // a due reminder that never fired is a miss
  return HANDOFF_RE.test(`${t?.reason ?? ""} ${t?.summary ?? ""}`);
}

// PURE: find open handoff/reminder tasks aged past staleDays on open convs.
export function findStaleHandoffTodos(
  todos: any[],
  convStatusById: Map<string, string>,
  opts: { nowMs: number; staleDays: number }
): StaleHandoffFinding[] {
  const cutoff = opts.nowMs - opts.staleDays * 24 * 60 * 60 * 1000;
  const out: StaleHandoffFinding[] = [];
  for (const t of todos ?? []) {
    if (!isOpen(t)) continue;
    if (!isHandoffTask(t)) continue;
    const createdMs = Date.parse(String(t?.createdAt ?? ""));
    if (!Number.isFinite(createdMs) || createdMs > cutoff) continue; // not stale yet
    const convStatus = norm(convStatusById.get(String(t?.convId ?? "")) ?? "open");
    if (/closed|completed|sold|archiv/.test(convStatus)) continue; // conv resolved -> moot
    out.push({
      todoId: String(t?.id ?? ""),
      convId: String(t?.convId ?? ""),
      leadKey: String(t?.leadKey ?? ""),
      reason: String(t?.reason ?? ""),
      taskClass: String(t?.taskClass ?? ""),
      ageDays: Math.round((opts.nowMs - createdMs) / (24 * 60 * 60 * 1000)),
      owner: String(t?.owner?.name ?? t?.ownerName ?? ""),
      summary: String(t?.summary ?? "").replace(/\s+/g, " ").slice(0, 140)
    });
  }
  return out.sort((a, b) => b.ageDays - a.ageDays);
}

export function summarizeStaleHandoffs(findings: StaleHandoffFinding[]) {
  const byReason: Record<string, number> = {};
  for (const f of findings) byReason[f.reason || "(none)"] = (byReason[f.reason || "(none)"] ?? 0) + 1;
  return {
    total: findings.length,
    convsAffected: new Set(findings.map(f => f.convId)).size,
    oldestDays: findings.length ? findings[0].ageDays : 0,
    byReason
  };
}

function selfTest() {
  const ok = (c: boolean, l: string) => { if (!c) { console.error(`SELF-TEST FAIL: ${l}`); process.exit(1); } };
  const now = Date.parse("2026-06-15T12:00:00Z");
  const daysAgo = (d: number) => new Date(now - d * 86400000).toISOString();
  const convStatus = new Map<string, string>([["a", "open"], ["b", "open"], ["c", "closed"]]);

  const todos = [
    { id: "1", convId: "a", reason: "pricing", taskClass: "todo", status: "open", createdAt: daysAgo(5), summary: "send payment numbers" }, // STALE
    { id: "2", convId: "a", reason: "callback", taskClass: "todo", status: "open", createdAt: daysAgo(1), summary: "call customer" }, // too fresh
    { id: "3", convId: "b", reason: "reservation", taskClass: "todo", status: "open", createdAt: daysAgo(4), summary: "reservation steps" }, // STALE
    { id: "4", convId: "a", reason: "pricing", taskClass: "todo", status: "done", createdAt: daysAgo(9), summary: "done one" }, // done -> skip
    { id: "5", convId: "a", reason: "followup", taskClass: "followup", status: "open", createdAt: daysAgo(9), summary: "cadence touch" }, // cadence followup -> skip
    { id: "6", convId: "a", reason: "appointment", taskClass: "appointment", status: "open", createdAt: daysAgo(9), summary: "appt" }, // appointment -> skip
    { id: "7", convId: "c", reason: "finance", taskClass: "todo", status: "open", createdAt: daysAgo(9), summary: "finance" }, // conv closed -> skip
    { id: "8", convId: "b", reason: "", taskClass: "reminder", status: "open", createdAt: daysAgo(6), summary: "reminder to follow up" } // STALE reminder
  ];
  const f = findStaleHandoffTodos(todos, convStatus, { nowMs: now, staleDays: 3 });
  const ids = f.map(x => x.todoId).sort();
  ok(JSON.stringify(ids) === JSON.stringify(["1", "3", "8"]), `expected [1,3,8], got ${JSON.stringify(ids)}`);
  ok(f[0].todoId === "8" || f[0].ageDays >= f[1].ageDays, "sorted oldest-first");
  const s = summarizeStaleHandoffs(f);
  ok(s.total === 3 && s.convsAffected === 2, `summary ${JSON.stringify(s)}`);
  console.log("PASS stale-handoff audit self-test");
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) { selfTest(); return; }

  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args.set(argv[i], argv[i + 1] ?? "");
  const conversationsPath =
    args.get("--conversations") ||
    process.env.CONVERSATIONS_DB_PATH ||
    (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "conversations.json") : path.resolve(process.cwd(), "services", "api", "data", "conversations.json"));
  const staleDays = Number(args.get("--stale-days") || process.env.STALE_HANDOFF_DAYS || "3");
  const outDir = args.get("--out-dir") || process.env.STALE_HANDOFF_OUT_DIR || path.resolve(process.cwd(), "reports", "stale_handoff");

  if (!fs.existsSync(conversationsPath)) { console.error(`Conversations file not found: ${conversationsPath}`); process.exit(1); }
  const raw = JSON.parse(fs.readFileSync(conversationsPath, "utf8"));
  const todos: any[] = Array.isArray(raw?.todos) ? raw.todos : [];
  const convs: any[] = Array.isArray(raw?.conversations) ? raw.conversations : [];
  const convStatusById = new Map<string, string>();
  for (const c of convs) convStatusById.set(String(c?.id ?? ""), String(c?.status ?? (c?.closedAt ? "closed" : "open")));

  const findings = findStaleHandoffTodos(todos, convStatusById, { nowMs: Date.now(), staleDays });
  const summary = summarizeStaleHandoffs(findings);

  fs.mkdirSync(outDir, { recursive: true });
  const report = { generatedAt: new Date().toISOString(), source: { conversationsPath, staleDays, openTodos: todos.filter(isOpen).length }, summary, findings };
  fs.writeFileSync(path.join(outDir, "stale_handoff_summary.json"), JSON.stringify({ ...report, findings: undefined }, null, 2));
  fs.writeFileSync(path.join(outDir, "stale_handoff_findings.json"), JSON.stringify(report, null, 2));
  const md = [
    "# Stale-Handoff Audit",
    "",
    `Generated: ${report.generatedAt} | threshold: ${staleDays}d`,
    `Stale open handoff/reminder tasks: ${summary.total} across ${summary.convsAffected} convs (oldest ${summary.oldestDays}d)`,
    "",
    ...findings.slice(0, 50).map(f => `- [${f.reason || f.taskClass}] ${f.convId} (${f.leadKey}) ${f.ageDays}d old${f.owner ? `, owner ${f.owner}` : ""}: "${f.summary}"`)
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "stale_handoff_report.md"), md + "\n");

  console.log(`stale-handoff audit: ${summary.total} stale open handoff/reminder task(s) across ${summary.convsAffected} convs (oldest ${summary.oldestDays}d); report at ${outDir}`);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) main();
