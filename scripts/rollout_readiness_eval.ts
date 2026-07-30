/**
 * rollout_readiness:eval — pins the dealer-#2 readiness scorecard (scripts/rollout_readiness_report.ts).
 *
 * The scorecard is the BAR itself (Joe, 2026-07-29: dealer #2 triggers on a readiness bar), so the
 * expensive failure is a scorecard that reads MET when it isn't — that would greenlight a rollout on
 * a broken agent. Every gate is therefore pinned fail-CLOSED: a missing input, an unparsed checklist,
 * or a zero-length eval split reads NOT_MET, never MET.
 *
 * Deterministic; no LLM, no network, no report files.
 *
 * Run: npx tsx scripts/rollout_readiness_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  evaluateReadiness,
  formatReadinessLine,
  parseChecklistRows,
  type ReadinessInput
} from "./rollout_readiness_report.ts";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`FAIL ${name}: ${err?.message ?? err}`);
  }
}

const ALL_GREEN: ReadinessInput = {
  checklistRows: [
    { capability: "ADF lead ingestion", status: "WORKING", evidence: "2026-06-11" },
    { capability: "AI SMS drafts", status: "WORKING", evidence: "2026-06-11" }
  ],
  releaseGate: { verdict: "READY", cleanStreakDays: 7, streakTarget: 7 },
  agentManagerTasks: [{ priority: "P2", title: "Review something minor" }],
  portability: { universal: 326, dealer: 0, violations: [] }
};

// --- The happy path is reachable: all four gates green => MET. ---
check("all gates green => MET", () => {
  const s = evaluateReadiness(ALL_GREEN);
  assert.equal(s.verdict, "MET");
  assert.equal(s.gatesMet, 4);
  assert.equal(s.gatesTotal, 4);
  assert.equal(s.score, 100);
  assert.deepEqual(s.blockers, []);
  assert.match(formatReadinessLine(s), /MET — 4\/4/);
});

// --- Each gate independently blocks the bar. ---
check("a non-WORKING checklist row blocks the bar", () => {
  const s = evaluateReadiness({
    ...ALL_GREEN,
    checklistRows: [...ALL_GREEN.checklistRows, { capability: "DocuSign", status: "UNVERIFIED", evidence: "" }]
  });
  assert.equal(s.verdict, "NOT_MET");
  assert.equal(s.gates.find(g => g.id === "checklist")?.met, false);
  assert.ok(s.blockers.some(b => /DocuSign: UNVERIFIED/.test(b)), "blocker names the row");
  assert.equal(s.checklistWorkingPct, 67);
});

check("a short release-gate streak blocks the bar", () => {
  const s = evaluateReadiness({ ...ALL_GREEN, releaseGate: { verdict: "NOT_READY", cleanStreakDays: 3, streakTarget: 7 } });
  assert.equal(s.verdict, "NOT_MET");
  assert.equal(s.gates.find(g => g.id === "release_gate")?.met, false);
  assert.ok(s.blockers.some(b => /streak 3\/7/.test(b)));
});

check("an open P0 or P1 blocks the bar", () => {
  for (const priority of ["P0", "P1"]) {
    const s = evaluateReadiness({ ...ALL_GREEN, agentManagerTasks: [{ priority, title: "Review stale pending drafts" }] });
    assert.equal(s.verdict, "NOT_MET", `${priority} must block`);
    assert.ok(s.blockers.some(b => b.startsWith(`${priority}:`)), `${priority} blocker is listed`);
  }
});

check("P2/P3 tasks do NOT block the bar", () => {
  const s = evaluateReadiness({ ...ALL_GREEN, agentManagerTasks: [{ priority: "P2", title: "x" }, { priority: "P3", title: "y" }] });
  assert.equal(s.gates.find(g => g.id === "no_p0_p1")?.met, true);
  assert.equal(s.verdict, "MET");
});

check("a dealer-portability violation blocks the bar", () => {
  const s = evaluateReadiness({
    ...ALL_GREEN,
    portability: { universal: 326, dealer: 0, violations: ["scripts/foo_eval.ts:12 asserts north tonawanda"] }
  });
  assert.equal(s.verdict, "NOT_MET");
  assert.equal(s.gates.find(g => g.id === "eval_portability")?.met, false);
});

// --- FAIL-CLOSED: a missing or empty input must never read MET. ---
check("missing inputs fail closed (never MET)", () => {
  const s = evaluateReadiness({ checklistRows: [], releaseGate: null, agentManagerTasks: null, portability: null });
  assert.equal(s.verdict, "NOT_MET");
  assert.equal(s.gatesMet, 0, "no gate passes on missing evidence");
  assert.equal(s.checklistWorkingPct, null);
  for (const g of s.gates) assert.ok(g.blockers.length > 0, `${g.id} explains why it is open`);
});

check("an empty checklist never counts as all-WORKING", () => {
  const s = evaluateReadiness({ ...ALL_GREEN, checklistRows: [] });
  assert.equal(s.gates.find(g => g.id === "checklist")?.met, false, "0/0 rows is not a pass");
});

check("a zero-length universal eval split never passes portability", () => {
  const s = evaluateReadiness({ ...ALL_GREEN, portability: { universal: 0, dealer: 0, violations: [] } });
  assert.equal(s.gates.find(g => g.id === "eval_portability")?.met, false, "an unwired split is not a pass");
});

// --- Checklist parsing: only the capability table, never the prose. ---
check("parseChecklistRows reads only the capability table", () => {
  const md = [
    "# Dealer-Ready Checklist",
    "",
    "Some prose about the doc.",
    "",
    "| Capability | Status | Last production evidence | Notes |",
    "| --- | --- | --- | --- |",
    "| ADF lead ingestion | WORKING | 2026-06-11 | |",
    "| DocuSign | UNVERIFIED | tokens 2026-05-19 | open |",
    "| Worker dispatcher | SHADOW | since 6/10 | |",
    "",
    "## Open verification items",
    "1. DocuSign: validate token refresh.",
    "",
    "| Other | Table | That is not the matrix |",
    "| --- | --- | --- |",
    "| junk | junk | junk |"
  ].join("\n");
  const rows = parseChecklistRows(md);
  assert.equal(rows.length, 3, "exactly the three capability rows");
  assert.deepEqual(rows.map(r => r.status), ["WORKING", "UNVERIFIED", "SHADOW"]);
  assert.equal(rows[0].capability, "ADF lead ingestion");
  assert.ok(!rows.some(r => r.capability === "junk"), "the trailing table is not graded");
});

// --- The real checked-in checklist must stay parseable (a doc reshape silently zeroing the
//     gate is exactly the failure this scorecard exists to prevent). ---
check("the live dealer_ready_checklist.md still parses", () => {
  const md = fs.readFileSync("docs/dealer_ready_checklist.md", "utf8");
  const rows = parseChecklistRows(md);
  assert.ok(rows.length >= 10, `expected the capability matrix to parse, got ${rows.length} rows`);
  assert.ok(rows.every(r => /^[A-Z_]+$/.test(r.status)), "every parsed row carries a bare status word");
  assert.ok(rows.some(r => /ADF lead ingestion/i.test(r.capability)), "the ADF ingestion row is present");
});

// --- Source guard: the report must not be able to send or mutate customer state. ---
check("the scorecard is read-only (no sends, no store writes)", () => {
  const src = fs.readFileSync("scripts/rollout_readiness_report.ts", "utf8");
  for (const banned of ["sendEmail", "sendSms", "twilio", "conversations.json"]) {
    assert.ok(!src.includes(banned), `rollout_readiness_report must not reference ${banned}`);
  }
});

if (failures) {
  console.error(`\n${failures} rollout-readiness check(s) failed`);
  process.exit(1);
}
console.log("\nPASS rollout readiness scorecard");
