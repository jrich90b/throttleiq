/**
 * The canonical agent intro is the SOFTENED form — "it's {agent} over at {dealer}" (buildAgentIntro,
 * domain/agentVoice.ts), live since 2026-06-15. **Joe ruling 2026-07-29: "I'd rather see over at."**
 *
 * That ruling came out of an audit of the 527 staff edits, where Joe and Scott were seen typing the
 * OLD "this is {agent} at {dealer}" form back in by hand. Verdict: those were reps typing fast on a
 * phone, not a style preference — so the softened form stands and the remaining old-form COPY should
 * migrate to it.
 *
 * Scoped by live evidence, not by grep count. Outbound since 2026-07-01: 123 messages already used
 * "over at" vs 55 on the old form — and of those 55, 21 were hand-typed by staff and 6 were call
 * transcripts (neither is our copy to migrate). The automated remainder concentrated in two places,
 * which this eval pins:
 *   1. the POST-SALE cadence (domain/postSaleCadence.ts) — the single biggest source, ~24 sends in
 *      July 2026 ("Hope you're enjoying the …" + the Custom Coverage reminder);
 *   2. the H-D META PROMO email (routes/sendgridInbound.ts).
 *
 * Other old-form sites are deliberately NOT swept: several are dead text, several name a SALESPERSON
 * or a finance rep rather than the agent persona ("this is {rep} in finance at {dealer}"), and one is
 * a DETECTOR that must keep matching the old wording. Sweeping them blind would churn ~30 sites and
 * cascade fixtures for traffic that isn't reaching customers.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "eval-no-live-key";

const { postSaleAccessoryOrEnjoyMessage } = await import(
  "../services/api/src/domain/postSaleCadence.ts"
);
const { buildAgentIntro } = await import("../services/api/src/domain/agentVoice.ts");

const DEALER = "American Harley-Davidson";

// ---- (1) post-sale cadence, both condition branches, carries the softened intro.
for (const isNewBike of [true, false]) {
  const msg = postSaleAccessoryOrEnjoyMessage({
    firstName: "Darwin",
    repName: "Scott",
    dealerName: DEALER,
    bikeModel: "Fat Boy",
    isNewBike
  });
  assert.ok(
    msg.startsWith(`Hey Darwin, it's Scott over at ${DEALER}.`),
    `post-sale (${isNewBike ? "new" : "pre-owned"}) opens with the softened intro — got: ${msg.slice(0, 70)}`
  );
  assert.ok(!/this is Scott at/i.test(msg), "the old 'this is {rep} at {dealer}' form is gone");
  // The re-intro must still name the dealer — a bare "{rep} at {dealer}" trips long_brand_repeat,
  // which is WHY this cadence re-introduces at all.
  assert.ok(msg.includes(DEALER), "post-sale still names the dealer (the reason it re-intros)");
}

// The condition-specific bodies are untouched — this was a wording change, not a behavior change.
const newBike = postSaleAccessoryOrEnjoyMessage({
  firstName: "Steven", repName: "Joe", dealerName: DEALER, bikeModel: "Road Glide", isNewBike: true
});
const usedBike = postSaleAccessoryOrEnjoyMessage({
  firstName: "Steven", repName: "Joe", dealerName: DEALER, bikeModel: "Road Glide", isNewBike: false
});
assert.match(newBike, /Custom Coverage/, "NEW bike keeps the Custom Coverage reminder");
assert.match(newBike, /full factory warranty/, "NEW bike keeps the factory-warranty line");
assert.ok(
  !/factory warranty/i.test(usedBike),
  "PRE-OWNED must still make NO factory-warranty claim (post-sale condition split)"
);
assert.match(usedBike, /Hope you're enjoying the Road Glide!/, "PRE-OWNED keeps the warm check-in");

// Name-collision guard still applies through buildAgentIntro (customer named like the rep).
assert.equal(
  postSaleAccessoryOrEnjoyMessage({
    firstName: "Scott", repName: "Scott", dealerName: DEALER, bikeModel: "Street Glide", isNewBike: false
  }).startsWith(buildAgentIntro("Scott", "Scott", DEALER)),
  true,
  "a customer sharing the rep's name routes through the existing collision guard, not a raw greeting"
);

// ---- (2) the H-D Meta promo EMAIL uses the composed standalone form, not "This is X at Y".
const sendgridSource = await fs.readFile(path.resolve("services/api/src/routes/sendgridInbound.ts"), "utf8");
const metaMarker = sendgridSource.indexOf('"Thanks for your H-D Meta promo offer request."');
assert.ok(metaMarker > 0, "found the Meta promo email body");
const metaBlock = sendgridSource.slice(metaMarker, metaMarker + 700);
assert.ok(
  metaBlock.includes("It's ${agentName} over at ${dealerName}."),
  "Meta promo email uses the composed standalone softened intro"
);
assert.ok(
  !metaBlock.includes("This is ${agentName} at ${dealerName}."),
  "Meta promo email no longer uses the old 'This is {agent} at {dealer}' line"
);

// ---- (3) the source of truth stays the source of truth.
const voiceSource = await fs.readFile(path.resolve("services/api/src/domain/agentVoice.ts"), "utf8");
assert.match(
  voiceSource,
  /return `it's \$\{agentName\} over at \$\{dealerName\}\. `;/,
  "buildAgentIntroPhrase remains the canonical softened wording"
);
const postSaleSource = await fs.readFile(path.resolve("services/api/src/domain/postSaleCadence.ts"), "utf8");
assert.match(
  postSaleSource,
  /buildAgentIntro\(firstName, repName, dealerName\)/,
  "post-sale composes the intro from the shared helper rather than re-templating it"
);

console.log("PASS intro 'over at' on the live surfaces — post-sale cadence + H-D Meta promo email");
