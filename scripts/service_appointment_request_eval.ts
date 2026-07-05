import { strict as assert } from "node:assert";
import fs from "node:fs";

/**
 * Service / parts-install appointment handoff eval (2026-06-27).
 *
 * LeadRider has NO integration into the service department's scheduler, so when a customer wants to
 * bring the bike IN for service or a parts/accessory install, the agent must HAND OFF (intake +
 * "service will confirm a time"), never quote or book a slot. Production miss: Don Cooper
 * (+17162605144) — "bringing it in for the wedge air cleaner mid next month, have appointment?" got
 * "Awesome! Glad everything is going good!" The keyword-gated isServiceDepartmentSchedulingRequest
 * (hasServiceDepartmentContext) didn't recognize a PARTS-install request on a non-service conv, so a
 * typed parser comprehends it instead of adding more keywords.
 *
 * Pins the centralized decision (decideServiceAppointmentTurn), the parser coverage
 * (parseServiceAppointmentRequestWithLLM, when LLM enabled), and both-path wiring (source guard).
 */

const { decideServiceAppointmentTurn } = await import("../services/api/src/domain/routeStateReducer.ts");

const MIN = 0.7;
const D = (over: any = {}) =>
  decideServiceAppointmentTurn({
    parserAccepted: true,
    intent: "service_appointment_request",
    explicitRequest: true,
    confidence: 0.9,
    confidenceMin: MIN,
    ...over
  });

// Handoff only on a confident, explicit service/install appointment request.
assert.equal(D().kind, "service_appointment_handoff", "explicit confident service-appointment => handoff");
assert.equal(D({ intent: "none" }).kind, "none", "non-service intent => none");
assert.equal(D({ explicitRequest: false }).kind, "none", "not explicit => none");
assert.equal(D({ confidence: 0.5 }).kind, "none", "below confidence floor => none");
assert.equal(D({ parserAccepted: false }).kind, "none", "parser not accepted => none");

// --- Source guards: both paths run the resolver (route-parity law) ---
const idx = fs.readFileSync("services/api/src/index.ts", "utf8");
const wirings = idx.match(/resolveServiceAppointmentRequestReply\(/g) ?? [];
// one definition + one live call + one regen call
assert.ok(wirings.length >= 3, `expected the resolver defined + called in both paths, saw ${wirings.length}`);
assert.ok(/"live"/.test(idx) && /"regen"/.test(idx), "resolver must run in live and regen scopes");
// Must NOT fabricate a slot, and must defer to the existing service handoff on a service-context conv.
assert.ok(
  /if \(hasServiceDepartmentContext\(conv\)\) return null;/.test(idx),
  "resolver must defer to the existing keyword-gated service handoff when the conv already has service context"
);
assert.ok(
  /service team get you scheduled[\s\S]*confirm a time/.test(idx),
  "reply intakes + says service will confirm a time (never quotes/books a slot)"
);

// --- Parser coverage (only when the LLM is enabled, e.g. in ci:eval) ---
const llmOn = process.env.LLM_ENABLED === "1" && !!process.env.OPENAI_API_KEY;
if (llmOn) {
  const { parseServiceAppointmentRequestWithLLM } = await import("../services/api/src/domain/llmDraft.ts");
  const expectKind = async (
    text: string,
    want: "service_appointment_request" | "none",
    history?: { direction: "in" | "out"; body: string }[]
  ) => {
    const r = await parseServiceAppointmentRequestWithLLM({ text, history });
    assert.ok(r, `parser returned null for: ${text}`);
    assert.equal(r!.intent, want, `"${text}" => ${r!.intent}, expected ${want}`);
  };
  // The production miss (garbled parts-install + appointment).
  await expectKind(
    "Good at the moment bringing it in for the wedge air cleaner middle of next month have appointment?",
    "service_appointment_request"
  );
  await expectKind("need to get it in for an oil change, what days work?", "service_appointment_request");
  await expectKind("want to put a stage 1 kit on, can I drop it off Saturday?", "service_appointment_request");
  // Sales test-ride / inventory / service-records / visit-time answer => none (no false handoff).
  await expectKind("Can I come in Friday to test ride the Street Glide?", "none");
  await expectKind("is the 2026 Road Glide still in stock?", "none");
  await expectKind("when were the tires last changed on it?", "none");
  await expectKind("1 or 2 works", "none", [{ direction: "out", body: "what time you planning on coming in today?" }]);
}

console.log("PASS service_appointment_request eval");
