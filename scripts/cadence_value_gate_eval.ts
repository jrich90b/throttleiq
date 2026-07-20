/**
 * cadence_value_gate:eval — pins the GO-LIVE wiring of the proactive cadence value gate
 * (Joe 2026-07-20: "no spam — later cadences must be high quality").
 *
 * 1. Behavioral: evaluateProactiveCadenceValueGate (the SHARED applier both paths call) — gate off →
 *    send; post-sale exempt; early steps always send; an existing value override sends; a later filler
 *    step with offers dark → suppress (quiet, never fabricate). All without any LLM call.
 * 2. vehicleLabelForOfferMatch + cadenceValueGateMinStep helpers.
 * 3. Source guards (route-parity): the live tick AND the regenerate cadence builder both call the SAME
 *    shared applier; tick suppress = advance + continue (skip the send); regen suppress = return null
 *    (keep the prior draft); both flag-gated by CADENCE_VALUE_GATE_ENABLED (default OFF — dark).
 */
import fs from "node:fs";
import path from "node:path";
import {
  evaluateProactiveCadenceValueGate,
  isCadenceValueGateEnabled,
  cadenceValueGateMinStep,
  vehicleLabelForOfferMatch
} from "../services/api/src/domain/nationalOffers.ts";

const failures: string[] = [];
const eq = (id: string, actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`  - ${id}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

(async () => {
  const envBackup = {
    gate: process.env.CADENCE_VALUE_GATE_ENABLED,
    offers: process.env.NATIONAL_OFFERS_ENABLED,
    minStep: process.env.CADENCE_VALUE_GATE_MIN_STEP
  };

  // --- helpers ---------------------------------------------------------------
  delete process.env.CADENCE_VALUE_GATE_ENABLED;
  eq("gate_dark_by_default", isCadenceValueGateEnabled(), false);
  delete process.env.CADENCE_VALUE_GATE_MIN_STEP;
  eq("min_step_default_3", cadenceValueGateMinStep(), 3);
  process.env.CADENCE_VALUE_GATE_MIN_STEP = "5";
  eq("min_step_env_override", cadenceValueGateMinStep(), 5);
  delete process.env.CADENCE_VALUE_GATE_MIN_STEP;

  eq(
    "vehicle_label_from_lead",
    vehicleLabelForOfferMatch({ lead: { vehicle: { year: "2026", make: "Harley-Davidson", model: "Low Rider S" } } }),
    "2026 Harley-Davidson Low Rider S"
  );
  eq(
    "vehicle_label_watch_fallback",
    vehicleLabelForOfferMatch({ inventoryWatch: { make: "Harley-Davidson", model: "Electra Glide Ultra Classic" } }),
    "Harley-Davidson Electra Glide Ultra Classic"
  );
  eq("vehicle_label_empty", vehicleLabelForOfferMatch({}), "");

  // --- behavioral decision table (offers stay DARK → matcher never fires → no LLM) ---
  const base = { stepIndex: 5, isPostSale: false, hasValueOverride: false, vehicleLabel: "2026 Low Rider S" };
  delete process.env.CADENCE_VALUE_GATE_ENABLED;
  eq("gate_off_sends", (await evaluateProactiveCadenceValueGate(base)).action, "send");

  process.env.CADENCE_VALUE_GATE_ENABLED = "1";
  process.env.NATIONAL_OFFERS_ENABLED = "0"; // offers dark → findNationalOfferForVehicle → null
  eq("post_sale_exempt", (await evaluateProactiveCadenceValueGate({ ...base, isPostSale: true })).action, "send");
  eq("early_step_sends", (await evaluateProactiveCadenceValueGate({ ...base, stepIndex: 2 })).action, "send");
  eq("value_override_sends", (await evaluateProactiveCadenceValueGate({ ...base, hasValueOverride: true })).action, "send");
  const later = await evaluateProactiveCadenceValueGate(base);
  eq("later_filler_no_value_suppresses", later.action, "suppress");
  eq("suppress_reason_is_stay_quiet", (later as any).reason, "no_value_trigger_stay_quiet");
  eq("boundary_step_3_is_later", (await evaluateProactiveCadenceValueGate({ ...base, stepIndex: 3 })).action, "suppress");

  // restore env
  for (const [k, v] of [
    ["CADENCE_VALUE_GATE_ENABLED", envBackup.gate],
    ["NATIONAL_OFFERS_ENABLED", envBackup.offers],
    ["CADENCE_VALUE_GATE_MIN_STEP", envBackup.minStep]
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  // --- source guards: both paths wired to the SAME shared applier ------------
  const idx = fs.readFileSync(path.join(process.cwd(), "services/api/src/index.ts"), "utf8");
  eq(
    "index_imports_shared_applier",
    /import \{\s*evaluateProactiveCadenceValueGate,\s*isCadenceValueGateEnabled,\s*vehicleLabelForOfferMatch\s*\} from "\.\/domain\/nationalOffers\.js"/.test(idx),
    true
  );
  const gateCalls = idx.match(/evaluateProactiveCadenceValueGate\(\{/g) ?? [];
  eq("both_paths_call_shared_applier", gateCalls.length >= 2, true);

  // live tick: suppress advances the cadence and skips the send
  const tickIdx = idx.indexOf('console.log("[followup][cadence-value-gate] later touch has no value trigger');
  const tickBlock = tickIdx >= 0 ? idx.slice(tickIdx - 1200, tickIdx + 700) : "";
  eq("tick_block_flag_gated", /isCadenceValueGateEnabled\(\)/.test(tickBlock), true);
  eq("tick_suppress_advances_and_continues", /advanceFollowUpCadence\(conv, cfg\.timezone\);\s*\n\s*continue;/.test(tickBlock), true);
  eq("tick_replace_swaps_message", /message = valueGate\.message;/.test(tickBlock), true);
  eq(
    "tick_passes_value_overrides",
    /leadUnitAvailabilityOverride \|\|\s*\n\s*heldInventoryOverride \|\|\s*\n\s*manualTestRideAvailabilityOverride/.test(tickBlock),
    true
  );

  // regen mirror: suppress keeps the prior draft (null); replace returns the offer body
  const regenIdx = idx.indexOf("// Proactive cadence VALUE GATE — regen mirror");
  const regenBlock = regenIdx >= 0 ? idx.slice(regenIdx, regenIdx + 1200) : "";
  eq("regen_mirror_exists", regenIdx >= 0, true);
  eq("regen_mirror_flag_gated", /isCadenceValueGateEnabled\(\)/.test(regenBlock), true);
  eq("regen_replace_returns_offer_body", /return \{ body: valueGate\.message \};/.test(regenBlock), true);
  eq("regen_suppress_returns_null", /if \(valueGate\.action === "suppress"\) \{\s*\n\s*return null;/.test(regenBlock), true);

  if (failures.length) {
    console.error("FAIL cadence_value_gate eval:");
    for (const f of failures) console.error(f);
    process.exit(1);
  }
  console.log(
    "PASS cadence_value_gate eval — shared-applier decision table (7 cases), helpers, and both-path wiring guards (tick suppress=advance+skip, regen suppress=null), dark by default"
  );
})();
