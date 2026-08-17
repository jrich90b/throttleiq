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
  buildMissingInfoFollowUpEmail,
  DEALER_INTAKE_ANSWERS_JSON_SCHEMA,
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
    taxRate: "",
    creditAppUrl: "",
    offersUrl: "",
    crmLoginWillingness: "",
    websiteProvider: "",
    websiteProviderEmail: "",
    dnsManager: "",
    emailHostProvider: "",
    googleBusinessProfile: "",
    socialMedia: [],
    consoleUsers: [],
    outboundEmailIdentity: "",
    calendarGoogleAccount: "",
    privacyPolicyUrl: "",
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

// --- Provider / Google / social intake (Joe 8/16: the Room 58 + Rackspace lesson) ---
ok("form collects the website provider email with the CC'd-provider explanation", () => {
  const html = renderIntakeFormHtml({ dealerName: "Demo Dealer" });
  assert.ok(html.includes('name="websiteProviderEmail"'));
  assert.match(html, /with you CC(?:&#039;|')d/i);
  assert.match(html, /SMS consent wording/i);
  assert.ok(html.includes('name="googleBusinessProfile"'));
  assert.ok(html.includes('name="socialMedia"'));
  assert.ok(html.includes('name="emailHostProvider"'));
});
ok("provider answers land in notes with their labels", () => {
  const block = buildIntakeNotesBlock(
    answers({
      websiteProvider: "Room 58",
      websiteProviderEmail: "support@room58.example",
      emailHostProvider: "Rackspace",
      googleBusinessProfile: "maps.google.com/demo-dealer",
      socialMedia: ["Facebook: Demo Dealer", "Instagram: @demodealer"]
    })
  );
  assert.match(block, /^Website provider: Room 58$/m);
  assert.match(block, /^Website provider email: support@room58\.example$/m);
  assert.match(block, /^Email host: Rackspace$/m);
  assert.match(block, /^Google Business Profile: maps\.google\.com\/demo-dealer$/m);
  assert.match(block, /^Social: Facebook: Demo Dealer; Instagram: @demodealer$/m);
});
ok("provider email counts as owed when blank; DNS/GBP/social do not", () => {
  const a = parseIntakeFormSubmission({ legalName: "X LLC" });
  assert.ok(a.unansweredQuestions.some(q => /contact email for your website provider/i.test(q)));
  assert.ok(!a.unansweredQuestions.some(q => /domain \/ DNS/i.test(q)));
  assert.ok(!a.unansweredQuestions.some(q => /Google Business Profile/i.test(q)));
  assert.ok(!a.unansweredQuestions.some(q => /social media/i.test(q)));
});

// --- Launch-completeness fields (Joe 8/16: console logins, outbound email, calendar, privacy) ---
ok("form collects console users, outbound email, calendar account, privacy policy", () => {
  const html = renderIntakeFormHtml({ dealerName: "Demo Dealer" });
  for (const f of ["consoleUsers", "outboundEmailIdentity", "calendarGoogleAccount", "privacyPolicyUrl"]) {
    assert.ok(html.includes(`name="${f}"`), `form must collect ${f}`);
  }
  assert.match(html, /never the password/i);
});
ok("launch-completeness answers land in notes; privacy policy blank does not nag", () => {
  const block = buildIntakeNotesBlock(
    answers({
      consoleUsers: ["Sam Rider - sam@demo.example", "Earl Rider - earl@demo.example"],
      outboundEmailIdentity: "sales@demo.example",
      calendarGoogleAccount: "calendar@demo.example (Sam clicks Allow)"
    })
  );
  assert.match(block, /^Console users: Sam Rider - sam@demo\.example; Earl Rider - earl@demo\.example$/m);
  assert.match(block, /^Outbound email: sales@demo\.example$/m);
  assert.match(block, /^Calendar Google account: calendar@demo\.example \(Sam clicks Allow\)$/m);
  const a = parseIntakeFormSubmission({ legalName: "X LLC" });
  assert.ok(a.unansweredQuestions.some(q => /console login/i.test(q)), "console users blank must be owed");
  assert.ok(!a.unansweredQuestions.some(q => /privacy policy/i.test(q)), "privacy policy blank is normal, not owed");
});

// --- Phase 2.5: audit fields, follow-up chase, dedupe, coverage guard (Joe 8/17) ---
ok("audit fields collected: tax rate, credit app, promotions, CRM login willingness", () => {
  const html = renderIntakeFormHtml({ dealerName: "Demo Dealer" });
  for (const f of ["taxRate", "creditAppUrl", "offersUrl", "crmLoginWillingness"]) {
    assert.ok(html.includes(`name="${f}"`), `form must collect ${f}`);
  }
  assert.match(html, /NEVER this form/i);
  const block = buildIntakeNotesBlock(answers({ taxRate: "8.75%", crmLoginWillingness: "yes" }));
  assert.match(block, /^Tax rate: 8\.75%$/m);
  assert.match(block, /^CRM login: yes$/m);
});
ok("tax rate + CRM login count as owed when blank; credit app + promotions do not", () => {
  const a = parseIntakeFormSubmission({ legalName: "X LLC" });
  assert.ok(a.unansweredQuestions.some(q => /tax rate/i.test(q)));
  assert.ok(a.unansweredQuestions.some(q => /CRM login/i.test(q)));
  assert.ok(!a.unansweredQuestions.some(q => /credit application/i.test(q)));
  assert.ok(!a.unansweredQuestions.some(q => /promotions/i.test(q)));
});
ok("missing-info follow-up lists each owed item with its why + form link + no-secrets line", () => {
  const { subject, bodyText } = buildMissingInfoFollowUpEmail(
    { dealerName: "Demo Dealer", primaryContact: "Sam Rider" },
    ["Sales tax rate on vehicle purchases", "Inventory feed or export URL"],
    "https://api.leadrider.ai/public/dealer-intake/tok123"
  );
  assert.match(subject, /still needed/i);
  assert.match(bodyText, /Sales tax rate on vehicle purchases/);
  assert.match(bodyText, /payment estimates come out right/i);
  assert.ok(bodyText.includes("https://api.leadrider.ai/public/dealer-intake/tok123"));
  assert.match(bodyText, /no passwords, API keys, card numbers, or your EIN/i);
});
ok("re-ingest REPLACES the machine-owned intake section; human notes survive", () => {
  const first = applyIntakeAnswersToSetup({ notes: "Joe's manual note about pricing" } as any, answers({ salesHours: "9-6" }), "intake A");
  const second = applyIntakeAnswersToSetup({ notes: first.patch.notes } as any, answers({ salesHours: "9-6, Sat 9-3" }), "intake B");
  assert.ok(second.patch.notes.includes("Joe's manual note about pricing"), "human note must survive");
  assert.equal((second.patch.notes.match(/\[intake /g) ?? []).length, 1, "only ONE intake section may remain");
  assert.ok(second.patch.notes.includes("9-6, Sat 9-3"));
});
ok("salesperson without a cell renders without empty parentheses", () => {
  const block = buildIntakeNotesBlock(answers({ salespeople: [{ name: "Chuck New", cell: "" }] }));
  assert.match(block, /^Salespeople: Chuck New$/m);
  assert.ok(!block.includes("()"));
});
ok("coverage guard: form fields and parser schema stay in lockstep", () => {
  const schemaKeys = new Set(Object.keys((DEALER_INTAKE_ANSWERS_JSON_SCHEMA as any).properties));
  const META = new Set(["unansweredQuestions", "sensitiveDataWarning"]);
  const html = renderIntakeFormHtml({ dealerName: "X" });
  for (const key of schemaKeys) {
    if (META.has(key)) continue;
    assert.ok(html.includes(`name="${key}"`), `schema field ${key} has no form input — add it to FORM_FIELDS or META`);
  }
});

console.log(`dealer_intake_mail:eval PASS (${passed} checks)`);
