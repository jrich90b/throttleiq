/**
 * email_draft_thread_moved:eval — the email draft stops being offered once its thread moves past it.
 *
 * WHY THIS EXISTS. `conv.emailDraft` is a live, sendable artifact the console's Email tab renders
 * and staff send verbatim, and until 2026-08-18 it was the only such artifact in the product with
 * no time on it. Nothing could ask "was this written before or after what just happened?", and the
 * one thing that reviews it — `selectEmailDraftsForClaudeReview` — keys its receipt on the draft's
 * body HASH and skips a hash it has already stamped. So a draft reviewed `ok` and made wrong an
 * hour later was frozen `ok` for the life of the thread, still offered as sendable.
 *
 * Measured on the americanharley store 2026-08-17 21:00Z: of the email drafts fresh enough to still
 * carry a reviewer receipt, three had been overtaken by their own threads by up to SEVEN delivered
 * turns and were all still on offer.
 *
 * WHAT IS PINNED. Behaviour of two pure functions, executed — never source text:
 *   1. the write chokepoint stamps `emailDraftAt` (body and time cannot come apart);
 *   2. the display referee withholds with `thread_moved` once a real turn postdates the stamp;
 *   3. the three ways a row is NOT a turn — a pending `draft_ai` row, a stale one, an outbound
 *      stamped `delivered: false`;
 *   4. forward-only: rule 3 itself never withholds an unstamped draft on a guess;
 *   5. rule precedence — a closed thread still reads `thread_closed`;
 *   6. RULE 4 (added the same day, second pass) — the undated draft, and the line that bounds it.
 *
 * WHY RULE 4 EXISTS. Rule 3 shipped strictly forward-only, and measuring the live store hours later
 * showed what that cost: of 95 OPEN threads still offering a draft, exactly **2** carried the stamp
 * rule 3 needs. The other 93 were permanently immune, and every email-lane defect on record sits in
 * that 93 — including +17165104578, a 6/15 draft still inviting the customer to come see a unit we
 * had twice told him was gone. Rule 4 makes the guess rule 3 refused to make and bounds it by the
 * only fact that licenses it: an undated draft is trustworthy exactly while it is STILL THE UNSENT
 * FIRST TOUCH. Measured blast radius: 83 of the 93 stop being offered, 10 stay.
 *
 * The negative cases in section 7 carry the weight. "Contacted" is `shouldSurfaceUnsentFirstTouch`'s
 * own `REAL_OUTBOUND_CONTACT_PROVIDERS` test rather than a turn count — a pending `draft_ai` row and
 * a second inbound lead form are BOTH non-events, and a turn count would have withheld both. And a
 * DATED draft must never reach rule 4, or every mid-thread draft would be withheld the instant it
 * was composed.
 *
 * FIXTURE PROVENANCE. Every message shape below is copied from the live store rows of the three
 * leads that exposed this (+17164233848, +17163686137, +17166977040): the real timestamps, the real
 * providers, the real `draftStatus` values. Bodies are replaced with neutral text — the predicate
 * never reads a body beyond "is it non-empty", and the fixture must not carry customer words.
 *
 * The pending-draft case is the one that matters most and is the reason this eval exists in this
 * shape: the first draft of the predicate excluded rows by `draftStatus`, which reads a live UNSENT
 * `draft_ai` row (no `draftStatus` until it goes stale) as a delivered turn. That is the shape of
 * the ADF first touch on every new lead, so the rule would have fired store-wide. The live rows on
 * +17164233848 caught it.
 */
import assert from "node:assert/strict";
import {
  resolveEmailDraftForDisplay,
  emailDraftThreadMovedSinceComposed,
  emailDraftUndatedAfterContact,
  stampEmailDraft
} from "../services/api/src/domain/conversationStore.js";

type Row = {
  id: string;
  direction: "in" | "out";
  from: string;
  to: string;
  body: string;
  at: string;
  provider?: string;
  draftStatus?: "pending" | "stale";
  delivered?: boolean;
};

