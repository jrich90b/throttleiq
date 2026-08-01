/**
 * rollout_readiness:eval — pins the dealer-#2 readiness scorecard (scripts/rollout_readiness_report.ts).
 *
 * The scorecard is the BAR itself (Joe, 2026-07-29: dealer #2 triggers on a readiness bar), so the
 * expensive failure is a scorecard that reads MET when it isn't — that would greenlight a rollout on
 * a broken agent. Every section is therefore pinned fail-CLOSED: a missing input, an unparsed
 * checklist, or a zero-length eval split reads NOT_MET, never MET.
 *
 * The load-bearing rule from Joe's 2026-07-30 five-section confirmation is "the score must not
 * flatter": all five sections are ALWAYS present, and a NOT_MEASURED section blocks the bar exactly
 * like an OPEN one. Those two properties are what most of this file exists to hold down.
 *
 * Deterministic; no LLM, no network, no report files.
 *
 * Run: npx tsx scripts/rollout_readiness_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  FUNNEL_SNAPSHOT_DIRS,
  READINESS_TARGETS,
  countAhHardcodes,
  evaluateReadiness,
  formatReadinessLine,
  parseChecklistRows,
  pickWidestFunnelWindow,
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

const T = READINESS_TARGETS;

/** Every section green — the only input shape that may ever read MET. */
const ALL_GREEN: ReadinessInput = {
  bookingFunnel: { engaged: 120, offeredRatePct: 62, bookRatePct: 30, offerToBookPct: 48, showed: 12, sinceDays: 30 },
  latency: { effectiveMedianMin: 6, under5minPct: 55 },
  portability: { universal: 326, dealer: 0, violations: [] },
  ahHardcodes: 40,
  checklistRows: [
    { capability: "ADF lead ingestion", status: "WORKING", evidence: "2026-06-11" },
    { capability: "AI SMS drafts", status: "WORKING", evidence: "2026-06-11" }
  ],
  releaseGate: { verdict: "READY", cleanStreakDays: 7, streakTarget: 7 },
  agentManagerTasks: [{ priority: "P2", title: "Review something minor" }],
  strangerTest: { passed: true, at: "2026-07-30", detail: "provisioned from config, gates green cold" },
  pitchNumbers: { medianResponseMin: 6, bookingLiftPct: 40, bdcHoursReplacedPerWeek: 25 }
};

const SECTION_IDS = ["funnel", "portability", "operability", "stranger_test", "pitch_numbers"] as const;

// --- The five sections are ALWAYS present, in every input state (Joe: never omitted). ---
check("all five sections are always reported, even on empty input", () => {
  const empty: ReadinessInput = {
    bookingFunnel: null,
    latency: null,
    portability: null,
    ahHardcodes: null,
    checklistRows: [],
    releaseGate: null,
    agentManagerTasks: null,
    strangerTest: null,
    pitchNumbers: null
  };
  for (const input of [ALL_GREEN, empty]) {
    const s = evaluateReadiness(input);
    assert.equal(s.sectionsTotal, 5);
    assert.deepEqual(s.sections.map(x => x.id), [...SECTION_IDS], "section order and membership are fixed");
    for (const sec of s.sections) assert.ok(sec.metrics.length > 0, `${sec.id} carries its evidence`);
  }
});

// --- The happy path is reachable. ---
check("all sections green => MET", () => {
  const s = evaluateReadiness(ALL_GREEN);
  assert.equal(s.verdict, "MET");
  assert.equal(s.sectionsMet, 5);
  assert.equal(s.score, 100);
  assert.deepEqual(s.blockers, []);
  assert.deepEqual(s.notMeasured, []);
  assert.match(formatReadinessLine(s), /MET — 5\/5 sections/);
});

