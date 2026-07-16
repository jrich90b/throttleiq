/**
 * Trade-vehicle repair eval (deterministic — no LLM).
 *
 * Pins the one-time cleanup tool for leads whose TRADE/SELL bike was mis-filed as the
 * motorcycle of interest before the 2026-07-15 adfParser fix (Joe's cleanup pass): the pure
 * decision (applyTradeVehicleRepair) and its guards — trade/sell-source only, expect-guarded
 * against a lead that changed since the audit, never clobbers a distinct real trade vehicle —
 * plus the worker-endpoint wiring (token gate + dry-run).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { applyTradeVehicleRepair } from "../services/api/src/domain/tradeVehicleRepair.ts";

const sellLead = () => ({
  source: "Marketplace - Sell My Bike",
  vehicle: { year: "2020", model: "Fltrxs Road Glide Special", description: "Fltrxs Road Glide Special" }
});

// 1) move_interest_to_trade: sell-source lead, empty trade slot => moved + interest cleared.
{
  const lead: any = sellLead();
  const d = applyTradeVehicleRepair(lead, {
    action: "move_interest_to_trade",
    expectModel: "Fltrxs Road Glide Special",
    expectYear: "2020"
  });
  assert.equal(d.ok, true, "clean move must apply");
  assert.equal(lead.vehicle, undefined, "interest slot must be cleared");
  assert.equal(lead.tradeVehicle?.model, "Fltrxs Road Glide Special");
  assert.equal(lead.tradeVehicle?.year, "2020");
}

// 2) Expect-guard: the live model changed since the audit => refused, untouched.
{
  const lead: any = sellLead();
  lead.vehicle.model = "Street Glide";
  const d = applyTradeVehicleRepair(lead, {
    action: "move_interest_to_trade",
    expectModel: "Fltrxs Road Glide Special",
    expectYear: "2020"
  });
  assert.equal(d.ok, false, "changed lead must be refused");
  assert.equal(lead.vehicle.model, "Street Glide", "refused lead must be untouched");
}

// 3) Source guard: a plain sales lead is never eligible.
{
  const lead: any = { ...sellLead(), source: "HD.com Request a Quote" };
  const d = applyTradeVehicleRepair(lead, {
    action: "move_interest_to_trade",
    expectModel: "Fltrxs Road Glide Special"
  });
  assert.equal(d.ok, false, "non-trade/sell source must be refused");
}

// 4) Distinct real trade vehicle is never clobbered by a move.
{
  const lead: any = { ...sellLead(), source: "Trade Accelerator - Trade In", tradeVehicle: { model: "Iron 883" } };
  const d = applyTradeVehicleRepair(lead, {
    action: "move_interest_to_trade",
    expectModel: "Fltrxs Road Glide Special",
    expectYear: "2020"
  });
  assert.equal(d.ok, false, "distinct trade vehicle must not be overwritten");
  assert.equal(lead.tradeVehicle.model, "Iron 883");
}

// 5) clear_interest_dup: same bike in both slots => interest cleared, trade kept.
{
  const lead: any = {
    source: "Trade Accelerator - Trade In",
    vehicle: { year: "2016", model: "Flhx Street Glide" },
    tradeVehicle: { year: "2016", model: "Flhx Street Glide" }
  };
  const d = applyTradeVehicleRepair(lead, {
    action: "clear_interest_dup",
    expectModel: "Flhx Street Glide",
    expectYear: "2016"
  });
  assert.equal(d.ok, true);
  assert.equal(lead.vehicle, undefined);
  assert.equal(lead.tradeVehicle.model, "Flhx Street Glide");
}

// 6) clear_interest_dup refuses when the slots hold DIFFERENT bikes (a real buy+trade pair).
{
  const lead: any = {
    source: "Trade Accelerator - Trade In",
    vehicle: { year: "2026", model: "Street Glide" },
    tradeVehicle: { year: "2018", model: "Fat Boy 114" }
  };
  const d = applyTradeVehicleRepair(lead, {
    action: "clear_interest_dup",
    expectModel: "Street Glide",
    expectYear: "2026"
  });
  assert.equal(d.ok, false, "a genuine buy+trade pair must not be 'deduped'");
  assert.equal(lead.vehicle.model, "Street Glide");
}

// 7) set_trade: writes the trade slot only; the interest slot is untouched.
{
  const lead: any = {
    source: "Trade Accelerator - Trade In",
    vehicle: { year: "2026", model: "Street Bob" },
    tradeVehicle: { description: "comment garbage …" }
  };
  const d = applyTradeVehicleRepair(lead, {
    action: "set_trade",
    expectModel: "Street Bob",
    expectYear: "2026",
    trade: { year: "2024", make: "Suzuki", model: "Gsx800frqm4 Gsx-8r", description: "2024 SUZUKI Gsx800frqm4 Gsx-8r" }
  });
  assert.equal(d.ok, true);
  assert.equal(lead.vehicle.model, "Street Bob", "interest slot untouched");
  assert.equal(lead.tradeVehicle.model, "Gsx800frqm4 Gsx-8r");
  assert.equal(lead.tradeVehicle.make, "Suzuki");
}

// 8) set_trade requires a model.
{
  const lead: any = sellLead();
  const d = applyTradeVehicleRepair(lead, {
    action: "set_trade",
    expectModel: "Fltrxs Road Glide Special",
    trade: { year: "2024" }
  });
  assert.equal(d.ok, false, "set_trade without a model must be refused");
}

// 9) Endpoint wiring pins: worker-token gate + dry-run + pure decision + outcome record.
const apiSource = fs.readFileSync("services/api/src/index.ts", "utf8");
const endpoint = apiSource.match(
  /app\.post\("\/internal\/worker\/trade-vehicle-repair\/:id",[\s\S]{0,2200}?\n\}\);/
)?.[0];
assert.ok(endpoint, "the trade-vehicle-repair worker endpoint must exist");
assert.match(endpoint!, /canUseWorkerInternal\(req\)/, "endpoint must be worker-token gated");
assert.match(endpoint!, /dryRun/, "endpoint must support dry-run");
assert.match(endpoint!, /applyTradeVehicleRepair\(/, "endpoint must use the pure decision");
assert.match(endpoint!, /recordRouteOutcome\("live", "trade_vehicle_repair"/, "repairs must be audit-logged");

console.log("PASS trade vehicle repair eval (8 decision cases + endpoint wiring pins)");