function conv(rows: Row[], extra: Record<string, unknown> = {}): any {
  return {
    id: "conv_email_draft_fixture",
    leadKey: "+15550000000",
    messages: rows,
    emailDraft: "Thanks for reaching out — happy to help with pricing, options, and availability.",
    ...extra
  };
}

/** Real rows from +17163686137 (Matthew): ADF 8/15, then eight delivered SMS turns on 8/17. */
const MATTHEW_ADF: Row = {
  id: "m1",
  direction: "in",
  from: "leads@example.com",
  to: "sales@example.com",
  body: "[lead form]",
  at: "2026-08-15T15:08:23.240Z",
  provider: "sendgrid_adf"
};
const MATTHEW_STALE_DRAFT: Row = {
  id: "m2",
  direction: "out",
  from: "dealership",
  to: "+15550000000",
  body: "[superseded draft]",
  at: "2026-08-15T15:08:29.341Z",
  provider: "draft_ai",
  draftStatus: "stale"
};
const MATTHEW_DELIVERED_LATER: Row = {
  id: "m3",
  direction: "out",
  from: "dealership",
  to: "+15550000000",
  body: "[delivered staff reply]",
  at: "2026-08-17T18:49:17.656Z",
  provider: "twilio"
};
const MATTHEW_INBOUND_LATER: Row = {
  id: "m4",
  direction: "in",
  from: "+15550000000",
  to: "dealership",
  body: "[customer reply]",
  at: "2026-08-17T19:29:48.448Z",
  provider: "twilio"
};

/** Real row from +17164233848: the NEWEST row on the thread is a live, unapproved draft. */
const DAVID_PENDING_DRAFT: Row = {
  id: "d1",
  direction: "out",
  from: "dealership",
  to: "+15550000000",
  body: "[pending draft awaiting approval]",
  at: "2026-08-17T21:50:20.371Z",
  provider: "draft_ai"
};

