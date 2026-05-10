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

function normalizeVehicleCondition(condition?: string | null): "new" | "used" | null {
  const t = String(condition ?? "").toLowerCase();
  if (!t.trim()) return null;
  if (/\bnew\b/.test(t)) return "new";
  if (/\b(used|pre[-\s]?owned|preowned)\b/.test(t)) return "used";
  return null;
}

function conditionExportEnabled(policy: any, condition: "new" | "used"): boolean | null {
  if (!policy || typeof policy !== "object") return null;
  const candidates =
    condition === "new"
      ? [policy.newVehicleExportEnabled, policy.newVehiclesEnabled, policy.newEnabled, policy.exportNewVehicles]
      : [policy.usedVehicleExportEnabled, policy.usedVehiclesEnabled, policy.usedEnabled, policy.exportUsedVehicles];
  for (const value of candidates) {
    if (typeof value === "boolean") return value;
  }
  return null;
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

export function internationalVehicleExportEnabled(
  profile: any,
  condition?: string | null
): boolean | null {
  const normalizedCondition = normalizeVehicleCondition(condition);
  for (const candidate of policyCandidates(profile)) {
    if (!candidate || typeof candidate !== "object") continue;
    if (normalizedCondition) {
      const conditionEnabled = conditionExportEnabled(candidate, normalizedCondition);
      if (conditionEnabled != null) return conditionEnabled;
    }
    const newEnabled = conditionExportEnabled(candidate, "new");
    const usedEnabled = conditionExportEnabled(candidate, "used");
    if (newEnabled != null || usedEnabled != null) {
      return newEnabled === true || usedEnabled === true;
    }
  }
  return internationalShippingEnabled(profile);
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

export function shouldDeclineInternationalShipping(
  profile: any,
  text?: string | null,
  options?: { vehicleCondition?: string | null }
): boolean {
  if (!isInternationalShippingInquiry(text)) return false;
  return internationalVehicleExportEnabled(profile, options?.vehicleCondition) === false;
}

export function buildInternationalShippingUnavailableReply(profile: any): string {
  return (
    internationalShippingDisabledResponse(profile) ||
    "Thanks for reaching out. We don't ship internationally, but I appreciate you checking with us."
  );
}
