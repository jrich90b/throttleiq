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
import { buildAgentIntro } from "./agentVoice.js";

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
  // must be framed as a light re-intro — a bare "{rep} at {dealer}" trips the voice-charter
  // long_brand_repeat check. The re-intro also reads naturally weeks after purchase, when the
  // customer may not have the rep saved. Wording is the canonical softened intro
  // (buildAgentIntro → "Hey {name}, it's {rep} over at {dealer}."): this cadence was the single
  // biggest remaining source of the OLD "this is {rep} at {dealer}" form reaching customers
  // (~24 sends in July 2026), and Joe ruled 2026-07-29 that "over at" is the wording he wants.
  const intro = buildAgentIntro(firstName, repName, dealerName);
  if (isNewBike) {
    return `${intro}Quick reminder about Custom Coverage. Any Harley-Davidson accessory we install will go under your full factory warranty on the bike. If you have questions, just let me know.`;
  }
  return `${intro}Hope you're enjoying the ${bikeModel}! If there's anything you need for it, just let me know.`;
}

/**
 * WHICH stranded sold leads a post-sale backfill may re-arm — and, far more often, may not.
 *
 * #519 taught the cadence referee that closing a lead BECAUSE IT SOLD must not kill the owner
 * sequence the sale just armed. It is forward-only: records already frozen stay frozen. This
 * decides which of those the repair script may touch, and it is deliberately the narrowest rule
 * that still fixes the reported defect.
 *
 * WHY IT IS THIS NARROW (measured on the live store, 2026-08-05). The naive selector — "sold, and
 * no active post-sale chase" — matched 15 leads. Only 3 of them were stranded by the bug at all.
 * The rest had stopped for reasons that were entirely correct: `customer_stepping_back` (×4 — the
 * customer ASKED us to back off), `purchase_delivery` (×3), `in_process_deal`, `inventory_watch`,
 * `pending_incoming_inventory`. Re-arming those is not a repair, it is a new defect, and one aimed
 * at the customer least willing to hear from us. So selection asks the referee itself
 * (`isCadenceCloseSoldReason`) rather than carrying a second list that could drift from it.
 *
 * AND WHY AGE MATTERS. Of the 3 genuine victims, one (Charles Desalvo +17168614216, sold 8/3) was
 * two days old and was healed by hand on Joe's approval; the other two are 74 and 89 days old. A
 * "congratulations on the new bike" text three months after the sale reads as a system that has
 * lost track of the customer — worse than the silence it replaces. The ceiling exists so nobody
 * has to re-derive that judgement under time pressure with a `--write` flag already typed.
 *
 * FAIL DIRECTION: every uncertainty returns `heal: false` — no sale date, an unparseable date, a
 * future date, an unknown stop reason. `heal: false` is silence, which is exactly today's
 * behaviour for these records, so the worst case of a wrong answer here is that a human repairs one
 * lead by hand. The opposite mistake texts a real customer. `skipReason` is always populated so the
 * caller can SAY what it passed over — a heal that silently matched nothing must not read the same
 * as a heal that had nothing to do.
 */
export const POST_SALE_BACKFILL_MAX_AGE_DAYS = 14;

/** Follow-up modes that mean a human deliberately parked this thread. Never auto-resume one. */
const POST_SALE_BACKFILL_PARKED_MODES = new Set<string>(["paused_indefinite", "holding_inventory"]);

export type PostSaleBackfillDecision = { heal: boolean; skipReason: string | null };

export function decidePostSaleCadenceBackfill(input: {
  /** `followUpCadence.stopReason`, exactly as stored. */
  stopReason?: string | null;
  /** `followUp.mode`, exactly as stored. */
  followUpMode?: string | null;
  /** `sale.soldAt` — the anchor the owner sequence would run from. */
  soldAtIso?: string | null;
  /** "now", injected so an eval can pin a production record instead of racing the clock. */
  asOfIso: string;
  maxAgeDays?: number;
  isSoldCloseReason: (reason?: string | null) => boolean;
}): PostSaleBackfillDecision {
  if (!input.isSoldCloseReason(input.stopReason)) {
    const reason = String(input.stopReason ?? "").trim();
    return { heal: false, skipReason: `not_a_sold_close:${reason || "unknown"}` };
  }
  const mode = String(input.followUpMode ?? "").trim();
  if (POST_SALE_BACKFILL_PARKED_MODES.has(mode)) {
    return { heal: false, skipReason: `deliberately_parked:${mode}` };
  }
  const soldAtMs = Date.parse(String(input.soldAtIso ?? ""));
  const asOfMs = Date.parse(String(input.asOfIso ?? ""));
  if (!Number.isFinite(soldAtMs) || !Number.isFinite(asOfMs)) {
    return { heal: false, skipReason: "no_sale_date" };
  }
  const ageDays = (asOfMs - soldAtMs) / 86_400_000;
  if (ageDays < 0) return { heal: false, skipReason: "sale_date_in_future" };
  const ceiling = Number.isFinite(input.maxAgeDays as number)
    ? (input.maxAgeDays as number)
    : POST_SALE_BACKFILL_MAX_AGE_DAYS;
  if (ageDays > ceiling) {
    return { heal: false, skipReason: `too_old:${Math.floor(ageDays)}d>${ceiling}d` };
  }
  return { heal: true, skipReason: null };
}
