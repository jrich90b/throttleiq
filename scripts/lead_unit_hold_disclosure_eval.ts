/**
 * Lead-unit hold/sold disclosure eval (pure, no LLM).
 *
 * Pins the Ryan Tower fix (+15857278545, LEA-238, 2026-07-04): his ADF lead named an
 * EXACT unit (2013 Street Glide, stock U894-13, VIN 1HD1KBM15DB626875) that went on
 * hold 7/2 for a DIFFERENT customer — and the live reply path kept quoting payments
 * ("Ballpark, on about $10,995...") and confirming purchase logistics ("Yes, bring
 * both!") without ever disclosing the hold. Hold-awareness existed only in the
 * watch-fire engines, the cadence override, and the console — never in the live/regen
 * reply turn.
 *
 * Layers:
 *   1. Decision table — decideLeadUnitAvailabilityDisclosure (routeStateReducer):
 *      fail toward DISCLOSING; only the customer's OWN hold, a prior disclosure for
 *      the same unit, or a protected (compliance) reply suppress it.
 *   2. Composer/append safety — the disclosure names the unit, discloses without
 *      fabricating availability, never double-appends when the text already
 *      discloses (cadence-override overlap), and never touches an empty reply.
 *   3. Source guards — the injector is wired at BOTH publish funnels
 *      (publishLiveTwilioReply for /webhooks/twilio early replies, and
 *      publishCustomerReplyDraft for the main pipeline + /conversations/:id/regenerate),
 *      the compliance skip rides forceSend, and the decision comes from routeStateReducer.
 *
 * Run: npx tsx scripts/lead_unit_hold_disclosure_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { decideLeadUnitAvailabilityDisclosure } from "../services/api/src/domain/routeStateReducer.ts";
import {
  appendLeadUnitAvailabilityDisclosure,
  composeLeadUnitAvailabilityDisclosure,
  textAlreadyDisclosesUnavailability
} from "../services/api/src/domain/leadUnitAvailabilityDisclosure.ts";

// --- 1) Decision table (pure). ---
type Row = {
  id: string;
  kind: "hold" | "sold" | null;
  own: boolean;
  disclosed: boolean;
  protectedReply: boolean;
  expect: "disclose_hold" | "disclose_sold" | "none";
};
const rows: Row[] = [
  // Ryan's exact case: held for ANOTHER customer, never disclosed, normal sales reply.
  { id: "held_for_other_discloses", kind: "hold", own: false, disclosed: false, protectedReply: false, expect: "disclose_hold" },
  // Fail toward disclosing: hold with unknown owner still discloses (own=false covers ownerless holds).
  { id: "sold_discloses", kind: "sold", own: false, disclosed: false, protectedReply: false, expect: "disclose_sold" },
  // The customer's OWN hold is good news, not a warning.
  { id: "own_hold_stays_quiet", kind: "hold", own: true, disclosed: false, protectedReply: false, expect: "none" },
  // Once per unit — a prior disclosure suppresses repeats.
  { id: "already_disclosed_once_only", kind: "hold", own: false, disclosed: true, protectedReply: false, expect: "none" },
  { id: "sold_already_disclosed", kind: "sold", own: false, disclosed: true, protectedReply: false, expect: "none" },
  // Compliance/system replies never carry it.
  { id: "protected_reply_never_touched", kind: "hold", own: false, disclosed: false, protectedReply: true, expect: "none" },
  { id: "protected_sold_never_touched", kind: "sold", own: false, disclosed: false, protectedReply: true, expect: "none" },
  // Available unit → nothing to say.
  { id: "available_none", kind: null, own: false, disclosed: false, protectedReply: false, expect: "none" }
];
for (const r of rows) {
  const kind = decideLeadUnitAvailabilityDisclosure({
    unavailableKind: r.kind,
    holdOwnedByThisConv: r.own,
    alreadyDisclosedForThisUnit: r.disclosed,
    isProtectedReplyKind: r.protectedReply
  }).kind;
  assert.equal(kind, r.expect, `decision[${r.id}] expected ${r.expect}, got ${kind}`);
}

// --- 2) Composer + append safety. ---
const unitLabel = "2013 Harley-Davidson Street Glide";
const holdLine = composeLeadUnitAvailabilityDisclosure({ kind: "hold", unitLabel });
assert.match(holdLine, /2013 Harley-Davidson Street Glide/, "hold disclosure names the unit");
assert.match(holdLine, /hold/i, "hold disclosure says hold");
assert.match(holdLine, /may not be available/i, "hold disclosure is honest about availability");
assert.ok(!/still available|is available\b/i.test(holdLine), "hold disclosure never claims availability");

const soldLine = composeLeadUnitAvailabilityDisclosure({ kind: "sold", unitLabel });
assert.match(soldLine, /no longer available/i, "sold disclosure says it's gone");
assert.ok(!/hold/i.test(soldLine), "sold disclosure doesn't hedge with 'hold'");

// Ryan's actual reply, with the disclosure appended: the answer still comes first.
const ryanReply =
  "Yes, bring both! Having the Sportster here lets us do the trade appraisal on the spot, and the cash down speeds things up with finance.";
const applied = appendLeadUnitAvailabilityDisclosure(ryanReply, { kind: "hold", unitLabel });
assert.equal(applied.appended, true, "disclosure appends to a normal sales reply");
assert.ok(applied.text.startsWith("Yes, bring both!"), "the customer's answer still comes first");
assert.match(applied.text, /hold/i, "the appended reply discloses the hold");

// Cadence-override overlap: text that already discloses is left alone (no broken record).
const alreadyToldText =
  "Hey Ryan, quick update — the 2013 Street Glide is currently on hold and may no longer be available.";
assert.equal(textAlreadyDisclosesUnavailability(alreadyToldText), true);
const notAppended = appendLeadUnitAvailabilityDisclosure(alreadyToldText, { kind: "hold", unitLabel });
assert.equal(notAppended.appended, false, "no double disclosure when the text already says it");
assert.equal(notAppended.text, alreadyToldText, "already-disclosing text passes through unchanged");

// Empty replies are never touched.
const empty = appendLeadUnitAvailabilityDisclosure("", { kind: "hold", unitLabel });
assert.equal(empty.appended, false, "empty reply is never touched");

// A normal reply doesn't false-positive the already-discloses check.
assert.equal(textAlreadyDisclosesUnavailability(ryanReply), false);

// --- 3) Source guards — the wiring both paths depend on. ---
const indexSrc = fs.readFileSync("services/api/src/index.ts", "utf8");

// The injector exists and consults the centralized decision.
assert.ok(
  /async function maybeApplyLeadUnitAvailabilityDisclosure\(/.test(indexSrc),
  "index.ts defines maybeApplyLeadUnitAvailabilityDisclosure"
);
assert.ok(
  /decideLeadUnitAvailabilityDisclosure\(\{/.test(indexSrc),
  "the injector uses the centralized routeStateReducer decision"
);

// Funnel 1: publishCustomerReplyDraft (main pipeline + regenerate) applies it.
const publishDraftFn = indexSrc.slice(
  indexSrc.indexOf("async function publishCustomerReplyDraft"),
  indexSrc.indexOf("function base64UrlEncode")
);
assert.ok(
  publishDraftFn.includes("maybeApplyLeadUnitAvailabilityDisclosure"),
  "publishCustomerReplyDraft (main pipeline + regen) applies the disclosure"
);

// Funnel 2: publishLiveTwilioReply (live webhook early replies) applies it, with the
// compliance (forceSend) skip.
const liveFnStart = indexSrc.indexOf("const publishLiveTwilioReply = async (");
const liveFn = indexSrc.slice(liveFnStart, liveFnStart + 4000);
assert.ok(
  liveFn.includes("maybeApplyLeadUnitAvailabilityDisclosure"),
  "publishLiveTwilioReply (live webhook) applies the disclosure"
);
assert.ok(
  /protectedReply:\s*!!options\?\.forceSend/.test(liveFn),
  "compliance (forceSend) replies are protected from injection"
);

// The dedup marker is persisted on the conversation.
assert.ok(
  indexSrc.includes("leadUnitAvailabilityDisclosed"),
  "the once-per-unit dedup marker is persisted on the conversation"
);

// ci:eval wiring.
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
assert.ok(
  String(pkg.scripts?.["ci:eval"] ?? "").includes("lead_unit_hold_disclosure:eval"),
  "lead_unit_hold_disclosure:eval is wired into ci:eval"
);

// --- Payment band render (the second Ryan Tower defect on this thread) ---
// Nearest-$10 rounding pulled both endpoints of the APR/fee spread into one bucket and
// rendered "$250–$250/mo". Joe (2026-07-06): keep it a RANGE depending on the calculation
// — endpoints round OUTWARD (low floors, high ceils to $10) so the rendered band always
// contains the computed spread; a lone number only when the endpoints are truly identical.
const { buildMonthlyPaymentLine } = await import("../services/api/src/domain/orchestrator.ts");

// Ryan's shape: one used price, APR 8–9% + fee spread → a tight band that must STAY a band.
const ryan = buildMonthlyPaymentLine({ priceMin: 10995, priceMax: 10995, isUsed: true, termMonths: 60, taxRate: 0.0875 });
const ryanBand = ryan.match(/\$(\d+)–\$(\d+)\/mo/);
assert.ok(ryanBand, `a tight computed spread renders as a range, got: ${ryan}`);
assert.ok(Number(ryanBand![1]) < Number(ryanBand![2]), "the rendered range has distinct low<high endpoints");
assert.ok(!/\$(\d+)–\$\1\/mo/.test(ryan), "no degenerate $X–$X/mo render");
// Outward rounding: endpoints land on $10 buckets.
assert.equal(Number(ryanBand![1]) % 10, 0, "low endpoint floors to $10");
assert.equal(Number(ryanBand![2]) % 10, 0, "high endpoint ceils to $10");

// A wide band stays wide and ordered.
const wide = buildMonthlyPaymentLine({ priceMin: 9995, priceMax: 15995, isUsed: true, termMonths: 60, taxRate: 0.0875 });
const wideBand = wide.match(/\$([\d,]+)–\$([\d,]+)\/mo/);
assert.ok(wideBand, `a wide price spread renders as a range, got: ${wide}`);
assert.ok(
  Number(wideBand![1].replace(/,/g, "")) < Number(wideBand![2].replace(/,/g, "")),
  "wide band ordered low<high"
);

// Fully-covered principal (down >= total) is the ONLY lone-number case ($0/mo edge).
const covered = buildMonthlyPaymentLine({ priceMin: 5000, priceMax: 5000, isUsed: true, termMonths: 60, taxRate: 0, downPayment: 6000 });
assert.ok(
  /\$0\/mo/.test(covered) && !/\$0–/.test(covered),
  `identical endpoints collapse to one number, got: ${covered}`
);

console.log(
  "PASS lead-unit hold disclosure eval (decision table 8 rows + composer/append safety + both-funnel source guards + outward-rounded payment band)"
);
