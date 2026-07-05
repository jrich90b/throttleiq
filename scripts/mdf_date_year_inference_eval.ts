/**
 * MDF date-year inference eval (pure, no LLM).
 *
 * Invoices/dates that show no year (e.g. "12/20", "June 1") came out of extraction without a year.
 * inferDateYear fills the MISSING year deterministically: the year that makes the date the most recent
 * one NOT in the future. So a Dec invoice processed in January resolves to LAST year (Joe's concern),
 * while a current-month date stays this year — and a Jan date in January is NOT wrongly pushed back.
 * Dates that already carry a year are normalized to MM/DD/YYYY; unparseable strings (incl. ISO) pass
 * through unchanged. This is structured-field cleanup, not customer comprehension.
 *
 * Run: npx tsx scripts/mdf_date_year_inference_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { inferDateYear } from "../services/api/src/domain/mdfAssistant.ts";

const mid = new Date("2026-06-15T12:00:00.000Z"); // a normal mid-year processing date

// No-year dates -> most-recent-past year.
assert.equal(inferDateYear("06/10", mid), "06/10/2026", "past mid-year date -> current year");
assert.equal(inferDateYear("12/20", mid), "12/20/2025", "a Dec date seen in June would be future this year -> prior year");
assert.equal(inferDateYear("June 1", mid), "06/01/2026", "month-name past date -> current year");
assert.equal(inferDateYear("Dec 5th", mid), "12/05/2025", "month-name + ordinal future-this-year -> prior year");
assert.equal(inferDateYear("15 March", mid), "03/15/2026", "day-first month name -> current year");

// Dates that already carry a year -> normalized, year preserved.
assert.equal(inferDateYear("6/15/24", mid), "06/15/2024", "2-digit year expands to 20YY");
assert.equal(inferDateYear("6-15-2026", mid), "06/15/2026", "4-digit year preserved + normalized");

// Pass-through cases (never fabricate).
assert.equal(inferDateYear("2026-06-15", mid), "2026-06-15", "ISO already has a year -> unchanged");
assert.equal(inferDateYear("", mid), "", "empty -> empty");
assert.equal(inferDateYear("see invoice", mid), "see invoice", "unparseable -> unchanged");
assert.equal(inferDateYear("13/40", mid), "13/40", "invalid month/day -> unchanged (no guessing)");

// THE January edge (Joe's concern): processed Jan 10, 2026.
const jan = new Date("2026-01-10T12:00:00.000Z");
assert.equal(inferDateYear("12/20", jan), "12/20/2025", "a Dec date processed in January -> PRIOR year");
assert.equal(inferDateYear("Dec 20", jan), "12/20/2025", "month-name Dec processed in January -> prior year");
// ...but a January date processed in January stays current year (not blanket-pushed back).
assert.equal(inferDateYear("01/05", jan), "01/05/2026", "a Jan date processed in January stays CURRENT year");

// --- Source guards ---
const src = fs.readFileSync("services/api/src/domain/mdfAssistant.ts", "utf8");
assert.ok(/invoiceDate: inferDateYear\(/.test(src), "normalizePacket must infer the year on invoice dates");
assert.ok(/activityStartDate: inferDateYear\(/.test(src) && /activityEndDate: inferDateYear\(/.test(src), "activity dates must also be year-normalized");
assert.ok(/invoiceDate: inferDateYear\(invoiceDate, new Date\(\)\)/.test(src), "the per-file invoice date must be year-normalized");
assert.ok(/no year, infer the most recent PAST year/i.test(src), "the extractor prompt must carry the year-inference rule as a backstop");

console.log("PASS mdf date-year inference eval — most-recent-past rule + January edge + pass-through + source guards");
