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
