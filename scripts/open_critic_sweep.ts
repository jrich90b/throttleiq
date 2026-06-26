/**
 * Open-critic sweep — Net 3 of the gap-detection loop (docs/autonomous_coding_loop.md).
 *
 * The unknown-unknowns net. Nets 1-2 only catch what our existing judges/categories recognize
 * (context-fidelity frames, material edits). This sweep runs an OPEN-ENDED LLM critic
 * (critiqueConversationHandlingWithLLM) over RECENT conversations with no fixed checklist — "did the
 * agent mishandle THIS lead in ANY way?" — and lets the model NAME the issue class itself. That's how a
 * brand-new gap class surfaces. Findings are escalated to Joe (Tier 2, notify, never auto-merged) because
 * the class is unconfirmed; a confirmed one then earns a real detector + eval.
 *
 * Read-only. Writes reports/open_critic/latest.json in the SAME OutcomeAnomaly shape the deterministic
 * feed uses; anomaly_loop_detect merges both. Conservative + capped to control cost + noise.
 *
 * Needs: LLM_ENABLED=1 + OPENAI_API_KEY (load .env first). Tunables: OPEN_CRITIC_MAX (default 40),
 * OPEN_CRITIC_WINDOW_DAYS (default 2). Kill: LLM_OPEN_CRITIC_ENABLED=0.
 *
 * Run (on the box, against a dealer store):
 *   CONVERSATIONS_DB_PATH=/home/ubuntu/leadrider-runtime/americanharley/data/conversations.json \
 *   REPORT_ROOT=/home/ubuntu/leadrider-runtime/americanharley/reports \
 *   npx tsx scripts/open_critic_sweep.ts
 */
import fs from "node:fs";
import path from "node:path";

const dbPath = path.resolve(process.env.CONVERSATIONS_DB_PATH || "data/conversations.json");
const raw = JSON.parse(fs.readFileSync(dbPath, "utf8"));
const convs: any[] = Array.isArray(raw?.conversations) ? raw.conversations : [];
const openTodos: any[] = (Array.isArray(raw?.todos) ? raw.todos : []).filter((t: any) => t?.status === "open");

// Inventory enrichment: the dealer's current in-stock model list (from the on-disk snapshot beside the
// store) so the critic can catch fabricated availability ("promised a bike we don't have"). Empty/missing
// → the critic skips the inventory check (never assumes out-of-stock). Deduped, by model.
const inStockModels: string[] = (() => {
  try {
    const snap = JSON.parse(fs.readFileSync(path.join(path.dirname(dbPath), "inventory_snapshot.json"), "utf8"));
    const items: any[] = Array.isArray(snap?.items) ? snap.items : Array.isArray(snap) ? snap : [];
    const set = new Set<string>();
    for (const it of items) {
      const label = [it?.year, it?.model ?? it?.description].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      if (label) set.add(label);
    }
    return [...set];
  } catch {
    return [];
  }
})();

const MAX = Number(process.env.OPEN_CRITIC_MAX ?? 40);
const WINDOW_DAYS = Number(process.env.OPEN_CRITIC_WINDOW_DAYS ?? 2);
const now = Date.now();
const windowMs = WINDOW_DAYS * 24 * 60 * 60 * 1000;

const REAL_OUT = new Set(["twilio", "sendgrid", "human"]);
const isClosed = (c: any) => !!(c?.closedAt || c?.closedReason || c?.sale?.soldAt);
const lastAt = (c: any) => {
  const msgs = Array.isArray(c?.messages) ? c.messages : [];
  const t = msgs.length ? Date.parse(String(msgs[msgs.length - 1]?.at ?? "")) : Date.parse(String(c?.updatedAt ?? ""));
  return Number.isFinite(t) ? t : 0;
};

// Prefilter (deterministic, no LLM): recent, open, with a customer message AND a real agent reply to judge.
const candidates = convs
  .filter(c => {
    if (isClosed(c)) return false;
    const msgs = Array.isArray(c?.messages) ? c.messages : [];
    const hasInbound = msgs.some((m: any) => m?.direction === "in" && String(m?.body ?? "").trim());
    const hasRealReply = msgs.some(
      (m: any) => m?.direction === "out" && REAL_OUT.has(String(m?.provider ?? "")) && String(m?.body ?? "").trim()
    );
    return hasInbound && hasRealReply && now - lastAt(c) <= windowMs;
  })
  .sort((a, b) => lastAt(b) - lastAt(a))
  .slice(0, MAX);

const { critiqueConversationHandlingWithLLM } = await import("../services/api/src/domain/llmDraft.ts");
const { decideOpenCriticAnomaly, summarizeTurnActions } = await import("../services/api/src/domain/conversationOutcomeAudit.ts");

const anomalies: any[] = [];
let judged = 0;
let flagged = 0;
for (const c of candidates) {
  const msgs = Array.isArray(c?.messages) ? c.messages : [];
  const thread = msgs
    .filter((m: any) => (m?.direction === "in" || m?.direction === "out") && String(m?.body ?? "").trim())
    .slice(-12)
    .map((m: any) => ({ direction: m.direction as "in" | "out", body: String(m.body) }));
  const lastReply = [...msgs]
    .reverse()
    .find((m: any) => m?.direction === "out" && REAL_OUT.has(String(m?.provider ?? "")) && String(m?.body ?? "").trim());
  if (!lastReply) continue;
  const channel = String(lastReply?.from ?? "").includes("@") ? "email" : "sms";
  const convTodos = openTodos.filter((t: any) => String(t?.convId ?? "") === String(c?.id ?? ""));
  let finding: any = null;
  try {
    finding = await critiqueConversationHandlingWithLLM({
      thread,
      lastAgentReply: String(lastReply.body),
      lead: {
        source: c?.lead?.source ?? null,
        bucket: c?.classification?.bucket ?? null,
        cta: c?.classification?.cta ?? null,
        vehicle: c?.lead?.vehicle?.model ?? c?.lead?.vehicle?.description ?? null
      },
      actions: summarizeTurnActions(c, convTodos),
      inStockModels,
      channel: channel as "sms" | "email"
    });
  } catch {
    finding = null;
  }
  if (!finding) continue;
  judged += 1;
  const anomaly = decideOpenCriticAnomaly(finding, { convId: String(c?.id ?? ""), leadKey: String(c?.leadKey ?? "") });
  if (anomaly) {
    anomalies.push(anomaly);
    flagged += 1;
  }
}

const reportRoot = process.env.REPORT_ROOT || path.resolve("reports");
const outDir = path.join(reportRoot, "open_critic");
fs.mkdirSync(outDir, { recursive: true });
const payload = {
  generatedAt: new Date().toISOString(),
  source: process.env.CONVERSATIONS_DB_PATH,
  summary: { candidates: candidates.length, judged, flagged },
  anomalies
};
fs.writeFileSync(path.join(outDir, "latest.json"), JSON.stringify(payload, null, 2));

console.log(`Open-critic sweep — ${candidates.length} recent candidate(s), ${judged} judged, ${flagged} flagged (major+confident)`);
for (const a of anomalies.slice(0, 25)) console.log(`   - [${a.severity}] ${a.dimension} ${a.convId} | ${a.detail}`);
console.log(`\nFeed written: ${path.join(outDir, "latest.json")}`);
