/**
 * email_draft_display_validity:eval
 *
 * Pins the Email-tab display referee: a stored `conv.emailDraft` stops being OFFERED as sendable
 * once the thread has moved past it. Operator report +15852503838 ("Email does not respond correctly
 * like the sms").
 *
 * Deterministic — no LLM, no clock. Every fixture body below is a VERBATIM draft from the live
 * americanharley store on 2026-08-15 (measured: 223 conversations carried a live email draft; 131
 * were on closed/sold threads, and of the 92 open ones exactly ONE — Jessica — still promised a
 * finance callback a landed decision had replaced). Fixtures written from invented copy would have
 * passed while proving nothing, so these are the real strings.
 *
 * The assertion is on the DECISION (offered vs withheld, and which rule withheld it), not on any
 * phrasing of a label — the API branches on exactly that.
 */
import assert from "node:assert/strict";
import {
  emailDraftPromisesPendingFinanceCallback,
  resolveConversationDetailDisplay,
  resolveEmailDraftForDisplay
} from "../services/api/src/domain/conversationStore.js";

type Case = {
  name: string;
  conv: any;
  expectSuppressed: null | "thread_closed" | "finance_outcome_landed";
};

// Verbatim live drafts (2026-08-15).
const TIMOTHY =
  "Hi Timothy,\n\nYes — the 2026 Street Glide 3 Limited in Iron Horse Metallic Black Trim is available. What day and time works best to stop in and take a look?";
const JESSICA =
  "Hi Jessica,\nThanks for your online credit application. It's Alexandra over at American Harley-Davidson. Our finance team will reach out shortly to go over your options and next steps.\nIf you'd like to set up a time to come in and go over the numbers in person, you can book here: https://americanharley.leadrider.ai/book?type=finance_discussion";
const OWEN =
  "Hey Owen,\n\nI don't want to leave you hanging after your application. The best next step is to sit down with our finance manager and go over where things stand and what makes sense from here on the Road Glide Custom.\n\nYou can grab a time here: https://americanharley.leadrider.ai/book?type=finance_discussion\n\nWhat day works best for you?";
const JIM = "Hi Jim,\n\nSounds good.";
const SHANE =
  "Hi Shane,\n\nThanks Shane — we just received your pre-qualification submission. Our finance team will reach out shortly to review options and next steps.";
const MIKE =
  "Hi Mike, Thanks for your interest in the 2014 Road King. This is Alexandra at American Harley-Davidson. I’m happy to help with pricing, options, and availability.";
const BRANDON =
  "Hi Brandon,\nThanks for your interest in the 2019 Fxdr 114. This is Alexandra at American Harley-Davidson. I’m happy to help with pricing, options, and availability. If you want to stop in I can set something up.";
const WATCH_ACK = "Got it. I’ll keep watching for a Breakout and let you know if one comes in.";

const CASES: Case[] = [
  // --- rule 1: the thread is finished. 131 of the 223 live drafts sit here. ---
  {
    name: "closed thread (+17163741119 Timothy, closedReason other) — availability copy is stale",
    conv: { id: "+17163741119", status: "closed", closedReason: "other", emailDraft: TIMOTHY },
    expectSuppressed: "thread_closed"
  },
  {
    name: "customer stepped back (+17164173509 Mike) — the worst state to re-offer a first touch in",
    conv: { id: "+17164173509", status: "closed", closedReason: "customer_stepping_back", emailDraft: MIKE },
    expectSuppressed: "thread_closed"
  },
  {
    name: "sold thread (+17163852815 Shane) — sale.soldAt closes it even without closedReason",
    conv: { id: "+17163852815", sale: { soldAt: "2026-07-23T14:38:09.478Z" }, emailDraft: SHANE },
    expectSuppressed: "thread_closed"
  },
  {
    name: "closedAt alone is enough",
    conv: { id: "+1999", closedAt: "2026-08-01T00:00:00.000Z", emailDraft: BRANDON },
    expectSuppressed: "thread_closed"
  },
  {
    name: "closed AND finance-decided (+17166091289 Terry) — closure is reported, one reason not two",
    conv: {
      id: "+17166091289",
      status: "closed",
      closedReason: "other",
      financeOutcome: { status: "declined", updatedAt: "2026-07-27T18:33:13.475Z" },
      emailDraft: JESSICA
    },
    expectSuppressed: "thread_closed"
  },

  // --- rule 2: a credit decision landed and the draft still promises the callback it replaced. ---
  {
    name: "OPEN thread, approved 8/12, draft still promises the finance callback (+15853564919 Jessica)",
    conv: {
      id: "+15853564919",
      financeOutcome: { status: "approved", updatedAt: "2026-08-12T21:55:34.676Z" },
      emailDraft: JESSICA
    },
    expectSuppressed: "finance_outcome_landed"
  },

  // --- the negatives that make rule 2 content-conditioned instead of blanket. Both are REAL open
  //     threads with a landed outcome; a "suppress on any financeOutcome" rule would eat both. ---
  {
    name: "OPEN, declined, draft ALREADY reflects the decline (+15857462112 Owen) — must still be offered",
    conv: {
      id: "+15857462112",
      financeOutcome: { status: "declined", updatedAt: "2026-08-10T14:44:28.247Z" },
      emailDraft: OWEN
    },
    expectSuppressed: null
  },
  {
    name: "OPEN, approved, draft makes no callback promise (+17163275913 Jim) — must still be offered",
    conv: {
      id: "+17163275913",
      financeOutcome: { status: "approved", updatedAt: "2026-08-12T21:41:29.981Z" },
      emailDraft: JIM
    },
    expectSuppressed: null
  },

  // --- ordinary live threads: the referee must be invisible on the other 91 open drafts. ---
  {
    name: "open thread, ordinary first-touch draft (+19083008509 Brandon)",
    conv: { id: "+19083008509", status: "open", emailDraft: BRANDON },
    expectSuppressed: null
  },
  {
    name: "open thread, inventory-watch acknowledgement (+17164815673)",
    conv: { id: "+17164815673", status: "open", emailDraft: WATCH_ACK },
    expectSuppressed: null
  },
  {
    name: "no draft at all — the referee invents nothing",
    conv: { id: "+15550000000", status: "closed", closedReason: "no_response" },
    expectSuppressed: null
  }
];

