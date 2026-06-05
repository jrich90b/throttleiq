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
