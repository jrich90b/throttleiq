/**
 * Post-sale follow-up cadence — NEW vs PRE-OWNED split.
 *
 * The "Custom Coverage / full factory warranty on accessories" reminder is a NEW-bike
 * pitch; sending it after a pre-owned purchase is a false warranty claim. So
 * postSaleVehicleIsNew fails SAFE: a sale is treated as NEW only when there is a
 * confident "new" condition signal AND no "used"/"pre-owned" hint — otherwise pre-owned
 * (warm "enjoying the bike / anything you need" copy, no warranty claim). Origin: Marcy
 * received the factory-warranty reminder on a non-new purchase (post-sale cadence step 2).
 */

import { isPlaceholderModel } from "./modelDeflection.js";

const USED_HINT = /\b(used|pre[\s-]?owned|cpo|certified\s+pre)\b/i;

function condText(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

// A "new" condition on a bike this many model years old at sale time is a lying ADF field,
// not a new bike. Gap 2 stays NEW (genuine non-current new stock exists — a new '24 sold
// in '26 with incentives); gap >= 3 flips to pre-owned. Joe ruling 2026-07-09 (Kellen
// +17167995197): a 2019 Electra Glide sold in 2026 carried condition:"new" from the Dealer
// Lead App ADF and got the Custom Coverage / factory-warranty pitch — a false warranty claim.
const MAX_NEW_MODEL_YEAR_GAP = 2;

function yearNum(value: unknown): number | null {
  const n = Number(String(value ?? "").trim());
  return Number.isInteger(n) && n >= 1980 && n <= 2100 ? n : null;
}

/** True only when the sold unit is confidently NEW (fail-safe: unknown => pre-owned). */
export function postSaleVehicleIsNew(conv: any): boolean {
  const label = [
    conv?.sale?.label,
    conv?.sale?.model,
    conv?.sale?.trim,
    conv?.lead?.vehicle?.model,
    conv?.lead?.vehicle?.description
  ]
    .map(v => String(v ?? ""))
    .join(" ");
  if (USED_HINT.test(label)) return false;
  const conds = [
    condText(conv?.sale?.condition),
    condText(conv?.lead?.vehicle?.condition),
    condText(conv?.inventoryContext?.condition)
  ];
  if (conds.some(c => c === "used" || c === "preowned" || c === "pre-owned")) return false;
  if (!conds.some(c => c === "new")) return false;
  // Model-year sanity: the ADF condition field routinely lies; a bike whose model year is
  // more than MAX_NEW_MODEL_YEAR_GAP years older than the sale can't be new inventory.
  // Fails SAFE — flipping to pre-owned only softens the touch (no factory-warranty claim).
  const modelYear =
    yearNum(conv?.sale?.year) ?? yearNum(conv?.lead?.vehicle?.year) ?? yearNum(conv?.inventoryContext?.year);
  if (modelYear != null) {
    const soldAtMs = Date.parse(String(conv?.sale?.soldAt ?? conv?.closedAt ?? ""));
    const saleYear = Number.isFinite(soldAtMs) ? new Date(soldAtMs).getUTCFullYear() : new Date().getUTCFullYear();
    if (saleYear - modelYear > MAX_NEW_MODEL_YEAR_GAP) return false;
  }
  return true;
}

/**
 * Resolve the model label used in post-sale check-in copy ("Thanks again for coming to
 * see us for your {model}"). ADF lead sources (Traffic Log Pro, Meta promo) routinely
 * attach a PLACEHOLDER vehicle — "Harley-Davidson Full Line", "Other" — which is lead-form
 * junk, not a bike we can name; without a guard it leaked into a real customer text
 * ("Thanks again for coming to see us for your Full Line", +17163975098, 2026-07).
 *
 * Candidate precedence is unchanged from the original inline resolver (sale label, then
 * joined sale fields, then lead vehicle model, then description) — but every candidate is
 * screened through isPlaceholderModel (modelDeflection.ts), the same invariant helper every
 * other placeholder-suppression surface uses, BOTH raw and after the caller's display
 * normalization (the normalizer strips the make prefix, so "Harley-Davidson Full Line"
 * would otherwise come back as a plausible-looking "Full Line").
 *
 * Deterministic is correct here: classifying our OWN lead/sale field values is structured
 * extraction, not customer comprehension. FAIL DIRECTION: safe — a false-positive
 * placeholder call only downgrades copy to the generic "bike" (the established rendering
 * for unknown models, Joe 2026-06-21); a false negative is the junk-leak bug itself.
 */
export function resolvePostSaleModelLabel(conv: any, normalize: (raw: string) => string): string {
  const sale = conv?.sale ?? {};
  const saleLabel =
    String(sale?.label ?? "").trim() ||
    [sale?.year, sale?.make, sale?.model, sale?.trim, sale?.color]
      .filter(Boolean)
      .join(" ")
      .trim();
  const candidates = [saleLabel, conv?.lead?.vehicle?.model, conv?.lead?.vehicle?.description];
  for (const candidate of candidates) {
    const raw = String(candidate ?? "").trim();
    if (!raw || isPlaceholderModel(raw)) continue;
    const normalized = String(normalize(raw) ?? "").trim();
    if (normalized && !isPlaceholderModel(normalized)) return normalized;
  }
  return "bike";
}

/**
 * The post-sale cadence message that differs by purchase condition (step index 1):
 * - NEW => the Custom Coverage / factory-warranty accessory reminder.
 * - PRE-OWNED => a warm "hope you're enjoying it / anything you need, let me know" check-in
 *   with NO factory-warranty claim.
 */
export function postSaleAccessoryOrEnjoyMessage(args: {
  firstName: string;
  repName: string;
  dealerName: string;
  bikeModel: string;
  isNewBike: boolean;
}): string {
  const { firstName, repName, dealerName, bikeModel, isNewBike } = args;
  // Charter: a post-sale follow-up is NOT a first touch, so the full dealer brand name
  // must be framed as a light re-intro ("this is {rep} at {dealer}") — a bare
  // "{rep} at {dealer}" trips the voice-charter long_brand_repeat check. The re-intro also
  // reads naturally weeks after purchase, when the customer may not have the rep saved.
  if (isNewBike) {
    return `Hi ${firstName} — this is ${repName} at ${dealerName}. Quick reminder about Custom Coverage. Any Harley-Davidson accessory we install will go under your full factory warranty on the bike. If you have questions, just let me know.`;
  }
  return `Hi ${firstName} — this is ${repName} at ${dealerName}. Hope you're enjoying the ${bikeModel}! If there's anything you need for it, just let me know.`;
}
