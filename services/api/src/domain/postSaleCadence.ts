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

const USED_HINT = /\b(used|pre[\s-]?owned|cpo|certified\s+pre)\b/i;

function condText(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
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
  return conds.some(c => c === "new");
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
