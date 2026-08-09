// Acknowledgment for a trade/sell ADF — a FORM submission, NOT a customer question.
//
// The orchestrator's trade template used to open every trade turn with
// "Totally fair question. I have you on a …", which is correct only when a CUSTOMER
// actually asked something over SMS. An ADF web-lead is a structured form; its body
// ("Inquiry: trade-in appraisal request") trips the same trade/appraisal keywords, so
// the form got answered as if it were a question — and, mid-conversation, cold
// ("I have you on a 2008 Suzuki…") while a live finance deal was in flight
// (Laricuss Nelson, Ref 11466).
//
// This builder produces the right framing for an ADF trade form:
//   - initial: a clean intake; the agent intro is added downstream by
//     applyInitialAdfPrefix, so this text carries no greeting of its own.
//   - mid-conversation: ties the trade to the existing relationship instead of
//     re-introducing cold.
// The "Totally fair question" template stays for genuine customer-SMS trade questions.
import { isPlaceholderModel } from "./modelDeflection.js";
import { findInventoryMatches } from "./inventoryFeed.js";
import { listInventoryHolds, normalizeInventoryHoldKey } from "./inventoryHolds.js";
import { listInventorySolds, normalizeInventorySoldKey } from "./inventorySolds.js";

export function buildTradeAdfAck(args: {
  bikeLabel?: string | null;
  // A DISTINCT purchase vehicle the customer named on a trade-toward-buy lead (the structured ADF
  // `vehicle` field, separate from the trade-in). When present, the ack acknowledges the bike they
  // want — not just the trade (steven osipovitch, 2026-06-26: a Trade Accelerator lead naming a 2016
  // Trike Freewheeler got "I got your trade-in request for your Ryker" with no mention of the bike he
  // wants to buy). Keyed on STRUCTURED fields (vehicle vs tradeVehicle), not free-text comprehension.
  purchaseLabel?: string | null;
  // Is that purchase target CONFIRMED on the floor right now? Resolved by tradeAdfPurchaseIsOnFloor
  // against the live feed (minus holds and solds); the ADF `vehicle` field is what the customer WANTS,
  // and nothing in it says we stock it. Only a confirmed unit earns "we'll go over the X while you're
  // here" — Cale Rice, Ref 11757, 2026-08-08: a Trade Accelerator ADF naming a 2021 Electra Glide
  // Standard was invited in to go over it when the floor held ZERO under any name (67 units; the only
  // Electra Glide is a 2013 Ultra Limited, a distinct model). We still acknowledge the bike they want
  // — that is the #93 fix and it only restates their own request — but we stop promising a walk-through
  // of a unit that isn't here. Defaults to FALSE so every unknown (feed outage, lookup error, a caller
  // that forgets to resolve it) fails toward NOT asserting a bike is on the floor.
  purchaseOnFloor?: boolean;
  midConversation: boolean;
}): string {
  const bike = String(args.bikeLabel ?? "").trim() || "your bike";
  const purchaseRaw = String(args.purchaseLabel ?? "").trim();
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  // Only weave the purchase in when it's REAL and DISTINCT from the trade. Guards against ADF feeds
  // that duplicate the trade into the vehicle field (or a buy lead mis-tagged with a trade), which
  // would otherwise read "trade your X toward the X". Also drop placeholder/make-only targets
  // ("Harley-Davidson Other", "Full Line") — a Trade Accelerator ADF whose `vehicle` field is a
  // placeholder would otherwise read "trade your Road King toward the 2026 Harley-Davidson Other"
  // (Gene Campana, Ref 11551, 2026-06-26 — staff stripped the fabricated target). Falling through to
  // the no-purchase branch ("I got your trade-in request for X") matches the human correction.
  // Deterministic placeholder classification (a known field value, not comprehension) via the shared
  // isPlaceholderModel; fail-direction safe — when the target is a non-bookable placeholder we ask
  // what they want instead of asserting a model.
  const purchase =
    purchaseRaw &&
    norm(purchaseRaw) !== norm(bike) &&
    !/^your bike$/i.test(purchaseRaw) &&
    !isPlaceholderModel(purchaseRaw)
      ? purchaseRaw
      : "";

  // The walk-through promise is the ONLY clause that asserts we have the unit. Acknowledging the
  // target does not, so an out-of-stock target keeps its acknowledgment and loses the promise.
  const walkThrough = !!purchase && args.purchaseOnFloor === true;

  if (args.midConversation) {
    if (!purchase) {
      return (
        `Thanks — I got your trade-in request for ${bike}. ` +
        "We can fold that into what we're already working on — a quick in-person appraisal gets you a firm number. " +
        "What day and time works best to stop in?"
      );
    }
    return (
      `Thanks — I got your request to trade your ${bike} toward the ${purchase}. ` +
      (walkThrough
        ? `We can fold that into what we're already working on — a quick in-person appraisal gets you a firm number, and we'll go over the ${purchase} while you're here. `
        : "We can fold that into what we're already working on — a quick in-person appraisal gets you a firm number. ") +
      "What day and time works best to stop in?"
    );
  }
  if (!purchase) {
    return (
      `Thanks — I got your trade-in request for ${bike}. ` +
      "We can give you a firm number after a quick in-person appraisal. " +
      "What day and time works best to stop in?"
    );
  }
  return (
    `Thanks — I got your request to trade your ${bike} toward the ${purchase}. ` +
    (walkThrough
      ? `We can give you a firm number after a quick in-person appraisal, and go over the ${purchase} while you're here. `
      : "We can give you a firm number after a quick in-person appraisal. ") +
    "What day and time works best to stop in?"
  );
}

