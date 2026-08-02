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
import { inferDateYear, activityYearOutlierConcern } from "../services/api/src/domain/mdfAssistant.ts";

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

// --- Activity-year OUTLIER concern (2026-08-02) ---
// inferDateYear only fills a MISSING year. A year extraction read WRONG passes straight through,
// and that is what blocked four "250 Years of Freedom" portal runs on 2026-07-31: seven invoices,
// six dated 2026 and one IBBQ4U invoice read as 2020-07-18, with the activity dates taken from the
// outlier. The runner then asked Ansira for a "2020 Event Claim" that does not exist.
// The concern FLAGS the disagreement; it never rewrites the year (a funding-year pick is a
// money-path decision and stays with the human).
const YO = activityYearOutlierConcern;

// THE PRODUCTION PACKET, verbatim from mdf_65220e89c062a (task agent_ms9foivd_7qsqd8).
const FREEDOM_INVOICES = [
  { vendorName: "IBBQ4U", invoiceDate: "2020-07-18", invoiceNumber: "557102" },
  { vendorName: "Pin Prick Sewing", invoiceDate: "2026-06-20", invoiceNumber: "3" },
  { vendorName: "The Big Sauce Trio Band", invoiceDate: "07/18/2026", invoiceNumber: "N/A" },
  { vendorName: "Hatchets & Hops", invoiceDate: "2026-07-31", invoiceNumber: "LUQJP7UG-0003" },
  { vendorName: "WNY memorial Fire Truck", invoiceDate: "07/18/2026", invoiceNumber: "1" },
  { vendorName: "BJ's", invoiceDate: "07/15/2026", invoiceNumber: "3618" },
  { vendorName: "The Market in the Square", invoiceDate: "07/18/2026", invoiceNumber: "03-491279" }
];
const freedom = YO("07/18/2020", "07/18/2020", FREEDOM_INVOICES);
assert.ok(freedom, "the production 2020-vs-2026 packet must raise a concern");
assert.ok(/2020/.test(freedom!) && /6 of 7 invoices are dated 2026/.test(freedom!), "names the split");
assert.ok(/IBBQ4U #557102/.test(freedom!), "names the offending invoice so the operator can go straight to it");

// Quiet on everything that is not a confident outlier.
assert.equal(YO("07/18/2026", "07/18/2026", FREEDOM_INVOICES), null, "activity year matching the majority -> quiet");
assert.equal(
  YO("07/18/2020", "07/18/2020", FREEDOM_INVOICES.slice(0, 2)),
  null,
  "under three dated invoices there is no majority worth trusting -> quiet"
);
assert.equal(
  YO("07/18/2025", "", [
    { invoiceDate: "01/02/2025" },
    { invoiceDate: "01/02/2026" },
    { invoiceDate: "01/02/2027" }
  ]),
  null,
  "no strict majority (1/1/1) -> quiet"
);
assert.equal(YO("", "", FREEDOM_INVOICES), null, "no activity year -> nothing to say");
assert.equal(YO("07/18/2020", "", []), null, "no invoices -> quiet");
assert.equal(
  YO("07/18/2020", "", [{ invoiceDate: "junk" }, { invoiceDate: "" }, { invoiceDate: "see invoice" }]),
  null,
  "undated invoices are not evidence -> quiet"
);
// A year-straddling claim where the activity year is genuinely the minority DOES flag — that is
// the intended behavior; the note is advisory and the operator confirms.
const straddle = YO("12/28/2025", "", [
  { vendorName: "A", invoiceDate: "12/28/2025" },
  { vendorName: "B", invoiceDate: "01/05/2026" },
  { vendorName: "C", invoiceDate: "01/06/2026" },
  { vendorName: "D", invoiceDate: "01/07/2026" }
]);
assert.ok(straddle && /3 of 4 invoices are dated 2026/.test(straddle), "minority activity year flags with the counts");

// --- Source guards ---
const src = fs.readFileSync("services/api/src/domain/mdfAssistant.ts", "utf8");
assert.ok(
  /concerns: \[[\s\S]{0,400}yearConcern \? \[yearConcern\] : \[\]/.test(src),
  "the outlier concern must be wired into the packet's eligibility.concerns"
);
assert.ok(
  !/activityStartDate = activityYearOutlierConcern|activityStartDate: activityYearOutlier/.test(src),
  "the concern must never write back onto a date field"
);
assert.ok(/invoiceDate: inferDateYear\(/.test(src), "normalizePacket must infer the year on invoice dates");
assert.ok(/activityStartDate: inferDateYear\(/.test(src) && /activityEndDate: inferDateYear\(/.test(src), "activity dates must also be year-normalized");
assert.ok(/invoiceDate: inferDateYear\(invoiceDate, new Date\(\)\)/.test(src), "the per-file invoice date must be year-normalized");
assert.ok(/no year, infer the most recent PAST year/i.test(src), "the extractor prompt must carry the year-inference rule as a backstop");

console.log("PASS mdf date-year inference eval — most-recent-past rule + January edge + pass-through + activity-year outlier concern (the 250-Years 2020-vs-2026 packet) + source guards");
