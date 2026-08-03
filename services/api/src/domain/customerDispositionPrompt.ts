// ---------------------------------------------------------------------------
// Customer-disposition parser prompt surface: the strict JSON schema + the
// few-shot corpus for parseCustomerDispositionWithLLM (llmDraft.ts).
//
// Extracted from llmDraft.ts verbatim (behavior-preserving move) so the prompt
// the de-tangle program keeps editing lives in a file a human can read, and so
// llmDraft.ts pays for its own growth under source_size_ratchet:eval.
// ---------------------------------------------------------------------------
export const CUSTOMER_DISPOSITION_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: [
    "disposition",
    "explicit_disposition",
    "timeframe_text",
    "sell_to_dealer_interest",
    "confidence"
  ],
  properties: {
    disposition: {
      type: "string",
      enum: [
        "none",
        "sell_on_own",
        "keep_current_bike",
        "stepping_back",
        "defer_no_window",
        "defer_with_window"
      ]
    },
    explicit_disposition: { type: "boolean" },
    timeframe_text: { type: "string" },
    // Dealer parlance: "sell outright" = the customer wants to sell their bike TO US for
    // cash (an acquisition lead), NOT sell it on their own. Deliberately a separate slot
    // rather than a `disposition` member — it is the opposite of a closeout.
    sell_to_dealer_interest: { type: "boolean" },
    confidence: { type: "number" }
  }
};

