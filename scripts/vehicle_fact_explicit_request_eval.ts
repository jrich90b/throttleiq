/**
 * vehicle_fact_explicit_request:eval — when the typed vehicle-fact parser RAN and said the
 * customer is not REQUESTING a fact (`explicitRequest: false`), a confidence-0 keyword match
 * must not claim the turn.
 *
 * The real miss (+14805441825, live 2026-08-16, reported twice in 12 minutes by the draft-review
 * lane). The customer described THEIR OWN bike:
 *
 *   in  17:05:38  "Bikes never seen rain above 20,000 miles plus the original seat"
 *   out 17:05:50  "It has about 20,000 miles."            <- our draft
 *   in  17:16:29  "About 20k miles"
 *   out 17:16:44  "It has about 20,000 miles."            <- again
 *
 * The route audit recorded both as `source: "fallback", confidence: 0` — no parser verdict
 * backed either one. The `\bmiles\b` branch of the legacy keyword fallback claimed the turn,
 * and the answer arm then read the number out of the customer's OWN sentence and handed it
 * back as a dealership fact.
 *
 * Why `explicitRequest` and not confidence. Replaying the real parser over these turns (3 runs
 * each) separates them 8/8 on `explicitRequest`, and NOT on confidence:
 *
 *   FALSE POSITIVES (explicitRequest false)
 *     "Bikes never seen rain above 20,000 miles..."     none@0.80-0.85
 *     "About 20k miles"                                 mileage@0.35-0.72  <- questionType is
 *                                                          NOT "none", so the pre-existing
 *                                                          confident-none guard cannot see it.
 *                                                          This is the hole being closed.
 *     "Color doesn't matter. 2014-2016 does matter."    none@0.79-0.80
 *     "Bike is awesome ... Has 110 miles on it already" mileage@0.55-0.60
 *     "...the rear tire really doesn't have much tread" none@0.90
 *   TRUE POSITIVES (explicitRequest true)
 *     "Price ?"                                         price@0.98
 *     "what's the price on both of them?"               price@0.90-0.98
 *     "Can you do any better, what can we do out the door?"  price@0.45-0.78
 *
 * Live evidence that this is the fallback's real hit rate: across 86 days of route audit,
 * 34 of 48 vehicle-fact routes were decided by the fallback at confidence 0, and every fallback
 * fire on a genuinely live inbound (zero lag from the customer's text) was a false positive.
 *
 * Fail direction: blocking the fallback returns null and the turn falls through to the general
 * draft pipeline, which still replies — we fail toward NOT asserting an unrequested fact (and
 * away from the spurious staff todo + manual_handoff flip the canned answer also triggers).
 *
 * Scope: money types (price / otd_total / finance_program_eligibility) are deliberately EXCLUDED
 * — changing whether we quote a figure is approve-first work. Not one measured false positive
 * was on a money type. Those types keep today's behaviour exactly.
 *
 * Deterministic: drives the pure referee with plain parse objects, plus source guards that BOTH
 * inbound doors gate their keyword chain on it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  isVehicleFactKeywordFallbackAllowed,
  MONEY_VEHICLE_FACT_QUESTION_TYPES,
  vehicleFactConfidenceMin,
  DEFAULT_VEHICLE_FACT_CONFIDENCE_MIN
} from "../services/api/src/domain/vehicleFactQuestionRoute.ts";

const MIN = DEFAULT_VEHICLE_FACT_CONFIDENCE_MIN;

// ---------------------------------------------------------------------------
// 1) The reported miss: the parser gave a questionType but said it was not a request.
//    The pre-existing confident-none guard is blind to this (questionType !== "none").
// ---------------------------------------------------------------------------
assert.equal(
  isVehicleFactKeywordFallbackAllowed({
    parsed: { questionType: "mileage", explicitRequest: false, confidence: 0.35 },
    candidateQuestionType: "mileage",
    minConfidence: MIN
  }),
  false,
  '+14805441825 "About 20k miles": explicitRequest false must block the mileage fallback'
);
// The same at the TOP of the measured confidence band — this must not be a confidence question.
assert.equal(
  isVehicleFactKeywordFallbackAllowed({
    parsed: { questionType: "mileage", explicitRequest: false, confidence: 0.72 },
    candidateQuestionType: "mileage",
    minConfidence: MIN
  }),
  false,
  "explicitRequest false must block regardless of confidence (0.35-0.72 measured)"
);
// A low-confidence "none" — below the confident-none floor, so ONLY the explicitRequest rule
// can catch it. This is the +14805441825 turn-1 shape if the parser lands under the floor.
assert.equal(
  isVehicleFactKeywordFallbackAllowed({
    parsed: { questionType: "none", explicitRequest: false, confidence: 0.5 },
    candidateQuestionType: "mileage",
    minConfidence: MIN
  }),
  false,
  "a low-confidence none with explicitRequest false must still block a non-money fallback"
);
// +15857552622: "Color doesn't matter." must not be answered with a colour.
assert.equal(
  isVehicleFactKeywordFallbackAllowed({
    parsed: { questionType: "none", explicitRequest: false, confidence: 0.79 },
    candidateQuestionType: "color",
    minConfidence: MIN
  }),
  false,
  '+15857552622 "Color doesn\'t matter": must block the color fallback'
);

// ---------------------------------------------------------------------------
// 2) True positives are untouched — every measured real question had explicitRequest true.
// ---------------------------------------------------------------------------
for (const [label, questionType, confidence] of [
  ['"Price ?"', "price", 0.98],
  ['"what\'s the price on both of them?"', "price", 0.9],
  ['"what can we do out the door?"', "otd_total", 0.45],
  ['"how many miles on it?"', "mileage", 0.55]
] as const) {
  assert.equal(
    isVehicleFactKeywordFallbackAllowed({
      parsed: { questionType, explicitRequest: true, confidence },
      candidateQuestionType: questionType,
      minConfidence: MIN
    }),
    true,
    `${label}: an explicit request must still reach the fallback (behaviour unchanged)`
  );
}

// ---------------------------------------------------------------------------
// 3) The outage fail-safe the fallback exists for is KEPT.
// ---------------------------------------------------------------------------
assert.equal(
  isVehicleFactKeywordFallbackAllowed({
    parsed: null,
    candidateQuestionType: "mileage",
    minConfidence: MIN
  }),
  true,
  "parser outage (null parse) must still reach the keyword fallback"
);
// A parser that ran but did not deny a request (explicitRequest absent) is not a denial.
assert.equal(
  isVehicleFactKeywordFallbackAllowed({
    parsed: { questionType: "mileage", confidence: 0.4 },
    candidateQuestionType: "mileage",
    minConfidence: MIN
  }),
  true,
  "an absent explicitRequest is not a denial — only an explicit false blocks"
);

// ---------------------------------------------------------------------------
// 4) The money slice is held back (approve-first). These keep today's behaviour EXACTLY:
//    explicitRequest false does NOT block a money-type fallback.
// ---------------------------------------------------------------------------
for (const moneyType of ["price", "otd_total", "finance_program_eligibility"]) {
  assert.ok(
    MONEY_VEHICLE_FACT_QUESTION_TYPES.has(moneyType),
    `${moneyType} must be registered as a money question type`
  );
  assert.equal(
    isVehicleFactKeywordFallbackAllowed({
      parsed: { questionType: "none", explicitRequest: false, confidence: 0.5 },
      candidateQuestionType: moneyType,
      minConfidence: MIN
    }),
    true,
    `${moneyType}: the explicitRequest rule must NOT change money-path behaviour (Lane 2)`
  );
}
// ...but a CONFIDENT none still blocks money types, exactly as it did before this change.
assert.equal(
  isVehicleFactKeywordFallbackAllowed({
    parsed: { questionType: "none", explicitRequest: false, confidence: 0.9 },
    candidateQuestionType: "price",
    minConfidence: MIN
  }),
  false,
  "a confident none must still block a money fallback (pre-existing rule preserved)"
);

// ---------------------------------------------------------------------------
// 5) The confidence floor is env-tunable and defaults to the documented value.
// ---------------------------------------------------------------------------
assert.equal(vehicleFactConfidenceMin({} as NodeJS.ProcessEnv), DEFAULT_VEHICLE_FACT_CONFIDENCE_MIN);
assert.equal(
  vehicleFactConfidenceMin({ LLM_VEHICLE_FACT_CONFIDENCE_MIN: "0.9" } as unknown as NodeJS.ProcessEnv),
  0.9
);
assert.equal(
  vehicleFactConfidenceMin({ LLM_VEHICLE_FACT_CONFIDENCE_MIN: "not-a-number" } as unknown as NodeJS.ProcessEnv),
  DEFAULT_VEHICLE_FACT_CONFIDENCE_MIN,
  "an unparseable floor must fall back to the default, never NaN (NaN would block nothing)"
);

// ---------------------------------------------------------------------------
// 6) Wiring: BOTH inbound doors gate their keyword chain on the shared referee. A referee no
//    resolver calls is the failure mode this project keeps hitting, so count the call sites.
// ---------------------------------------------------------------------------
function checkDoorWiring(file: string, fnNeedle: string, label: string) {
  const src = fs.readFileSync(path.resolve(file), "utf8");
  const start = src.indexOf(fnNeedle);
  assert.ok(start > 0, `${label}: resolver must exist`);
  const end = src.indexOf("\nfunction ", start + fnNeedle.length);
  const body = src.slice(start, end > start ? end : undefined);
  const calls = body.split("isVehicleFactKeywordFallbackAllowed(").length - 1;
  assert.equal(calls, 1, `${label}: the resolver must consult the shared referee exactly once`);
  // The referee must gate the fallback FACTORY, so every keyword branch inherits it rather
  // than each branch remembering to ask.
  const factoryIdx = body.indexOf("const fallback =");
  const refereeIdx = body.indexOf("isVehicleFactKeywordFallbackAllowed(");
  assert.ok(factoryIdx > 0, `${label}: the keyword fallback factory must exist`);
  assert.ok(
    refereeIdx > factoryIdx && refereeIdx < body.indexOf("\\btires?\\b"),
    `${label}: the referee must gate the fallback factory, ahead of the keyword branches`
  );
}

checkDoorWiring(
  "services/api/src/index.ts",
  "function resolveVehicleFactQuestionDecision(",
  "SMS live+regen (index.ts)"
);
checkDoorWiring(
  "services/api/src/routes/sendgridInbound.ts",
  "function resolveAdfVehicleFactDecision(",
  "email/ADF (sendgridInbound.ts)"
);

console.log(
  "PASS vehicle-fact explicit-request eval (parser explicitRequest:false beats the confidence-0 keyword fallback in both doors; money slice + outage fail-safe unchanged)"
);
