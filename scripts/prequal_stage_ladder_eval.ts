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

  console.log("writer: counts invitations, sends the application once, respects the finish line");
  console.log("PASS prequal stage ladder — bike, then budget, then the visit, then the application.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
