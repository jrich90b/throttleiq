/**
 * ADF FIRST-TOUCH: doubled greeting + the photo line's colour (2026-08-07).
 *
 * Both defects reached a customer in one message. Michael Hooker (+17165481952) built a **2026 Low
 * Rider S in Aurora Blue Denim** on Harley's build tool and sent us the link; the reply that went
 * out at 2026-08-07T11:54:22Z opened *"Hi Michael,\n\nHey Michael, it's Alexandra…"* and then said
 * *"Here's a photo of a 2026 Low Rider S in White Onyx Pearl Black Trim we have in stock."*
 *
 * Part 1 pins `formatEmailLayout` — the greeting detector now knows every opening the composer
 * writes, so it stops stacking a second one.
 * Part 2 pins `decideLeadPhotoLine` — the colour is read off the UNIT, never borrowed from the
 * lead, and a mismatch is stated rather than glossed.
 * Part 3 pins the WIRING, because tsc cannot prove the route still calls the decider.
 *
 * Run: npx tsx scripts/lead_photo_line_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { formatEmailLayout } = await import("../services/api/src/domain/tone.ts");
const { decideLeadPhotoLine } = await import("../services/api/src/domain/leadPhotoLine.ts");

let n = 0;
const ok = (cond: boolean, msg: string) => {
  assert.equal(cond, true, msg);
  n++;
};
/** How many greetings does this body open with? */
const greetingCount = (s: string) =>
  (s.match(/^(hi|hey|hello|hiya)\b[^\n]*,/gim) ?? []).filter(line => s.indexOf(line) < 200).length;

// ---------------------------------------------------------------------------
// PART 1 — the doubled greeting
// ---------------------------------------------------------------------------

// The exact body that reached Michael.
const michael = formatEmailLayout(
  "Hey Michael, it's Alexandra over at American Harley-Davidson. Thanks for your inquiry about the 2026 Low Rider S.",
  { firstName: "Michael", fallbackName: "there" }
);
ok(!/^Hi Michael,\s*\n+\s*Hey Michael/i.test(michael), "no longer stacks 'Hi Michael,' on top of 'Hey Michael,'");
ok(michael.startsWith("Hey Michael,"), "the composer's own greeting is kept, not rewritten");
ok(greetingCount(michael) === 1, "exactly one greeting");

// The no-name variant (+17168610158).
const brooke = formatEmailLayout("Hi, this is Brooke at American Harley-Davidson. You mentioned a trade.", {
  firstName: "Lucas",
  fallbackName: "there"
});
ok(!/^Hi Lucas,\s*\n+\s*Hi, this is Brooke/i.test(brooke), "a greeting with no name is still a greeting");
ok(greetingCount(brooke) === 1, "exactly one greeting on the no-name form");

// Everything that already worked must keep working.
for (const [body, why] of [
  ["Hi Michael, thanks for reaching out about the Low Rider S.", "Hi <name>, is untouched"],
  ["Hello Michael, thanks for reaching out.", "Hello <name>, is untouched"]
] as const) {
  const out = formatEmailLayout(body, { firstName: "Michael", fallbackName: "there" });
  ok(greetingCount(out) === 1, why);
}

// A body with NO greeting still gets one — the whole point of the prepend.
const bare = formatEmailLayout("Thanks for your inquiry about the 2026 Low Rider S.", {
  firstName: "Michael",
  fallbackName: "there"
});
ok(bare.startsWith("Hi Michael,"), "a greeting-less body still gets a greeting prepended");
ok(greetingCount(bare) === 1, "and only one");

// The em-dash rewrite is untouched.
const dash = formatEmailLayout("Hi Michael — thanks for reaching out.", { firstName: "Michael", fallbackName: "there" });
ok(dash.startsWith("Hi Michael,"), "the 'Hi <name> —' rewrite still produces 'Hi <name>,'");
ok(greetingCount(dash) === 1, "and does not then double up");

// A word that merely STARTS with a greeting is not a greeting.
const hitch = formatEmailLayout("Hitching a trailer, are you? Let me know.", { firstName: "Sam", fallbackName: "there" });
ok(hitch.startsWith("Hi Sam,"), "'Hitching…' is not a greeting — the prepend still fires");

