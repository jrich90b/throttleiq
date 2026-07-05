/**
 * Test-ride preferred-date reply eval.
 *
 * Production fixtures: Room58 "Book test ride" ADF web leads 08610167776 (preferredDate "29/6/2026",
 * "12 pm") and 8879803743 ("30/06/2026"). The form emits DD/MM/YYYY, but the initial-draft date parser
 * (a MM/DD-only private copy duplicated in sendgridInbound.ts + index.ts) read month=29/30 → null → the
 * test-ride lead fell through to a generic "not in stock" deflection that IGNORED the requested date/time.
 *
 * Fix: one shared, DD/MM-aware structured-ADF date parser (domain/preferredAdfDate.ts) that both the
 * SendGrid inbound path and the regenerate twin delegate to. DD/MM is applied only when unambiguous
 * (first component > 12), so US MM/DD free-text-style values are unchanged.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const { parsePreferredAdfDate, formatPreferredAdfDateForReply } = await import(
  "../services/api/src/domain/preferredAdfDate.ts"
);

const utc = (d: Date | null) => (d ? `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}` : null);

// ── The production miss: DD/MM/YYYY must resolve (previously null).
assert.equal(utc(parsePreferredAdfDate("29/6/2026")), "2026-6-29", "29/6/2026 → June 29 (DD/MM)");
assert.equal(utc(parsePreferredAdfDate("30/06/2026")), "2026-6-30", "30/06/2026 → June 30 (DD/MM)");
assert.equal(utc(parsePreferredAdfDate("13/5/2026")), "2026-5-13", "13/5 → May 13 (13 can't be a month)");

// ── Regression: US MM/DD (and ambiguous both-≤12) behavior is UNCHANGED.
assert.equal(utc(parsePreferredAdfDate("6/29/2026")), "2026-6-29", "6/29/2026 → June 29 (MM/DD)");
assert.equal(utc(parsePreferredAdfDate("5/8/2026")), "2026-5-8", "5/8 stays MM/DD (May 8), not DD/MM");
assert.equal(utc(parsePreferredAdfDate("12/11/2025")), "2025-12-11", "12/11 stays MM/DD (Dec 11)");
assert.equal(utc(parsePreferredAdfDate("6/29/26")), "2026-6-29", "2-digit year → 20xx");

// ── Invalid stays null.
assert.equal(parsePreferredAdfDate("13/13/2026"), null, "month 13 (no valid order) → null");
assert.equal(parsePreferredAdfDate("0/5/2026"), null, "month 0 → null");
assert.equal(parsePreferredAdfDate("not a date"), null, "non-date → null");
assert.equal(parsePreferredAdfDate(""), null, "empty → null");

// ── Reply label.
assert.match(String(formatPreferredAdfDateForReply("29/6/2026")), /June 29/, "label names the resolved date");
assert.equal(formatPreferredAdfDateForReply("29/13/2026"), null, "unparseable → no label");

// ── Source pins: BOTH the SendGrid inbound path and the regenerate twin delegate to the shared parser
// (kills the previously-duplicated MM/DD-only copies that could drift).
const sendgrid = await fs.readFile(path.resolve("services/api/src/routes/sendgridInbound.ts"), "utf8");
const index = await fs.readFile(path.resolve("services/api/src/index.ts"), "utf8");
assert.match(sendgrid, /from "\.\.\/domain\/preferredAdfDate\.js"/, "sendgridInbound imports the shared parser");
assert.match(sendgrid, /return parsePreferredAdfDate\(value\);/, "sendgridInbound parsePreferredDateOnly delegates");
assert.match(index, /from "\.\/domain\/preferredAdfDate\.js"/, "index imports the shared parser");
assert.match(index, /return parsePreferredAdfDate\(value\);/, "index parsePreferredDateOnlyForReply delegates");

console.log("PASS test-ride preferred-date reply eval");
