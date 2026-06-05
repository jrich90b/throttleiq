import { isManualOutboundQuoteDeliveredText } from "../services/api/src/domain/manualCadenceContext.ts";
import {
  activateManualQuoteDeliveredFollowUp,
  isManualPriceConfirmHandoff
} from "../services/api/src/domain/manualQuoteFollowUp.ts";

function makeConv(overrides: any = {}) {
  return {
    id: "conv_michael",
    leadKey: "+16076549423",
    status: "open",
    createdAt: "2026-06-04T11:01:11.000Z",
    updatedAt: "2026-06-04T11:01:11.000Z",
    messages: [],
    followUp: {
      mode: "manual_handoff",
      reason: "price_confirm",
      updatedAt: "2026-06-04T11:01:20.957Z"
    },
    followUpCadence: {
      status: "stopped",
      anchorAt: "2026-06-04T11:01:20.957Z",
      stepIndex: 0,
      stopReason: "manual_handoff"
    },
    ...overrides
  };
}

const michaelQuoteText =
  "Hey Michael, sorry it took a little bit, got a little busy here on the floor. Here is a quote on that iron horse street glide limited. I have it priced at the billiard gray base color and there are no dealer prep/hd freight charges, so you would just have the taxes and dmv charges. 10k down at just a 60 mo term you would probably be looking around $500/mo";

const futurePricingText =
  "Hey Michael, this is Joe at American H-D. I will get a price worked up for you. Couple questions, what county would you be registering the bike in and do you have a trade?";

if (!isManualOutboundQuoteDeliveredText(michaelQuoteText, { hasMedia: true })) {
  throw new Error("expected delivered quote text to be detected");
}
if (isManualOutboundQuoteDeliveredText(futurePricingText)) {
  throw new Error("future pricing work should not be detected as delivered quote");
}

const conv = makeConv();
if (!isManualPriceConfirmHandoff(conv)) {
  throw new Error("expected price_confirm handoff recognition");
}
const activated = activateManualQuoteDeliveredFollowUp(conv as any, michaelQuoteText, {
  channel: "sms",
  hasMedia: true,
  nowIso: "2026-06-04T20:37:16.000Z",
  timezone: "America/New_York"
});
if (!activated) throw new Error("expected quote-delivered cadence activation");
if (conv.followUp?.mode !== "active" || conv.followUp?.reason !== "manual_quote_delivered") {
  throw new Error(`unexpected followUp state: ${JSON.stringify(conv.followUp)}`);
}
if (
  conv.followUpCadence?.status !== "active" ||
  conv.followUpCadence?.kind !== "engaged" ||
  conv.followUpCadence?.contextTag !== "manual_quote_delivered" ||
  !conv.followUpCadence?.nextDueAt ||
  conv.followUpCadence?.stopReason
) {
  throw new Error(`unexpected cadence state: ${JSON.stringify(conv.followUpCadence)}`);
}
if (conv.manualContext?.contextTag !== "manual_quote_delivered") {
  throw new Error(`unexpected manualContext: ${JSON.stringify(conv.manualContext)}`);
}

const stillWaiting = makeConv();
if (
  activateManualQuoteDeliveredFollowUp(stillWaiting as any, futurePricingText, {
    channel: "sms",
    nowIso: "2026-06-04T15:02:05.000Z",
    timezone: "America/New_York"
  })
) {
  throw new Error("should not activate cadence before quote is actually delivered");
}
if (stillWaiting.followUp?.mode !== "manual_handoff") {
  throw new Error("future pricing text should leave manual handoff intact");
}

const nonPriceHandoff = makeConv({
  followUp: {
    mode: "manual_handoff",
    reason: "service_request",
    updatedAt: "2026-06-04T11:01:20.957Z"
  }
});
if (
  activateManualQuoteDeliveredFollowUp(nonPriceHandoff as any, michaelQuoteText, {
    channel: "sms",
    hasMedia: true,
    timezone: "America/New_York"
  })
) {
  throw new Error("quote text outside price_confirm handoff should not mutate cadence");
}

const callOnly = makeConv({ contactPreference: "call_only" });
if (
  activateManualQuoteDeliveredFollowUp(callOnly as any, michaelQuoteText, {
    channel: "sms",
    hasMedia: true,
    timezone: "America/New_York"
  })
) {
  throw new Error("call-only conversations should not start SMS/email follow-up cadence");
}

const room58 = makeConv({
  id: "conv_room58",
  followUp: {
    mode: "manual_handoff",
    reason: "room58_price_confirm",
    updatedAt: "2026-06-04T11:01:20.957Z"
  }
});
if (
  !activateManualQuoteDeliveredFollowUp(room58 as any, "Attached is the quote with payment numbers.", {
    channel: "sms",
    hasMedia: true,
    timezone: "America/New_York"
  })
) {
  throw new Error("room58 price handoff should recover after quote attachment");
}

console.log("PASS manual quote follow-up eval");