// No name anywhere falls back rather than throwing.
const noName = formatEmailLayout("Thanks for reaching out.", {});
ok(noName.startsWith("Hi there,"), "falls back to 'there' when the lead has no first name");

// ---------------------------------------------------------------------------
// PART 2 — the photo line's colour
// ---------------------------------------------------------------------------

// Michael's real case: he built Aurora Blue Denim, the floor has White Onyx.
const mismatch = decideLeadPhotoLine({
  label: "2026 Low Rider S",
  unitColor: "White Onyx Pearl Black Trim",
  requestedColor: "Aurora Blue Denim"
});
ok(mismatch.colorDiffers === true, "a different colour on the floor is recognised as different");
ok(
  mismatch.line === "Here’s a photo of a 2026 Low Rider S we have in stock — it’s White Onyx Pearl Black Trim rather than the Aurora Blue Denim you were looking at.",
  "the line names BOTH colours instead of quietly showing another bike"
);
ok(
  !/keep an eye out|let you know|watch for/i.test(mismatch.line ?? ""),
  "no promise to watch for the colour — an offer with no side effect behind it is its own bug class"
);

// The latent one: a unit with no colour must NEVER borrow the customer's.
const noUnitColor = decideLeadPhotoLine({
  label: "2026 Low Rider S",
  unitColor: null,
  requestedColor: "Aurora Blue Denim"
});
ok(
  !/aurora blue denim/i.test(noUnitColor.line ?? ""),
  "never claims stock in a colour we could not read off the unit"
);
ok(noUnitColor.line === "Here’s a photo of a 2026 Low Rider S we have in stock.", "states the bike, no colour");
ok(noUnitColor.colorShown === null, "and reports that no colour was shown");

// A genuine match reads exactly as it always did.
const match = decideLeadPhotoLine({
  label: "2026 Low Rider S",
  unitColor: "Vivid Black Black Trim",
  requestedColor: "Vivid Black"
});
ok(match.colorDiffers === false, "the feed's trim suffix is not a colour mismatch");
ok(match.line === "Here’s a photo of a 2026 Low Rider S in Vivid Black Black Trim we have in stock.", "match keeps today's copy");

// No colour requested — unchanged behaviour (21 of 24 live photo lines are this case).
const noRequest = decideLeadPhotoLine({ label: "2026 Low Rider S", unitColor: "White Onyx Pearl Black Trim" });
ok(noRequest.colorDiffers === false, "a lead with no configured colour cannot mismatch");
ok(
  noRequest.line === "Here’s a photo of a 2026 Low Rider S in White Onyx Pearl Black Trim we have in stock.",
  "no requested colour keeps today's copy exactly"
);

// Case and punctuation do not manufacture a mismatch.
ok(
  decideLeadPhotoLine({ label: "X", unitColor: "vivid-black", requestedColor: "Vivid Black" }).colorDiffers === false,
  "colour comparison is case- and punctuation-insensitive, like the picker's"
);

// Nothing to say => say nothing.
for (const label of ["", "   ", null, undefined]) {
  ok(decideLeadPhotoLine({ label, unitColor: "Vivid Black" }).line === null, "no model label => no line at all");
}

// ---------------------------------------------------------------------------
// PART 3 — the wiring
// ---------------------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const route = fs.readFileSync(path.join(here, "../services/api/src/routes/sendgridInbound.ts"), "utf8");

ok(
  route.includes('import { decideLeadPhotoLine } from "../domain/leadPhotoLine.js";'),
  "the ADF route imports the decider"
);
ok(
  /return decideLeadPhotoLine\(\{\s*label,\s*unitColor: pick\.color,\s*requestedColor: conv\?\.lead\?\.vehicle\?\.color\s*\}\)\.line;/.test(
    route
  ),
  "buildInitialPhotoLine returns the decider's line, with the UNIT colour and the LEAD colour in the right slots"
);
// The bug was the fallback itself — it must not come back.
ok(
  !/pick\.color \?\? conv\?\.lead\?\.vehicle\?\.color/.test(route),
  "the `pick.color ?? lead.vehicle.color` fallback is gone — that is what claimed unverified stock"
);
ok(
  !/Here’s a photo of a \$\{label\}/.test(route),
  "the route no longer builds the sentence itself — one place owns the copy"
);

