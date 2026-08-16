/**
 * Dealer intake mail eval (deterministic — no LLM calls).
 *
 * Pins the safety-relevant mechanics of the intake email loop
 * (services/api/src/domain/dealerIntakeMail.ts):
 *   1. Sensitive scrub: a dashed EIN and card-length digit runs are redacted;
 *      normal phone numbers survive.
 *   2. Empty-never-clobbers: a blank parsed answer must not overwrite an
 *      existing record value.
 *   3. Notes labels: the intake notes block uses the exact "Inventory/export URL:",
 *      "Tone:" and "Rules:" labels dealerSetupStore reads back out of notes.
 *   4. Step status keys off the dealer's actual blanks, not optional empty fields
 *      ("no DBA" is an answer, not a blank).
 *   5. Flag gate: with DEALER_INTAKE_EMAIL_ENABLED unset, the loop is off.
 *   6. Reply matching: threadId match wins, sender-address match is the fallback,
 *      already-processed messages never re-ingest.
 */
import assert from "node:assert/strict";
import {
  applyIntakeAnswersToSetup,
  buildIntakeInviteEmail,
  buildIntakeNotesBlock,
  isDealerIntakeEmailEnabled,
  matchReplyToInvite,
  parseIntakeFormSubmission,
  renderIntakeFormHtml,
  scrubSensitive,
  type DealerIntakeAnswers
} from "../services/api/src/domain/dealerIntakeMail.ts";

function answers(overrides: Partial<DealerIntakeAnswers> = {}): DealerIntakeAnswers {
  return {
    legalName: "",
    dbaName: "",
    address: "",
    website: "",
    mainPhone: "",
    primaryContact: "",
    ownerGm: "",
    salespeople: [],
    messageApprover: "",
    afterHoursEscalation: "",
    salesHours: "",
    serviceHours: "",
    closures: "",
    crmProvider: "",
    monthlyLeadVolume: "",
    leadSources: [],
    leadNotificationDestination: "",
    inventoryFeedUrl: "",
    inventoryFeedOwner: "",
    tonePreferences: "",
    neverSay: [],
    unansweredQuestions: [],
    extraNotes: "",
    sensitiveDataWarning: "",
    ...overrides
  };
}

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

// 1) Scrub.
ok("scrub redacts a dashed EIN", () => {
  assert.equal(scrubSensitive("our EIN is 16-1234567 thanks"), "our EIN is [redacted] thanks");
});
ok("scrub redacts a 16-digit card run", () => {
  assert.ok(!scrubSensitive("card 4111 1111 1111 1111 ok").includes("4111"));
});
ok("scrub preserves a 10-digit phone number", () => {
  assert.equal(scrubSensitive("call 716-692-7200 anytime"), "call 716-692-7200 anytime");
});

// 2) Empty never clobbers.
ok("blank parsed answer never overwrites an existing value", () => {
  const setup = { legalName: "Existing Legal LLC", notes: "" } as any;
  const { patch } = applyIntakeAnswersToSetup(setup, answers({ legalName: "" }), "test");
  assert.ok(!("legalName" in patch), "legalName must not be patched by a blank answer");
});
ok("changed parsed answer patches with a diff", () => {
  const setup = { legalName: "Old Name", notes: "" } as any;
  const { patch, diffs } = applyIntakeAnswersToSetup(setup, answers({ legalName: "New Name LLC" }), "test");
  assert.equal(patch.legalName, "New Name LLC");
  assert.ok(diffs.some(d => d.startsWith("legalName:")));
});

// 3) Load-bearing notes labels (dealerSetupStore.buildDealerConfigStandard reads these).
ok("notes block uses the store-recognized labels", () => {
  const block = buildIntakeNotesBlock(
    answers({
      inventoryFeedUrl: "https://feeds.example.com/inv.xml",
      tonePreferences: "friendly, casual",
      neverSay: ["never promise OTD", "never trash competitors"]
    })
  );
  assert.match(block, /^Inventory\/export URL: https:\/\/feeds\.example\.com\/inv\.xml$/m);
  assert.match(block, /^Tone: friendly, casual$/m);
  assert.match(block, /^Rules: never promise OTD; never trash competitors$/m);
});

// 4) Step status from actual blanks, not optional empties.
ok("no blanks -> intake step done even with empty optional fields", () => {
  const setup = { notes: "" } as any;
  const { stepStatus } = applyIntakeAnswersToSetup(setup, answers({ legalName: "X LLC" }), "test");
  assert.equal(stepStatus, "done");
});
ok("reported blanks -> waiting_on_dealer with the owed list in the note", () => {
  const setup = { notes: "" } as any;
  const { stepStatus, stepNote } = applyIntakeAnswersToSetup(
    setup,
    answers({ unansweredQuestions: ["Inventory feed URL"] }),
    "test"
  );
  assert.equal(stepStatus, "waiting_on_dealer");
  assert.ok(stepNote.includes("Inventory feed URL"));
});

