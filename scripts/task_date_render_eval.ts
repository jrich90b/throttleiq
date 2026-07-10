/**
 * Task-date render sanity eval (pure, no LLM).
 *
 * Pins the "9130 days ago" Task Inbox bug (Henry Cole, +17168618786, operator-reported
 * 2026-07-01): todoRequestedCallTimeLabel falls back to the summary's YEAR-LESS text
 * ("Thu, Jul 2, 9:00 AM") when a task has no dueAt, and V8 parses a year-less date string
 * to the year 2001 — so a fresh call reminder rendered as "9130 days ago" (2026 − 2001)
 * and the absolute label reformatted to 7/2/2001.
 *
 * Layers:
 *   1. parseSaneTaskDateMs — accepts real task dates (past-but-recent and near-future),
 *      rejects the year-less 2001 parse, garbage, and far-future noise.
 *   2. Source guard — TaskInboxSection must route BOTH render sites (daysAgoLabel and
 *      requestedCallPretty) through the sane-parse, never bare new Date() on a label.
 *
 * Run: npx tsx scripts/task_date_render_eval.ts
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";

const { parseSaneTaskDateMs } = await import("../apps/web/src/app/lib/taskTriage.ts");

const NOW = Date.parse("2026-07-01T15:00:00.000Z");

// The exact reported artifact: a year-less summary label parses to 2001 in V8 → must be rejected.
const yearless = parseSaneTaskDateMs("Thu, Jul 2, 9:00 AM", NOW);
assert.equal(yearless, null, `year-less label must be rejected as a date, got ${yearless ? new Date(yearless).toISOString() : yearless}`);

// Real task dates pass.
assert.ok(parseSaneTaskDateMs("2026-07-02T13:00:00.000Z", NOW) != null, "a real ISO dueAt must parse");
assert.ok(parseSaneTaskDateMs("2026-03-25T14:00:00.000Z", NOW) != null, "a months-old appointment must still parse (overdue history)");
assert.ok(parseSaneTaskDateMs("2027-01-10T14:00:00.000Z", NOW) != null, "a scheduled future date must parse");

// Garbage and out-of-window noise fail closed.
assert.equal(parseSaneTaskDateMs("", NOW), null, "empty string is not a date");
assert.equal(parseSaneTaskDateMs("call me whenever", NOW), null, "prose is not a date");
assert.equal(parseSaneTaskDateMs("1970-01-01T00:00:00.000Z", NOW), null, "epoch zero is not a plausible task date");
assert.equal(parseSaneTaskDateMs("2001-07-02T13:00:00.000Z", NOW), null, "the V8 year-less default year (2001) is rejected even as ISO");
assert.equal(parseSaneTaskDateMs("2099-01-01T00:00:00.000Z", NOW), null, "far-future noise is rejected");

// --- 2) Source guard: both render sites go through the sane parse. ---
const inbox = fs.readFileSync("apps/web/src/app/components/TaskInboxSection.tsx", "utf8");
const daysAgoBody = inbox.slice(inbox.indexOf("function daysAgoLabel"), inbox.indexOf("function daysAgoLabel") + 600);
assert.ok(/parseSaneTaskDateMs/.test(daysAgoBody), "daysAgoLabel must parse via parseSaneTaskDateMs");
assert.ok(
  /requestedCallPretty =\s*\n?\s*requestedCallTime && parseSaneTaskDateMs\(/.test(inbox),
  "requestedCallPretty must gate reformatting on parseSaneTaskDateMs"
);

// --- 3) Source guard: the API-side due label (deriveTodoActionLabel's "(requested: ...)")
// carries the SAME sane-year window, so a 2001 garbage parse can't render a 25-year-old due
// label either (Joe ruling 2026-07-09; the "9130 days ago" class, +17168618786). ---
const apiIndex = fs.readFileSync("services/api/src/index.ts", "utf8");
const dueLabelStart = apiIndex.indexOf("function formatTodoCallDueAtLabel");
const dueLabelBody = apiIndex.slice(dueLabelStart, dueLabelStart + 900);
assert.ok(
  /year < 2015 \|\| year > nowYear \+ 5/.test(dueLabelBody),
  "formatTodoCallDueAtLabel applies the sane-year window before rendering a due label"
);

console.log("PASS task-date render eval — year-less/garbage labels rejected, real dates pass, both inbox render sites + the API due label guarded");