// --- THE anti-flattery rule: unmeasured is not a pass. ---
check("a NOT_MEASURED section blocks the bar just like an OPEN one", () => {
  for (const missing of ["strangerTest", "pitchNumbers", "bookingFunnel"] as const) {
    const s = evaluateReadiness({ ...ALL_GREEN, [missing]: null });
    assert.equal(s.verdict, "NOT_MET", `${missing} unmeasured must block the bar`);
    assert.equal(s.sectionsMet, 4);
    assert.equal(s.notMeasured.length, 1, `${missing} is reported as unmeasured`);
    assert.ok(s.blockers.length > 0, `${missing} explains itself`);
  }
});

check("an unmeasured section is NOT_MEASURED, never OPEN or MET", () => {
  const s = evaluateReadiness({ ...ALL_GREEN, strangerTest: null, pitchNumbers: null });
  assert.equal(s.sections.find(x => x.id === "stranger_test")?.status, "NOT_MEASURED");
  assert.equal(s.sections.find(x => x.id === "pitch_numbers")?.status, "NOT_MEASURED");
  assert.deepEqual(s.notMeasured, ["stranger_test", "pitch_numbers"]);
  assert.match(formatReadinessLine(s), /unmeasured/, "the digest line names the unmeasured sections");
});

check("the day-one state (only operability + portability wired) is NOT_MET, not a 2/2 pass", () => {
  const s = evaluateReadiness({
    ...ALL_GREEN,
    bookingFunnel: null,
    latency: null,
    strangerTest: null,
    pitchNumbers: null
  });
  assert.equal(s.verdict, "NOT_MET");
  assert.equal(s.sectionsTotal, 5, "the three unwired sections still count against the score");
  assert.equal(s.score, 40, "2/5, not 100% of what happens to be measured");
});

// --- Section 1: funnel. ---
check("a below-target funnel rate blocks the bar", () => {
  const s = evaluateReadiness({ ...ALL_GREEN, bookingFunnel: { ...ALL_GREEN.bookingFunnel!, bookRatePct: 16 } });
  assert.equal(s.verdict, "NOT_MET");
  assert.equal(s.sections.find(x => x.id === "funnel")?.status, "OPEN");
  assert.ok(s.blockers.some(b => /Booked/.test(b) && /16%/.test(b)), "the blocker names the metric and the value");
});

check("slow first-touch latency blocks the funnel section", () => {
  const s = evaluateReadiness({ ...ALL_GREEN, latency: { effectiveMedianMin: 90, under5minPct: 13 } });
  assert.equal(s.sections.find(x => x.id === "funnel")?.status, "OPEN");
  assert.ok(s.blockers.some(b => /First-touch/.test(b)));
});

check("a too-small funnel sample reads NOT_MEASURED, never a pass", () => {
  // The live box writes a 1-day window (n=9 engaged) — that must never grade the bar.
  const s = evaluateReadiness({
    ...ALL_GREEN,
    bookingFunnel: { engaged: 9, offeredRatePct: 100, bookRatePct: 100, offerToBookPct: 100, showed: 5, sinceDays: 1 }
  });
  assert.equal(s.sections.find(x => x.id === "funnel")?.status, "NOT_MEASURED", "a 9-lead window is noise, not a 100% funnel");
  assert.equal(s.verdict, "NOT_MET");
  assert.ok(s.blockers.some(b => /sample too small/.test(b)));
});

check("a missing latency reading cannot pass the funnel section", () => {
  const s = evaluateReadiness({ ...ALL_GREEN, latency: null });
  assert.equal(s.sections.find(x => x.id === "funnel")?.status, "OPEN", "absent latency is not a silent pass");
});

// --- Section 2: portability. ---
check("a dealer-portability eval violation blocks the bar", () => {
  const s = evaluateReadiness({
    ...ALL_GREEN,
    portability: { universal: 326, dealer: 0, violations: ["scripts/foo_eval.ts:12 asserts north tonawanda"] }
  });
  assert.equal(s.verdict, "NOT_MET");
  assert.equal(s.sections.find(x => x.id === "portability")?.status, "OPEN");
});

check("a zero-length universal eval split never passes portability", () => {
  const s = evaluateReadiness({ ...ALL_GREEN, portability: { universal: 0, dealer: 0, violations: [] } });
  assert.equal(s.sections.find(x => x.id === "portability")?.status, "OPEN", "an unwired split is not a pass");
});

