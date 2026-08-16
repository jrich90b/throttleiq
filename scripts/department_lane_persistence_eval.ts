/**
 * DEPARTMENT LANE PERSISTENCE across repeat lead forms (2026-08-16).
 *
 * The reply lane for Riding Academy already survives a second record from the school
 * (`resolveRidingAcademyAdfLaneClaim` / `riding_academy_status_lane:eval`, 8/07). The CLASSIFICATION
 * did not. `parseAdfDepartmentInterestWithLLM` was gated on `isInitialAdf`, so the department verdict
 * was computed on the FIRST form and thrown away; a second form re-entered the generic bike path with
 * no memory that this lead is a rider-education customer.
 *
 * MEASURED on the live americanharley store 2026-08-16, n=5 Riding Academy leads, perfectly separated
 * by form count:
 *
 *   Aidan Stewart   +15857041173  2 forms -> classification.ruleName "default"                     WRONG
 *   Mitchell        +17165975331  2 forms -> classification.ruleName "default"                     WRONG
 *   Matthew Barber  +17163686137  1 form  -> "adf_department_riding_academy"                       ok
 *   Igor Yuzbashev  +17164442120  1 form  -> "adf_department_riding_academy"                       ok
 *   Savannah Niver  +13155211619  1 form  -> "adf_department_riding_academy"                       ok
 *
 * What that cost a customer: Aidan's second form (Wait List -> Enrolled) regenerated his EMAIL draft
 * as "I'd love to help with pricing. Which 2026 model are you interested in?" — to a student whose own
 * enrollment form says "Future Motorcycle Purchase Expectation: No" — and the regeneration overwrote a
 * corrected draft, so hand-heals on conv.emailDraft do not hold while this is open. His SMS draft for
 * the same turn was correct ("a seat opened up"), because the reply lane persists and the
 * classification did not: same lead, same minute, two answers.
 *
 * Second defect pinned here: even when the lane HELD, `shouldPricingIntentSetQuoteCta` ran later and
 * rewrote the lane's `contact_us` back to `request_a_quote` (Matthew -> dialogState pricing_init,
 * Mitchell). Every sibling lane that forces a non-bike route clears the pricing intent; the course
 * lane was the one that did not.
 *
 * Run: npx tsx scripts/department_lane_persistence_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const R = await import("../services/api/src/domain/routeStateReducer.ts");

let n = 0;
const ok = (cond: boolean, msg: string) => {
  assert.equal(cond, true, msg);
  n++;
};

const lane = (
  priorLane: "apparel" | "parts" | "service" | "riding_academy" | "none" | null,
  thisTurnLane: "apparel" | "parts" | "service" | "riding_academy" | "none",
  vehicleSubjectThisTurn = false
) => R.decideDepartmentLaneTurn({ priorLane, thisTurnLane, vehicleSubjectThisTurn });

// ---------------------------------------------------------------------------
// PART 1 — the decision table
// ---------------------------------------------------------------------------

// The regression itself: form 1 establishes the lane, form 2 parses to nothing, lane must HOLD.
ok(lane("riding_academy", "none").kind === "riding_academy", "Aidan's 2nd lead form keeps the course lane");
ok(lane("riding_academy", "none").persist === "riding_academy", "...and it stays persisted");
ok(lane("riding_academy", "none").reason === "carried_forward", "...recorded as carried_forward");

// A lead with no prior lane is untouched — this must not invent lanes for bike shoppers.
ok(lane(null, "none").kind === "none", "no prior lane + no verdict => none (normal bike flow)");
ok(lane(null, "none").persist === null, "...and nothing is persisted");
ok(lane("none", "none").kind === "none", '"none" as a prior lane is the same as no lane');

// Fresh comprehension outranks memory, in both directions.
ok(lane(null, "riding_academy").kind === "riding_academy", "a fresh verdict establishes the lane");
ok(lane(null, "riding_academy").reason === "fresh_verdict", "...recorded as fresh_verdict");
ok(lane("riding_academy", "parts").kind === "parts", "a fresh DIFFERENT verdict moves the lane");
ok(lane("riding_academy", "parts").persist === "parts", "...and replaces what was persisted");

// The release valve: a course student who genuinely starts shopping bikes is let out.
ok(lane("riding_academy", "none", true).kind === "none", "a confident vehicle verdict releases the lane");
ok(lane("riding_academy", "none", true).persist === null, "...and clears it from the conversation");
ok(lane("riding_academy", "none", true).reason === "released_to_vehicle", "...recorded as released_to_vehicle");

// FAIL DIRECTION — the whole point. Absence of a verdict must never drop a lane, because dropping it
// is the measured live defect (bike-pricing copy at a customer who said they are not buying a bike)
// AND it silently destroys a corrected draft. Only a positive vehicle verdict releases.
ok(lane("riding_academy", "none", false).kind === "riding_academy", "no verdict does NOT release the lane");
for (const prior of ["parts", "apparel", "service", "riding_academy"] as const) {
  ok(lane(prior, "none").kind === prior, `${prior} lane carries forward too (one rule, every department)`);
}

// `persist` is what the store writes; it must never be the string "none" (absence IS null), or the
// setter would stamp a bogus lane onto the conversation.
for (const prior of [null, "none", "parts", "riding_academy"] as const) {
  for (const turn of ["none", "parts", "riding_academy"] as const) {
    for (const veh of [false, true]) {
      const d = lane(prior, turn, veh);
      ok(d.persist !== ("none" as unknown), `persist is never "none" (${prior}/${turn}/${veh})`);
      ok(
        d.persist === null || d.persist === d.kind,
        `persist agrees with the in-force lane (${prior}/${turn}/${veh})`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// PART 2 — the wiring. A pure referee nobody calls is worth nothing; memory
// `parser-fix-inert-until-the-lexical-gate-lets-it-through` is exactly this failure.
// ---------------------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const inbound = fs.readFileSync(
  path.join(here, "..", "services", "api", "src", "routes", "sendgridInbound.ts"),
  "utf8"
);

ok(inbound.includes("decideDepartmentLaneTurn({"), "the intake path actually calls the referee");
ok(
  inbound.split("decideDepartmentLaneTurn({").length - 1 === 1,
  "exactly ONE call site — a second copy is how live and regen drifted apart before"
);
ok(
  inbound.includes("setConversationDepartmentLane(conv, departmentLaneDecision.persist)"),
  "the referee's verdict is what gets persisted — not a hand-rolled write next to it"
);
ok(
  /\(isInitialAdf \|\| !!persistedDepartmentLane\)/.test(inbound),
  "the department parser gate is re-opened on repeat forms, or the lane could never be released"
);

// The lane branch must clear the pricing intent, or `shouldPricingIntentSetQuoteCta` overwrites the
// contact_us it just set (Matthew, Mitchell — live).
const laneBranch = inbound.slice(
  inbound.indexOf('} else if (initialAdfRiderCourseDecision || adfDepartmentRoute.kind === "riding_academy") {')
);
const laneBranchBody = laneBranch.slice(0, laneBranch.indexOf("} else if (adfDepartmentRoute.kind === \"parts\""));
ok(laneBranchBody.length > 0, "found the riding-academy bucket branch");
ok(
  laneBranchBody.includes('inferredCta = "contact_us"'),
  "the course lane still routes to contact_us"
);
ok(
  laneBranchBody.includes("pricingInquiryIntent = false"),
  "the course lane clears the pricing intent so its cta survives to the classification"
);

// The single-writer invariant on the new field.
const store = fs.readFileSync(
  path.join(here, "..", "services", "api", "src", "domain", "conversationStore.ts"),
  "utf8"
);
ok(
  store.includes("export function setConversationDepartmentLane("),
  "conv.departmentLane has a named setter"
);
const writers = (store.match(/conv\.departmentLane = /g) ?? []).length;
ok(writers === 1, `exactly one writer of conv.departmentLane in the store (found ${writers})`);
const inboundWrites = (inbound.match(/\.departmentLane\s*=/g) ?? []).length;
ok(inboundWrites === 0, `intake never writes conv.departmentLane inline (found ${inboundWrites})`);

console.log(`department_lane_persistence: ${n} assertions passed`);
