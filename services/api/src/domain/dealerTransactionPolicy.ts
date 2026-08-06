/**
 * Dealer-transaction-policy: the deterministic keyword scan, and what it is allowed to decide.
 *
 * Lifted out of `index.ts` unchanged so the route's machinery sits next to the referee that governs
 * it (`resolveDealerTransactionPolicySource`, inboundPipeline.ts). Behaviour-preserving move — the
 * only thing that changed is where it lives.
 *
 * READ THIS BEFORE TRUSTING `parseDealerTransactionPolicyFallback`. It fires on the mere PRESENCE of
 * "private seller" / "another dealer" / "marketplace" and then asserts `explicitRequest: true` at a
 * hardcoded 0.76 — deliberately just over the 0.74 accept gate it is bypassing. It cannot tell a
 * customer ASKING whether we broker private-party deals from a customer MENTIONING that he is also
 * talking to a private seller. On 2026-08-06 that cost a live buyer his answer: he asked our price,
 * the parser correctly read `none`, and on the one replay where the parser reported 0.72 instead of
 * 0.86 this scan overrode it and told him we cannot facilitate a private-party sale.
 *
 * So it is a LAST resort, reached only when the parser produced no reading at all. The precedence is
 * enforced in one place and pinned by `dealer_transaction_policy_precedence:eval`.
 */
import type { DealerTransactionPolicyParse } from "./llmDraft.js";

export type DealerTransactionPolicyDecision = DealerTransactionPolicyParse & {
  source: "parser" | "fallback";
};

export function hasDealerTransactionPolicyParserHint(text: string | null | undefined): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  const riderToRider = /\brider\s*(?:to|2|-)?\s*rider\b/.test(t) || /\br2r\b/.test(t);
  const thirdParty =
    /\b(private\s+(?:seller|party)|third[-\s]?party|outside seller|facebook marketplace|marketplace seller|craigslist)\b/.test(
      t
    ) ||
    /\b(another|other)\s+dealer\b/.test(t) ||
    /\bdealer\s+trade\b/.test(t) ||
    /\b(?:facilitate|facilitating|broker|handle|process)\b[\s\S]{0,90}\b(?:private|seller|party|marketplace|another dealer|other dealer|third[-\s]?party|used bike)\b/.test(
      t
    ) ||
    /\b(?:buy|purchase|acquire)\s+(?:this|that|the)\s+bike\b[\s\S]{0,140}\btrade\s+(?:mine|my\s+bike|my\s+motorcycle)\b/.test(
      t
    ) ||
    /\btrade\s+(?:mine|my\s+bike|my\s+motorcycle)\s+(?:on|toward|towards)\s+(?:it|this|that|the\s+bike)\b/.test(
      t
    );
  return riderToRider || thirdParty;
}

export function parseDealerTransactionPolicyFallback(text: string): DealerTransactionPolicyDecision | null {
  const t = String(text ?? "").toLowerCase();
  if (!hasDealerTransactionPolicyParserHint(t)) return null;
  const asksRiderToRiderFinancing =
    (/\brider\s*(?:to|2|-)?\s*rider\b/.test(t) || /\br2r\b/.test(t)) &&
    /\b(finance|financing|program|work|participate|offer)\b/.test(t);
  const asksPrivateSellerFacilitation =
    /\b(private\s+(?:seller|party)|third[-\s]?party|outside seller|facebook marketplace|marketplace seller|craigslist)\b/.test(
      t
    );
  const asksExternalDealerFacilitation =
    /\b(another|other)\s+dealer\b/.test(t) || /\bdealer\s+trade\b/.test(t);
  if (!asksRiderToRiderFinancing && !asksPrivateSellerFacilitation && !asksExternalDealerFacilitation) {
    return null;
  }
  const intent: DealerTransactionPolicyParse["intent"] =
    asksRiderToRiderFinancing && (asksPrivateSellerFacilitation || asksExternalDealerFacilitation)
      ? "rider_to_rider_and_third_party"
      : asksRiderToRiderFinancing
        ? "rider_to_rider_financing"
        : asksPrivateSellerFacilitation
          ? "private_seller_facilitation"
          : "external_dealer_facilitation";
  return {
    intent,
    explicitRequest: true,
    asksRiderToRiderFinancing,
    asksPrivateSellerFacilitation,
    asksExternalDealerFacilitation,
    confidence: 0.76,
    source: "fallback"
  };
}
