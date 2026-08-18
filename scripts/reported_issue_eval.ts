import { strict as assert } from "node:assert";
import fs from "node:fs";

/**
 * Operator "Report issue" → self-healing-loop feed eval (2026-06-27).
 *
 * The existing dashboard "Report issue" button (opsAnomalyStore) is the explicit-human-flag net: a rep
 * flags something wrong on a conversation with a note — the strongest "this was wrong + here's why"
 * signal there is. This wires the AGENT-BEHAVIOR subset of those reports into the code loop (on top of
 * the support-ticket flow they already trigger).
 *
 * Pins: (1) decideOpsAnomalyReportedIssue — only agent-behavior types cross (routing/cadence/appointment/
 * task_inbox/handoff/other); tone + infra (inventory/integration/ui) are dropped; closed/info/no-note/
 * convId-less/stale are dropped; carries the note. (2) the classifier escalates reported_issue Tier 2
 * (notify, never auto-merge, even if graduated). (3) the sweep + the detect-merge wiring (source guards).
 */

const { decideOpsAnomalyReportedIssue } = await import("../services/api/src/domain/conversationOutcomeAudit.ts");
const { classifyOutcomeAnomaly, DIMENSION_FIX_CUTOVERS, ECHO_SUPPRESSIBLE_DIMENSIONS } = await import(
  "../services/api/src/domain/anomalyClassifier.ts"
);
const { findingKeyOf } = await import("../services/api/src/domain/loopPrDedup.ts");
const { partitionByDispositions } = await import("../services/api/src/domain/dispositionLedger.ts");
const { isReproduceEligibleDimension } = await import("../services/api/src/domain/reproduceConfirm.ts");
type DispositionRecord = import("../services/api/src/domain/dispositionLedger.ts").DispositionRecord;

