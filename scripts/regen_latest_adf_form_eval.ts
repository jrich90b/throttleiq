/**
 * regen_latest_adf_form:eval — a repeat-ADF first touch is answered from the form the customer is
 * IN, not the one they arrived on.
 *
 * THE MISS (measured 2026-08-18 on the live americanharley store). `updateLeadProfile`
 * (conversationStore) deliberately pins `conv.lead` to the FIRST lead form and files every later
 * form carrying a different `leadRef` under `conv.latestLead`. The regenerate path read `conv.lead`.
 * So Aidan Stewart (+15857041173), who moved Riding Academy Wait List -> Enrolled on 2026-08-15, had
 * a draft regenerated at 2026-08-17T21:50Z that told him *"you're on the wait list right now"*. It
 * only surfaced because the draft-quality gate held it. Maya Iversen (+15854782032) and Andrei
 * Kavalchuk (+15853170121) sit in the identical state. 84 threads store a second form; 4 are on this
 * lane; 3 of the 4 flip from a falsehood to the truth under the fix, and NOTHING else changes.
 *
 * The LIVE intake never had the bug — it decides from `effectiveInquiry`, the record it is answering,
 * and drafted "a seat opened up" for Aidan the same day. This is the live-vs-regenerate drift
 * CLAUDE.md forbids ("Parser-first in both paths. Live and regenerate must stay in sync").
 *
 * WHAT THIS PINS IS THE DECISION, NOT A LABEL: for each fixture it asserts the ack KIND the turn
 * resolves to (which is what the customer is told), by EXECUTING the resolver over realistic store
 * shapes. Deterministic — no LLM, no clock, no network. The comprehension here is not comprehension
 * at all: `Enrollment Status:` is a machine enum on a form nobody typed, which AGENTS.md classes as
 * structured extraction.
 */
import assert from "node:assert";
import fs from "node:fs";
import {
  resolveAdfFirstTouchAckKind,
  resolveLatestAdfLeadProfile,
  buildAdfFirstTouchAck
} from "../services/api/src/domain/ridingAcademy.js";

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks += 1;
};

const adfRow = (ref: string, status: string, at: string) => ({
  direction: "in",
  provider: "sendgrid_adf",
  providerMessageId: `adf_${ref}`,
  at,
  body: [
    "WEB LEAD (ADF)",
    `Source: Riding Academy - ${status}`,
    `Ref: ${ref}`,
    "Name: Test Student",
    "",
    "Inquiry:",
    `Enrollment Status: ${status}-Course: New Rider Course - eCourse + Range-Class Start Date: 8/22/2026`
  ].join("\n")
});

const profile = (ref: string, status: string) => ({
  leadRef: ref,
  source: `Riding Academy - ${status}`,
  inquiry: `Enrollment Status: ${status}-Course: New Rider Course - eCourse + Range-Class Start Date: 8/22/2026`
});

const resolve = (conv: {
  lead?: any;
  latestLead?: any;
  messages: any[];
  purchaseTimeframe?: string | null;
}) =>
  resolveAdfFirstTouchAckKind({
    provider: "sendgrid_adf",
    messages: conv.messages,
    eventPromoKind: "none",
    lead: conv.lead,
    latestLead: conv.latestLead,
    purchaseTimeframe: conv.purchaseTimeframe ?? null
  });

// ---------------------------------------------------------------------------
// 1. THE REPRODUCED MISS — Aidan's exact shape: form 1 Wait List, form 2 Enrolled.
// ---------------------------------------------------------------------------
const waitThenEnrolled = {
  lead: profile("11795", "Wait List"),
  latestLead: profile("11800", "Enrolled"),
  messages: [
    adfRow("11795", "Wait List", "2026-08-15T15:21:23.681Z"),
    adfRow("11800", "Enrolled", "2026-08-15T22:49:02.563Z")
  ]
};
const enrolledTurn = resolve(waitThenEnrolled);
ok(
  enrolledTurn.kind === "riding_academy_waitlist_to_enrolled_ack",
  `a wait-listed student who got a seat must be told the seat opened (got ${enrolledTurn.kind})`
);
ok(
  enrolledTurn.kind !== "riding_academy_waitlist_ack",
  "and must NEVER be told they are still on the wait list — the shipped defect"
);
const enrolledCopy = buildAdfFirstTouchAck(enrolledTurn.kind as any, {
  firstName: "Aidan",
  agentName: "Alexandra",
  dealerName: "American Harley-Davidson"
});
ok(
  !enrolledCopy.toLowerCase().includes("on the wait list"),
  "the composed reply must not assert a wait-list status the customer has left"
);
ok(
  enrolledTurn.inquiry.includes("Enrollment Status: Enrolled"),
  "the resolver must report the record it decided from, so the reply extras read the same form"
);

// ---------------------------------------------------------------------------
// 2. STILL WAIT-LISTED — one form only. Must be unchanged: they ARE on the list.
// ---------------------------------------------------------------------------
const waitOnly = {
  lead: profile("11795", "Wait List"),
  latestLead: undefined,
  messages: [adfRow("11795", "Wait List", "2026-08-15T15:21:23.681Z")]
};
ok(
  resolve(waitOnly).kind === "riding_academy_waitlist_ack",
  "a genuinely wait-listed student still gets the wait-list ack"
);

