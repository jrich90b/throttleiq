/**
 * Pre-qualification stage ladder — decision table (pure, no LLM).
 *
 * Joe, 2026-08-11, verbatim: "Pre qualification needs to change. The agent should discover what bike
 * they are interested in, what their budget in then either try to book an appointment or if that
 * fails, send them a credit application link."
 *
 * MEASURED on the live store, 90 days, BEFORE any code was written — the numbers changed the spec:
 *   27 prequal leads (the finance lane that matters; credit applications: 3).
 *   19 of 27 ALREADY name a real, specific bike — so "discover the bike" applies to 8, not 27, and
 *     asking the other 19 would read as not having listened. Gated on `isPlaceholderModel`.
 *   0 of 27 ever had a budget captured, though `paymentBudgetContext` has held the shape all along.
 *   6 of 27 booked (22%, vs 3.8% for non-finance leads — this lane is our BEST, not our worst).
 *   15 were invited in and never came. That 15 is the credit application's audience.
 *
 * "If that fails" is Joe's rule, decided 2026-08-11: send the application when the customer tells us
 * they cannot come in, OR after TWO invitations with no booking. Two, deliberately — one unanswered
 * invitation is not a refusal, and a credit application cannot be unsent.
 *
 * This asserts the DECISION (the stage), never the wording. It executes the real referee and the
 * real writer, so it fails if either is unwired — not merely if their source text changes.
 *
 * Run: npx tsx scripts/prequal_stage_ladder_eval.ts
 */
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

type Row = {
  name: string;
  input: Partial<Record<string, unknown>>;
  expect: string;
};

const BASE = {
  isPrequalLead: true,
  suppressed: false,
  appointmentBooked: false,
  bikeUnknown: false,
  budgetKnown: true,
  visitOffersMade: 0,
  visitNotPossible: false,
  creditAppSentAt: null,
  creditAppAvailable: true
};

