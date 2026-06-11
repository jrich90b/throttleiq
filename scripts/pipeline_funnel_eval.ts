/**
 * Pipeline funnel stage derivation eval — stages must be consistent with the
 * deal-state machinery (finance signals reuse the disposition closeout
 * blockers, so a lead the agent can't archive is a lead the funnel calls hot).
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const { buildPipelineSummary, deriveLeadStage } = await import(
  "../services/api/src/domain/pipelineFunnel.ts"
);

const nowMs = Date.parse("2026-06-11T22:00:00.000Z");

const batka: any = {
  id: "+17169982451",
  status: "open",
  lead: { firstName: "Dave", lastName: "Batka", source: "HDFS COA Online", vehicle: { year: "2026", model: "Road Glide Limited" } },
  messages: [
    { direction: "in", provider: "sendgrid_adf", at: "2026-06-11T16:26:00.000Z", body: "App ID: 1013954557" },
    { direction: "in", provider: "twilio", at: "2026-06-11T19:08:00.000Z", body: "I am going to take care of the pipes myself" }
  ],
  appointment: { staffNotify: { outcome: { note: "Showed - finance needs more info", updatedAt: "2026-05-15T16:00:00.000Z" } } }
};
assert.equal(
  deriveLeadStage(batka, { openTodos: [{ convId: "+17169982451", reason: "approval", summary: "Credit approval task" }], nowMs }),
  "finance",
  "active credit signals outrank showed"
);

const showed: any = {
  id: "a", status: "open",
  messages: [{ direction: "in", provider: "twilio", at: "2026-06-01T00:00:00.000Z", body: "hi" }],
  appointment: { status: "confirmed", staffNotify: { outcome: { note: "Showed", updatedAt: "2026-06-01T00:00:00.000Z" } } }
};
assert.equal(deriveLeadStage(showed, { nowMs }), "showed");

const appt: any = { id: "b", status: "open", appointment: { status: "confirmed" }, messages: [{ direction: "in", provider: "twilio", at: "2026-06-10T00:00:00.000Z", body: "yes" }] };
assert.equal(deriveLeadStage(appt, { nowMs }), "appointment");

const quoted: any = { id: "c", status: "open", voiceFacts: { quotedPrice: 14995, updatedAt: "2026-06-01T00:00:00.000Z" }, messages: [{ direction: "in", provider: "twilio", at: "2026-06-01T00:00:00.000Z", body: "ok" }] };
assert.equal(deriveLeadStage(quoted, { nowMs }), "quoted");

const engaged: any = { id: "d", status: "open", messages: [{ direction: "in", provider: "twilio", at: "2026-06-10T00:00:00.000Z", body: "how much" }] };
assert.equal(deriveLeadStage(engaged, { nowMs }), "engaged");

const fresh: any = { id: "e", status: "open", messages: [{ direction: "in", provider: "sendgrid_adf", at: "2026-06-11T00:00:00.000Z", body: "WEB LEAD" }] };
assert.equal(deriveLeadStage(fresh, { nowMs }), "new", "ADF-only lead is new");

const sold: any = { id: "f", status: "closed", closedReason: "sold", closedAt: "2026-06-01T00:00:00.000Z", messages: [] };
assert.equal(deriveLeadStage(sold, { nowMs }), "won");
const lost: any = { id: "g", status: "closed", closedReason: "no_response", closedAt: "2026-06-01T00:00:00.000Z", messages: [] };
assert.equal(deriveLeadStage(lost, { nowMs }), "lost");

const summary = buildPipelineSummary([batka, showed, appt, quoted, engaged, fresh, sold, lost], [
  { convId: "+17169982451", reason: "approval", summary: "Credit approval task" }
], nowMs);
const counts = Object.fromEntries(summary.stages.map(s => [s.stage, s.count]));
assert.deepEqual(
  counts,
  { new: 1, engaged: 1, quoted: 1, appointment: 1, showed: 1, finance: 1, won: 1, lost: 1 },
  `stage counts: ${JSON.stringify(counts)}`
);
assert.equal(summary.totals.open, 6);
assert.equal(summary.totals.financeActive, 1);
const financeCards = summary.stages.find(s => s.stage === "finance")!.cards;
assert.equal(financeCards[0].name, "Dave Batka");
assert.equal(financeCards[0].creditActive, true);
assert.equal(financeCards[0].bike, "2026 Road Glide Limited");

// Old closed conversations fall out of the display window.
const oldLost: any = { id: "h", status: "closed", closedReason: "no_response", closedAt: "2026-01-01T00:00:00.000Z", messages: [] };
const summary2 = buildPipelineSummary([oldLost], [], nowMs);
assert.equal(summary2.stages.find(s => s.stage === "lost")!.count, 0, "stale closed leads excluded");

// Endpoint wiring pin.
const apiSource = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
assert.match(apiSource, /app\.get\("\/pipeline", /, "pipeline endpoint must exist");
assert.match(apiSource, /buildPipelineSummary\(getAllConversations\(\), listOpenTodos\(\)\)/, "endpoint uses the domain summary");

console.log("PASS pipeline funnel eval");