const NOW = new Date("2026-06-27T12:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
const report = (over: any = {}) => ({
  id: "a1",
  type: "cadence",
  severity: "warning",
  title: "Conversation issue",
  note: "no follow-up cadence was scheduled after he asked us to check back",
  status: "open",
  createdAt: ago(1),
  context: { convId: "+1555", leadKey: "+1555" },
  ...over
});
const map = (over: any = {}) => decideOpsAnomalyReportedIssue(report(over), { now: NOW });

// 1. MAPPING — an open, recent, agent-behavior report with a note + convId crosses, carrying the note.
{
  const a = map();
  assert(a, "agent-behavior report => anomaly");
  assert.equal(a!.dimension, "reported_issue", "dimension");
  assert.equal(a!.category, "feedback", "reported_issue maps to feedback category");
  assert.equal(a!.severity, "P2", "P2");
  assert.equal(a!.convId, "+1555", "convId carried (loop needs it)");
  assert.ok(/cadence/.test(a!.detail) && /follow-up cadence/.test(a!.detail), "detail carries type + note");
  assert.equal(a!.reportedAt, ago(1), "the report's createdAt is carried as reportedAt");
}

// 1b. reportedAt is an UPPER BOUND on the offending reply, never the event time.
//
// An operator files days after the reply they're unhappy about (Mark Kocsis, 7/10: reported at
// 02:38Z about a draft from 7/06). Stamping it as occurredAt would tell suppressStaleFindings the
// bad reply happened at report time — newer than it truly was — and a dimension cutover could then
// wrongly KEEP or DROP on a fiction. reported_issue is also a COARSE dimension (many distinct issue
// types), so it must stay out of DIMENSION_FIX_CUTOVERS or new reports get buried under an old fix.
{
  const a = map()!;
  assert.equal(a.occurredAt, undefined, "reported_issue never claims an occurredAt it cannot resolve");
  const { DIMENSION_FIX_CUTOVERS } = await import("../services/api/src/domain/anomalyClassifier.ts");
  assert.equal(
    DIMENSION_FIX_CUTOVERS["reported_issue"],
    undefined,
    "reported_issue stays out of the cutover ledger — a coarse dimension must not be auto-suppressed"
  );
  // With no occurredAt, the suppressor keeps it: a human-filed report is never silently dropped.
  const { suppressStaleFindings } = await import("../services/api/src/domain/anomalyClassifier.ts");
  const res = suppressStaleFindings([a], { guardingEvals: new Set(["tlp_autosend_coverage:eval"]) });
  assert.equal(res.kept.length, 1, "operator-filed report survives stale suppression");
  assert.equal(res.suppressed.length, 0, "…and is never auto-suppressed");
}

// reportedAt is omitted when the report has no usable createdAt (rather than invented).
assert.equal(map({ createdAt: "" })!.reportedAt, undefined, "no createdAt => no reportedAt (never invented)");

// AGENT-BEHAVIOR types all cross.
for (const type of ["routing", "cadence", "appointment", "task_inbox", "handoff", "other"]) {
  assert(map({ type }), `${type} (agent behavior) => anomaly`);
}
// SUPPORT-only types are dropped (tone covered by 👎 + voice layer; infra can't be parser-fixed).
for (const type of ["tone", "inventory", "integration", "ui"]) {
  assert.equal(map({ type }), null, `${type} (support-only) => null`);
}

// NOISE FLOOR — closed / info / no-note / no-convId / stale all drop.
assert.equal(map({ status: "closed" }), null, "closed => null");
assert.equal(map({ severity: "info" }), null, "info severity => null");
assert.equal(map({ note: "", title: "" }), null, "no note/title => null");
assert.equal(map({ context: { convId: "" } }), null, "no convId => null (agent reports are conv-scoped)");
assert.equal(map({ createdAt: ago(40) }), null, "stale (>21d) => null");
// title is a fallback when note is blank.
assert.ok(map({ note: "", title: "Conversation issue: agent mis-routed" }), "title is used when note is blank");

// 2. CLASSIFICATION — always Tier 2 escalate, notify, never auto-merge (even if graduated).
const cls = classifyOutcomeAnomaly(map()!, {});
assert.equal(cls.tier, 2, "reported_issue => Tier 2");
assert.equal(cls.action, "escalate", "escalate (approve-first)");
assert.equal(cls.notify, true, "notify");
assert.equal(cls.autoMergeEligible, false, "never auto-merge");
assert.equal(
  classifyOutcomeAnomaly(map()!, { graduatedCategories: new Set(["reported_issue"]) }).autoMergeEligible,
  false,
  "stays approve-first even if the dimension graduates (human judgment)"
);

// ---------------------------------------------------------------------------------------------
// 2b. THE DRAFT REVIEWER GETS ITS OWN DIMENSION (2026-08-18).
//
// The Claude draft reviewer files into the SAME opsAnomalyStore as the human "Report issue" button,
// with type `other`. While both mapped to `reported_issue` they shared ONE key per lead
// (`<convId>::reported_issue`) — so a single TIMELESS `no-action`/`joe-ruled` disposition on a
// human's note permanently muted the machine reviewer on that lead. Measured on the live feed:
// `+17167995566` (no-action 8/14) and `+17165241170` (joe-ruled 8/4) each swallowed a later reviewer
// finding, invisible forever, while the reviewer was filing 18 reports in a single day across 11
// leads. These assertions pin the split, and the mute test below is the regression itself.
// ---------------------------------------------------------------------------------------------
const REVIEWER_NOTE =
  "The pipeline's draft was clearly wrong: The draft ignores the customer's actual question about the mirrors.";
const reviewer = (over: any = {}) =>
  map({
    type: "other",
    title: "Claude draft review rewrote a pipeline draft",
    note: REVIEWER_NOTE,
    reporter: { name: "claude-draft-review" },
    ...over
  });

{
  const a = reviewer()!;
  assert(a, "a reviewer-filed row still crosses into the loop");
  assert.equal(a.dimension, "draft_review_rewrite", "reviewer rows get their OWN dimension");
  assert.equal(a.category, "feedback", "…in the feedback family, like the human lane");
  assert.equal(a.severity, "P2", "P2");
  assert.equal(a.convId, "+1555", "convId carried");
  assert.ok(a.detail.includes("draft-review rewrite"), "detail is prefixed so triage can tell at a glance");
  assert.ok(a.detail.includes("ignores the customer"), "…and still carries the reviewer's reasoning");
  assert.ok(!a.detail.includes("operator-reported"), "a machine row never claims to be operator-reported");

  // The split is driven by the REPORTER, not by the type — the reviewer and a human both file `other`.
  const humanOther = map({ type: "other", note: "Why did this create a new thread?" })!;
  assert.equal(humanOther.dimension, "reported_issue", "a human note of type other is UNCHANGED");
  assert.ok(humanOther.detail.includes("operator-reported"), "…and keeps the operator detail prefix");

  // Reporter matching is case/whitespace tolerant; any OTHER reporter stays in the human lane.
  assert.equal(reviewer({ reporter: { name: "  Claude-Draft-Review  " } })!.dimension, "draft_review_rewrite");
  assert.equal(reviewer({ reporter: { name: "some-other-bot" } })!.dimension, "reported_issue");
  assert.equal(reviewer({ reporter: null })!.dimension, "reported_issue", "no reporter => human lane");
  assert.equal(reviewer({ reporter: { name: "" } })!.dimension, "reported_issue", "blank reporter => human lane");
}

// The reviewer lane obeys the SAME noise floor — the split widens nothing.
assert.equal(reviewer({ status: "closed" }), null, "closed reviewer row => null");
assert.equal(reviewer({ severity: "info" }), null, "info reviewer row => null");
assert.equal(reviewer({ note: "", title: "" }), null, "no note/title => null");
assert.equal(reviewer({ context: { convId: "" } }), null, "no convId => null");
assert.equal(reviewer({ createdAt: ago(40) }), null, "stale reviewer row => null");

// CLASSIFICATION — a judge's opinion, not a verified miss: Tier 2, notify, never auto-merge, even
// if the dimension graduates. The grader-phantom class is large; a tick must confirm against the
// thread before treating a reviewer complaint as a real miss.
{
  const cls2 = classifyOutcomeAnomaly(reviewer()!, {});
  assert.equal(cls2.tier, 2, "draft_review_rewrite => Tier 2");
  assert.equal(cls2.action, "escalate", "escalate (approve-first)");
  assert.equal(cls2.notify, true, "notify");
  assert.equal(cls2.workOrder, true, "it is a work order");
  assert.equal(cls2.autoMergeEligible, false, "never auto-merge an unverified judge opinion");
  assert.equal(
    classifyOutcomeAnomaly(reviewer()!, { graduatedCategories: new Set(["draft_review_rewrite"]) })
      .autoMergeEligible,
    false,
    "stays approve-first even if the dimension graduates"
  );
}

// TIMESTAMP — still an UPPER BOUND. Measured 2026-08-18 over all 28 matchable live reviewer rows,
// the lag from the reviewed draft to the report has a median of 23 SECONDS and 25/28 are under 10
// minutes — but two backfill rows (from the run that extended the reviewer to the email lane) lag
// 22h and 52h. A backfilled row stamped `occurredAt` would read a PRE-fix draft as a post-fix
// regression, so the tight median does not license the stronger claim. An upper bound over-surfaces;
// it never hides.
{
  const a = reviewer()!;
  assert.equal(a.reportedAt, ago(1), "createdAt is carried as reportedAt");
  assert.equal(a.occurredAt, undefined, "never an occurredAt the row cannot resolve");
  assert.equal(reviewer({ createdAt: "" })!.reportedAt, undefined, "no createdAt => no reportedAt");
  assert.equal(
    DIMENSION_FIX_CUTOVERS["draft_review_rewrite"],
    undefined,
    "stays out of the cutover ledger — like reported_issue, it is a coarse dimension"
  );
  assert.ok(
    !ECHO_SUPPRESSIBLE_DIMENSIONS.has("draft_review_rewrite"),
    "out of echo scope: a commit naming the lead does not prove the reviewer's latest complaint is stale"
  );
  assert.ok(
    !isReproduceEligibleDimension("draft_review_rewrite"),
    "not reproduce-eligible yet — that set grows only when a dimension earns a matching judge criterion"
  );
}

// THE REGRESSION THIS FIXES — a timeless disposition on the HUMAN key must no longer mute the
// machine reviewer on the same lead, and vice versa.
{
  const human = map({ note: "I don't think this one should have been closed" })!;
  const bot = reviewer()!;
  const humanKey = findingKeyOf(human.convId, human.dimension);
  const botKey = findingKeyOf(bot.convId, bot.dimension);
  assert.notEqual(humanKey, botKey, "same lead, two lanes => two distinct finding keys");
  assert.equal(humanKey, "+1555::reported_issue", "the human key is unchanged");
  assert.equal(botKey, "+1555::draft_review_rewrite", "the reviewer gets its own key");

  const timeless = (key: string): DispositionRecord => ({
    key,
    disposition: "no-action",
    at: ago(2),
    by: "agent-loop",
    deployTs: null,
    note: null
  });

  // Joe rules on his own note. The reviewer's finding on that lead SURVIVES.
  const afterHuman = partitionByDispositions([human, bot], {
    ledger: new Map([[humanKey, timeless(humanKey)]])
  });
  assert.equal(afterHuman.suppressed.length, 1, "the human note is disposed");
  assert.equal(afterHuman.kept.length, 1, "…and exactly one finding survives");
  assert.equal(afterHuman.kept[0].dimension, "draft_review_rewrite", "the survivor is the reviewer's");

  // And the mirror: disposing a reviewer finding must not mute the operator's own button.
  const afterBot = partitionByDispositions([human, bot], {
    ledger: new Map([[botKey, timeless(botKey)]])
  });
  assert.equal(afterBot.kept.length, 1, "one finding survives");
  assert.equal(afterBot.kept[0].dimension, "reported_issue", "the operator's lane is never muted by the machine");
}

// 3. WIRING — the sweep emits the sibling feed and anomaly_loop_detect merges it.
const sweep = fs.readFileSync("scripts/ops_anomaly_loop_sweep.ts", "utf8");
assert.match(sweep, /decideOpsAnomalyReportedIssue/, "sweep uses the mapper");
assert.match(sweep, /ops_anomaly", "latest\.json"|ops_anomaly\/latest\.json/, "sweep writes the sibling feed");
const det = fs.readFileSync("scripts/anomaly_loop_detect.ts", "utf8");
assert.match(det, /"ops_anomaly", "latest\.json"/, "anomaly_loop_detect merges the ops-anomaly feed");

console.log("PASS reported_issue eval");
