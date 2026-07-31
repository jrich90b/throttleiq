/**
 * Callback timeframe date eval (2026-07-31, Joe-approved).
 *
 * THE BUG. When a customer named a horizon we could not turn into a date, the callback task fell
 * back to due-TOMORROW-9am. Measured on the live store: "Call requested: **10 days**." and "Call
 * requested: **next spring**." were both sitting on a rep's desk the next morning — nine days and
 * six months early. Of 33 tasks given a deadline under 12h out, 29 were cleared after it.
 *
 * That is worse than it looks: a deadline nobody can meet is what teaches staff that an overdue
 * badge means nothing, which quietly undermines every other reminder surface.
 *
 * TWO CHANGES, and the split between them is the point:
 *   1. ARITHMETIC ("10 days", "in 2 weeks", "in 3 months", "next month") is deterministic quantity
 *      extraction — a number and a unit — so it resolves to a real date.
 *   2. JUDGEMENT ("next spring", "after the holidays") is comprehension. It stays UNRESOLVED on
 *      purpose, and the caller must then leave the task undated rather than invent a deadline.
 *      Missing beats wrong. A typed parser can own these later.
 *
 * Run: npx tsx scripts/callback_timeframe_date_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  mentionsUnresolvedTimeframe,
  parseRequestedDateOnly,
  resolveRelativeTimeframeDays
} from "../services/api/src/domain/conversationStore.ts";

const TZ = "America/New_York";
let n = 0;

const daysOut = (phrase: string): number | null => {
  const r = parseRequestedDateOnly(phrase, TZ);
  if (!r) return null;
  const now = new Date();
  const target = Date.UTC(r.year, r.month - 1, r.day, 12);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12);
  return Math.round((target - today) / 86400000);
};

// --- 1. THE PRODUCTION FAILURES ------------------------------------------------------------------
{
  // Verbatim from the live store's task summaries.
  assert.equal(daysOut("10 days"), 10, '"Call requested: 10 days." must land 10 days out, not tomorrow');
  assert.equal(parseRequestedDateOnly("next spring", TZ), null,
    '"next spring" is judgement, not arithmetic — it must NOT resolve to a guessed date');
  assert.equal(mentionsUnresolvedTimeframe("next spring"), true,
    'and it must be recognised as a STATED timeframe so the caller declines to invent tomorrow-9am');
  n += 3;
}

// --- 2. ARITHMETIC RESOLVES ----------------------------------------------------------------------
{
  const cases: Array<[string, number]> = [
    ["in 10 days", 10],
    ["in 2 weeks", 14],
    ["in 3 months", 90],
    ["next month", 30],
    ["a few weeks", 21],
    ["in 6 months", 180],
    ["two weeks", 14],
    ["in 1 day", 1]
  ];
  for (const [phrase, expected] of cases) {
    assert.equal(daysOut(phrase), expected, `"${phrase}" should be ${expected} days out`);
    n += 1;
  }
  assert.equal(resolveRelativeTimeframeDays("in 3 months"), 90, "months are 30 days — a reminder, not a contract");
  n += 1;

  // An absurd horizon is refused, not clamped: past ~2 years it is far likelier a misread number.
  assert.equal(resolveRelativeTimeframeDays("in 400 years"), null, "an absurd horizon does not resolve");
  assert.equal(resolveRelativeTimeframeDays("in 900 months"), null, "beyond the cap does not resolve");
  assert.equal(resolveRelativeTimeframeDays("in 0 days"), null, "zero is not a horizon");
  assert.equal(resolveRelativeTimeframeDays(""), null, "empty input");
  assert.equal(resolveRelativeTimeframeDays(null), null, "null input");
  n += 5;
}

// --- 3. THE WEEK-ANCHORED PHRASES MUST NOT MOVE --------------------------------------------------
// These are owned by an older branch that anchors to MONDAY and is pinned by
// manual_outbound_promise:eval. The numeric resolver runs AFTER it precisely so these keep winning;
// if the order is ever flipped, "in a couple weeks" becomes a flat 14 days and that eval breaks.
{
  for (const phrase of ["next week", "in a couple weeks", "in a few days"]) {
    const r = parseRequestedDateOnly(phrase, TZ);
    assert.ok(r, `"${phrase}" must still resolve`);
    assert.equal(r!.dayOfWeek, "monday", `"${phrase}" must stay anchored to a Monday`);
    n += 2;
  }
  const src = fs.readFileSync("services/api/src/domain/conversationStore.ts", "utf8");
  assert.ok(
    src.indexOf("Relative week phrases") < src.indexOf("Numeric timeframes"),
    "the week-anchored branch must run BEFORE the numeric resolver"
  );
  n += 1;
}

// --- 4. JUDGEMENT STAYS UNRESOLVED, AND IS RECOGNISED AS STATED ----------------------------------
{
  for (const phrase of ["next spring", "after the holidays", "sometime this summer", "next winter"]) {
    assert.equal(parseRequestedDateOnly(phrase, TZ), null, `"${phrase}" must not resolve to a guessed date`);
    assert.equal(mentionsUnresolvedTimeframe(phrase), true, `"${phrase}" must count as a stated timeframe`);
    n += 2;
  }
  // No timeframe at all → the tomorrow-9am default is still correct and must survive.
  for (const phrase of ["call me back", "give me a call", "can you call me"]) {
    assert.equal(mentionsUnresolvedTimeframe(phrase), false, `"${phrase}" states no timeframe — keep the default`);
    n += 1;
  }
  assert.equal(mentionsUnresolvedTimeframe(""), false, "empty text states no timeframe");
  n += 1;
}

// --- 5. THE WIRING -------------------------------------------------------------------------------
{
  const api = fs.readFileSync("services/api/src/index.ts", "utf8");
  // The dateless path must be tried before giving up.
  assert.match(api, /const dateOnly = parseRequestedDateOnly\(source, timezone\);/,
    "buildCallbackTodoSchedule tries the date-only parser for a dateless timeframe");
  // And the invented fallback must be gated on NOT having stated a timeframe.
  assert.match(api, /const statedTimeframe = mentionsUnresolvedTimeframe\(/,
    "the tomorrow-9am fallback is gated on whether a timeframe was stated");
  assert.match(api, /if \(!statedTimeframe\) \{/, "the fallback only applies when no timeframe was given");
  n += 3;

  // Fail-direction: the guard may only SUPPRESS an invented date, never manufacture one.
  const block = api.slice(api.indexOf("const statedTimeframe = mentionsUnresolvedTimeframe("));
  const scoped = block.slice(0, block.indexOf("const dueLabel"));
  assert.ok(!/schedule\s*=\s*\{[^}]*dueAt/.test(scoped),
    "the timeframe guard never invents a due date of its own");
  n += 1;
}

console.log(`PASS callback timeframe date eval (${n} assertions)`);
