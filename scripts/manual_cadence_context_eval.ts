import {
  detectManualOutboundCadenceContext,
  isSparseManualConversationContext
} from "../services/api/src/domain/manualCadenceContext.ts";

type Case = {
  id: string;
  text: string;
  sparse?: boolean;
  expected: string | null;
};

const cases: Case[] = [
  {
    id: "nate_seller_photo_details",
    text: "Hey Nate, it's Joe at American Harley. Just shoot some pictures and details on the bike over to me. Thanks!",
    expected: "seller_photo_details_request"
  },
  {
    id: "seller_vin_miles",
    text: "Send me a few photos, the VIN, mileage, and payoff on your bike when you can.",
    expected: "seller_photo_details_request"
  },
  {
    id: "dealer_sends_buyer_list_not_seller",
    text: "Hey Nate, happy to send a short list. What style are you leaning toward?",
    expected: null
  },
  {
    id: "dealer_sends_photos_not_seller",
    text: "I can send you some pictures of the bike this afternoon.",
    expected: null
  },
  {
    id: "sparse_unknown_manual_context",
    text: "Hey Nate, thanks for the call. Text me back when you can.",
    sparse: true,
    expected: "manual_context_needed"
  }
];

for (const c of cases) {
  const conv = c.sparse ? { messages: [] } : undefined;
  const result = detectManualOutboundCadenceContext(c.text, conv);
  const actual = result?.contextTag ?? null;
  if (actual !== c.expected) {
    console.error(JSON.stringify({ id: c.id, expected: c.expected, actual, result }, null, 2));
    throw new Error(`manual cadence context failed: ${c.id}`);
  }
}

const sparse = isSparseManualConversationContext({ messages: [] });
if (!sparse) throw new Error("expected empty manual conversation to be sparse");

const notSparse = isSparseManualConversationContext({
  lead: { source: "Website", inquiry: "Interested in a bike" },
  messages: []
});
if (notSparse) throw new Error("expected lead-source conversation not to be sparse");

console.log(`PASS manual cadence context eval (${cases.length} cases)`);
