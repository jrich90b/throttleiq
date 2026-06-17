/**
 * Task-fulfillment auto-close — SHADOW backfill report (read-only).
 *
 * Scans every OPEN call / follow-up task and asks the LLM parser whether the most
 * recent real outbound (SMS/email) AFTER the task was created already fulfilled the
 * task's objective. Prints what a live cutover (TASK_FULFILLMENT_AUTOCLOSE=1) WOULD
 * close — e.g. Don Pagels' "notify when the Freewheeler is available" call task,
 * fulfilled by the "it is available" text. Touches nothing.
 *
 * Run against a store snapshot:
 *   CONVERSATIONS_DB_PATH=/path/to/conversations.json LLM_ENABLED=1 \
 *     OPENAI_API_KEY=... npx tsx scripts/task_fulfillment_autoclose_report.ts [--limit=120]
 */
import {
  reloadConversationStore,
  listOpenTodos,
  getConversation,
  inferTodoTaskClass
} from "../services/api/src/domain/conversationStore.ts";
import { isAutoCloseEligibleTask } from "../services/api/src/domain/taskFulfillmentAutoClose.ts";
import { classifyTaskFulfillmentWithLLM } from "../services/api/src/domain/llmDraft.ts";

const limitArg = process.argv.find(a => a.startsWith("--limit="))?.split("=")[1];
const LIMIT = Math.max(1, Number(process.env.REPORT_LIMIT ?? limitArg ?? 150));

if (!process.env.CONVERSATIONS_DB_PATH) {
  console.error("Set CONVERSATIONS_DB_PATH to the conversations.json you want to scan.");
  process.exit(1);
}
if (process.env.LLM_ENABLED !== "1" || !process.env.OPENAI_API_KEY) {
  console.error("Set LLM_ENABLED=1 and OPENAI_API_KEY — this report calls the LLM parser.");
  process.exit(1);
}

// Real follow-up actions: sent SMS/email AND logged call summaries (the live hook
// evaluates calls too, so the backfill must as well).
const SENT_PROVIDERS = new Set(["twilio", "human", "sendgrid", "voice_summary"]);
const channelFor = (provider: string): "sms" | "email" | "call" =>
  provider === "sendgrid" ? "email" : provider === "voice_summary" ? "call" : "sms";
const ms = (s: unknown) => {
  const t = new Date(String(s ?? "")).getTime();
  return Number.isFinite(t) ? t : 0;
};

await reloadConversationStore();

const open = listOpenTodos();
const eligible = open.filter(t =>
  isAutoCloseEligibleTask({
    status: t.status,
    reason: t.reason,
    taskClass: t.taskClass ?? inferTodoTaskClass(t.reason, t.summary, t as any)
  })
);

type Row = {
  convId: string;
  name: string;
  reason: string;
  summary: string;
  channel: string;
  action: string;
  fulfilled: boolean;
  confidence: number;
  evidence: string;
};

const wouldClose: Row[] = [];
const fulfilledLowConf: Row[] = [];
const notFulfilled: Row[] = [];
let evaluated = 0;
let skippedNoOutbound = 0;

const candidates = eligible
  .map(t => {
    const conv = getConversation(t.convId);
    if (!conv) return null;
    const createdMs = ms(t.createdAt);
    const outbound = [...(conv.messages ?? [])]
      .filter(
        (m: any) =>
          m?.direction === "out" &&
          SENT_PROVIDERS.has(String(m?.provider ?? "")) &&
          String(m?.body ?? "").trim() &&
          ms(m?.at) >= createdMs
      )
      .sort((a: any, b: any) => ms(a?.at) - ms(b?.at));
    const latest = outbound[outbound.length - 1];
    if (!latest) return null;
    const channel = channelFor(String(latest.provider));
    const name = `${conv.lead?.firstName ?? ""} ${conv.lead?.lastName ?? ""}`.trim() || conv.leadKey;
    return { task: t, conv, latest, channel, name };
  })
  .filter(Boolean) as Array<{ task: any; conv: any; latest: any; channel: string; name: string }>;

skippedNoOutbound = eligible.length - candidates.length;
const toScan = candidates.slice(0, LIMIT);

for (const c of toScan) {
  const verdicts = await classifyTaskFulfillmentWithLLM({
    action: { channel: c.channel as "sms" | "email", text: String(c.latest.body ?? "") },
    tasks: [{ id: c.task.id, reason: c.task.reason, summary: c.task.summary }],
    recentHistory: [...(c.conv.messages ?? [])].slice(-6).map((m: any) => ({
      direction: m?.direction === "in" ? "in" : "out",
      body: String(m?.body ?? "")
    }))
  });
  evaluated += 1;
  const v = verdicts?.find(x => x.taskId === c.task.id);
  if (!v) continue;
  const row: Row = {
    convId: c.conv.id,
    name: c.name,
    reason: c.task.reason,
    summary: String(c.task.summary ?? "").slice(0, 90),
    channel: c.channel,
    action: String(c.latest.body ?? "").replace(/\s+/g, " ").slice(0, 90),
    fulfilled: v.fulfilled,
    confidence: v.confidence,
    evidence: v.evidence
  };
  if (!v.fulfilled) notFulfilled.push(row);
  else if (v.confidence >= 0.85) wouldClose.push(row);
  else fulfilledLowConf.push(row);
}

const fmt = (r: Row) =>
  `  [${r.confidence.toFixed(2)}] ${r.name} (${r.convId}) — ${r.reason}\n` +
  `      task: ${r.summary}\n` +
  `      ${r.channel}: "${r.action}"\n` +
  `      why: ${r.evidence}`;

console.log("\n=== Task-fulfillment auto-close — SHADOW backfill ===");
console.log(
  `open eligible tasks: ${eligible.length} | with outbound-since-task: ${candidates.length} | ` +
    `evaluated: ${evaluated}${candidates.length > toScan.length ? ` (capped at ${LIMIT}, ${candidates.length - toScan.length} not scanned)` : ""} | ` +
    `no outbound since task: ${skippedNoOutbound}`
);
console.log(`\nWOULD CLOSE (fulfilled, confidence ≥ 0.85): ${wouldClose.length}`);
wouldClose.sort((a, b) => b.confidence - a.confidence).forEach(r => console.log(fmt(r)));
console.log(`\nfulfilled but BELOW 0.85 (would stay open): ${fulfilledLowConf.length}`);
fulfilledLowConf.sort((a, b) => b.confidence - a.confidence).forEach(r => console.log(fmt(r)));
console.log(`\nNOT fulfilled (stay open) — sanity-check the parser was right: ${notFulfilled.length}`);
notFulfilled
  .sort((a, b) => b.confidence - a.confidence)
  .forEach(r =>
    console.log(
      `  [${r.confidence.toFixed(2)}] ${r.name} (${r.channel}) — task: ${r.summary} | action: "${r.action}"`
    )
  );
console.log("\n(Read-only — nothing was changed.)");