check("the AH-hardcode count is a ratchet — over budget blocks the bar", () => {
  const over = evaluateReadiness({ ...ALL_GREEN, ahHardcodes: T.portability.ahHardcodeBudget + 1 });
  assert.equal(over.sections.find(x => x.id === "portability")?.status, "OPEN", "adding AH literals must cost");
  const at = evaluateReadiness({ ...ALL_GREEN, ahHardcodes: T.portability.ahHardcodeBudget });
  assert.equal(at.sections.find(x => x.id === "portability")?.status, "MET", "the budget itself is passing");
  const missing = evaluateReadiness({ ...ALL_GREEN, ahHardcodes: null });
  assert.equal(missing.sections.find(x => x.id === "portability")?.status, "OPEN", "an uncounted debt is not zero debt");
});

check("countAhHardcodes actually counts the live tree and stays within budget", () => {
  const n = countAhHardcodes("services/api/src");
  assert.ok(typeof n === "number" && n > 0, "the scan finds the real AH literals");
  assert.ok(
    n! <= T.portability.ahHardcodeBudget,
    `AH literals in services/api/src rose to ${n}, over the ${T.portability.ahHardcodeBudget} ratchet — remove the hardcode or justify a new budget`
  );
  assert.equal(countAhHardcodes("services/api/does-not-exist"), null, "a missing tree reads null, not 0");
});

