/**
 * reviewer_reintroduction_guard:eval
 *
 * Charter **C1.2a** — "Once the customer has received ANY message from us on the thread, never
 * introduce again" — enforced as a deterministic POST-CHECK on the Claude draft-review lane's
 * FREE-COMPOSED rewrite, in BOTH channels.
 *
 * WHY THIS EXISTS. C1.2a is enforced at the template builders (`buildDealerRideIdentitySentence`).
 * A `rewrite` verdict has no builder — it composes the whole reply — and the lane never re-reads
 * its own output (the loop-stop guard is deliberate and correct). It re-introduced anyway, WITH
 * C1.2a in the prompt in front of it, which is why the fix is a check on the OUTPUT rather than
 * another instruction.
 *
 * ⭐ EVERY REWRITE FIXTURE BELOW IS A VERBATIM LIVE BODY, copied out of the americanharley store on
 * 2026-08-21 — 4 of the 18 standing reviewer-authored drafts on threads that had already received a
 * delivered outbound. Invented wordings would have passed against any pattern I happened to write;
 * these are the shapes the model actually produced ("it's Stone at American Harley!" shortens the
 * dealer name; "it's Alexandra AGAIN at …" puts a word between the name and the anchor; Emaud's
 * greeting sits on its own line above the intro).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  enforceNoReintroduction,
  stripReintroductionOpener,
  hasCustomerReceivedOutbound
} from "../services/api/src/domain/agentVoice.js";

const DEALER = "American Harley-Davidson";

/** A thread the customer has actually heard from us on. */
const HEARD_FROM_US = [
  { direction: "in", provider: "twilio" },
  { direction: "out", provider: "twilio" }
];
/** A genuine first touch: a never-approved draft reached nobody. */
const FIRST_TOUCH = [
  { direction: "in", provider: "twilio" },
  { direction: "out", provider: "draft_ai" }
];

// --- 1. The four live specimens ---------------------------------------------------------------
// Each: the verbatim rewrite, and what the customer must NOT see / must still see.
const LIVE: Array<{ lead: string; body: string; gone: string; keeps: string[] }> = [
  {
    lead: "+17167995566 (SMS, 2026-08-18)",
    body:
      "Hey Heather, it's Stone at American Harley! Just following up — have you and your husband had " +
      "a chance to swing by yet? I'd love to walk you both through some great beginner-friendly bikes. " +
      "What weekend works best for you?",
    gone: "it's Stone at American Harley",
    keeps: ["Hey Heather", "Just following up", "beginner-friendly bikes", "What weekend works best for you?"]
  },
  {
    lead: "+13155211619 (email)",
    body:
      "Hey Savannah, it's Alexandra again at American Harley-Davidson — congrats once more on passing " +
      "the course! 🎉\n\nSo glad to hear you're thinking about a future purchase. What kind of riding are " +
      "you picturing yourself doing?",
    gone: "it's Alexandra again at",
    keeps: ["Hey Savannah", "congrats once more on passing the course", "What kind of riding"]
  },
  {
    lead: "+17165350779 (email)",
    body:
      "Hey Bryan, it's Scott over at American Harley-Davidson. Totally understand — forced Saturday " +
      "shifts are the worst, sorry about that!\n\nOur weekday hours are M–F 9am–6pm, so we can definitely " +
      "work with your 5–6pm window.",
    gone: "it's Scott over at",
    keeps: ["Hey Bryan", "Totally understand", "M–F 9am–6pm", "5–6pm window"]
  },
  {
    lead: "+14027703000 (email, greeting on its own line)",
    body:
      "Hi Emaud,\n\nIt's Alexandra over at American Harley-Davidson — thanks for submitting your credit " +
      "application! Our finance team will be reaching out shortly to walk you through your options and " +
      "next steps.\n\nIn the meantime, I'd love to know — is there a specific bike you're looking at?",
    gone: "Alexandra over at",
    keeps: ["Hi Emaud", "credit application", "finance team will be reaching out", "specific bike"]
  }
];

