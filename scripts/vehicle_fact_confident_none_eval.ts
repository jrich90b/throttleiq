/**
 * vehicle_fact_confident_none:eval — a confident parser "none" must suppress the vehicle-fact
 * keyword fallback in BOTH inbound paths.
 *
 * Real miss (adf_ref_11422, 6/19 turn, corpus-replay judged): after a resale-value chat the
 * customer said "Fair enough. And I need a front tire and probably back." — a parts NEED. The
 * typed vehicle-fact parser correctly returned questionType "none" (confidence ~0.8–0.93), but
 * resolveVehicleFactQuestionDecision fell through to the legacy keyword fallback, whose
 * `\btires?\b` branch hijacked the turn into questionType "service_records" and drafted the
 * canned "I'll check on the service records and follow up shortly." — never helping with the
 * tires the customer actually needs.
 *
 * Fix under the fail-direction test: the fallback regex is a PARSER-OUTAGE fail-safe, not a
 * comprehension authority. When the parser RAN and confidently says "none", that verdict wins
 * (parser-first); when the parse is null or low-confidence, the keyword fallback still fires
 * (outage fail-safe kept). Mirrors the existing isVehicleInfoRequestParserConfidentNone pattern.
 *
 * This eval is deterministic: functional checks on the exported pure helper + source guards
 * that both path resolvers consult it before their keyword-fallback chains.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { isVehicleFactQuestionParserConfidentNone } from "../services/api/src/domain/llmDraft.ts";

const MIN = 0.74;

// 1) Functional: confident "none" is recognized...
assert.equal(
  isVehicleFactQuestionParserConfidentNone(
    { questionType: "none", explicitRequest: false, requestedFields: [], confidence: 0.9 },
    MIN
  ),
  true,
  "a confident parser none must be authoritative"
);
// ...the production replay confidences (0.8) clear the default floor...
assert.equal(
  isVehicleFactQuestionParserConfidentNone(
    { questionType: "none", explicitRequest: false, requestedFields: [], confidence: 0.8 },
    MIN
  ),
  true,
  "the adf_ref_11422 replay confidence (0.8) must clear the default floor"
);
// ...but a low-confidence none does NOT suppress the fallback (fail-safe kept)...
assert.equal(
  isVehicleFactQuestionParserConfidentNone(
    { questionType: "none", explicitRequest: false, requestedFields: [], confidence: 0.5 },
    MIN
  ),
  false,
  "a low-confidence none must NOT suppress the fallback"
);
// ...a null parse (parser outage) does NOT suppress the fallback (fail-safe kept)...
assert.equal(
  isVehicleFactQuestionParserConfidentNone(null, MIN),
  false,
  "a null parse (parser outage) must NOT suppress the fallback"
);
// ...and a real classification is never treated as none.
assert.equal(
  isVehicleFactQuestionParserConfidentNone(
    { questionType: "service_records", explicitRequest: true, requestedFields: ["service_records"], confidence: 0.97 },
    MIN
  ),
  false,
  "a confident real classification is not a confident none"
);

// 2) Source guards: both path resolvers consult the helper BEFORE their keyword fallback chain,
//    and the outage fallback itself is kept.
function checkResolver(file: string, fnNeedle: string, label: string) {
  const src = fs.readFileSync(path.resolve(file), "utf8");
  const start = src.indexOf(fnNeedle);
  assert.ok(start > 0, `${label}: resolver must exist`);
  const guardIdx = src.indexOf("isVehicleFactQuestionParserConfidentNone(", start);
  const fallbackIdx = src.indexOf("\\btires?\\b", start);
  assert.ok(guardIdx > start, `${label}: resolver must consult the confident-none verdict`);
  assert.ok(fallbackIdx > start, `${label}: the parser-outage keyword fallback must be KEPT`);
  assert.ok(
    guardIdx < fallbackIdx,
    `${label}: the confident-none guard must run BEFORE the keyword fallback`
  );
}

checkResolver(
  "services/api/src/index.ts",
  "function resolveVehicleFactQuestionDecision(",
  "live/regen (index.ts)"
);
checkResolver(
  "services/api/src/routes/sendgridInbound.ts",
  "function resolveAdfVehicleFactDecision(",
  "email/ADF (sendgridInbound.ts)"
);

console.log(
  "PASS vehicle-fact confident-none eval (parser none beats the keyword fallback in both paths; outage fail-safe kept)"
);