const COMPOSED_AT = "2026-08-15T15:08:29.000Z";

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}: ${(err as Error).message}`);
  }
}

// 1. The write chokepoint stamps the time. Body and time cannot come apart.
check("stampEmailDraft writes the body AND the composed time", () => {
  const c: any = {};
  const before = Date.now();
  stampEmailDraft(c, "Hi Matthew — your seat is still unpaid.");
  const stamped = Date.parse(String(c.emailDraftAt));
  assert.equal(c.emailDraft, "Hi Matthew — your seat is still unpaid.");
  assert.ok(Number.isFinite(stamped), "emailDraftAt must be a parseable ISO time");
  assert.ok(stamped >= before - 1000 && stamped <= Date.now() + 1000, "stamp must be now");
});

// 2. The measured defect: delivered turns land after the draft ⇒ withheld, with the reason.
check("a delivered staff turn after the draft withholds it as thread_moved", () => {
  const c = conv([MATTHEW_ADF, MATTHEW_STALE_DRAFT, MATTHEW_DELIVERED_LATER, MATTHEW_INBOUND_LATER], {
    emailDraftAt: COMPOSED_AT
  });
  assert.equal(emailDraftThreadMovedSinceComposed(c), true);
  const resolved = resolveEmailDraftForDisplay(c);
  assert.equal(resolved.emailDraft, null);
  assert.equal(resolved.suppressedReason, "thread_moved");
});

check("an inbound customer turn alone is enough", () => {
  const c = conv([MATTHEW_ADF, MATTHEW_INBOUND_LATER], { emailDraftAt: COMPOSED_AT });
  assert.equal(resolveEmailDraftForDisplay(c).suppressedReason, "thread_moved");
});

// 3. The three ways a row is NOT a turn. Each of these on its own must leave the draft on offer.
check("a PENDING draft row after the draft is not a turn - the ADF first-touch shape", () => {
  const c = conv([MATTHEW_ADF, DAVID_PENDING_DRAFT], { emailDraftAt: COMPOSED_AT });
  assert.equal(emailDraftThreadMovedSinceComposed(c), false);
  const resolved = resolveEmailDraftForDisplay(c);
  assert.equal(resolved.suppressedReason, null);
  assert.ok(String(resolved.emailDraft ?? "").length > 0, "draft must still be offered");
});

check("a STALE draft row after the draft is not a turn", () => {
  const stale: Row = { ...MATTHEW_STALE_DRAFT, id: "s1", at: "2026-08-17T19:06:40.238Z" };
  const c = conv([MATTHEW_ADF, stale], { emailDraftAt: COMPOSED_AT });
  assert.equal(emailDraftThreadMovedSinceComposed(c), false);
});

check("an outbound that never reached the customer is not a turn", () => {
  const undelivered: Row = { ...MATTHEW_DELIVERED_LATER, id: "u1", delivered: false };
  const c = conv([MATTHEW_ADF, undelivered], { emailDraftAt: COMPOSED_AT });
  assert.equal(emailDraftThreadMovedSinceComposed(c), false);
});

check("an empty-bodied row after the draft is not a turn", () => {
  const empty: Row = { ...MATTHEW_DELIVERED_LATER, id: "e1", body: "   " };
  const c = conv([MATTHEW_ADF, empty], { emailDraftAt: COMPOSED_AT });
  assert.equal(emailDraftThreadMovedSinceComposed(c), false);
});

// 4. Nothing newer than the draft ⇒ still offered. This is the healthy majority.
check("a draft composed after every turn is still offered", () => {
  const c = conv([MATTHEW_ADF, MATTHEW_DELIVERED_LATER, MATTHEW_INBOUND_LATER], {
    emailDraftAt: "2026-08-17T20:00:00.000Z"
  });
  assert.equal(emailDraftThreadMovedSinceComposed(c), false);
  assert.equal(resolveEmailDraftForDisplay(c).suppressedReason, null);
});

check("a turn at the exact composed time does not withhold", () => {
  const sameMs: Row = { ...MATTHEW_INBOUND_LATER, id: "x1", at: COMPOSED_AT };
  const c = conv([MATTHEW_ADF, sameMs], { emailDraftAt: COMPOSED_AT });
  assert.equal(emailDraftThreadMovedSinceComposed(c), false);
});

// 5. Rule 3 stays strictly forward-only — it never guesses about an undated draft. What happens to
//    that draft is rule 4's answer, pinned in section 7. Keeping the two predicates separate is
//    what makes rule 4 self-retiring: a draft written through `stampEmailDraft` is dated, so it is
//    answered by rule 3 and can never reach rule 4.
check("rule 3 never guesses about a pre-stamp draft", () => {
  const c = conv([MATTHEW_ADF, MATTHEW_DELIVERED_LATER, MATTHEW_INBOUND_LATER]);
  assert.equal((c as any).emailDraftAt, undefined);
  assert.equal(emailDraftThreadMovedSinceComposed(c), false);
});

check("an unparseable stamp reads as pre-stamp, not as stale", () => {
  const c = conv([MATTHEW_INBOUND_LATER], { emailDraftAt: "not-a-date" });
  assert.equal(emailDraftThreadMovedSinceComposed(c), false);
});

// 6. Precedence: the older, more specific rules still answer first.
check("a closed thread still reads thread_closed, not thread_moved", () => {
  const c = conv([MATTHEW_ADF, MATTHEW_INBOUND_LATER], {
    emailDraftAt: COMPOSED_AT,
    status: "closed",
    closedAt: "2026-08-17T20:00:00.000Z"
  });
  assert.equal(resolveEmailDraftForDisplay(c).suppressedReason, "thread_closed");
});

check("no draft at all is not a suppression", () => {
  const c = conv([MATTHEW_INBOUND_LATER], { emailDraft: "", emailDraftAt: COMPOSED_AT });
  assert.equal(resolveEmailDraftForDisplay(c).suppressedReason, null);
});

// 7. RULE 4 — the undated draft. Rule 3 protects 2 of the 95 open-thread drafts on the live store;
//    these cases pin what happens to the other 93. The line is "is this still the unsent FIRST
//    TOUCH?", tested exactly as `shouldSurfaceUnsentFirstTouch` tests it, so the drafts we keep
//    offering are the drafts we are still asking a human to send.
check("an undated draft on a thread we have already replied to is withheld", () => {
  const c = conv([MATTHEW_ADF, MATTHEW_DELIVERED_LATER, MATTHEW_INBOUND_LATER]);
  assert.equal((c as any).emailDraftAt, undefined);
  assert.equal(emailDraftUndatedAfterContact(c), true);
  const resolved = resolveEmailDraftForDisplay(c);
  assert.equal(resolved.emailDraft, null);
  assert.equal(resolved.suppressedReason, "undated_after_contact");
});

check("a placed CALL counts as contact — any channel, not just SMS", () => {
  const call: Row = { ...MATTHEW_DELIVERED_LATER, id: "v1", provider: "voice_call" };
  const c = conv([MATTHEW_ADF, call]);
  assert.equal(emailDraftUndatedAfterContact(c), true);
  assert.equal(resolveEmailDraftForDisplay(c).suppressedReason, "undated_after_contact");
});

check("an undated draft on a NEVER-contacted lead is still offered", () => {
  const c = conv([MATTHEW_ADF, MATTHEW_INBOUND_LATER]);
  assert.equal(emailDraftUndatedAfterContact(c), false);
  const resolved = resolveEmailDraftForDisplay(c);
  assert.equal(resolved.suppressedReason, null);
  assert.ok(String(resolved.emailDraft ?? "").length > 0, "the unsent first touch must survive");
});

check("a second inbound lead form is not contact — a turn count would get this wrong", () => {
  const secondAdf: Row = { ...MATTHEW_ADF, id: "m1b", at: "2026-08-15T15:26:00.000Z" };
  const c = conv([MATTHEW_ADF, secondAdf]);
  assert.equal(emailDraftUndatedAfterContact(c), false);
  assert.equal(resolveEmailDraftForDisplay(c).suppressedReason, null);
});

check("a pending draft_ai outbound is not contact — nobody sent it", () => {
  const c = conv([MATTHEW_ADF, DAVID_PENDING_DRAFT, MATTHEW_STALE_DRAFT]);
  assert.equal(emailDraftUndatedAfterContact(c), false);
  assert.equal(resolveEmailDraftForDisplay(c).suppressedReason, null);
});

// The self-retiring property, and the single most important negative: once a draft is DATED, rule 4
// must never see it — otherwise every freshly composed mid-thread draft would be withheld the
// instant it was written, on a thread that by definition has already been replied to.
check("a DATED draft composed after we replied is still offered — rule 4 cannot reach it", () => {
  const c = conv([MATTHEW_ADF, MATTHEW_DELIVERED_LATER, MATTHEW_INBOUND_LATER], {
    emailDraftAt: "2026-08-17T20:00:00.000Z"
  });
  assert.equal(emailDraftUndatedAfterContact(c), false);
  assert.equal(resolveEmailDraftForDisplay(c).suppressedReason, null);
});

check("a freshly stamped draft on a contacted thread is offered", () => {
  const c = conv([MATTHEW_ADF, MATTHEW_DELIVERED_LATER]);
  stampEmailDraft(c, "Hi Matthew — the seal kit ships 8/21.");
  assert.equal(emailDraftUndatedAfterContact(c), false);
  assert.equal(resolveEmailDraftForDisplay(c).suppressedReason, null);
});

check("precedence: a closed contacted thread still reads thread_closed", () => {
  const c = conv([MATTHEW_ADF, MATTHEW_DELIVERED_LATER], {
    status: "closed",
    closedAt: "2026-08-17T20:00:00.000Z"
  });
  assert.equal(resolveEmailDraftForDisplay(c).suppressedReason, "thread_closed");
});

if (failures) {
  console.error(`email_draft_thread_moved:eval FAILED (${failures} case(s))`);
  process.exit(1);
}
console.log("email_draft_thread_moved:eval OK (21 case(s))");