for (const spec of LIVE) {
  const guarded = enforceNoReintroduction({ body: spec.body, dealerName: DEALER, messages: HEARD_FROM_US });
  assert.ok(
    !guarded.includes(spec.gone),
    `${spec.lead}: the re-introduction must be gone — still reads: ${guarded.slice(0, 120)}`
  );
  // C1.2a's own words: "no 'Hey there, it's {name} over at {dealer}'" — no dealer-name intro at all.
  assert.ok(
    !/^\s*(?:hey|hi|hello)[^\n]{0,40}?(?:it[’']s|this is)\s+[^.!?\n]{0,60}?\s+(?:over\s+at|at|from)\s+American/i.test(
      guarded
    ),
    `${spec.lead}: no self-introduction may survive in the opener — ${guarded.slice(0, 120)}`
  );
  for (const keep of spec.keeps) {
    assert.ok(
      guarded.includes(keep),
      `${spec.lead}: the guard must delete ONLY the introduction — lost "${keep}"`
    );
  }
  // The greeting survives: stripping the intro must never strip the customer's name too.
  assert.ok(/^(?:hey|hi)\b/i.test(guarded), `${spec.lead}: the greeting must survive — ${guarded.slice(0, 60)}`);
  // No stranded punctuation where the clause used to be.
  assert.ok(!/[,—–.!]\s*[,—–]/.test(guarded.slice(0, 60)), `${spec.lead}: doubled punctuation — ${guarded.slice(0, 60)}`);
  // Emails keep their paragraph layout (a greeting line stays a greeting line).
  if (spec.body.startsWith("Hi Emaud,\n\n")) {
    assert.ok(guarded.startsWith("Hi Emaud,\n\nThanks for submitting"), `greeting line lost: ${guarded.slice(0, 40)}`);
  }
}

// --- 2. The gate: a genuine FIRST touch keeps its intro (charter C1.2) -------------------------
// C1.2 says the full self-intro is INTENDED on a first touch — "keep it; don't dedupe it away".
// This is the fail-direction that matters: over-stripping would silently un-introduce the agent.
for (const spec of LIVE) {
  assert.equal(
    enforceNoReintroduction({ body: spec.body, dealerName: DEALER, messages: FIRST_TOUCH }),
    spec.body,
    `first touch must be byte-identical (C1.2) — ${spec.lead}`
  );
}
assert.equal(hasCustomerReceivedOutbound(FIRST_TOUCH), false, "a never-approved draft reached nobody");
assert.equal(hasCustomerReceivedOutbound(HEARD_FROM_US), true, "a delivered twilio outbound was received");
assert.equal(
  enforceNoReintroduction({ body: LIVE[0]!.body, dealerName: DEALER, messages: [] }),
  LIVE[0]!.body,
  "an empty thread is a first touch"
);

// --- 3. What the guard must NOT touch ----------------------------------------------------------
const UNTOUCHED = [
  // Third-person mention of a colleague mid-reply — not a self-introduction.
  "Hey Rick, Scott in service will call you at American Harley-Davidson tomorrow with the quote.",
  // Ordinary reply that happens to open with "this is".
  "Hey Tom, this is the part number you asked about: 54000123. It ships Tuesday.",
  // A self-introduction naming a DIFFERENT business is not ours to rewrite.
  "Hey Dana, it's Alexandra at Some Other Powersports. Following up on your trade.",
  // Mid-body identity line is out of scope: this guard owns the OPENER only.
  "Thanks for the photos! It's Alexandra over at American Harley-Davidson, by the way."
];
for (const body of UNTOUCHED) {
  assert.equal(
    enforceNoReintroduction({ body, dealerName: DEALER, messages: HEARD_FROM_US }),
    body,
    `must be left alone: ${body.slice(0, 50)}`
  );
}
// Never delete a reply outright: an intro with nothing after it stays as it is.
const INTRO_ONLY = "Hey Heather, it's Stone at American Harley!";
assert.equal(
  enforceNoReintroduction({ body: INTRO_ONLY, dealerName: DEALER, messages: HEARD_FROM_US }),
  INTRO_ONLY,
  "a body that is nothing but an introduction is kept — deleting a reply is worse"
);
// No dealer name to anchor on ⇒ no strip (portability: the anchor is the profile, never a literal).
assert.equal(
  stripReintroductionOpener(LIVE[0]!.body, ""),
  LIVE[0]!.body,
  "without a dealer name the guard is a no-op"
);
// A different dealer's profile still works — the anchors are DERIVED, not hardcoded.
const OTHER = "Hey Dana, it's Marco at Lakeshore Powersports Group. Your deposit is in.";
assert.ok(
  !enforceNoReintroduction({ body: OTHER, dealerName: "Lakeshore Powersports Group", messages: HEARD_FROM_US })
    .includes("it's Marco at"),
  "the guard is dealer-agnostic"
);

// --- 4. WIRING: both lanes of the review pass must route the rewrite through the guard ----------
// Trap 2: a source-shape check cannot prove wiring on its own, so assert an EXPECTED COUNT of the
// exact call shape, plus that the stored email hash is taken from the GUARDED body (hashing the
// unguarded one would leave our own rewrite unstamped and re-reviewed once a minute, forever).
const REVIEW_SRC = readFileSync(
  new URL("../services/api/src/domain/claudeDraftReview.ts", import.meta.url),
  "utf8"
);
const CALL = "enforceNoReintroduction({ body: verdict.fixedDraft, dealerName, messages: conv.messages })";
assert.equal(
  REVIEW_SRC.split(CALL).length - 1,
  2,
  "the C1.2a guard must be applied in BOTH the SMS and the EMAIL rewrite path — expected exactly 2 call sites"
);
assert.ok(
  REVIEW_SRC.includes("saveOperatorDraft(conv, {\n        body: fixedBody,\n        channel: \"sms\""),
  "the SMS lane must SAVE the guarded body, not the raw rewrite"
);
assert.ok(
  REVIEW_SRC.includes("saveOperatorDraft(conv, {\n        body: fixedBody,\n        channel: \"email\""),
  "the email lane must SAVE the guarded body, not the raw rewrite"
);
assert.ok(
  REVIEW_SRC.includes("storedHash = emailDraftReviewHash(fixedBody)"),
  "the email receipt must hash what is STORED (the guarded body) or the lane re-reviews itself forever"
);

console.log("reviewer_reintroduction_guard:eval PASS");