let failures = 0;
for (const c of CASES) {
  const { emailDraft, suppressedReason } = resolveEmailDraftForDisplay(c.conv);
  const offered = emailDraft !== null && String(emailDraft ?? "").trim() !== "";
  const wantOffered = c.expectSuppressed === null && !!String(c.conv.emailDraft ?? "").trim();
  try {
    assert.equal(
      suppressedReason,
      c.expectSuppressed,
      `expected suppressedReason ${String(c.expectSuppressed)}, got ${String(suppressedReason)}`
    );
    assert.equal(offered, wantOffered, `expected offered=${wantOffered}, got ${offered}`);
    if (c.expectSuppressed !== null) {
      assert.equal(emailDraft, null, "a withheld draft must render as null, never as the stale body");
    } else if (wantOffered) {
      assert.equal(emailDraft, c.conv.emailDraft, "an honest draft must pass through byte-for-byte");
    }
    console.log(`PASS ${c.name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${c.name}: ${(err as Error).message}`);
  }
}

// The referee never mutates the stored field — suppression is a display decision, and the draft has
// to survive so a reopened thread (or a revert of this change) still has it.
const preserved: any = { id: "+1", status: "closed", closedReason: "other", emailDraft: TIMOTHY };
resolveEmailDraftForDisplay(preserved);
try {
  assert.equal(preserved.emailDraft, TIMOTHY, "the stored draft must be left untouched");
  console.log("PASS suppression is non-destructive (stored emailDraft untouched)");
} catch (err) {
  failures += 1;
  console.log(`FAIL non-destructive: ${(err as Error).message}`);
}

// The phrase guard reads OUR OWN template copy, in both of the wordings the store actually holds.
try {
  assert.ok(emailDraftPromisesPendingFinanceCallback(JESSICA), "must catch 'finance team will reach out'");
  assert.ok(emailDraftPromisesPendingFinanceCallback(SHANE), "must catch the pre-qual wording");
  assert.ok(!emailDraftPromisesPendingFinanceCallback(OWEN), "must not fire on decline-aware copy");
  assert.ok(!emailDraftPromisesPendingFinanceCallback(JIM), "must not fire on a bare acknowledgement");
  assert.ok(!emailDraftPromisesPendingFinanceCallback(BRANDON), "must not fire on ordinary first-touch copy");
  console.log("PASS pending-finance-callback phrase guard");
} catch (err) {
  failures += 1;
  console.log(`FAIL phrase guard: ${(err as Error).message}`);
}

// The detail endpoint reads the referee, and still answers the follow-up-hold question it always did.
try {
  const held = resolveConversationDetailDisplay({
    id: "+17163741119",
    status: "closed",
    closedReason: "other",
    emailDraft: TIMOTHY,
    followUp: { mode: "manual_handoff" },
    followUpCadence: { kind: "standard" }
  } as any);
  assert.equal(held.emailDraft, null, "detail view must withhold a closed thread's draft");
  assert.equal(held.emailDraftSuppressedReason, "thread_closed", "detail view must say WHY it withheld");
  assert.equal(held.followUpHold, true, "a manual_handoff standard cadence must still render as on hold");
  const live = resolveConversationDetailDisplay({
    id: "+19083008509",
    status: "open",
    emailDraft: BRANDON,
    followUpCadence: { kind: "standard" }
  } as any);
  assert.equal(live.emailDraft, BRANDON, "detail view must pass an honest draft through");
  assert.equal(live.emailDraftSuppressedReason, null);
  assert.equal(live.followUpHold, null);
  console.log("PASS conversation detail display view");
} catch (err) {
  failures += 1;
  console.log(`FAIL detail display view: ${(err as Error).message}`);
}

if (failures) {
  console.error(`email_draft_display_validity:eval FAILED (${failures})`);
  process.exit(1);
}
console.log("email_draft_display_validity:eval PASSED");
