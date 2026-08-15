/**
 * The conversation has to SAY when a lead opted out (Joe, 2026-08-15, +15307211080).
 *
 * WHAT HAPPENED. Rick McDuffie replied STOP at 12:20:56.761Z. Everything that sends did exactly the
 * right thing: the cadence stopped with `stopReason: "opt_out"` and the phone was written to
 * `suppressions.json` at 12:21:01.690Z — five milliseconds later. Joe was sitting on that
 * CONVERSATION three and a half minutes after that and filed: "Customer said stop but I don't see
 * the lead going to the suppressed list." He was right about what he could see. The conversation
 * view rendered nothing at all about the opt-out, and the suppression list is a separate section
 * whose data is fetched once when the page loads — a console tab open since the morning still
 * listed 27 numbers instead of 28.
 *
 * So the compliance machinery was correct and the console could not corroborate it. That gap is the
 * defect: a manager who cannot see an opt-out honoured has to assume it was missed.
 *
 * WHAT THIS PINS. `resolveOptOutForDisplay` is the whole decision, and it is pure — the caller hands
 * it the suppression-list answer (that list lives outside the conversation record) and it reads the
 * rest off the thread. This eval EXECUTES it; it does not assert on its source text.
 *
 * FAIL DIRECTION, pinned below: toward showing the badge. Displaying an opt-out we did not act on
 * raises a question a human answers in seconds. Acting on one we never display is the silence Joe
 * just reported, and it costs the dealer's confidence in every STOP that follows.
 *
 * NOTE ON `cadence_stop`: it is not redundant with the suppression list. That list is keyed by
 * PHONE, so an email-only lead that opts out is stopped without ever appearing on it. The two
 * sources cover different leads and the badge says which one spoke.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  resolveConversationDetailDisplay,
  resolveOptOutForDisplay
} from "../services/api/src/domain/conversationStore";

function convWith(patch: any): any {
  return { id: "+15555550100", leadKey: "+15555550100", messages: [], ...patch };
}

// 1. Rick's real shape: on the suppression list. The badge names the list, because that is the
//    record that actually blocks a send.
{
  const got = resolveOptOutForDisplay(
    convWith({ followUpCadence: { status: "stopped", stopReason: "opt_out" } }),
    { suppressed: true }
  );
  assert.equal(got?.optedOut, true, "a suppressed lead must show as opted out");
  assert.equal(got?.source, "suppression_list", "the suppression list outranks the cadence as the reason");
}

// 2. The list has not caught up (or the lead has no phone row at all) but the cadence stopped for an
//    opt-out. Still shows — this is the fail-direction case, and it is the one that covers
//    email-only leads, which can never appear on a phone-keyed list.
{
  const got = resolveOptOutForDisplay(
    convWith({ followUpCadence: { status: "stopped", stopReason: "opt_out" } }),
    { suppressed: false }
  );
  assert.equal(got?.optedOut, true, "a cadence stopped for opt_out must show even with no suppression row");
  assert.equal(got?.source, "cadence_stop");
}

// 3. A thread closed for an opt-out counts too — closing is the other way the same fact is recorded.
{
  const got = resolveOptOutForDisplay(convWith({ status: "closed", closedReason: "opt_out" }), {
    suppressed: false
  });
  assert.equal(got?.optedOut, true, "closedReason opt_out must show as opted out");
}

// 4. THE PRECISION SIDE. An ordinary live lead shows nothing. A badge on every thread would be
//    worth less than no badge — staff would stop reading it, which is how the real one gets missed.
{
  assert.equal(
    resolveOptOutForDisplay(convWith({ followUpCadence: { status: "active" } }), { suppressed: false }),
    null,
    "an active lead must not show an opt-out badge"
  );
  assert.equal(
    resolveOptOutForDisplay(convWith({}), {}),
    null,
    "no suppression answer and no stop reason means no badge"
  );
  assert.equal(resolveOptOutForDisplay(null, { suppressed: false }), null, "a missing conv is not an opt-out");
}

// 5. A cadence stopped for some OTHER reason is not an opt-out. `stopped` alone means many things
//    (sold, closed out, handed to a human); only the opt_out reason is a compliance fact.
{
  for (const reason of ["sold", "manual_handoff", "closed", "suppressed", null]) {
    assert.equal(
      resolveOptOutForDisplay(convWith({ followUpCadence: { status: "stopped", stopReason: reason } }), {
        suppressed: false
      }),
      null,
      `stopReason ${String(reason)} is not an opt-out`
    );
  }
}

// 6. WIRING. `/conversations/:id` asks the one referee, so the badge cannot drift away from the
//    email-draft and follow-up-hold answers that already live there. Executed, not source-matched:
//    the referee itself must carry the opt-out through with the suppression answer it was given.
{
  const suppressed = resolveConversationDetailDisplay(
    convWith({ followUpCadence: { status: "stopped", stopReason: "opt_out" } }),
    { suppressed: true }
  );
  assert.equal(suppressed.optOut?.optedOut, true, "the detail referee must carry the opt-out");
  assert.equal(suppressed.optOut?.source, "suppression_list");

  const live = resolveConversationDetailDisplay(convWith({ followUpCadence: { status: "active" } }), {
    suppressed: false
  });
  assert.equal(live.optOut, null, "a live lead's detail payload carries no opt-out");

  // Back-compat: the referee still answers without the second argument (other callers pass one arg).
  const noOpts = resolveConversationDetailDisplay(convWith({}));
  assert.equal(noOpts.optOut, null);
}

// 7. THE ENDPOINT ACTUALLY PASSES THE SUPPRESSION ANSWER. A pure referee that nobody hands the list
//    to would return null forever and every assertion above would still pass — the exact shape of
//    trap 2 (a guard that cannot prove wiring). `.includes` rather than a regex: the source-pin
//    ratchet counts escaped parens in assert lines.
{
  const src = fs.readFileSync("services/api/src/index.ts", "utf8");
  assert.ok(
    src.includes("resolveConversationDetailDisplay(conv, { suppressed: isSuppressed(conv.leadKey) })"),
    "/conversations/:id must hand the referee the suppression-list answer"
  );
  assert.ok(
    src.includes("followUpHold, optOut }"),
    "/conversations/:id must return optOut on the conversation payload"
  );
  const web = fs.readFileSync("apps/web/src/app/page.tsx", "utf8");
  assert.ok(
    web.includes("selectedConv.optOut?.optedOut"),
    "the console conversation view must render the opt-out state it is now given"
  );
  assert.ok(
    web.includes("Opted out — do not text this lead."),
    "the badge must say plainly that this lead must not be texted"
  );
}

console.log("opt_out_display_eval: PASS");
