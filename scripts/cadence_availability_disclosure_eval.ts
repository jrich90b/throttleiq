/**
 * Cadence "disclose a unit's unavailability ONCE" eval.
 *
 * Origin: Lizbeth (+18035525355, 2026-07-04). Her lead unit went sold/held and
 * the held-inventory cadence overrides re-sent the same "I know you were
 * interested in the {unit}, but that bike has sold …" message on every cadence
 * step — five near-verbatim sends over six weeks — because the overrides bypass
 * the cadence no-repeat rotation. After the first disclosure (with no customer
 * reply since), the override must suppress so the normal varied cadence carries
 * the thread. A customer inbound RE-ARMS disclosure.
 *
 * Pure-function eval over the domain helpers — no live store, no LLM.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  isUnitUnavailabilityDisclosureText,
  hasDisclosedUnitUnavailabilityWithoutReply,
  customerSourcedInterestColor
} = await import("../services/api/src/domain/cadenceAvailabilityDisclosure.ts");

let passed = 0;
const fail: string[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (e: any) {
    fail.push(`${name}: ${e?.message ?? e}`);
    console.log(`FAIL ${name}: ${e?.message ?? e}`);
  }
}

// Verbatim production sends from Lizbeth's thread (both label variants + statuses).
const SOLD_SPORTSTER =
  "Hey Lizbeth, I know you were interested in the Sportster, but that bike has sold. If you want, I can check inventory with you so you can choose another bike.";
const SOLD_IRON883 =
  "Hey Lizbeth, I know you were interested in the 2022 Iron 883, but that bike has sold. If you want, I can check inventory with you so you can choose another bike.";
const HOLD_INTEREST =
  "Hey Lizbeth, I know you were interested in the Street Glide, but that bike is on hold right now. If you want, I can check inventory with you so you can choose another bike.";
const UPDATE_SOLD =
  "Hey Lizbeth, quick update — the 2022 Iron 883 is no longer available. If you want, I can show you similar options in stock, or I can keep an eye out for another Iron 883 and text you first.";
const UPDATE_HOLD =
  "Hey Lizbeth, quick update — the Street Glide is currently on hold and may no longer be available. If you want, I can send a short list of options that fit what you're after.";

// Non-disclosures that must NEVER trip the guard.
const NORMAL_CHECKIN = "Hey Lizbeth, still interested in the 2022 Iron 883? Happy to send photos or numbers.";
const GENERIC_UPDATE = "Hey Lizbeth, quick update on your order — we should have paperwork ready tomorrow.";
const GENERIC_SOLD_WORD = "Hey Lizbeth, that model has sold really well this year — want me to grab you one?";

const inbound = (body = "Yes what else do you have?") => ({ direction: "in", provider: "twilio", body });
const sent = (body: string) => ({ direction: "out", provider: "twilio", body });
const draft = (body: string) => ({ direction: "out", provider: "draft_ai", body });

check("detects the 'has sold' interest disclosure (both label variants)", () => {
  assert.equal(isUnitUnavailabilityDisclosureText(SOLD_SPORTSTER), true);
  assert.equal(isUnitUnavailabilityDisclosureText(SOLD_IRON883), true);
});

check("detects the 'on hold right now' interest disclosure", () => {
  assert.equal(isUnitUnavailabilityDisclosureText(HOLD_INTEREST), true);
});

check("detects the 'quick update — no longer available / on hold' disclosures", () => {
  assert.equal(isUnitUnavailabilityDisclosureText(UPDATE_SOLD), true);
  assert.equal(isUnitUnavailabilityDisclosureText(UPDATE_HOLD), true);
});

check("does NOT flag a normal model check-in", () => {
  assert.equal(isUnitUnavailabilityDisclosureText(NORMAL_CHECKIN), false);
});

check("does NOT flag a 'quick update' with no unavailability status", () => {
  assert.equal(isUnitUnavailabilityDisclosureText(GENERIC_UPDATE), false);
});

check("does NOT flag an incidental 'has sold' with no disclosure lead-in", () => {
  assert.equal(isUnitUnavailabilityDisclosureText(GENERIC_SOLD_WORD), false);
});

check("empty / whitespace never matches", () => {
  assert.equal(isUnitUnavailabilityDisclosureText(""), false);
  assert.equal(isUnitUnavailabilityDisclosureText("   "), false);
});

check("suppresses after a prior sent disclosure with no reply since", () => {
  assert.equal(
    hasDisclosedUnitUnavailabilityWithoutReply([inbound(), sent(SOLD_SPORTSTER)]),
    true
  );
});

check("Lizbeth reproduction: only the FIRST disclosure sends; later ticks suppress", () => {
  // Before send #1 there is no prior disclosure — the override is allowed to fire.
  const beforeFirst = [inbound("Hi Joe!")];
  assert.equal(hasDisclosedUnitUnavailabilityWithoutReply(beforeFirst), false);
  // After send #1 (5/23), every later tick (5/27, 6/04, 6/06, 6/11, 7/04) suppresses,
  // even as the label flips Sportster -> Iron 883 and back (no inbound in between).
  const afterFirst = [inbound("Hi Joe!"), sent(SOLD_SPORTSTER)];
  assert.equal(hasDisclosedUnitUnavailabilityWithoutReply(afterFirst), true);
  const afterMany = [
    inbound("Hi Joe!"),
    sent(SOLD_SPORTSTER),
    sent(SOLD_IRON883),
    sent(SOLD_SPORTSTER)
  ];
  assert.equal(hasDisclosedUnitUnavailabilityWithoutReply(afterMany), true);
});

check("re-arms once the customer writes back after a disclosure", () => {
  const history = [inbound(), sent(SOLD_SPORTSTER), inbound("Actually what about a Street Glide?")];
  assert.equal(hasDisclosedUnitUnavailabilityWithoutReply(history), false);
});

check("no prior disclosure at all => allowed (fail toward disclosing)", () => {
  assert.equal(hasDisclosedUnitUnavailabilityWithoutReply([inbound(), sent(NORMAL_CHECKIN)]), false);
  assert.equal(hasDisclosedUnitUnavailabilityWithoutReply([]), false);
  assert.equal(hasDisclosedUnitUnavailabilityWithoutReply(undefined), false);
});

check("a pending (unsent) draft disclosure does NOT count", () => {
  assert.equal(hasDisclosedUnitUnavailabilityWithoutReply([inbound(), draft(SOLD_SPORTSTER)]), false);
});

check("a draft disclosure ABOVE a real one still suppresses on the real send", () => {
  // draft_ai preview left in the thread + the actual sent disclosure below it.
  assert.equal(
    hasDisclosedUnitUnavailabilityWithoutReply([inbound(), sent(SOLD_IRON883), draft(UPDATE_SOLD)]),
    true
  );
});

// Joe ruling 2026-07-19 (+17169867992 William): the "you were interested in the {unit}"
// disclosure must only attribute a COLOR the customer actually sourced.
check("customer-sourced color: lead vehicle color is attributable", () => {
  assert.equal(customerSourcedInterestColor({ leadColor: "Vivid Black", inboundColor: null }), "Vivid Black");
});
check("customer-sourced color: a color from the customer's own words is attributable", () => {
  assert.equal(customerSourcedInterestColor({ leadColor: null, inboundColor: "red" }), "red");
});
check("customer-sourced color: lead color wins over an inbound color", () => {
  assert.equal(customerSourcedInterestColor({ leadColor: "blue", inboundColor: "red" }), "blue");
});
check("customer-sourced color: NO customer color => null (William: omit the fabricated 'black')", () => {
  assert.equal(customerSourcedInterestColor({ leadColor: null, inboundColor: null }), null);
  assert.equal(customerSourcedInterestColor({ leadColor: "", inboundColor: "   " }), null);
  assert.equal(customerSourcedInterestColor({}), null);
});
check("held/sold override builds its unit label from a customer-sourced color only", () => {
  // Source-level pin: buildCadenceHeldInventoryOverride's model-search label must derive its
  // color via customerSourcedInterestColor, not item.color/context.color (the search-surfaced
  // sibling / self-echoed color that fabricated William's "in black").
  const src = readFileSync("services/api/src/index.ts", "utf8");
  const start = src.indexOf("async function buildCadenceHeldInventoryOverride(");
  assert.ok(start >= 0, "buildCadenceHeldInventoryOverride must exist in index.ts");
  const body = src.slice(start, start + 40000);
  assert.match(
    body,
    /customerSourcedInterestColor\(/,
    "the held/sold cadence override must gate its interest-label color via customerSourcedInterestColor"
  );
  assert.doesNotMatch(
    body,
    /color: item\?\.color \?\? context\.color/,
    "the model-search interest label must not attribute item.color/context.color (non-customer-sourced)"
  );
});

console.log(`\nCadence availability disclosure: ${passed} checks passed`);
if (fail.length) {
  console.error(`\n${fail.length} failures`);
  process.exit(1);
}
console.log("PASS cadence availability disclosure eval");
