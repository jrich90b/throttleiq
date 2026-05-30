import {
  detectManualOutboundCadenceContext,
  hasRecentContactedVoiceContext,
  isManualOutboundCreditAppNeedsMoreInfoText,
  isSparseManualConversationContext,
  shouldHoldManualFinanceDocsForRecentVoiceContact
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

const creditAppConv = {
  lead: {
    inquiry: "App ID: 1013910342, Model Year: 2025, Model: Heritage Classic"
  },
  messages: [
    {
      direction: "out",
      body: "Thanks - I received your credit application. I’ll have our finance team reach out shortly."
    }
  ]
};

const financeNeedsInfoCases = [
  {
    id: "manual_credit_app_needs_info_exact",
    text:
      "Hey Joseph, its Joe at American Harley-Davidson. Just following up on your credit application you submitted. Harley just needs some more info. I am heading out for the night, but ill be back in tomorrow if you have any questions.",
    conv: creditAppConv,
    expected: true
  },
  {
    id: "manual_harley_needs_info_with_credit_context",
    text: "Harley just needs a little more information before they can finish the application.",
    conv: creditAppConv,
    expected: true
  },
  {
    id: "generic_more_info_about_bike_not_finance",
    text: "Can you send me more info on the bike when you get a chance?",
    conv: { lead: { inquiry: "Interested in a 2025 Heritage Classic" }, messages: [] },
    expected: false
  },
  {
    id: "staff_offers_more_info_not_needed_by_finance",
    text: "If you need more info on the credit app, just let me know.",
    conv: creditAppConv,
    expected: false
  },
  {
    id: "manual_insurance_binder_request_is_finance_docs",
    text: "We will need the Insurance Cards and Insurance Binder (Verification of Insurance)",
    conv: {
      classification: { bucket: "finance_prequal", cta: "hdfs_coa" },
      messages: []
    },
    expected: true
  }
];

for (const c of financeNeedsInfoCases) {
  const actual = isManualOutboundCreditAppNeedsMoreInfoText(c.text, c.conv);
  if (actual !== c.expected) {
    console.error(JSON.stringify({ id: c.id, expected: c.expected, actual }, null, 2));
    throw new Error(`manual finance needs-info detection failed: ${c.id}`);
  }
}

const recentVoiceConv = {
  classification: { bucket: "finance_prequal", cta: "hdfs_coa" },
  voiceContext: {
    contacted: true,
    updatedAt: new Date().toISOString(),
    summary:
      "Customer wants the Fat Boy, will bring a licensed friend, needs insurance, and will provide a driver license photo and down payment."
  }
};
if (!hasRecentContactedVoiceContext(recentVoiceConv)) {
  throw new Error("expected recent contacted voice context to be recognized");
}
if (
  !shouldHoldManualFinanceDocsForRecentVoiceContact(
    "We will need the Insurance Cards and Insurance Binder (Verification of Insurance)",
    recentVoiceConv
  )
) {
  throw new Error("expected recent voice contact to hold finance-doc follow-up");
}

console.log(`PASS manual cadence context eval (${cases.length + financeNeedsInfoCases.length + 2} cases)`);
