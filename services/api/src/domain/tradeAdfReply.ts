// Acknowledgment for a trade/sell ADF — a FORM submission, NOT a customer question.
//
// The orchestrator's trade template used to open every trade turn with
// "Totally fair question. I have you on a …", which is correct only when a CUSTOMER
// actually asked something over SMS. An ADF web-lead is a structured form; its body
// ("Inquiry: trade-in appraisal request") trips the same trade/appraisal keywords, so
// the form got answered as if it were a question — and, mid-conversation, cold
// ("I have you on a 2008 Suzuki…") while a live finance deal was in flight
// (Laricuss Nelson, Ref 11466).
//
// This builder produces the right framing for an ADF trade form:
//   - initial: a clean intake; the agent intro is added downstream by
//     applyInitialAdfPrefix, so this text carries no greeting of its own.
//   - mid-conversation: ties the trade to the existing relationship instead of
//     re-introducing cold.
// The "Totally fair question" template stays for genuine customer-SMS trade questions.
import { isPlaceholderModel } from "./modelDeflection.js";

export function buildTradeAdfAck(args: {
  bikeLabel?: string | null;
  // A DISTINCT purchase vehicle the customer named on a trade-toward-buy lead (the structured ADF
  // `vehicle` field, separate from the trade-in). When present, the ack acknowledges the bike they
  // want — not just the trade (steven osipovitch, 2026-06-26: a Trade Accelerator lead naming a 2016
  // Trike Freewheeler got "I got your trade-in request for your Ryker" with no mention of the bike he
  // wants to buy). Keyed on STRUCTURED fields (vehicle vs tradeVehicle), not free-text comprehension.
  purchaseLabel?: string | null;
  midConversation: boolean;
}): string {
  const bike = String(args.bikeLabel ?? "").trim() || "your bike";
  const purchaseRaw = String(args.purchaseLabel ?? "").trim();
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  // Only weave the purchase in when it's REAL and DISTINCT from the trade. Guards against ADF feeds
  // that duplicate the trade into the vehicle field (or a buy lead mis-tagged with a trade), which
  // would otherwise read "trade your X toward the X". Also drop placeholder/make-only targets
  // ("Harley-Davidson Other", "Full Line") — a Trade Accelerator ADF whose `vehicle` field is a
  // placeholder would otherwise read "trade your Road King toward the 2026 Harley-Davidson Other"
  // (Gene Campana, Ref 11551, 2026-06-26 — staff stripped the fabricated target). Falling through to
  // the no-purchase branch ("I got your trade-in request for X") matches the human correction.
  // Deterministic placeholder classification (a known field value, not comprehension) via the shared
  // isPlaceholderModel; fail-direction safe — when the target is a non-bookable placeholder we ask
  // what they want instead of asserting a model.
  const purchase =
    purchaseRaw &&
    norm(purchaseRaw) !== norm(bike) &&
    !/^your bike$/i.test(purchaseRaw) &&
    !isPlaceholderModel(purchaseRaw)
      ? purchaseRaw
      : "";

  if (args.midConversation) {
    return purchase
      ? `Thanks — I got your request to trade your ${bike} toward the ${purchase}. ` +
          `We can fold that into what we're already working on — a quick in-person appraisal gets you a firm number, and we'll go over the ${purchase} while you're here. ` +
          "What day and time works best to stop in?"
      : `Thanks — I got your trade-in request for ${bike}. ` +
          "We can fold that into what we're already working on — a quick in-person appraisal gets you a firm number. " +
          "What day and time works best to stop in?";
  }
  return purchase
    ? `Thanks — I got your request to trade your ${bike} toward the ${purchase}. ` +
        `We can give you a firm number after a quick in-person appraisal, and go over the ${purchase} while you're here. ` +
        "What day and time works best to stop in?"
    : `Thanks — I got your trade-in request for ${bike}. ` +
        "We can give you a firm number after a quick in-person appraisal. " +
        "What day and time works best to stop in?";
}