// ---------------------------------------------------------------------------
// 3. TWO FORMS, SAME STATUS (Mitchell +17165975331) — enrolled, no prior wait list.
// ---------------------------------------------------------------------------
const enrolledTwice = {
  lead: profile("11700", "Enrolled"),
  latestLead: profile("11701", "Enrolled"),
  messages: [
    adfRow("11700", "Enrolled", "2026-08-13T20:12:53.598Z"),
    adfRow("11701", "Enrolled", "2026-08-13T20:30:54.471Z")
  ]
};
ok(
  resolveAdfFirstTouchAckKind({
    provider: "sendgrid_adf",
    messages: enrolledTwice.messages,
    eventPromoKind: "none",
    lead: enrolledTwice.lead,
    latestLead: enrolledTwice.latestLead,
    purchaseTimeframe: null
    // A duplicate record is not news: the prior status is also "enrolled", so this stays the plain
    // enrollment ack and never claims a seat "opened up".
  }).kind === "riding_academy_enrollment_ack",
  "two Enrolled records in a row stay the plain enrollment ack"
);

// ---------------------------------------------------------------------------
// 4. FAIL DIRECTION — no later form, or no leadRef to tell two forms apart, is byte-identical
//    to the old behaviour. This is what keeps the change scoped to repeat-form threads.
// ---------------------------------------------------------------------------
ok(
  resolveLatestAdfLeadProfile(profile("11795", "Wait List"), undefined)?.source ===
    "Riding Academy - Wait List",
  "no latestLead ⇒ the primary lead, unchanged"
);
ok(
  resolveLatestAdfLeadProfile(profile("11795", "Wait List"), profile("11795", "Enrolled"))?.source ===
    "Riding Academy - Wait List",
  "same leadRef is the SAME form re-filed, not a newer one ⇒ the primary lead"
);
ok(
  resolveLatestAdfLeadProfile(profile("11795", "Wait List"), { leadRef: "", source: "x" } as any)
    ?.source === "Riding Academy - Wait List",
  "a latestLead with no leadRef cannot be proven newer ⇒ the primary lead"
);
ok(
  resolveLatestAdfLeadProfile(undefined, undefined) == null,
  "no profiles at all resolves to nothing rather than throwing"
);

// ---------------------------------------------------------------------------
// 5. A CUSTOMER SMS REPLY CLOSES THE LANE — unchanged, and the reason the fix cannot reach a
//    thread that is already a conversation.
// ---------------------------------------------------------------------------
ok(
  resolve({
    ...waitThenEnrolled,
    messages: [...waitThenEnrolled.messages, { direction: "in", provider: "twilio", body: "thanks!" }]
  }).kind === "none",
  "once the customer has texted back, this is no longer a first touch"
);

// ---------------------------------------------------------------------------
// 6. THE NON-BUYER SURVEY IS NOT DISTURBED. `purchaseTimeframe` stays the CALLER's read of
//    `conv.lead` on purpose: 12 repeat-form leads carry a different timeframe on their newer form,
//    six of them leaving "I am not interested in purchasing at this time", so folding it in would
//    silently suppress the survey ack on leads nobody measured. Measured 2026-08-18; do not fold it
//    in without measuring that class on its own.
// ---------------------------------------------------------------------------
const surveyish = {
  lead: { leadRef: "900", source: "Dealer Lead App", inquiry: "looking around" },
  latestLead: { leadRef: "901", source: "Dealer Lead App", inquiry: "still looking" },
  messages: [
    { direction: "in", provider: "sendgrid_adf", providerMessageId: "adf_900", body: "WEB LEAD (ADF)\nRef: 900" },
    { direction: "in", provider: "sendgrid_adf", providerMessageId: "adf_901", body: "WEB LEAD (ADF)\nRef: 901" }
  ]
};
ok(
  resolveAdfFirstTouchAckKind({
    provider: "sendgrid_adf",
    messages: surveyish.messages,
    eventPromoKind: "none",
    lead: surveyish.lead,
    latestLead: surveyish.latestLead,
    purchaseTimeframe: "I am not interested in purchasing at this time"
  }).kind === "non_buyer_survey_ack",
  "a non-buyer timeframe still reaches the survey ack on a repeat-form lead"
);
ok(
  resolveAdfFirstTouchAckKind({
    provider: "sendgrid_adf",
    messages: surveyish.messages,
    eventPromoKind: "none",
    lead: surveyish.lead,
    latestLead: surveyish.latestLead,
    purchaseTimeframe: "0-3 Months"
  }).kind === "none",
  "a buying timeframe on a non-academy repeat-form lead routes normally — no new reply class"
);

// ---------------------------------------------------------------------------
// 7. WIRING — the regen call site must hand over BOTH profiles and reuse the resolved inquiry.
//    Without this the resolver is correct and inert (the #723 class).
// ---------------------------------------------------------------------------
const index = fs.readFileSync("services/api/src/index.ts", "utf8");
const call = index.slice(
  index.indexOf("const regenAdfFirstTouch = resolveAdfFirstTouchAckKind({"),
  index.indexOf("const regenAdfFirstTouch = resolveAdfFirstTouchAckKind({") + 600
);
ok(call.includes("lead: conv.lead,"), "the regen call must pass the primary lead profile");
ok(call.includes("latestLead: conv.latestLead,"), "and the latest lead profile — the whole fix");
ok(
  !call.includes("leadSource: conv.lead?.source"),
  "and must no longer pre-pick the FIRST form's source"
);
ok(
  call.includes("resolveEnrollmentAckExtras(dealerProfile, regenAdfFirstTouch.inquiry)"),
  "the reply extras must read the SAME record the decision read, not conv.lead again"
);

console.log(`regen_latest_adf_form:eval OK (${checks} assertion(s))`);
