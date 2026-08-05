/**
 * Console Copilot Phase 1 (docs/console_copilot_phase1.md): pins the deterministic heat
 * scoring + snapshot the manager copilot answers from, and the read-only wiring of its two
 * endpoints. Clock is PINNED (2026-08-05 midnight lesson: never let an eval read the wall
 * clock).
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const { computeLeadHeat, buildCopilotSnapshot, renderCopilotSnapshotForLLM } = await import(
  "../services/api/src/domain/copilotInsights.ts"
);

const nowMs = Date.parse("2026-08-05T15:00:00.000Z");
const hoursAgo = (h: number) => new Date(nowMs - h * 3_600_000).toISOString();

const inbound = (at: string) => ({
  id: `m-${at}`,
  direction: "in",
  from: "+15550000001",
  to: "+15550000002",
  body: "sounds good",
  at,
  provider: "twilio"
});

// A lead firing every signal: fresh reply + proposed visit + active watch + open task.
const blazing: any = {
  id: "conv-blazing",
  leadKey: "+15550000001",
  mode: "suggest",
  createdAt: hoursAgo(72),
  updatedAt: hoursAgo(3),
  messages: [inbound(hoursAgo(3))],
  lead: { name: "Test Rider", phone: "+15550000001", source: "Dealer Website" },
  appointment: { status: "proposed" },
  inventoryWatches: [{ model: "Street Glide", status: "active" }]
};
const openTodos: any[] = [
  { id: "t1", convId: "conv-blazing", status: "open", summary: "call back", dueAt: hoursAgo(2) },
  { id: "t2", convId: "conv-other", status: "open", summary: "future", dueAt: hoursAgo(-30) },
  { id: "t3", convId: "conv-other", status: "done", summary: "done", dueAt: hoursAgo(50) }
];

const hot = computeLeadHeat(blazing, openTodos, nowMs);
assert.ok(hot, "all-signals lead must score");
assert.equal(hot!.temperature, "hot", "reply+visit+watch+task = hot");
assert.equal(hot!.score, 40 + 25 + 15 + 10, "hot score is the sum of its reasons");
assert.deepEqual(
  hot!.reasons.map(r => r.key),
  ["recent_reply", "visit_proposed", "active_watch", "open_task"],
  "every point on the score carries a named reason"
);
assert.equal(hot!.lastInboundAt, blazing.messages[0].at, "heat reports the last customer reply");

// Recency decays: the same lead gone quiet for 5 days is only warm-band on the reply signal.
const cooling = { ...blazing, id: "conv-cooling", messages: [inbound(hoursAgo(5 * 24))] };
const cooled = computeLeadHeat(cooling, [], nowMs);
assert.equal(cooled!.reasons.find(r => r.key === "reply_this_week")!.points, 20, "5d-old reply scores the weekly band");
assert.equal(cooled!.reasons.some(r => r.key === "recent_reply"), false, "5d-old reply is not a recent reply");

// A week-old-reply-only lead is cold, not hot.
const quiet: any = {
  id: "conv-quiet",
  leadKey: "+15550000003",
  mode: "suggest",
  createdAt: hoursAgo(200),
  updatedAt: hoursAgo(150),
  messages: [inbound(hoursAgo(6 * 24))],
  lead: { name: "Quiet Lead", phone: "+15550000003", source: "Facebook" }
};
const quietHeat = computeLeadHeat(quiet, [], nowMs);
assert.equal(quietHeat!.temperature, "cold", "an old reply alone is cold");
assert.equal(quietHeat!.score, 20, "old-reply-only score");

// Exclusions: sold, closed, on-hold, and confirmed-visit leads are never heat candidates.
assert.equal(computeLeadHeat({ ...blazing, id: "c1", status: "closed" }, [], nowMs), null, "closed lead never heats");
assert.equal(
  computeLeadHeat({ ...blazing, id: "c2", sale: { soldAt: hoursAgo(24) } }, [], nowMs),
  null,
  "sold lead never heats"
);
assert.equal(
  computeLeadHeat({ ...blazing, id: "c3", hold: { reason: "unit hold" } }, [], nowMs),
  null,
  "on-hold lead is being handled, not chased"
);
assert.equal(
  computeLeadHeat({ ...blazing, id: "c4", appointment: { status: "confirmed" } }, [], nowMs),
  null,
  "a confirmed visit takes the lead off the needs-attention list"
);

// Paused watches don't count as demand.
const pausedWatch = computeLeadHeat(
  { ...blazing, id: "c5", appointment: undefined, inventoryWatches: [{ model: "X", status: "paused" }] },
  [],
  nowMs
);
assert.equal(pausedWatch!.reasons.some(r => r.key === "active_watch"), false, "paused watch is not active demand");

// Snapshot: totals, ordering, and the overdue-task line staff will read.
const snapshot = buildCopilotSnapshot([blazing, quiet, { ...blazing, id: "c6", status: "closed" }], openTodos, nowMs, {
  limit: 10
});
assert.equal(snapshot.generatedAt, new Date(nowMs).toISOString(), "snapshot stamps the pinned clock");
assert.equal(snapshot.totals.openLeads, 2, "closed lead is not an open lead");
assert.equal(snapshot.totals.hot, 1, "one hot lead in the fixture set");
assert.equal(snapshot.totals.openTasks, 2, "done tasks are not open");
assert.equal(snapshot.totals.overdueTasks, 1, "only past-due open tasks are overdue");
assert.equal(snapshot.totals.visitProposedNotConfirmed, 1, "proposed visit counted");
assert.equal(snapshot.hotLeads[0]!.convId, "conv-blazing", "hottest lead sorts first");
assert.ok(
  snapshot.bySource.some(s => s.source === "Dealer Website" && s.count === 1),
  "sources are tallied"
);

// The LLM grounding text carries bracketed conv ids (leadRefs come FROM the snapshot, the
// model never invents ids) and the deterministic counts.
const text = renderCopilotSnapshotForLLM(snapshot);
assert.match(text, /\[conv-blazing\]/, "grounding text brackets the conv id for citation");
assert.ok(text.includes("Open sales leads: 2 (hot 1, warm 0)"), "grounding text carries the counts");
assert.match(text, /2 open, 1 overdue/, "grounding text carries the task counts");

// Wiring: registration pinned by plain-string includes (no code-syntax regex — the
// source-pin ratchet's lesson), everything else pinned by BEHAVIOR: the handlers are
// called directly with mock req/res.
const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
assert.ok(
  apiSource.includes("registerCopilotRoutes(app)"),
  "copilot routes are registered in index.ts"
);
// The deterministic GET lane must never grow an LLM call.
const routeSource = await fs.readFile(path.resolve("services/api/src/routes/copilot.ts"), "utf8");
const insightsHandlerSource = routeSource
  .split("export function copilotInsightsHandler")[1]!
  .split("export async function copilotAskHandler")[0]!;
assert.doesNotMatch(
  insightsHandlerSource,
  /answerCopilotQuestionWithLLM/,
  "the insights GET is deterministic — no LLM in that lane"
);

// This eval must NEVER spend a real LLM call: LLM is forced off (the ask path's 503 lane),
// and a placeholder key satisfies llmDraft's module-load client construction when the eval
// runs outside the ci:eval env.
process.env.LLM_ENABLED = "0";
process.env.OPENAI_API_KEY ??= "eval-placeholder-never-called";
const { copilotInsightsHandler, copilotAskHandler } = await import(
  "../services/api/src/routes/copilot.ts"
);
function mockRes() {
  return {
    statusCode: 200,
    body: null as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    }
  };
}

// Non-managers are refused on both endpoints.
const salesInsights = mockRes();
copilotInsightsHandler({ user: { role: "salesperson" } } as any, salesInsights as any);
assert.equal(salesInsights.statusCode, 403, "insights is manager-only");
const salesAsk = mockRes();
await copilotAskHandler({ user: { role: "salesperson" }, body: { question: "hot leads?" } } as any, salesAsk as any);
assert.equal(salesAsk.statusCode, 403, "ask is manager-only");

// A manager gets a live snapshot from the deterministic lane.
const managerInsights = mockRes();
copilotInsightsHandler({ user: { role: "manager" } } as any, managerInsights as any);
assert.equal(managerInsights.statusCode, 200, "manager can read insights");
assert.ok(managerInsights.body?.snapshot?.totals, "insights returns a snapshot");

// Empty question is rejected before any budget or LLM spend.
const emptyAsk = mockRes();
await copilotAskHandler({ user: { role: "manager" }, body: {} } as any, emptyAsk as any);
assert.equal(emptyAsk.statusCode, 400, "empty question is rejected");

// The daily cap refuses BEFORE the LLM is consulted.
process.env.COPILOT_ASK_DAILY_CAP = "0";
const cappedAsk = mockRes();
await copilotAskHandler({ user: { role: "manager" }, body: { question: "hot leads?" } } as any, cappedAsk as any);
assert.equal(cappedAsk.statusCode, 429, "exhausted daily budget refuses the ask");
delete process.env.COPILOT_ASK_DAILY_CAP;

// With the LLM disabled (forced off above) the ask degrades to 503 — never a fabricated answer.
const noLlmAsk = mockRes();
await copilotAskHandler({ user: { role: "manager" }, body: { question: "hot leads?" } } as any, noLlmAsk as any);
assert.equal(noLlmAsk.statusCode, 503, "LLM off = unavailable, not a made-up answer");

// registerCopilotRoutes registers every copilot endpoint — behavior-tested with a mock app,
// so index.ts's single registration line provably carries all three routes.
const { registerCopilotRoutes } = await import("../services/api/src/routes/copilot.ts");
const registered: string[] = [];
registerCopilotRoutes({
  get: (p: string) => registered.push(`GET ${p}`),
  post: (p: string) => registered.push(`POST ${p}`)
} as any);
assert.deepEqual(
  registered,
  ["GET /copilot/insights", "POST /copilot/ask", "POST /copilot/marketing-list"],
  "registerCopilotRoutes carries all copilot endpoints"
);

console.log("PASS console copilot insights eval");
