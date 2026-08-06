// Lead-unit hold/sold disclosure for the LIVE reply paths (the Ryan Tower class,
// +15857278545, LEA-238, 2026-07-04): the customer's lead names an EXACT unit
// (stock#/VIN), that unit goes on hold for a DIFFERENT customer, and the reply
// path kept quoting payments and confirming purchase logistics without ever
// disclosing the hold. The pure route decision lives in
// routeStateReducer.decideLeadUnitAvailabilityDisclosure; this module owns the
// customer-facing sentence and the deterministic append (both eval-pinned by
// scripts/lead_unit_hold_disclosure_eval.ts). Wired at BOTH publish funnels in
// services/api/src/index.ts — publishLiveTwilioReply (/webhooks/twilio early
// replies) and publishCustomerReplyDraft (main pipeline + /conversations/:id/
// regenerate + widget + dealer-ride) — so live and regenerate stay in parity.

export type LeadUnitAvailabilityDisclosureContext = {
  kind: "hold" | "sold";
  unitLabel: string;
};

// Does THIS conversation own the hold/sold record for the lead's unit? Both inventory stores
// stamp the conversation the record belongs to (convId + leadKey), so a "sold" record sitting on
// the BUYER's own thread is their purchase, not lost inventory — the reply path and the cadence
// override must both stay quiet about availability there (Charles Desalvo +17168614216, 2026-08-06:
// two days after delivery the draft told him his own Street Glide was "no longer available").
//
// Pure and deterministic (an id comparison, not comprehension). Fail direction: an ownerless or
// mismatched record returns FALSE = disclose = today's behavior, so this can only ever make us
// quieter toward the person who already bought the bike.
export function isUnitRecordOwnedByConversation(
  record: { convId?: string | null; leadKey?: string | null } | null | undefined,
  conv: { id?: string | null; leadKey?: string | null } | null | undefined
): boolean {
  const recordConvId = String(record?.convId ?? "").trim();
  const recordLeadKey = String(record?.leadKey ?? "").trim();
  const convId = String(conv?.id ?? "").trim();
  const convLeadKey = String(conv?.leadKey ?? "").trim();
  if (recordConvId && convId && recordConvId === convId) return true;
  if (recordLeadKey && convLeadKey && recordLeadKey === convLeadKey) return true;
  return false;
}

// Belt-and-braces dedup: the cadence engine's buildCadenceLeadUnitAvailabilityOverride
// composes its own full "quick update — it's on hold" message, and a staff reply may
// already have said it. If the outgoing text (or a recent outbound) already discloses
// unavailability, appending again would read like a broken record.
export function textAlreadyDisclosesUnavailability(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  return (
    /\b(?:on hold|has a hold|deposit on it)\b/.test(t) ||
    /\bno longer available\b/.test(t) ||
    /\bmay (?:no longer|not) be available\b/.test(t)
  );
}

export function composeLeadUnitAvailabilityDisclosure(
  ctx: LeadUnitAvailabilityDisclosureContext
): string {
  const unit = String(ctx.unitLabel ?? "").trim() || "that bike";
  if (ctx.kind === "sold") {
    return `Quick heads up — the ${unit} is no longer available. I can line up similar in-stock options if you want, or keep an eye out and text you first when a match comes in.`;
  }
  return `Quick heads up — the ${unit} currently has a hold on it, so it may not be available. If it frees up I'll text you first, and I can line up similar in-stock options in the meantime.`;
}

// Append the disclosure to an outgoing reply. The reply still answers the
// customer's question first; the disclosure rides along as its own sentence.
// No-ops (returns the text unchanged) when the text already discloses.
export function appendLeadUnitAvailabilityDisclosure(
  text: string,
  ctx: LeadUnitAvailabilityDisclosureContext
): { text: string; appended: boolean } {
  const base = String(text ?? "").trim();
  if (!base) return { text, appended: false };
  if (textAlreadyDisclosesUnavailability(base)) return { text, appended: false };
  const disclosure = composeLeadUnitAvailabilityDisclosure(ctx);
  return { text: `${base}\n\n${disclosure}`, appended: true };
}
