export function isInternationalShippingInquiry(text?: string | null): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  const shippingSignal = /\b(ship|shipping|shipped|deliver|delivery|export|transport)\b/.test(t);
  const internationalSignal =
    /\b(international|internationally|outside (?:the )?(?:u\.?s\.?|united states|usa)|overseas|another country|out of country|export)\b/.test(
      t
    ) ||
    /\b(honduras|canada|mexico|uk|united kingdom|europe|australia|guatemala|el salvador|costa rica|panama)\b/.test(
      t
    );
  return shippingSignal && internationalSignal;
}

function policyCandidates(profile: any): any[] {
  const policies = profile?.policies && typeof profile.policies === "object" ? profile.policies : {};
  return [
    policies.internationalShipping,
    policies.vehicleShipping?.international,
    policies.shipping?.international,
    profile?.internationalShipping
  ];
}

export function internationalShippingEnabled(profile: any): boolean | null {
  for (const candidate of policyCandidates(profile)) {
    if (typeof candidate === "boolean") return candidate;
    if (candidate && typeof candidate === "object" && typeof candidate.enabled === "boolean") {
      return candidate.enabled;
    }
  }
  return null;
}

export function internationalShippingDisabledResponse(profile: any): string | null {
  for (const candidate of policyCandidates(profile)) {
    if (!candidate || typeof candidate !== "object") continue;
    const response =
      candidate.disabledResponse ??
      candidate.unavailableResponse ??
      candidate.response ??
      candidate.message ??
      candidate.text;
    if (typeof response === "string" && response.trim()) return response.trim();
  }
  return null;
}

export function shouldDeclineInternationalShipping(profile: any, text?: string | null): boolean {
  if (!isInternationalShippingInquiry(text)) return false;
  return internationalShippingEnabled(profile) === false;
}

export function buildInternationalShippingUnavailableReply(profile: any): string {
  return (
    internationalShippingDisabledResponse(profile) ||
    "Thanks for reaching out. We don't ship internationally, but I appreciate you checking with us."
  );
}
