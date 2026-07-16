/**
 * Trade-vehicle repair — pure decision + mutation for the one-time cleanup of leads whose
 * TRADE/SELL bike was mis-filed as the motorcycle of interest (Joe, 2026-07-15; the intake
 * bug itself was fixed in adfParser pickVehicle/pickTradeVehicle the same day — this repairs
 * the ~24 pre-fix conversations).
 *
 * Served by POST /internal/worker/trade-vehicle-repair/:id (worker-token gated, dry-run
 * capable) — the sanctioned in-process repair path; production data files are never edited
 * directly. Every action is EXPECT-GUARDED: the caller states the vehicle model/year it
 * audited, and the mutation only applies when the live lead still matches — so a lead that
 * changed since the audit is refused instead of corrupted. Fail direction: any mismatch or
 * doubt => refuse (no mutation).
 */
import type { LeadProfile } from "./conversationStore.js";

export type TradeVehicleRepairAction =
  // The interest slot holds the customer's OWN bike (sell/trade lead, trade slot empty or a
  // duplicate): move it to tradeVehicle and clear the interest slot.
  | "move_interest_to_trade"
  // The same bike sits in BOTH slots (the old single-vehicle bug): clear the interest copy.
  | "clear_interest_dup"
  // The trade slot is missing/garbled while the ADF named a real trade: set tradeVehicle
  // (does not touch the interest slot).
  | "set_trade";

export type TradeVehicleRepairRequest = {
  action: TradeVehicleRepairAction;
  // What the auditor saw in lead.vehicle at audit time — the live lead must still match.
  expectModel: string;
  expectYear?: string;
  // set_trade only: the trade vehicle to write.
  trade?: {
    year?: string;
    make?: string;
    model?: string;
    description?: string;
  };
};

export type TradeVehicleRepairDecision =
  | { ok: false; error: string }
  | {
      ok: true;
      action: TradeVehicleRepairAction;
      before: { vehicle: unknown; tradeVehicle: unknown };
      after: { vehicle: unknown; tradeVehicle: unknown };
    };

const norm = (raw: unknown): string => String(raw ?? "").trim().toLowerCase();

function isTradeOrSellSource(lead: LeadProfile | null | undefined): boolean {
  return /trade|sell/i.test(String(lead?.source ?? ""));
}

function vehicleMatchesExpectation(
  lead: LeadProfile,
  expectModel: string,
  expectYear?: string
): boolean {
  const current = norm(lead.vehicle?.model ?? lead.vehicle?.description);
  if (!current || !norm(expectModel) || current !== norm(expectModel)) return false;
  const currentYear = String(lead.vehicle?.year ?? "").trim();
  const wantYear = String(expectYear ?? "").trim();
  if (wantYear && currentYear && wantYear !== currentYear) return false;
  return true;
}

/**
 * Pure: decides and (on ok) applies the repair to the given lead object in place.
 * Callers pass a clone for dry-run.
 */
export function applyTradeVehicleRepair(
  lead: LeadProfile | null | undefined,
  req: TradeVehicleRepairRequest
): TradeVehicleRepairDecision {
  if (!lead) return { ok: false, error: "no lead on conversation" };
  if (!isTradeOrSellSource(lead)) {
    return { ok: false, error: "lead source is not a trade/sell source" };
  }
  if (!vehicleMatchesExpectation(lead, req.expectModel, req.expectYear)) {
    return { ok: false, error: "live vehicle no longer matches the audited expectation" };
  }
  const before = {
    vehicle: lead.vehicle ? { ...lead.vehicle } : undefined,
    tradeVehicle: lead.tradeVehicle ? { ...lead.tradeVehicle } : undefined
  };

  if (req.action === "move_interest_to_trade") {
    const v = lead.vehicle ?? {};
    const existingTrade = norm(lead.tradeVehicle?.model ?? lead.tradeVehicle?.description);
    const moving = norm(v.model ?? v.description);
    // Only move onto an EMPTY trade slot or a duplicate/near-duplicate of the same bike —
    // never clobber a distinct, real trade vehicle.
    if (existingTrade && !(existingTrade.includes(moving) || moving.includes(existingTrade))) {
      return { ok: false, error: "trade slot holds a distinct vehicle; refusing to overwrite" };
    }
    lead.tradeVehicle = {
      ...(v.year ? { year: v.year } : {}),
      ...(v.make ? { make: v.make } : {}),
      ...(v.model ? { model: v.model } : {}),
      ...(v.vin ? { vin: v.vin } : {}),
      ...(typeof v.mileage === "number" ? { mileage: v.mileage } : {}),
      ...(v.color ? { color: v.color } : {}),
      ...(v.description ? { description: v.description } : {})
    };
    lead.vehicle = undefined;
  } else if (req.action === "clear_interest_dup") {
    const tradeModel = norm(lead.tradeVehicle?.model ?? lead.tradeVehicle?.description);
    const vehModel = norm(lead.vehicle?.model ?? lead.vehicle?.description);
    if (!tradeModel || tradeModel !== vehModel) {
      return { ok: false, error: "interest and trade slots are not duplicates" };
    }
    lead.vehicle = undefined;
  } else if (req.action === "set_trade") {
    const t = req.trade ?? {};
    if (!String(t.model ?? "").trim()) {
      return { ok: false, error: "set_trade requires a trade model" };
    }
    lead.tradeVehicle = {
      ...(t.year ? { year: String(t.year) } : {}),
      ...(t.make ? { make: String(t.make) } : {}),
      model: String(t.model),
      ...(t.description ? { description: String(t.description) } : {})
    };
  } else {
    return { ok: false, error: `unknown action: ${String((req as any).action)}` };
  }

  return {
    ok: true,
    action: req.action,
    before,
    after: {
      vehicle: lead.vehicle ? { ...lead.vehicle } : undefined,
      tradeVehicle: lead.tradeVehicle ? { ...lead.tradeVehicle } : undefined
    }
  };
}