/**
 * Pure availability decision: does ANY feed match for the purchase target survive the hold/sold
 * lists? Separated from the fetch so it can be executed in an eval without a network call.
 * A held or sold unit is not walk-through-able for a different customer — both fail toward the
 * quieter copy, which is the safe direction (we under-promise instead of inviting someone in for a
 * bike that is spoken for).
 */
export function tradeAdfPurchaseUnitIsAvailable(args: {
  matches: Array<{ stockId?: string | null; vin?: string | null }>;
  holds?: Record<string, unknown> | null;
  solds?: Record<string, unknown> | null;
}): boolean {
  return args.matches.some(item => {
    const soldKey = normalizeInventorySoldKey(item.stockId, item.vin);
    if (soldKey && args.solds?.[soldKey]) return false;
    const holdKey = normalizeInventoryHoldKey(item.stockId, item.vin);
    if (holdKey && args.holds?.[holdKey]) return false;
    return true;
  });
}

/**
 * Is this purchase target one we could ever assert a walk-through for? A blank or placeholder model
 * ("Harley-Davidson Other", "Full Line") is not a bookable unit, so there is nothing to look up.
 * Pure and exported so the eval can execute it — inside the resolver it saves a pointless feed fetch,
 * which is real but invisible, and an invisible guard is one no test can hold in place.
 */
export function tradeAdfPurchaseTargetIsAssertable(model?: string | null): boolean {
  // isPlaceholderModel already classifies blank/whitespace as a placeholder (measured), so a separate
  // emptiness test here would be unreachable code no sabotage could hold in place. One guard, one
  // observable behaviour.
  return !isPlaceholderModel(String(model ?? "").trim());
}

/**
 * Shared resolver for BOTH ADF trade paths (routes/sendgridInbound.ts initial, domain/orchestrator.ts
 * mid-conversation) so the two cannot drift. Year-aware on purpose: findInventoryMatches requires an
 * exact year when one is given, because "go over the 2021 Electra Glide Standard" is a claim about
 * that model YEAR, not about the family. Every failure mode returns false.
 *
 * `deps` exists so the eval can EXECUTE this whole resolver — the year it looks up, and the fact that
 * it consults holds/solds at all — without a live feed fetch. Production never passes it.
 */
export async function tradeAdfPurchaseIsOnFloor(args: {
  year?: string | null;
  model?: string | null;
  deps?: {
    findMatches?: (opts: { year?: string | null; model?: string | null }) => Promise<
      Array<{ stockId?: string | null; vin?: string | null }>
    >;
    loadHolds?: () => Promise<Record<string, unknown>>;
    loadSolds?: () => Promise<Record<string, unknown>>;
  };
}): Promise<boolean> {
  const model = String(args.model ?? "").trim();
  if (!tradeAdfPurchaseTargetIsAssertable(model)) return false;
  const findMatches = args.deps?.findMatches ?? findInventoryMatches;
  const loadHolds = args.deps?.loadHolds ?? listInventoryHolds;
  const loadSolds = args.deps?.loadSolds ?? listInventorySolds;
  try {
    const year = String(args.year ?? "").trim();
    const matches = await findMatches({ year: year || null, model });
    if (!matches.length) return false;
    const [holds, solds] = await Promise.all([loadHolds(), loadSolds()]);
    return tradeAdfPurchaseUnitIsAvailable({ matches, holds, solds });
  } catch {
    return false;
  }
}