export const CUSTOMER_DISPOSITION_EXAMPLES: string[] = [
  `EXAMPLE A
inbound: "I think I'm going to keep my bike and hold off for now."
output: {"disposition":"keep_current_bike","explicit_disposition":true,"timeframe_text":"","sell_to_dealer_interest":false,"confidence":0.96}`,
  `EXAMPLE B
inbound: "I'm just going to sell it myself."
output: {"disposition":"sell_on_own","explicit_disposition":true,"timeframe_text":"","sell_to_dealer_interest":false,"confidence":0.97}`,
  // B2 pins the production miss (+17169831712, 2026-07-23): staff asked "trading the bike in
  // or you want to sell outright?" and "Sell it outright." was read as sell_on_own @0.98 -
  // the lead was closed + paused_indefinite instead of routed to a cash appraisal.
  `EXAMPLE B2
out: "are you looking into trading the bike in or you want to sell outright?"
inbound: "Sell it outright."
output: {"disposition":"none","explicit_disposition":false,"timeframe_text":"","sell_to_dealer_interest":true,"confidence":0.95}`,
  `EXAMPLE B3
inbound: "I just want to sell it to you guys outright, not trade it in."
output: {"disposition":"none","explicit_disposition":false,"timeframe_text":"","sell_to_dealer_interest":true,"confidence":0.96}`,
  `EXAMPLE B4
inbound: "I think I'll just list it on Marketplace and sell it privately."
output: {"disposition":"sell_on_own","explicit_disposition":true,"timeframe_text":"","sell_to_dealer_interest":false,"confidence":0.96}`,
  `EXAMPLE C
inbound: "Price is too high right now, maybe after tax return."
output: {"disposition":"defer_with_window","explicit_disposition":true,"timeframe_text":"after tax return","sell_to_dealer_interest":false,"confidence":0.93}`,
  `EXAMPLE C2
inbound: "I can't do it now but I'm thinking maybe next spring."
output: {"disposition":"defer_with_window","explicit_disposition":true,"timeframe_text":"next spring","sell_to_dealer_interest":false,"confidence":0.94}`,
  `EXAMPLE C3
inbound: "Alright let me think about it i will get back to you in several days"
output: {"disposition":"defer_with_window","explicit_disposition":true,"timeframe_text":"in several days","sell_to_dealer_interest":false,"confidence":0.94}`,
  `EXAMPLE C4
inbound: "Give me a few days to think it over and I will let you know"
output: {"disposition":"defer_with_window","explicit_disposition":true,"timeframe_text":"a few days","sell_to_dealer_interest":false,"confidence":0.93}`,
  `EXAMPLE C5
inbound: "Okay. Im waiting on two other dealers to get back to me. I should have a decision soon. Then ill leave a deposit and talk financing or cash price at that point."
output: {"disposition":"defer_with_window","explicit_disposition":true,"timeframe_text":"soon","sell_to_dealer_interest":false,"confidence":0.9}`,
  `EXAMPLE D
inbound: "I need to talk to my wife first."
output: {"disposition":"none","explicit_disposition":false,"timeframe_text":"","sell_to_dealer_interest":false,"confidence":0.86}`,
  `EXAMPLE E
inbound: "I have $2,500 down and want to stay under $500/month."
output: {"disposition":"none","explicit_disposition":false,"timeframe_text":"","sell_to_dealer_interest":false,"confidence":0.96}`,
  `EXAMPLE F
inbound: "Do you have any black Street Glides in stock?"
output: {"disposition":"none","explicit_disposition":false,"timeframe_text":"","sell_to_dealer_interest":false,"confidence":0.96}`,
  `EXAMPLE G
inbound: "I'm going to keep mine for now, but can you call me next month?"
output: {"disposition":"keep_current_bike","explicit_disposition":true,"timeframe_text":"next month","sell_to_dealer_interest":false,"confidence":0.92}`,
  `EXAMPLE H
inbound: "You can hold off. Thanks"
output: {"disposition":"stepping_back","explicit_disposition":true,"timeframe_text":"","sell_to_dealer_interest":false,"confidence":0.95}`,
  `EXAMPLE I
inbound: "I'll pass man. I just like to ride the new models and check them out. Not a big deal. Thx"
output: {"disposition":"stepping_back","explicit_disposition":true,"timeframe_text":"","sell_to_dealer_interest":false,"confidence":0.94}`,
  `EXAMPLE J
inbound: "I have to cancel coming to you Tuesday. I'm having service done on the bike and inspection. I need to do a few more things before I can sell. I'll get back to you."
output: {"disposition":"defer_no_window","explicit_disposition":true,"timeframe_text":"","sell_to_dealer_interest":false,"confidence":0.93}`,
  `EXAMPLE K
inbound: "Thanks Joe. I'm all set on the bike search for the time being. Appreciate your help. I'll reach out when I'm looking again."
output: {"disposition":"defer_no_window","explicit_disposition":true,"timeframe_text":"","sell_to_dealer_interest":false,"confidence":0.94}`,
  `EXAMPLE L
inbound: "I'm not looking right now but I'll get a hold of you when I'm ready."
output: {"disposition":"defer_no_window","explicit_disposition":true,"timeframe_text":"","sell_to_dealer_interest":false,"confidence":0.93}`,
  `EXAMPLE M
inbound: "We are out of town, but I think I will wait on deciding whether to get a Harley. Thanks for checking in with me."
output: {"disposition":"defer_no_window","explicit_disposition":true,"timeframe_text":"","sell_to_dealer_interest":false,"confidence":0.94}`,
  `EXAMPLE N
inbound: "Ill pass man. I was in sat for a part for my brother's bike but it was pouring. I just like to ride the new models and ck em out. Not a big deal. Thx"
output: {"disposition":"stepping_back","explicit_disposition":true,"timeframe_text":"","sell_to_dealer_interest":false,"confidence":0.94}`,
  `EXAMPLE O
inbound: "Yes, Scott he bought a 2016 with about 10,000 about a week ago in Ohio. I forgot to tell you thank you I appreciate it."
output: {"disposition":"stepping_back","explicit_disposition":true,"timeframe_text":"","sell_to_dealer_interest":false,"confidence":0.94}`,
  `EXAMPLE P
inbound: "I ended up buying a 2016 in Ohio. Thank you, I appreciate it."
output: {"disposition":"stepping_back","explicit_disposition":true,"timeframe_text":"","sell_to_dealer_interest":false,"confidence":0.95}`,
  `EXAMPLE Q
inbound: "Got into a horse driving accident and broke 5 ribs and punctured a lung I'll have to pass at this point"
output: {"disposition":"stepping_back","explicit_disposition":true,"timeframe_text":"","sell_to_dealer_interest":false,"confidence":0.96}`,
  `EXAMPLE R
inbound: "I am going to take care of the pipes myself"
output: {"disposition":"none","explicit_disposition":false,"timeframe_text":"","sell_to_dealer_interest":false,"confidence":0.95}`,
  `EXAMPLE S
inbound: "Sounds like it could be a nice bike but a little out of my current price range. Thank you though."
output: {"disposition":"none","explicit_disposition":false,"timeframe_text":"","sell_to_dealer_interest":false,"confidence":0.9}`,
  `EXAMPLE T
inbound: "Money's just too tight right now, I've got to stop looking for a while."
output: {"disposition":"defer_no_window","explicit_disposition":true,"timeframe_text":"","sell_to_dealer_interest":false,"confidence":0.92}`,
  `EXAMPLE U
inbound: "Im still interested but not in the market right now. I do however still like to know when bikes come in! Could o see pictures of that 883 and the price?"
output: {"disposition":"none","explicit_disposition":false,"timeframe_text":"","sell_to_dealer_interest":false,"confidence":0.94}`,
  `EXAMPLE V
inbound: "Not buying today but definitely keep me posted when something comes in. How many miles on that one?"
output: {"disposition":"none","explicit_disposition":false,"timeframe_text":"","sell_to_dealer_interest":false,"confidence":0.93}`,
  `EXAMPLE W
out: "Hey Shad, happy to send a short list. What style are you leaning toward, and should I focus on new, used, or both? If you want, share your budget range and I will keep it dialed in."
inbound: "Sorry been busy with work most likely used and the lowest monthly payments is the best for me at this moment as I have alot of hospital bills for my daughter which is not in the best health at the moment.  Thank you sincerely, Shad stymus."
output: {"disposition":"none","explicit_disposition":false,"timeframe_text":"","sell_to_dealer_interest":false,"confidence":0.93}`,
  `EXAMPLE X
out: "What style are you leaning toward, and should I focus on new, used, or both?"
inbound: "Sorry for the slow reply, work has been nuts. Probably used, and honestly the lowest monthly payment I can get is what matters most to me right now."
output: {"disposition":"none","explicit_disposition":false,"timeframe_text":"","sell_to_dealer_interest":false,"confidence":0.93}`,
  // Y pins the production miss (Robert Spencer +17169408998, 2026-07-30): a service lead was
  // promised "our service department will reach out shortly", nobody did, and his chase-up
  // "Forget about me?" was read as stepping_back @0.9 - the lead we had already let down was
  // CLOSED with "I hear you. If anything changes down the road, just give me a shout."
  `EXAMPLE Y
out: "Thanks — I’ve received your service request. I’ll have our service department reach out shortly."
inbound: "Forget about me?"
output: {"disposition":"none","explicit_disposition":false,"timeframe_text":"","sell_to_dealer_interest":false,"confidence":0.95}`,
  // Z pins the production miss (Todd Glynn +17164490433, 2026-04-30): a test-ride lead waiting
  // on his son's co-decision ("on hold kinda till my son decides if he is going to get one
  // also") was read as stepping_back - a warm TWO-bike household got the goodbye taper and the
  // lead was closed. Waiting on another person is the EXAMPLE D class, not a closeout.
  `EXAMPLE Z
out: "If the test ride for the Road Glide Limited is still on your list, I can help get it set up."
inbound: "I'm on hold kinda till my son decides if he is going to get one also"
output: {"disposition":"none","explicit_disposition":false,"timeframe_text":"","sell_to_dealer_interest":false,"confidence":0.9}`
  ];