// ---------------------------------------------------------------------------
// PART 4 — ADDRESSING SOMEONE BY NAME IS ALSO A GREETING (this fix tripping over itself).
//
// The colour-correction copy Part 2 introduced opens "Michael — one correction on my last note".
// No hi/hey/hello, so the detector above missed it and the layout stacked a greeting anyway:
// "Hi Michael,\n\nMichael — one correction…" went to +17165481952 at 2026-08-07T13:04:33Z, NINE
// MINUTES after the 12:55Z deploy that was meant to end doubled greetings. Executed, not grepped.
// ---------------------------------------------------------------------------
{
  const correction = formatEmailLayout(
    "Michael — one correction on my last note: we don't have the Aurora Blue Denim Low Rider S on the floor.",
    { firstName: "Michael", fallbackName: "there" }
  );
  ok(
    !/^Hi Michael,\s*\n+\s*Michael\b/i.test(correction),
    "a body that already addresses the customer by name must not get a second greeting stacked on it"
  );
  ok(correction.startsWith("Michael —"), "the composer's own opening is kept, not rewritten");

  const commaForm = formatEmailLayout("Michael, one correction on my last note.", {
    firstName: "Michael",
    fallbackName: "there"
  });
  ok(!/^Hi Michael,\s*\n+\s*Michael,/i.test(commaForm), "the comma form is addressed too");

  // FAIL DIRECTION: only the EXACT name we were about to greet with counts, and only when it is
  // followed by a comma or a dash. Anything else still gets a greeting — today's behaviour.
  for (const [body, why] of [
    ["Michelle, here is that quote.", "a DIFFERENT name is not this customer being addressed"],
    ["Michaels are great bikes for that.", "the name inside another word is not an address"],
    ["Thanks for reaching out about the Low Rider S.", "a body with no opening name still gets one"]
  ] as const) {
    const out = formatEmailLayout(body, { firstName: "Michael", fallbackName: "there" });
    ok(out.startsWith("Hi Michael,"), why);
  }
  // With no real name there is nothing to match, so the fallback greeting must still appear.
  ok(
    formatEmailLayout("there — here is that quote.", { firstName: "", fallbackName: "there" }).startsWith(
      "Hi there,"
    ),
    "the 'there' fallback is not a name and must never suppress the greeting"
  );
}

// ---------------------------------------------------------------------------
// PART 1b — a greeting the layout did not CREATE, but passed straight through
// ---------------------------------------------------------------------------
// Part 1 stopped formatEmailLayout STACKING a second greeting. It never stopped it forwarding a
// body that arrives already doubled: it sees the greeting on line 1, correctly declines to prepend,
// and never looks at line 2. That gap re-opened the class 11 days later, on 2026-08-18T21:03:48Z —
// the Claude draft reviewer is told to "keep its greeting" when it rewrites an email, rewrote a
// template that already greeted, and stored a doubled opening for +17168610158 on a `mode: "human"`
// thread the draft-sanity backstop is barred from reading.
//
// Measured against the live store the day this shipped: of 227 standing email drafts exactly 9
// change and 0 lose content; of 7,314 outbound bodies exactly 1 changes and 0 lose content.

// Lucas's exact stored body (+17168610158). The bare line goes; the greeting that carries the
// sentence — and the sign-off — stay.
const lucas = formatEmailLayout(
  "Hi Lucas,\n\nHi, this is Brooke at American Harley-Davidson! I saw you submitted a test ride request for the 2013 Street Glide.\n\nBrooke\nAmerican Harley-Davidson",
  { firstName: "Lucas", fallbackName: "there" }
);
ok(greetingCount(lucas) === 1, "a body that ARRIVES doubled is collapsed to one greeting");
ok(lucas.startsWith("Hi, this is Brooke"), "the greeting that carries the message is the one kept");
ok(lucas.includes("test ride request for the 2013 Street Glide"), "the message survives the collapse");
ok(lucas.includes("Brooke\nAmerican Harley-Davidson"), "and so does the sign-off");

