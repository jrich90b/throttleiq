/**
 * ADF email mirror eval (pure, no LLM).
 *
 * Pins the fix for the operator report on +15852503838 (Scott Raichel): "Email does not respond
 * correctly like the sms".
 *
 * THE BUG. `handleSendgridInbound` publishes the email draft EARLY, from the generic
 * `buildInitialEmailDraft` template. Roughly 800 lines further down, a stack of lane-specific ack
 * overrides replaces the SMS `draft` — Riding Academy enrollment, non-buyer survey, dealer-lead
 * survey, event-promo / marketing opt-in, GLA demo ride. Every one of those is a ruling Joe already
 * made, and none of them reached the email lane, because nothing carried the final body back. So one
 * conversation shipped two different answers on the same turn.
 *
 * MEASURED on the live store 2026-08-17 — Scott is a `Riding Academy - Enrolled` lead:
 *   SMS   (2026-08-11 00:54Z): "Thanks for signing up for the Riding Academy ... your seat isn't
 *                               showing as paid yet ..."
 *   EMAIL (still live today):  "I'm happy to help with pricing, options, and availability" plus an
 *                               `inventory_visit` booking link.
 *
 * Layers:
 *   1. Decision table — decideAdfEmailMirror mirrors ONLY when a lane ack genuinely replaced the SMS
 *      body, and every other arm keeps whatever is already published (fail-safe direction).
 *   2. Customer-visible outcome — the mirrored body, run through the real email layout pass, carries
 *      the course answer and drops the generic bike-shopper pitch. Asserts the OUTCOME, not wording.
 *   3. Wiring — the snapshot, the override block and the mirror call really are in that order in
 *      routes/sendgridInbound.ts, with one call site each. A referee nothing calls fixes nothing.
 *
 * Run: npx tsx scripts/adf_email_mirrors_final_ack_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { decideAdfEmailMirror } from "../services/api/src/domain/routeStateReducer.ts";
import { formatEmailLayout } from "../services/api/src/domain/tone.ts";

// The two real bodies from Scott's conversation, verbatim from the live store.
const GENERIC_SMS_DRAFT =
  "Thanks for your interest. I’m happy to help with pricing, options, and availability. " +
  "If you want to stop in to go over options, let me know what day works best.";
const RIDING_ACADEMY_ACK =
  "Hey Scott, it's Alexandra over at American Harley-Davidson. Thanks for signing up for the Riding " +
  "Academy — I'm your contact here for anything to do with the course. Our Riding Academy Manager " +
  "will be sending you your e-course link which just needs to be completed before the start of " +
  "class. One thing to flag: your seat isn't showing as paid yet, you can take care of that at the " +
  "dealership or over the phone.";

// --- 1) Decision table (pure). -------------------------------------------------------------------
// Only `mirror_final_draft` changes anything. The three keep arms are the fail direction: an email
// that is already live is never blanked, never re-published around a blocked draft guard, and never
// touched on a turn where no lane ack fired.
type Row = {
  id: string;
  emailPublished: boolean;
  before: string | null | undefined;
  final: string | null | undefined;
  kind: "mirror_final_draft" | "keep_published_email";
  reason: string;
};
const rows: Row[] = [
  {
    id: "riding_academy_ack_replaced_the_generic_body",
    emailPublished: true,
    before: GENERIC_SMS_DRAFT,
    final: RIDING_ACADEMY_ACK,
    kind: "mirror_final_draft",
    reason: "ack_override_replaced_draft"
  },
  {
    id: "no_lane_ack_fired_so_the_email_is_already_current",
    emailPublished: true,
    before: GENERIC_SMS_DRAFT,
    final: GENERIC_SMS_DRAFT,
    kind: "keep_published_email",
    reason: "no_ack_override"
  },
  {
    // Whitespace-only churn is not an override. Guards against a formatting pass re-publishing the
    // email on every ADF turn for no customer-visible reason.
    id: "whitespace_only_difference_is_not_an_override",
    emailPublished: true,
    before: `  ${GENERIC_SMS_DRAFT}  `,
    final: GENERIC_SMS_DRAFT,
    kind: "keep_published_email",
    reason: "no_ack_override"
  },
  {
    // The draft-guard invariant blocked publication and staff already hold a manual_handoff task.
    // Publishing here would route around that guard.
    id: "draft_guard_blocked_publication",
    emailPublished: false,
    before: GENERIC_SMS_DRAFT,
    final: RIDING_ACADEMY_ACK,
    kind: "keep_published_email",
    reason: "no_email_published"
  },
  {
    // Never trade a wrong-but-present email for an empty one.
    id: "blank_final_draft_never_blanks_a_live_email",
    emailPublished: true,
    before: GENERIC_SMS_DRAFT,
    final: "   ",
    kind: "keep_published_email",
    reason: "final_draft_blank"
  },
  {
    id: "null_final_draft_never_blanks_a_live_email",
    emailPublished: true,
    before: GENERIC_SMS_DRAFT,
    final: null,
    kind: "keep_published_email",
    reason: "final_draft_blank"
  },
  {
    // First-ever body on a turn that had no pre-override draft at all: still an override, still
    // mirrored — the email must not stay generic just because the snapshot was empty.
    id: "empty_snapshot_still_counts_as_an_override",
    emailPublished: true,
    before: null,
    final: RIDING_ACADEMY_ACK,
    kind: "mirror_final_draft",
    reason: "ack_override_replaced_draft"
  }
];

for (const row of rows) {
  const decision = decideAdfEmailMirror({
    emailPublished: row.emailPublished,
    draftBeforeAckOverrides: row.before,
    finalDraft: row.final
  });
  assert.equal(decision.kind, row.kind, `${row.id}: wrong decision kind`);
  assert.equal(decision.reason, row.reason, `${row.id}: wrong reason`);
  if (decision.kind === "mirror_final_draft") {
    assert.equal(
      decision.body,
      String(row.final ?? "").trim(),
      `${row.id}: mirrored body must be the final draft verbatim — the mirror never composes copy`
    );
  }
}

// --- 2) Customer-visible outcome. ----------------------------------------------------------------
// What staff would actually see in the Email tab after the mirror, through the REAL layout pass.
const mirrored = decideAdfEmailMirror({
  emailPublished: true,
  draftBeforeAckOverrides: GENERIC_SMS_DRAFT,
  finalDraft: RIDING_ACADEMY_ACK
});
assert.equal(mirrored.kind, "mirror_final_draft", "the Scott case must mirror");
const emailBody = formatEmailLayout(mirrored.kind === "mirror_final_draft" ? mirrored.body : "", {
  firstName: "Scott",
  fallbackName: "there"
});
const lower = emailBody.toLowerCase();
assert.ok(lower.includes("riding academy"), "mirrored email must name the Riding Academy");
assert.ok(lower.includes("e-course"), "mirrored email must keep the e-course instruction");
assert.ok(lower.includes("paid"), "mirrored email must keep the unpaid-seat flag — the one thing he needs");
assert.ok(
  !lower.includes("pricing, options, and availability"),
  "mirrored email must NOT keep the generic bike-shopper pitch"
);
// The layout pass must not double-greet a body that already addresses the customer by name.
assert.equal(
  (emailBody.match(/scott/gi) ?? []).length,
  1,
  "mirrored email greeted the customer twice — the layout pass stopped detecting the ack's own greeting"
);

// --- 3) Wiring. ----------------------------------------------------------------------------------
// A referee nothing calls fixes nothing, and the ORDER is the whole fix: the snapshot has to be taken
// before the lane acks and the mirror consulted after them. Index comparisons on the real file, not
// source-text assertions about wording.
const route = fs.readFileSync("services/api/src/routes/sendgridInbound.ts", "utf8");
const callSites = route.split("decideAdfEmailMirror(").length - 1;
assert.equal(callSites, 1, "expected exactly ONE decideAdfEmailMirror call site in the ADF route");

const snapshotAt = route.indexOf("const draftBeforeAdfAckOverrides = draft;");
const ridingAcademyAckAt = route.indexOf("if (academyAdfClaim.liveReplyKind) {");
const mirrorAt = route.indexOf("const adfEmailMirror = decideAdfEmailMirror({");
const smsQueueAt = route.lastIndexOf("queueInitialDraftForPreferredContact(draft, initialMediaUrls);");
for (const [name, at] of [
  ["snapshot", snapshotAt],
  ["riding academy ack", ridingAcademyAckAt],
  ["mirror", mirrorAt],
  ["sms queue", smsQueueAt]
] as const) {
  assert.ok(at > 0, `wiring: could not find the ${name} site in the ADF route`);
}
assert.ok(
  snapshotAt < ridingAcademyAckAt,
  "wiring: the snapshot must be taken BEFORE the lane acks, or it captures the override it is meant to detect"
);
assert.ok(
  ridingAcademyAckAt < mirrorAt,
  "wiring: the mirror must run AFTER the lane acks, or it can never see one"
);
assert.ok(
  mirrorAt < smsQueueAt,
  "wiring: the mirror must run before the SMS draft is queued, so both lanes ship the same turn's body"
);

// The publish result has to be captured, or `emailPublished` is a constant and the blocked-guard arm
// is dead code that always reads false.
assert.ok(
  route.includes("adfEmailPublished = publishAdfEmailDraft"),
  "wiring: the initial-ADF email publish must record its result into adfEmailPublished"
);
// The mirror must still run the body through the draft guard before it writes. It deliberately does
// NOT go through publishAdfEmailDraft — that wrapper files a manual_handoff task on refusal, and the
// SMS lane refuses the same body two statements later, so the wrapper would double-file the handoff.
const mirrorBlock = route.slice(mirrorAt, smsQueueAt);
assert.ok(
  mirrorBlock.includes("applyAdfReplyInvariant"),
  "wiring: the mirror must run the mirrored body through the draft-guard invariant before writing it"
);
assert.ok(
  mirrorBlock.includes("setEmailDraft(conv, mirrorInvariant.draftText)"),
  "wiring: the mirror must write the guarded body through the email layout pass"
);
assert.ok(
  !mirrorBlock.includes("publishAdfEmailDraft("),
  "wiring: the mirror must not CALL publishAdfEmailDraft — one refusal would file the handoff task twice"
);

console.log(`  PASS adf email mirror — ${rows.length} decision rows, outcome + wiring verified`);
