import { strict as assert } from "node:assert";
import fs from "node:fs";

/**
 * Operator "Report issue" feed eval (2026-06-27).
 *
 * The explicit-human-flag net of the self-healing loop: a rep clicks "Report issue" with a note when
 * they notice something wrong on a conversation — wrong routing/intent, bad cadence, a missed/wrong
 * appointment, a missing/duplicate task, a botched handoff, etc. (turn-WIDE, not message-bound). It's
 * the strongest "this was wrong + here's why" signal (better than an inferred 👎 or an edit diff).
 *
 * Pins: (1) the audit emit (an OPEN recent reportedIssue → a `reported_issue` anomaly carrying the
 * note; resolved / stale / empty → none); (2) the classifier (reported_issue → Tier 2 escalate,
 * notify, never auto-merge — even if the category "graduated"); (3) the endpoint + feed wiring
 * (source guards). Pure where possible; no network.
 */

const { auditConversationOutcome } = await import("../services/api/src/domain/conversationOutcomeAudit.ts");
const { classifyOutcomeAnomaly } = await import("../services/api/src/domain/anomalyClassifier.ts");

const NOW = new Date("2026-06-27T12:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

const conv = (reportedIssues: any[]) => ({ id: "+1555", leadKey: "+1555", reportedIssues });
const reportedDims = (c: any) =>
  auditConversationOutcome(c, { now: NOW }).filter(a => a.dimension === "reported_issue");

// 1. AUDIT EMIT — an open, recent report with a note surfaces, carrying category + note.
{
  const got = reportedDims(
    conv([{ id: "ri_1", at: ago(1), category: "cadence", note: "kept nudging after he said he bought elsewhere", status: "open" }])
  );
  assert.equal(got.length, 1, "one open recent report => one anomaly");
  assert.equal(got[0].category, "feedback", "reported_issue maps to feedback category");
  assert.equal(got[0].severity, "P2", "P2");
  assert.ok(/cadence/.test(got[0].detail) && /nudging/.test(got[0].detail), "detail carries category + the note");
}

// Noise floor: resolved / stale (>21d) / empty-note never feed the loop.
assert.equal(reportedDims(conv([{ id: "r", at: ago(1), note: "x", status: "resolved" }])).length, 0, "resolved => no anomaly");
assert.equal(reportedDims(conv([{ id: "r", at: ago(40), note: "x", status: "open" }])).length, 0, "stale (>21d) => no anomaly");
assert.equal(reportedDims(conv([{ id: "r", at: ago(1), note: "   ", status: "open" }])).length, 0, "empty note => no anomaly");
assert.equal(reportedDims(conv([])).length, 0, "no reports => no anomaly");
// Multiple open reports each surface.
assert.equal(
  reportedDims(conv([
    { id: "a", at: ago(1), category: "task", note: "missing callback task", status: "open" },
    { id: "b", at: ago(2), category: "handoff", note: "never handed to service", status: "open" }
  ])).length,
  2,
  "two open reports => two anomalies"
);

// 2. CLASSIFICATION — always Tier 2 escalate, notify, never auto-merge (even if graduated).
const anomaly = reportedDims(
  conv([{ id: "ri", at: ago(1), category: "routing", note: "answered the wrong question", status: "open" }])
)[0];
const cls = classifyOutcomeAnomaly(anomaly, {});
assert.equal(cls.tier, 2, "reported_issue => Tier 2");
assert.equal(cls.action, "escalate", "escalate (approve-first)");
assert.equal(cls.workOrder, true, "is a work order");
assert.equal(cls.notify, true, "notify the operator");
assert.equal(cls.autoMergeEligible, false, "never auto-merge");
const gradCls = classifyOutcomeAnomaly(anomaly, { graduatedCategories: new Set(["reported_issue"]) });
assert.equal(gradCls.autoMergeEligible, false, "stays approve-first even if the dimension 'graduates' (human judgment)");

// 3. WIRING — the endpoint exists and the feed/classifier reference the dimension.
const idx = fs.readFileSync("services/api/src/index.ts", "utf8");
assert.match(idx, /app\.post\("\/conversations\/:id\/report-issue"/, "report-issue endpoint exists");
assert.match(idx, /note required/, "endpoint requires a note");
const audit = fs.readFileSync("services/api/src/domain/conversationOutcomeAudit.ts", "utf8");
assert.match(audit, /dimension: "reported_issue"/, "audit emits the reported_issue anomaly");
const classifier = fs.readFileSync("services/api/src/domain/anomalyClassifier.ts", "utf8");
assert.match(classifier, /anomaly\.dimension === "reported_issue"/, "classifier has the reported_issue escalate branch");

console.log("PASS reported_issue eval");