// The pipeline residue shape (+17164442120, +17165340608, +19189848896 and five more).
const igor = formatEmailLayout(
  "Hi igor,\n\nHey igor, it's Alexandra over at American Harley-Davidson. I saw you want to do the Jumpstart experience.",
  { firstName: "igor", fallbackName: "there" }
);
ok(greetingCount(igor) === 1, "the 'Hi <name>,' + 'Hey <name>,' residue collapses too");
ok(igor.startsWith("Hey igor,"), "the composer's own voice is what survives");
ok(igor.includes("Jumpstart experience"), "content preserved");

// FAIL DIRECTION — only a line that is a greeting and NOTHING ELSE may be dropped.
// A greeting that carries a sentence is content: leaving a doubled greeting is a far smaller
// failure than deleting a sentence, so these must all come through untouched.
for (const [body, why] of [
  [
    "Hi, this is Brooke at American Harley-Davidson.\n\nHey Lucas, the bike is ready.",
    "line 1 carries a sentence — never dropped, even though line 2 also greets"
  ],
  [
    "Hi Lucas,\n\nYour bike is ready for pickup Thursday at 9am.",
    "line 2 does not greet — the ordinary email keeps its greeting"
  ],
  [
    "Hi Lucas,\n\nHey — quick question about Thursday.",
    "a dash-form opener is not a recognised greeting, so nothing is dropped"
  ]
] as const) {
  const before = body.split("\n").filter(l => l.trim()).length;
  const out = formatEmailLayout(body, { firstName: "Lucas", fallbackName: "there" });
  ok(out.split("\n").filter(l => l.trim()).length === before, why);
}

// The collapse must never strip the ONLY greeting and leave the email opening cold.
const single = formatEmailLayout("Hi Lucas,\n\nThanks for stopping in.", { firstName: "Lucas", fallbackName: "there" });
ok(single.startsWith("Hi Lucas,"), "a lone greeting is not a duplicate and stays");
ok(greetingCount(single) === 1, "exactly one greeting on the ordinary path");

// A lone greeting must survive VERBATIM, not be dropped and re-prepended.
// Counting lines cannot see this: drop "Hey Lucas," from a body whose second line does not greet
// and the prepend below puts "Hi Lucas," back, so the line count is identical and the customer is
// greeted in a word the composer did not choose. tone.ts is layout, not voice — pin the word.
const heyKept = formatEmailLayout("Hey Lucas,\n\nYour bike is ready Thursday at 9am.", {
  firstName: "Lucas",
  fallbackName: "there"
});
ok(heyKept.startsWith("Hey Lucas,"), "a lone 'Hey' greeting is never rewritten into 'Hi'");
ok(heyKept.includes("Thursday at 9am"), "and the message is untouched");

// Same trap with the fallback: a body greeting "there" must not acquire the lead's first name.
const thereKept = formatEmailLayout("Hi there,\n\nYour parts came in.", { firstName: "Lucas", fallbackName: "there" });
ok(thereKept.startsWith("Hi there,"), "a lone 'Hi there,' is not swapped for the lead's first name");

const tone = fs.readFileSync(path.join(here, "../services/api/src/domain/tone.ts"), "utf8");
ok(
  /EMAIL_BODY_OPENS_WITH_GREETING\s*=\s*\/\^\(hi\|hey\|hello\|hiya\)/i.test(tone),
  "the greeting detector recognises hey/hiya, not just hi/hello"
);
ok(
  tone.includes("EMAIL_BODY_OPENS_WITH_GREETING.test(out)") &&
    tone.includes("emailBodyOpensByAddressing(out, greetingName)"),
  "and formatEmailLayout consults BOTH openings before prepending"
);
// The collapse has to run BEFORE the prepend test, or the prepend reads the bare line we are
// about to discard and decides against greeting a body that then has no greeting left.
ok(
  tone.indexOf("dropDuplicateLeadingSalutation(out, greetingName)") > 0 &&
    tone.indexOf("dropDuplicateLeadingSalutation(out, greetingName)") <
      tone.indexOf("EMAIL_BODY_OPENS_WITH_GREETING.test(out)"),
  "the duplicate-greeting collapse runs before the prepend decision"
);

console.log(`lead_photo_line_eval: PASS (${n} assertions)`);