check("the AH scan sees the no-space host/domain form, not just 'american harley'", () => {
  // Guards the 2026-08-01 fix: the pattern used to require a space, so `americanharley` and
  // `americanharley-davidson.com` were invisible and 21 real literals went uncounted. Narrowing
  // it back would silently flatter the portability score.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-hardcode-scan-"));
  try {
    fs.writeFileSync(path.join(dir, "a.ts"), 'const host = "americanharley-davidson.com";\n');
    assert.equal(countAhHardcodes(dir), 1, "the no-space domain form must count as a literal");
    fs.writeFileSync(path.join(dir, "a.ts"), '// americanharley-davidson.com is our host\n');
    assert.equal(countAhHardcodes(dir), 0, "comment-only prose still must not inflate the debt");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Section 3: operability. ---
check("a non-WORKING checklist row blocks the bar", () => {
  const s = evaluateReadiness({
    ...ALL_GREEN,
    checklistRows: [...ALL_GREEN.checklistRows, { capability: "DocuSign", status: "UNVERIFIED", evidence: "" }]
  });
  assert.equal(s.verdict, "NOT_MET");
  assert.equal(s.sections.find(x => x.id === "operability")?.status, "OPEN");
  assert.ok(s.blockers.some(b => /DocuSign: UNVERIFIED/.test(b)), "blocker names the row");
  assert.equal(s.checklistWorkingPct, 67);
});

check("a short release-gate streak blocks the bar", () => {
  const s = evaluateReadiness({ ...ALL_GREEN, releaseGate: { verdict: "NOT_READY", cleanStreakDays: 3, streakTarget: 7 } });
  assert.equal(s.verdict, "NOT_MET");
  assert.equal(s.sections.find(x => x.id === "operability")?.status, "OPEN");
  assert.ok(s.blockers.some(b => /clean streak/i.test(b) && /3/.test(b)));
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
  assert.equal(s.sections.find(x => x.id === "operability")?.status, "MET");
  assert.equal(s.verdict, "MET");
});

check("an empty checklist never counts as all-WORKING", () => {
  const s = evaluateReadiness({ ...ALL_GREEN, checklistRows: [] });
  assert.equal(s.sections.find(x => x.id === "operability")?.status, "OPEN", "0/0 rows is not a pass");
});

// --- Section 4: stranger test. ---
check("a FAILED stranger test is OPEN, and only a pass clears it", () => {
  const failed = evaluateReadiness({ ...ALL_GREEN, strangerTest: { passed: false, at: "2026-07-30" } });
  assert.equal(failed.sections.find(x => x.id === "stranger_test")?.status, "OPEN");
  assert.equal(failed.verdict, "NOT_MET");
  const passed = evaluateReadiness(ALL_GREEN);
  assert.equal(passed.sections.find(x => x.id === "stranger_test")?.status, "MET");
});

// --- Section 5: pitch numbers. ---
check("a zero booking lift does not count as a measured win", () => {
  const s = evaluateReadiness({ ...ALL_GREEN, pitchNumbers: { ...ALL_GREEN.pitchNumbers!, bookingLiftPct: 0 } });
  assert.equal(s.sections.find(x => x.id === "pitch_numbers")?.status, "OPEN");
});

// --- FAIL-CLOSED: a missing or empty input must never read MET. ---
check("missing inputs fail closed (never MET)", () => {
  const s = evaluateReadiness({
    bookingFunnel: null,
    latency: null,
    portability: null,
    ahHardcodes: null,
    checklistRows: [],
    releaseGate: null,
    agentManagerTasks: null,
    strangerTest: null,
    pitchNumbers: null
  });
  assert.equal(s.verdict, "NOT_MET");
  assert.equal(s.sectionsMet, 0, "no section passes on missing evidence");
  assert.equal(s.score, 0);
  assert.equal(s.checklistWorkingPct, null);
  for (const sec of s.sections) assert.ok(sec.blockers.length > 0, `${sec.id} explains why it is open`);
});

// --- Targets stay visible and sane (they are Joe's veto surface). ---
check("the proposed targets never regress below the measured baseline", () => {
  // Baseline (americanharley, 30d, 6/16): offered 58 / booked 16 / offer->book 27.
  assert.ok(T.funnel.offeredRatePct >= 58, "offered-rate target must not fall below the baseline");
  assert.ok(T.funnel.bookRatePct > 16, "book-rate target must beat the baseline");
  assert.ok(T.funnel.offerToBookPct > 27, "offer->book target must beat the baseline");
  assert.ok(T.funnel.minEngagedSample >= 30, "a funnel verdict needs a real sample");
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
//     section is exactly the failure this scorecard exists to prevent). ---
check("the live dealer_ready_checklist.md still parses", () => {
  const md = fs.readFileSync("docs/dealer_ready_checklist.md", "utf8");
  const rows = parseChecklistRows(md);
  assert.ok(rows.length >= 10, `expected the capability matrix to parse, got ${rows.length} rows`);
  assert.ok(rows.every(r => /^[A-Z_]+$/.test(r.status)), "every parsed row carries a bare status word");
  assert.ok(rows.some(r => /ADF lead ingestion/i.test(r.capability)), "the ADF ingestion row is present");
});

// --- The digest line must survive a stale four-gate scorecard on the box. ---
check("formatReadinessLine tolerates a legacy four-gate scorecard", () => {
  const legacy = {
    verdict: "NOT_MET" as const,
    gatesMet: 1,
    gatesTotal: 4,
    score: 25,
    gates: [
      { id: "checklist", met: false },
      { id: "eval_portability", met: true }
    ]
  };
  const line = formatReadinessLine(legacy);
  assert.match(line, /NOT_MET — 1\/4/);
  assert.match(line, /checklist/);
});

// --- The five-section definition is recorded in the charter, not just in code. ---
check("the charter's North star carries the five-test definition", () => {
  const charter = fs.readFileSync("docs/policy_charter.md", "utf8");
  const northStar = charter.slice(charter.indexOf("## North star"), charter.indexOf("## What this document is"));
  for (const test of ["funnel", "portability", "operability", "stranger test", "pitch numbers"]) {
    assert.ok(new RegExp(test, "i").test(northStar), `the North-star section names the ${test} test`);
  }
  assert.ok(/not yet measured|must not flatter/i.test(northStar), "the anti-flattery rule is recorded");
});

// --- Source guard: the report must not be able to send or mutate customer state. ---
check("the scorecard is read-only (no sends, no store writes)", () => {
  const src = fs.readFileSync("scripts/rollout_readiness_report.ts", "utf8");
  for (const banned of ["sendEmail", "sendSms", "twilio", "conversations.json"]) {
    assert.ok(!src.includes(banned), `rollout_readiness_report must not reference ${banned}`);
  }
});

// --- The funnel is graded on the WIDEST window on disk, never on whichever writer ran last.
//     The hourly loop writes a 1-day snapshot over the same filename; before this, that
//     1-day window (6 engaged) held the funnel section at NOT_MEASURED permanently. ---
check("the funnel grades the widest window available", () => {
  const oneDay = { sinceDays: 1, summary: { engaged: 6, offeredRatePct: 50, bookRatePct: 33.3 } };
  const thirtyDay = { sinceDays: 30, summary: { engaged: 231, offeredRatePct: 57.6, bookRatePct: 19 } };
  // Order must not matter — the widest wins either way.
  assert.equal(pickWidestFunnelWindow([oneDay, thirtyDay])?.sinceDays, 30, "30d beats 1d");
  assert.equal(pickWidestFunnelWindow([thirtyDay, oneDay])?.sinceDays, 30, "order-independent");
  assert.equal(pickWidestFunnelWindow([oneDay])?.sinceDays, 1, "a lone narrow window is still read");
  assert.equal(pickWidestFunnelWindow([]), null, "no snapshots => null, not a fabricated window");
  assert.equal(pickWidestFunnelWindow([null, undefined as any]), null, "unreadable snapshots => null");
  // A snapshot without a parsed summary is not a measurement, however wide it claims to be.
  assert.equal(pickWidestFunnelWindow([{ sinceDays: 90 } as any, thirtyDay])?.sinceDays, 30, "no summary => not usable");
  assert.ok(FUNNEL_SNAPSHOT_DIRS.includes("booking_funnel_30d"), "the 30-day snapshot dir is searched");
  assert.ok(FUNNEL_SNAPSHOT_DIRS.includes("booking_funnel"), "the legacy hourly snapshot stays a fallback");
});

check("a wide window with a real sample actually grades the funnel", () => {
  // The live 30-day reading (2026-07-30): the sample clears the floor, so the section must
  // produce a verdict instead of hiding behind NOT_MEASURED.
  const s = evaluateReadiness({
    ...(ALL_GREEN as ReadinessInput),
    bookingFunnel: { engaged: 231, offeredRatePct: 57.6, bookRatePct: 19, offerToBookPct: 33.1, showed: 8, sinceDays: 30 }
  });
  const funnel = s.sections.find(x => x.id === "funnel");
  assert.notEqual(funnel?.status, "NOT_MEASURED", "231 engaged over 30d is a measurement");
  assert.equal(funnel?.status, "OPEN", "19% booked is below the 25% target — OPEN, not MET");
});

// --- Joe's pre-LeadRider baseline is the anchor for every pitch claim; losing it would make
//     section 5 unmeasurable no matter how much data we collect. ---
check("the pre-LeadRider close-rate baseline is recorded", () => {
  assert.equal(READINESS_TARGETS.pitch.preLeadRiderCloseRatePct, 6, "Joe, 2026-07-30: ~6% last year");
  const src = fs.readFileSync("scripts/rollout_readiness_report.ts", "utf8");
  assert.match(src, /CLOSE rate, not the booking rate/, "the close-vs-booking distinction stays documented");
});

// --- The 30-day snapshot must actually get generated, or the widest window stays 1 day. ---
check("a 30-day funnel snapshot is wired to be produced", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const cmd = String(pkg?.scripts?.["booking_funnel:audit30"] ?? "");
  assert.match(cmd, /--since-days 30/, "audit30 runs a 30-day window");
  assert.match(cmd, /booking_funnel_30d/, "audit30 writes the snapshot dir the scorecard reads");
});

if (failures) {
  console.error(`\n${failures} rollout-readiness check(s) failed`);
  process.exit(1);
}
console.log("\nPASS rollout readiness scorecard");