async function main(): Promise<void> {
  const { decidePrequalTurn, PREQUAL_VISIT_OFFER_LIMIT } = await import(
    "../services/api/src/domain/routeStateReducer.ts"
  );
  assert.equal(PREQUAL_VISIT_OFFER_LIMIT, 2, "Joe's rule: two invitations before the application");

  const rows: Row[] = [
    // --- the ladder, in Joe's order ---------------------------------------------------------
    { name: "no specific bike -> ask which one", input: { bikeUnknown: true, budgetKnown: false }, expect: "ask_bike" },
    { name: "bike known, no budget -> ask the budget", input: { budgetKnown: false }, expect: "ask_budget" },
    { name: "qualified -> invite them in", input: {}, expect: "offer_visit" },
    { name: "invited once -> invite again", input: { visitOffersMade: 1 }, expect: "offer_visit" },
    { name: "invited twice, still nothing -> the application", input: { visitOffersMade: 2 }, expect: "send_credit_app" },
    { name: "invited three times -> the application", input: { visitOffersMade: 3 }, expect: "send_credit_app" },
    { name: "they cannot come in -> the application, immediately", input: { visitNotPossible: true }, expect: "send_credit_app" },

    // --- the ORDER matters: qualify before either outcome -----------------------------------
    // A customer who cannot come in still gets asked what they want and what they can spend. Those
    // are questions that HELP; only the invitation is a push.
    { name: "cannot come in but bike unknown -> still ask the bike first", input: { visitNotPossible: true, bikeUnknown: true }, expect: "ask_bike" },
    { name: "cannot come in but no budget -> still ask the budget first", input: { visitNotPossible: true, budgetKnown: false }, expect: "ask_budget" },

    // --- every way the ladder must STAY SILENT ----------------------------------------------
    { name: "not a prequal lead", input: { isPrequalLead: false, bikeUnknown: true }, expect: "none" },
    { name: "grief / not interested / already bought", input: { suppressed: true, bikeUnknown: true }, expect: "none" },
    // THE FINISH LINE. This is the stop condition the whole ladder exists to have.
    { name: "already booked -> stop asking", input: { appointmentBooked: true, budgetKnown: false }, expect: "none" },
    // A credit application cannot be unsent, so it goes out at most once per lead, ever.
    { name: "application already sent -> never a second one", input: { creditAppSentAt: "2026-08-10T12:00:00.000Z", visitNotPossible: true }, expect: "none" },
    { name: "already sent, and now they would qualify again", input: { creditAppSentAt: "2026-08-10T12:00:00.000Z", visitOffersMade: 9 }, expect: "none" },

    // --- no real URL: never promise a link we cannot produce ---------------------------------
    { name: "no credit-app URL -> keep inviting instead", input: { creditAppAvailable: false, visitOffersMade: 5 }, expect: "offer_visit" },
    { name: "no credit-app URL and they cannot come in -> still never a fake link", input: { creditAppAvailable: false, visitNotPossible: true }, expect: "offer_visit" }
  ];

  for (const row of rows) {
    const decision = decidePrequalTurn({ ...BASE, ...row.input } as any);
    assert.equal(decision.stage, row.expect, `${row.name}: expected ${row.expect}, got ${decision.stage} (${decision.reason})`);
    assert.ok(String(decision.reason ?? "").trim(), `${row.name}: every decision must say WHY`);
  }
  console.log(`decision table: ${rows.length} rows, all stages as ruled`);

  // --- the writer: the ladder's state, and the two things it must never get wrong -------------
  // Importing the store hydrates one; point it at a temp dir so this eval never writes into the
  // repo (an untracked file in the box checkout blocks `deploy:api` with exit 21).
  process.env.DATA_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), "prequal-eval-"));
  delete process.env.CONVERSATIONS_DB_PATH;
  const { applyPrequalStageReply } = await import("../services/api/src/domain/conversationStore.ts");
  const prequalConv = (over: any = {}) => ({
    id: "c_prequal",
    leadKey: "+17165550000",
    messages: [],
    lead: { vehicle: { model: "2025 Road Glide" } },
    paymentBudgetContext: { monthlyBudget: 450 },
    ...over
  });
  const URL = "https://creditapplication.harley-davidson.com/us/en/?dealerid=3436";

  // An invitation is COUNTED only when one actually goes out, or "we tried twice" is a lie.
  const conv: any = prequalConv();
  const first = applyPrequalStageReply(conv, { isPrequalLead: true, creditAppUrl: URL });
  assert.ok(first.includes("?"), "the invitation asks something");
  assert.equal(conv.prequalFlow?.visitOffersMade, 1, "one invitation counted");
  const second = applyPrequalStageReply(conv, { isPrequalLead: true, creditAppUrl: URL });
  assert.ok(second.includes("?"), "still inviting on the second try");
  assert.equal(conv.prequalFlow?.visitOffersMade, 2, "two invitations counted");
  const third = applyPrequalStageReply(conv, { isPrequalLead: true, creditAppUrl: URL });
  assert.ok(third.includes(URL), "after two invitations the application goes out, with the REAL url");
  assert.ok(conv.prequalFlow?.creditAppSentAt, "and the send is stamped");
  assert.equal(conv.prequalFlow?.visitOffersMade, 2, "sending the application is not another invitation");
  const fourth = applyPrequalStageReply(conv, { isPrequalLead: true, creditAppUrl: URL });
  assert.equal(fourth, "", "nothing more after the application — never a second one");

  // A non-prequal lead is untouched, and so is its state.
  const other: any = prequalConv();
  assert.equal(applyPrequalStageReply(other, { isPrequalLead: false, creditAppUrl: URL }), "");
  assert.equal(other.prequalFlow, undefined, "a lane this does not own gets no state written");

  // 19 of 27 measured leads name a real bike. Asking THEM which bike is the miss Joe fixed by hand.
  const known: any = prequalConv({ paymentBudgetContext: undefined });
  const askKnown = applyPrequalStageReply(known, { isPrequalLead: true, creditAppUrl: URL });
  assert.ok(!/which bike/i.test(askKnown), "never ask which bike when the lead already names one");
  assert.ok(/payment|budget/i.test(askKnown), "with the bike known and no budget, ask the budget");
  // A catch-all is NOT a known bike — "Harley-Davidson Full Line" is one of the 8 real ones.
  const placeholder: any = prequalConv({ lead: { vehicle: { model: "Harley-Davidson Full Line" } }, paymentBudgetContext: undefined });
  assert.ok(
    /which bike/i.test(applyPrequalStageReply(placeholder, { isPrequalLead: true, creditAppUrl: URL })),
    "a catch-all placeholder must be treated as no bike at all"
  );

  // Suppression goes through the SHARED referee — a booked thread is never pushed.
  const booked: any = prequalConv({ appointment: { whenIso: "2026-08-20T15:00:00.000Z" } });
  assert.equal(applyPrequalStageReply(booked, { isPrequalLead: true, creditAppUrl: URL }), "", "booked means stop");

  // No configured URL: keep inviting, never emit a broken link. BOTH shapes of "no url" —
  // a sabotage that only checked for emptiness survived this eval until the second case was added,
  // and a dealer profile carrying a note instead of a link is exactly how that reaches a customer.
  for (const badUrl of ["", "   ", "call the store", "creditapplication.harley-davidson.com", "TBD"]) {
    const noUrl: any = prequalConv({ prequalFlow: { visitOffersMade: 5 } });
    const line = applyPrequalStageReply(noUrl, { isPrequalLead: true, creditAppUrl: badUrl });
    assert.ok(line, `a lead past the invitation limit still gets a reply with url=${JSON.stringify(badUrl)}`);
    assert.ok(
      !line.includes(badUrl.trim()) || !badUrl.trim(),
      `never hand the customer a non-link as if it were one (url=${JSON.stringify(badUrl)})`
    );
    assert.ok(line.includes("?"), `with no usable url we INVITE instead (url=${JSON.stringify(badUrl)})`);
    assert.ok(!noUrl.prequalFlow?.creditAppSentAt, "and nothing is stamped as sent");
  }

  // --- the lender's own verdict, read off the form (Joe, 2026-08-11) ------------------------------
  // Branson Stockwell (+17164312263) arrived with PreQual: N and got a message implying the soft
  // check had gone fine. MEASURED across all 42 prequal leads that day: 15 N, 5 Y, 22 with no such
  // field. So `unknown` is the COMMONEST answer and must behave exactly as it did before.
  const { readPrequalSubmissionResult, buildPrequalNotClearedCreditAppLine } = await import(
    "../services/api/src/domain/workflowRegressionGuards.ts"
  );

  // Every string below is a REAL inquiry field copied off the live store, never invented — a
  // plausible-looking wording would have passed and shipped a reader that does not fit the feed.
  const REAL_FORMS: Array<[string, string]> = [
    ["PreQual: N, PreQualified Amount; $0 Please note non-prequalified customers can still be considered for approval with a completed credit application.", "not_cleared"],
    ["Model Year: 2025, Model: Heritage Classic, PreQual: N, PreQualified Amount; $0 Please note non-prequalified customers can still be considered for approval with a completed credit application.", "not_cleared"],
    ["Model Year: 2022, Model: Iron 883, PreQual: Y, PreQualified Amount; $13,000 or up to $33,000. Please note prequalified customers still require a full application.", "cleared"],
    ["PreQual: Y, PreQualified Amount; $18,000 or up to $53,000. Please note prequalified customers s", "cleared"],
    // 22 of 42 leads look like this — no verdict at all. Must stay `unknown`.
    ["Model Year: 2016, Model: Ultra Limited,", "unknown"],
    ["Model Year: 2019, Model: Tri Glide Ultra,", "unknown"],
    ["", "unknown"]
  ];
  for (const [text, expected] of REAL_FORMS) {
    assert.equal(
      readPrequalSubmissionResult(text),
      expected,
      `real form string read wrong: ${JSON.stringify(text.slice(0, 60))}`
    );
  }
  assert.equal(readPrequalSubmissionResult(null), "unknown", "a missing inquiry is unknown, never a verdict");
  console.log(`the lender's verdict: ${REAL_FORMS.length} real form strings read correctly`);

  // A soft check that did not clear starts AT the application — it does not have to earn it with two
  // unanswered invitations first. But it still qualifies first: the bike and the budget come before.
  assert.equal(
    decidePrequalTurn({ ...BASE, prequalResult: "not_cleared" } as any).stage,
    "send_credit_app",
    "PreQual: N goes straight to the application once qualified"
  );
  assert.equal(
    decidePrequalTurn({ ...BASE, prequalResult: "not_cleared", bikeUnknown: true } as any).stage,
    "ask_bike",
    "...but never before we know which bike"
  );
  assert.equal(
    decidePrequalTurn({ ...BASE, prequalResult: "not_cleared", budgetKnown: false } as any).stage,
    "ask_budget",
    "...and never before the budget"
  );
  assert.equal(
    decidePrequalTurn({ ...BASE, prequalResult: "not_cleared", appointmentBooked: true } as any).stage,
    "none",
    "a booked lead is still finished, whatever the form said"
  );
  // The two values that must change NOTHING — 27 of 42 leads are one of these.
  for (const result of ["cleared", "unknown"] as const) {
    assert.equal(
      decidePrequalTurn({ ...BASE, prequalResult: result } as any).stage,
      "offer_visit",
      `prequalResult=${result} must behave exactly as before`
    );
  }

  // The copy must never hand the customer their credit outcome. Adverse action is the lender's job.
  const notCleared = buildPrequalNotClearedCreditAppLine("https://creditapplication.harley-davidson.com/us/en/?dealerid=3436");
  assert.ok(notCleared, "a not-cleared lead gets a line");
  assert.ok(/soft check/i.test(notCleared!), "it reframes the pre-qual as the soft check it is");
  for (const forbidden of ["not approved", "denied", "declined", "rejected", "did not qualify", "didn't qualify", "$0"]) {
    assert.ok(
      !notCleared!.toLowerCase().includes(forbidden),
      `the reply must never state the customer's credit outcome (found "${forbidden}")`
    );
  }
  assert.equal(buildPrequalNotClearedCreditAppLine(""), null, "and never a fabricated link");
  // The visit must NOT be traded away. 15 of 42 leads take this rung, and booking is the number the
  // business is judged on — the application is an EXTRA path, never a replacement for coming in.
  assert.ok(
    /stop in|come in|swing by/i.test(notCleared!),
    "the not-cleared line keeps the door to a visit open"
  );
  // Count question marks OUTSIDE the URL — the credit-app link carries "?dealerid=", which is not a
  // question. (The first cut of this assertion failed on exactly that, which is the useful kind of
  // failure: a naive "does it contain ?" check would have mis-graded every message with a link.)
  assert.equal(
    (notCleared!.replace(/https?:\/\/\S+/g, "").match(/\?/g) ?? []).length,
    0,
    "and it adds no second question — the ceiling is one per message"
  );

  console.log("writer: counts invitations, sends the application once, respects the finish line");
  console.log("PASS prequal stage ladder — bike, then budget, then the visit, then the application.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
