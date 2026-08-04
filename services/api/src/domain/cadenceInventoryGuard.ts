import { getInventoryFeed, hasInventoryForModelYear } from "./inventoryFeed.js";

function normalizeGuardText(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceMentionsTradeSell(source: string): boolean {
  return (
    /\b(?:trade value|value my trade|value your trade|sell my bike|sell your bike|private party seller)\b/.test(
      source
    ) || /\btrade accelerator\b.*\bsell\b/.test(source)
  );
}

export function isTradeSellCadenceContext(conv: any): boolean {
  const bucket = normalizeGuardText(conv?.classification?.bucket);
  const cta = normalizeGuardText(conv?.classification?.cta);
  const source = normalizeGuardText(conv?.lead?.source ?? conv?.leadSource);
  const followUpReason = normalizeGuardText(conv?.followUp?.reason);
  const cadenceContext = normalizeGuardText(conv?.followUpCadence?.contextTag);
  const manualContext = normalizeGuardText(conv?.manualContext?.contextTag);
  const dialogState = normalizeGuardText(conv?.dialogState?.name);
  const usedVariantKeys = normalizeGuardText(
    conv?.followUpCadence?.usedVariants && typeof conv.followUpCadence.usedVariants === "object"
      ? Object.keys(conv.followUpCadence.usedVariants).join(" ")
      : ""
  );

  if (bucket === "trade_in_sell") return true;
  if (["value_my_trade", "sell_my_bike", "trade_in_value"].includes(cta)) return true;
  if (
    [
      followUpReason,
      cadenceContext,
      manualContext,
      dialogState,
      usedVariantKeys
    ].some(value =>
      /\b(?:private_party_seller|seller_photo_details_request|sell:pickup|trade_in_sell|value_my_trade|sell_my_bike)\b/.test(
        value
      )
    )
  ) {
    return true;
  }
  return sourceMentionsTradeSell(source);
}

/**
 * A proactive cadence line that OFFERS to keep an availability watch on the customer's model
 * — "…want me to keep an eye on the {model} for you?" (the inventory-cluster step-2 variant).
 *
 * Joe ruling 2026-07-19 (+17164184478 Chris Duchon): the agent offered to "keep an eye on"
 * a Fltrx Road Glide that is amply IN STOCK. You don't offer an availability watch on a bike
 * that's already on the lot — you invite the customer in to see it. This detector lets both
 * cadence builders drop the watch-offer variant when the model is confirmed in stock, falling
 * to the sibling "still interested / other options?" line. Deterministic side-effect/copy
 * selection (AGENTS.md permits deterministic for side-effect + copy routing), not comprehension.
 */
export function isWatchOfferCadenceVariant(text: string | null | undefined): boolean {
  const t = normalizeGuardText(text);
  if (!t) return false;
  return (
    /\bkeep an eye (?:out )?on\b/.test(t) ||
    /\bwatch (?:the|this|that|it)\b.*\bfor you\b/.test(t) ||
    /\b(?:let|text|ping|message) you (?:know )?when (?:one|it|a|the)\b/.test(t)
  );
}

/**
 * Drop watch-offer variants from a cadence variant pool WHEN the customer's model is confirmed
 * in stock. Never returns an empty pool — if excluding the watch offer would leave nothing (a
 * pool that was ONLY watch offers), the original pool is kept so a cadence touch still sends.
 * (When `inStock` is false — e.g. a feed outage returning false — the pool is returned
 * unchanged, so a legitimately out-of-stock watch offer is never wrongly suppressed.)
 */
export function excludeWatchOfferWhenInStock(variants: string[], inStock: boolean): string[] {
  if (!inStock || !Array.isArray(variants) || variants.length === 0) return variants;
  const filtered = variants.filter(v => !isWatchOfferCadenceVariant(v));
  return filtered.length ? filtered : variants;
}

export function inventoryItemMatchesRequestedYear(
  item: { year?: string | number | null; label?: string | null } | null | undefined,
  requestedYear: string | number | null | undefined
): boolean {
  const requested = String(requestedYear ?? "").match(/\b(?:19|20)\d{2}\b/)?.[0] ?? "";
  if (!requested) return true;
  const itemYear =
    String(item?.year ?? "").match(/\b(?:19|20)\d{2}\b/)?.[0] ??
    String(item?.label ?? "").match(/\b(?:19|20)\d{2}\b/)?.[0] ??
    "";
  return itemYear === requested;
}

export function filterCadenceUnavailableItemsByRequestedYear<T extends { year?: string | number | null; label?: string | null }>(
  items: T[],
  requestedYear: string | number | null | undefined,
  opts: { yearSearchBroadened: boolean }
): T[] {
  if (!opts.yearSearchBroadened) return items;
  return items.filter(item => inventoryItemMatchesRequestedYear(item, requestedYear));
}

/**
 * The lead's bike of interest is GONE from the lot — the LABEL-ONLY half of the value gate's
 * held/sold read.
 *
 * Steven Osipovitch (+15854653751, operator-reported 2026-07-25 "Cadence follow up mentioned a bike
 * we no longer have in stock"): a later-step cadence touch pitched "that 2016 Freewheeler would
 * qualify for the used bike financing we have at rates starting 7.29% APR" on a bike the store no
 * longer had. The existing read (leadUnitUnavailableForValueGate, index.ts) can only tell a unit is
 * gone when the LEAD carries a stockId/VIN to look up in the hold/sold ledgers; his Trade Accelerator
 * ADF carried only "2016 / Trike Freewheeler", so the guard returned false and the offer fired.
 * Same defect class as the Jason Roorda held-unit ruling (2026-07-28), one rung down in identifier
 * precision.
 *
 * Deterministic side-effect / copy-selection gate — AGENTS.md permits deterministic here: this reads
 * OUR OWN inventory feed, never customer intent. It reuses the SAME in-stock definition the sibling
 * watch-offer guard above already uses (hasInventoryForModelYear, yearDelta 1), so the two reads of
 * "is this model on the lot" cannot drift apart.
 *
 * FAIL DIRECTION: an empty feed (no URL, fetch failure, timeout — getInventoryFeed returns [] or a
 * stale/empty cache) is NOT evidence the bike is gone, so `feedHealthy` must be true before this can
 * suppress anything. When it does fire, the touch stays quiet — the value gate's own designed
 * anti-spam outcome — and the availability / held-inventory overrides still own the turn, because
 * they are evaluated BEFORE leadUnitUnavailable in evaluateProactiveCadenceValueGate.
 */
export function decideLeadModelGoneFromFeed(input: {
  hasSpecificModel: boolean;
  feedHealthy: boolean;
  modelInStock: boolean;
}): boolean {
  return !!input.hasSpecificModel && !!input.feedHealthy && !input.modelInStock;
}

/** Placeholder model labels an ADF leaves behind — never specific enough to call a unit "gone". */
const UNKNOWN_CADENCE_MODEL_RE =
  /^(?:n\/?a|na|none|unknown|other|tbd|new_model_interest|motorcycle|bike|harley[- ]davidson)$/i;

/**
 * Read half of the decision above: resolve the lead's OWN stated vehicle against the live feed.
 * Any failure returns false, i.e. keep today's behavior (send).
 */
export async function leadModelGoneFromInventoryFeed(conv: any): Promise<boolean> {
  try {
    const vehicle = conv?.lead?.vehicle ?? {};
    const model = String(vehicle?.model ?? "").trim();
    const year = String(vehicle?.year ?? "").trim();
    if (!model || UNKNOWN_CADENCE_MODEL_RE.test(model)) return false;
    const feed = await getInventoryFeed();
    return decideLeadModelGoneFromFeed({
      hasSpecificModel: true,
      feedHealthy: feed.length > 0,
      modelInStock: await hasInventoryForModelYear({ model, year: year || null, yearDelta: 1 })
    });
  } catch {
    return false;
  }
}
