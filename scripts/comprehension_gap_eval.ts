/**
 * Comprehension gap log eval (2026-07-31).
 *
 * WHY IT EXISTS. parserCapture records every typed-parser call — 148k of them — so a parser that
 * answers badly leaves evidence. A DETERMINISTIC path that quietly falls back leaves none: "call me
 * next spring" never reached a parser, so across all 148k records there was no trace, and the wrong
 * due date hid for months until someone read task metadata by hand. This log is the other half:
 * when the agent knows it could not read something, the phrase is written down so "does this
 * deserve a parser?" is answered by volume instead of by whoever happened to notice.
 *
 * Pins, in fail-direction order:
 *   1. logging is INERT — off unless configured, kill switch wins, empty phrase is never a record;
 *   2. the record keeps what a future eval row needs (exact wording) and caps what it doesn't;
 *   3. grouping ranks by real frequency and does not merge across sites;
 *   4. the wiring records the live give-up and can NEVER change the task that was created.
 *
 * Run: npx tsx scripts/comprehension_gap_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildComprehensionGapRecord,
  groupComprehensionGaps,
  resolveComprehensionGapDir,
  appendComprehensionGapRecord,
  COMPREHENSION_GAP_PHRASE_CAP
} from "../services/api/src/domain/comprehensionGapLog.ts";
import { readGapRecords, renderGapMarkdown } from "./comprehension_gap_report.ts";

let n = 0;

// --- 1. INERT BY DEFAULT -------------------------------------------------------------------------
{
  assert.equal(resolveComprehensionGapDir({}), null, "no configured root → logging is OFF (dev machines stay clean)");
  assert.equal(
    resolveComprehensionGapDir({ COMPREHENSION_GAP_LOG_DISABLED: "1", REPORT_ROOT: "/r" }),
    null,
    "the kill switch wins over a configured root"
  );
  assert.equal(
    resolveComprehensionGapDir({ COMPREHENSION_GAP_LOG_DISABLED: "1", COMPREHENSION_GAP_DIR: "/explicit" }),
    null,
    "the kill switch wins over an explicit dir too"
  );
  assert.equal(resolveComprehensionGapDir({ REPORT_ROOT: "/r" }), "/r/comprehension_gaps", "defaults under REPORT_ROOT");
  assert.equal(
    resolveComprehensionGapDir({ COMPREHENSION_GAP_DIR: "/explicit", REPORT_ROOT: "/r" }),
    "/explicit",
    "an explicit dir beats REPORT_ROOT"
  );
  n += 5;
}

// --- 2. THE RECORD -------------------------------------------------------------------------------
{
  const rec = buildComprehensionGapRecord({
    at: "2026-07-31T12:00:00.000Z",
    site: "callback_timeframe",
    phrase: "  next   spring  ",
    outcome: "left_undated",
    convId: "+15550001111"
  });
  assert.equal(rec.phrase, "next spring", "whitespace is collapsed so the same ask groups together");
  assert.equal(rec.site, "callback_timeframe", "the site is kept");
  assert.equal(rec.outcome, "left_undated", "the HONEST consequence is recorded, not just the miss");
  assert.equal(rec.convId, "+15550001111", "the lead is recorded so the turn can be found again");
  assert.equal(rec.phraseTruncated, false, "a short phrase is not truncated");
  n += 5;

  const long = buildComprehensionGapRecord({
    at: "2026-07-31T12:00:00.000Z",
    site: "s",
    phrase: "x".repeat(COMPREHENSION_GAP_PHRASE_CAP + 50),
    outcome: "o"
  });
  assert.equal(long.phrase.length, COMPREHENSION_GAP_PHRASE_CAP, "an over-long phrase is capped");
  assert.equal(long.phraseTruncated, true, "and the truncation is recorded, so nobody trains on half a phrase");
  n += 2;

  // Unknowns degrade to a label rather than an empty column.
  const bare = buildComprehensionGapRecord({ at: "", site: "", phrase: "hi", outcome: "" });
  assert.equal(bare.site, "unknown", "a missing site is labelled");
  assert.equal(bare.outcome, "unknown", "a missing outcome is labelled");
  assert.ok(!("convId" in bare), "no convId key when there is no convId (keeps records small)");
  n += 3;
}

// --- 3. AN EMPTY PHRASE IS NEVER A RECORD --------------------------------------------------------
// It would inflate the counts that decide whether a parser is worth building.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gaplog-eval-"));
  const prev = process.env.COMPREHENSION_GAP_DIR;
  process.env.COMPREHENSION_GAP_DIR = dir;
  try {
    appendComprehensionGapRecord(
      buildComprehensionGapRecord({ at: "2026-07-31T12:00:00.000Z", site: "s", phrase: "   ", outcome: "o" })
    );
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 0, "a blank phrase writes nothing at all");
    n += 1;

    appendComprehensionGapRecord(
      buildComprehensionGapRecord({ at: "2026-07-31T12:00:00.000Z", site: "s", phrase: "next spring", outcome: "o" })
    );
    const written = fs.readdirSync(dir);
    assert.deepEqual(written, ["comprehension_gaps_20260731.jsonl"], "a real phrase lands in a daily file");
    n += 1;

    // Round-trip through the reader the report uses.
    const back = readGapRecords(dir, "2026-01-01T00:00:00.000Z");
    assert.equal(back.length, 1, "the report reads what the logger wrote");
    assert.equal(back[0].phrase, "next spring", "and the phrase survives the round trip");
    n += 2;

    // A torn final line (an append that died mid-write) must cost ONE record, not the report.
    fs.appendFileSync(path.join(dir, "comprehension_gaps_20260731.jsonl"), '{"at":"2026-07-31T12:00:00.000Z","sit');
    assert.equal(readGapRecords(dir, "2026-01-01T00:00:00.000Z").length, 1, "a torn line is skipped, not fatal");
    n += 1;

    assert.equal(readGapRecords(path.join(dir, "nope"), "2026-01-01T00:00:00.000Z").length, 0,
      "a missing directory reads as no evidence, never a crash");
    n += 1;
  } finally {
    if (prev === undefined) delete process.env.COMPREHENSION_GAP_DIR;
    else process.env.COMPREHENSION_GAP_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- 4. GROUPING RANKS BY REAL FREQUENCY ---------------------------------------------------------
{
  const R = (phrase: string, convId: string, at: string, site = "callback_timeframe") =>
    buildComprehensionGapRecord({ at, site, phrase, outcome: "left_undated", convId });
  const groups = groupComprehensionGaps([
    R("next spring", "+1", "2026-07-01T00:00:00.000Z"),
    R("Next Spring", "+2", "2026-07-05T00:00:00.000Z"),
    R("next  spring", "+1", "2026-07-09T00:00:00.000Z"),
    R("after the holidays", "+3", "2026-07-02T00:00:00.000Z")
  ]);
  assert.equal(groups.length, 2, "case and spacing variants are ONE phrasing");
  assert.equal(groups[0].phrase, "next spring", "most frequent first — volume decides, not who noticed");
  assert.equal(groups[0].count, 3, "every occurrence counts");
  assert.deepEqual(groups[0].convIds, ["+1", "+2"], "distinct leads, deduped — 3 asks from 1 lead is not 3 leads");
  assert.equal(groups[0].firstSeenAt, "2026-07-01T00:00:00.000Z", "first seen");
  assert.equal(groups[0].lastSeenAt, "2026-07-09T00:00:00.000Z", "last seen — a phrase that stopped occurring is not urgent");
  n += 6;

  // The same words at a DIFFERENT site are a different gap and must not be merged.
  const twoSites = groupComprehensionGaps([
    R("next spring", "+1", "2026-07-01T00:00:00.000Z", "callback_timeframe"),
    R("next spring", "+2", "2026-07-01T00:00:00.000Z", "some_other_site")
  ]);
  assert.equal(twoSites.length, 2, "site is part of the identity of a gap");
  n += 1;

  assert.deepEqual(groupComprehensionGaps([]), [], "empty input");
  assert.deepEqual(groupComprehensionGaps(null), [], "null input");
  n += 2;

  // The empty report must not read as "the agent understands everything".
  const empty = renderGapMarkdown([], { days: 30, total: 0 });
  assert.match(empty, /nothing is wired/i, "an empty report says it may mean nothing is WIRED, not that all is well");
  n += 1;
}

// --- 5. THE WIRING -------------------------------------------------------------------------------
{
  const api = fs.readFileSync("services/api/src/index.ts", "utf8");
  assert.match(api, /recordComprehensionGap\(\{\s*\n\s*site: "callback_timeframe"/,
    "the live give-up (an unreadable callback timeframe) is recorded");
  assert.match(api, /outcome: "left_undated"/, "and records what happened instead");
  n += 2;

  // It must sit on the ELSE branch — the one where we declined to invent a date. Logging on the
  // fallback branch would record every ordinary "call me back" as a comprehension gap.
  // Slice forward from the start marker — a file-wide indexOf for the end bound can land BEFORE it.
  const start = api.indexOf("const statedTimeframe = mentionsUnresolvedTimeframe(");
  assert.ok(start > 0, "the timeframe guard must exist to anchor this check");
  const block = api.slice(start, api.indexOf("const dueLabel", start));
  assert.ok(
    block.indexOf("buildDefaultCallbackFallbackSchedule") < block.indexOf("recordComprehensionGap"),
    "the gap is recorded on the declined branch, not the ordinary-default branch"
  );
  n += 2;

  // Pure logging: the gap log may never assign a schedule or due date.
  const logged = block.slice(block.indexOf("recordComprehensionGap"));
  assert.ok(!/schedule\s*=/.test(logged), "recording a gap never changes the task that was created");
  n += 1;

  // The module must stay behaviour-free: no caller may depend on its return value.
  const mod = fs.readFileSync("services/api/src/domain/comprehensionGapLog.ts", "utf8");
  assert.match(mod, /export function recordComprehensionGap[^)]*\)\s*:\s*void/, "the writer returns void by design");
  assert.ok(/catch\s*\{/.test(mod), "every write path swallows its errors");
  n += 2;
}

console.log(`PASS comprehension gap log eval (${n} assertions)`);
