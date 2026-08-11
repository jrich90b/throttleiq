/**
 * A recorded finance APPROVAL aims the next reply at a booking (Joe, 2026-08-11).
 *
 * MEASURED on `HDFS COA Online` before building — of the leads whose business manager recorded an
 * outcome: **11 approved, ZERO booked**, while 10 of the 11 were messaged after the approval. Their
 * financing is arranged and nobody asks them in. That is the whole opportunity in this lane.
 *
 * ⚠️ THE OTHER TWO OUTCOMES ARE DELIBERATELY INERT, and this eval pins that:
 *  - `declined` — never tell a customer they were declined. Adverse-action notice is the LENDER's,
 *    the same rule as a `PreQual: N` lead.
 *  - `needs_more_info` — MEASURED as not meaning that. Its reasons are dominated by "Phone number is
 *    not reachable" / "4th call attempt that does not go through" / "remind stone to follow up":
 *    staff use it for customers they cannot REACH. Acting on it would text "can you send a pay
 *    stub?" to someone who simply has not answered the phone.
 *
 * ⚠️ AND IT NEVER QUOTES THE APPROVAL. The real recorded reasons carry amounts ("HD preapproval up to
 * fifty three grand"). An amount, a rate, a term or how long it lasts is the business manager's to
 * give. The goal is a TIME, not a number.
 *
 * Run: npx tsx scripts/finance_approved_books_them_eval.ts
 */
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

const NOW = Date.parse("2026-08-11T12:00:00.000Z");
const DAYS = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

async function main(): Promise<void> {
  process.env.DATA_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), "finance-approved-eval-"));
  delete process.env.CONVERSATIONS_DB_PATH;
  const { resolveFinanceApprovedAdvanceGoal, resolveLeadAdvanceGoal } = await import(
    "../services/api/src/domain/conversationStore.ts"
  );

  const conv = (outcome: any, over: any = {}) =>
    ({ id: "c", leadKey: "+17165550000", messages: [], lead: { source: "HDFS COA Online" }, financeOutcome: outcome, ...over }) as any;

  // --- the rung fires on a live approval --------------------------------------------------------
  const approved = resolveFinanceApprovedAdvanceGoal(conv({ status: "approved", updatedAt: DAYS(2) }), NOW);
  assert.ok(approved, "a recent approval produces a goal");
  assert.ok(/finishing up in person|day and time/i.test(approved!), "…and that goal is to get them booked");

  // NEVER a figure or a term. The recorded reasons carry amounts; the agent must not repeat them.
  assert.ok(/do not quote/i.test(approved!), "the goal forbids quoting the approval");
  for (const forbidden of ["amount", "rate", "term"]) {
    assert.ok(approved!.toLowerCase().includes(forbidden), `…naming ${forbidden} explicitly`);
  }
  assert.ok(!/\$\s?\d/.test(approved!), "and the goal itself carries no figure");

  // --- the outcomes that must stay INERT --------------------------------------------------------
  for (const status of ["declined", "needs_more_info", "unknown", ""]) {
    assert.equal(
      resolveFinanceApprovedAdvanceGoal(conv({ status, updatedAt: DAYS(2) }), NOW),
      null,
      `${status || "(empty)"} must produce no goal`
    );
  }
  assert.equal(resolveFinanceApprovedAdvanceGoal(conv(null), NOW), null, "no outcome at all, no goal");

  // --- an approval EXPIRES. The staff notes say so themselves ("valid for 30 days"). -------------
  assert.ok(resolveFinanceApprovedAdvanceGoal(conv({ status: "approved", updatedAt: DAYS(29) }), NOW), "29 days old still counts");
  assert.equal(
    resolveFinanceApprovedAdvanceGoal(conv({ status: "approved", updatedAt: DAYS(31) }), NOW),
    null,
    "31 days old must not drive today's turn"
  );
  assert.equal(
    resolveFinanceApprovedAdvanceGoal(conv({ status: "approved" }), NOW),
    null,
    "an approval with no date cannot be aged, so it does not fire"
  );

  // --- the four shared suppressions still own the turn ------------------------------------------
  assert.equal(
    resolveFinanceApprovedAdvanceGoal(
      conv({ status: "approved", updatedAt: DAYS(2) }, { appointment: { status: "confirmed", whenIso: "2026-08-20T15:00:00.000Z" } }),
      NOW
    ),
    null,
    "already booked is this goal's own finish line — stop"
  );
  // The appointment shape is copied from the live store, not invented. The first cut wrote
  // `{ whenIso }` with no status and the assertion failed — which looked like a suppression bug until
  // it was checked: all 64 real appointments carry status booked/confirmed (or startLocal/startsAt),
  // so `advanceEveryReplySuppressed` catches every one of them. The FIXTURE was wrong, not the code.
  assert.equal(
    resolveFinanceApprovedAdvanceGoal(conv({ status: "approved", updatedAt: DAYS(2) }, { sale: { id: "s1" } }), NOW),
    null,
    "they already bought — never push an owner"
  );

  // --- priority: an approval outranks the prequal ladder ----------------------------------------
  // A prequal lead who then got approved is in the warmest state we have; the qualifying rungs are
  // behind them and the only thing left is a time.
  const prequalThenApproved: any = {
    id: "c2",
    leadKey: "+17165550001",
    messages: [],
    lead: { source: "Marketplace - Prequal", vehicle: { model: "Harley-Davidson Full Line" } },
    financeOutcome: { status: "approved", updatedAt: DAYS(1) }
  };
  const dispatched = resolveLeadAdvanceGoal(prequalThenApproved, "https://example.com/apply");
  assert.ok(dispatched && /finishing up in person/i.test(dispatched), "an approval outranks the prequal rungs");
  assert.ok(!/which bike/i.test(dispatched!), "…so it does not fall back to asking which bike");

  // And with no approval, the prequal ladder still owns the lane.
  const prequalOnly = { ...prequalThenApproved, financeOutcome: undefined };
  const stillPrequal = resolveLeadAdvanceGoal(prequalOnly as any, "https://example.com/apply");
  assert.ok(stillPrequal && /which bike/i.test(stillPrequal), "no approval, and prequal keeps its first rung");

  console.log("PASS finance approved — an approval aims the turn at a booking, quotes nothing, expires, and outranks the ladder.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