// 5) Flag gate (this eval runs without the flag set — the loop must read as OFF).
ok("intake email loop is OFF unless DEALER_INTAKE_EMAIL_ENABLED=1", () => {
  const prev = process.env.DEALER_INTAKE_EMAIL_ENABLED;
  delete process.env.DEALER_INTAKE_EMAIL_ENABLED;
  assert.equal(isDealerIntakeEmailEnabled(), false);
  process.env.DEALER_INTAKE_EMAIL_ENABLED = "1";
  assert.equal(isDealerIntakeEmailEnabled(), true);
  if (prev === undefined) delete process.env.DEALER_INTAKE_EMAIL_ENABLED;
  else process.env.DEALER_INTAKE_EMAIL_ENABLED = prev;
});

// 6) Reply matching.
const invites = [
  { id: "a", threadId: "t-1", to: "sam@dealer.com", processedMessageIds: ["m-old"] },
  { id: "b", threadId: "t-2", to: "jane@other.com", processedMessageIds: [] }
];
ok("threadId match wins", () => {
  assert.equal(matchReplyToInvite(invites, { id: "m-1", threadId: "t-2", from: "Sam <sam@dealer.com>" }), "b");
});
ok("sender-address fallback matches when the dealer starts a new thread", () => {
  assert.equal(matchReplyToInvite(invites, { id: "m-2", threadId: "t-999", from: "Sam Rider <SAM@dealer.com>" }), "a");
});
ok("already-processed message never re-ingests", () => {
  assert.equal(matchReplyToInvite(invites, { id: "m-old", threadId: "t-1", from: "sam@dealer.com" }), null);
});
ok("unrelated mail matches nothing", () => {
  assert.equal(matchReplyToInvite(invites, { id: "m-3", threadId: "t-999", from: "spam@example.com" }), null);
});

// Invite content sanity: the email itself must carry the no-secrets + EIN warnings.
ok("invite email warns about secrets and keeps the EIN out", () => {
  const { subject, bodyText } = buildIntakeInviteEmail({ dealerName: "Demo Dealer", primaryContact: "Sam Rider, GM" });
  assert.ok(subject.includes("Demo Dealer"));
  assert.match(bodyText, /don't put passwords, API keys, or card numbers/i);
  assert.match(bodyText, /NOT through\s+the form or email/i);
});
ok("invite email carries the form link when one is minted", () => {
  const { bodyText } = buildIntakeInviteEmail(
    { dealerName: "Demo Dealer", primaryContact: "Sam Rider, GM" },
    "https://api.leadrider.ai/public/dealer-intake/abc123"
  );
  assert.ok(bodyText.includes("https://api.leadrider.ai/public/dealer-intake/abc123"));
  assert.match(bodyText, /prefer email\? just reply/i);
});

// --- Branded public intake form (deterministic labeled-field mapping) ---
ok("form page carries the no-secrets warning and has NO EIN field", () => {
  const html = renderIntakeFormHtml({ dealerName: "Demo Dealer" });
  assert.match(html, /do NOT enter passwords, API keys, card numbers, or your EIN/i);
  assert.ok(!/name="ein/i.test(html), "the form must not collect an EIN");
  assert.ok(html.includes("LeadRider"));
});
ok("form page escapes a hostile dealer name", () => {
  const html = renderIntakeFormHtml({ dealerName: '<script>alert(1)</script>' });
  assert.ok(!html.includes("<script>alert"), "dealer name must be HTML-escaped");
});
ok("form submission maps labeled fields deterministically", () => {
  const a = parseIntakeFormSubmission({
    legalName: " Demo Powersports LLC ",
    salesHours: "9-6 weekdays, Sat till 3, closed Sunday",
    salespeople: "Sam Rider - 555-201-3344\nTina Vasquez — 406-555-8181",
    leadSources: "website\ncycletrader",
    neverSay: "never promise OTD"
  });
  assert.equal(a.legalName, "Demo Powersports LLC");
  assert.equal(a.salesHours, "9-6 weekdays, Sat till 3, closed Sunday");
  assert.deepEqual(a.salespeople[0], { name: "Sam Rider", cell: "555-201-3344" });
  assert.deepEqual(a.salespeople[1], { name: "Tina Vasquez", cell: "406-555-8181" });
  assert.deepEqual(a.leadSources, ["website", "cycletrader"]);
  assert.deepEqual(a.neverSay, ["never promise OTD"]);
});
ok("form submission reports blank labeled fields as unanswered", () => {
  const a = parseIntakeFormSubmission({ legalName: "X LLC" });
  assert.ok(a.unansweredQuestions.length > 5, "blank fields must be reported");
  assert.ok(a.unansweredQuestions.some(q => /inventory feed/i.test(q)));
  assert.ok(!a.unansweredQuestions.some(q => /DBA/i.test(q)), "DBA is optional, not a blank");
});
ok("form submission scrubs a leaked EIN and flags it", () => {
  const a = parseIntakeFormSubmission({ extraNotes: "our EIN is 16-1234567 btw" });
  assert.ok(!JSON.stringify(a).includes("16-1234567"), "EIN value must never survive");
  assert.ok(a.sensitiveDataWarning.length > 0, "leak must be flagged");
});
ok("form submission keeps a normal phone number intact", () => {
  const a = parseIntakeFormSubmission({ mainPhone: "716-692-7200" });
  assert.equal(a.mainPhone, "716-692-7200");
  assert.equal(a.sensitiveDataWarning, "");
});

console.log(`dealer_intake_mail:eval PASS (${passed} checks)`);
