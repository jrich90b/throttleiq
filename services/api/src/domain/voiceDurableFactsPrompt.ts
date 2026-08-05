// ---------------------------------------------------------------------------
// Voice durable-facts parser prompt surface: the strict JSON schema, the
// guideline block, and the few-shot corpus for parseVoiceDurableFactsWithLLM
// (llmDraft.ts).
//
// Extracted from llmDraft.ts verbatim (behavior-preserving move) so the prompt
// the de-tangle program keeps editing lives in a file a human can read, and so
// llmDraft.ts pays for its own growth under source_size_ratchet:eval.
// ---------------------------------------------------------------------------

export const VOICE_DURABLE_FACTS_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: [
    "quoted_unit",
    "discussed_unit",
    "quoted_price",
    "otd_price",
    "budget_max",
    "wants_preowned",
    "preferences",
    "blockers",
    "next_step_owner",
    "next_step_action",
    "next_step_due_text",
    "next_step_is_visit",
    "next_step_confidence",
    "confidence"
  ],
  properties: {
    quoted_unit: { type: "string" },
    discussed_unit: { type: "string" },
    quoted_price: { type: "number" },
    otd_price: { type: "number" },
    budget_max: { type: "number" },
    wants_preowned: { type: "boolean" },
    preferences: { type: "array", items: { type: "string" } },
    blockers: { type: "array", items: { type: "string" } },
    // The concrete NEXT STEP agreed on the call (the plan), if any:
    // owner "customer" = the customer's move ("I'll come in Saturday", "I'll think it
    // over and call you"); owner "staff" = a dealership promise only a human can keep
    // ("I'll send you numbers Monday", "I'll get your trade appraised"); "none" = no
    // concrete next step was agreed.
    next_step_owner: { type: "string", enum: ["customer", "staff", "none"] },
    next_step_action: { type: "string" },
    next_step_due_text: { type: "string" },
    // True when the CUSTOMER's next step is a physical visit to the store ("I'll come in
    // Saturday between 1:30 and 2"). False for non-visit steps (think it over, call back).
    next_step_is_visit: { type: "boolean" },
    next_step_confidence: { type: "number" }
  }
};

export const VOICE_DURABLE_FACTS_GUIDELINES: string[] = [
  "- quoted_unit: the specific unit a price was quoted for (e.g. \"2017 Breakout\"), empty string if no quote happened.",
  "- discussed_unit: the specific unit the CUSTOMER IS SHOPPING FOR on this call, quoted or not.",
  "  NEVER the bike they own, are trading in, or want to sell — that is not what they're shopping",
  "  for. Empty string when no specific purchase unit came up (sell/trade-only, service, or",
  "  generic browsing).",
  "- quoted_price / otd_price: dollar amounts actually quoted on the call; 0 when not stated. otd_price is the out-the-door total.",
  "- budget_max: the customer's stated ceiling in dollars; 0 when not stated.",
  "- wants_preowned: true only if the customer said they want used/pre-owned.",
  "- preferences: short durable wants (e.g. \"ape hangers\", \"long stretch rear tire\", \"engine guards\"). Empty array if none.",
  "- blockers: durable hesitations (e.g. \"deciding on physical stamina and finances\", \"needs new plates\"). Empty array if none.",
  "- next_step_owner: the concrete NEXT STEP agreed on the call, if any. \"customer\" when the",
  "  customer committed to a move (\"I'll come in Saturday\", \"I'll call you back after payday\").",
  "  \"staff\" when the dealership promised something a human must do (\"I'll send you numbers",
  "  Monday\", \"I'll get your trade appraised\"). \"none\" when nothing concrete was agreed —",
  "  vague pleasantries (\"talk soon\", \"we'll be in touch\") are none.",
  // CONDITIONAL staff promise. The call that forced this rule (James Bernsdorf +17167964264,
  // 2026-07-25): the rep said "If we're interested in buying it, I will call you", the
  // summarizer narrated it as "Dealer MAY contact him if interested", and the parser read the
  // hedge as uncertainty — 0.6-0.75, straddling the 0.7 next-step gate. Below the gate the plan
  // collapses to a breather and NO task is minted, so nobody ever decided on his bike and the
  // lead was taper-retired 10 days later with the promise unkept.
  "  A dealership promise is still \"staff\" when it is CONDITIONAL on something the STORE decides",
  "  (\"if we're interested in buying it, I'll call you\", \"if one comes in I'll let you know\",",
  "  \"I'll run it by my manager and get back to you\"): the customer hung up waiting on us, so",
  "  score next_step_confidence 0.85+, the same as for an unconditional promise. These summaries",
  "  are written in reported speech, so a hedge in the SUMMARY's wording (\"dealer MAY contact him",
  "  if interested\") is how a firm promise on the call gets narrated — it does not lower the",
  "  confidence that a staff-owed step exists. It is \"none\" only when no",
  "  action was promised at all, or the condition is entirely the CUSTOMER's to resolve",
  "  (\"call us if you decide to sell\") — then nobody at the store owes a move.",
  "- next_step_action: the promised action in a few words, empty when owner is none.",
  "- next_step_due_text: the stated day/date exactly as said (\"Saturday\", \"Monday\", \"July 25th\",",
  "  \"tomorrow\"); empty when no day was stated.",
  "- next_step_is_visit: true ONLY when the customer's next step is physically COMING IN to the",
  "  store (\"I'll come in Saturday between 1:30 and 2\", \"I'll stop by after work\"). False for",
  "  every non-visit step (think it over, call back, send documents) and for staff-owned steps.",
  "- next_step_confidence: 0 to 1 that a real next step with that owner was agreed; 0 when owner is none.",
  "- Never invent numbers. confidence 0 to 1 for the extraction overall."
];

export const VOICE_DURABLE_FACTS_EXAMPLES: string[] = [
  'EXAMPLE A summary: "Customer declines the billiard gray HDFXBR Breakout priced at twenty eight grand due to cost; he is interested in a pre-owned Breakout around fifteen grand (less than twenty)."',
  'EXAMPLE A output: {"quoted_unit":"","discussed_unit":"pre-owned Breakout","quoted_price":0,"otd_price":0,"budget_max":15000,"wants_preowned":true,"preferences":[],"blockers":["declined new at $28k as too expensive"],"next_step_owner":"none","next_step_action":"","next_step_due_text":"","next_step_is_visit":false,"next_step_confidence":0,"confidence":0.92}',
  'EXAMPLE B summary: "Customer asked prices for a Harley Breakout (pre-owned) and was quoted $14,995 asking price; with new plates, taxes, and fees the total was quoted as $16,534. Customer needs new plates. He said he will come by Saturday to look at it in person."',
  'EXAMPLE B output: {"quoted_unit":"pre-owned Breakout","discussed_unit":"pre-owned Breakout","quoted_price":14995,"otd_price":16534,"budget_max":0,"wants_preowned":true,"preferences":[],"blockers":["needs new plates"],"next_step_owner":"customer","next_step_action":"come by to look at the Breakout in person","next_step_due_text":"Saturday","next_step_is_visit":true,"next_step_confidence":0.94,"confidence":0.95}',
  'EXAMPLE C summary: "Customer wants to sell his 2015 Ultra Limited; Stone offered to have it appraised. No purchase discussed."',
  'EXAMPLE C output: {"quoted_unit":"","discussed_unit":"","quoted_price":0,"otd_price":0,"budget_max":0,"wants_preowned":false,"preferences":[],"blockers":[],"next_step_owner":"staff","next_step_action":"have the customer\'s 2015 Ultra Limited appraised","next_step_due_text":"","next_step_is_visit":false,"next_step_confidence":0.85,"confidence":0.93}',
  'EXAMPLE D summary: "Scott walked the customer through financing options on the 2024 Road Glide and promised to send over exact payment numbers on Monday. Customer said that sounds good."',
  'EXAMPLE D output: {"quoted_unit":"","discussed_unit":"2024 Road Glide","quoted_price":0,"otd_price":0,"budget_max":0,"wants_preowned":false,"preferences":[],"blockers":[],"next_step_owner":"staff","next_step_action":"send exact payment numbers on the 2024 Road Glide","next_step_due_text":"Monday","next_step_is_visit":false,"next_step_confidence":0.95,"confidence":0.9}',
  'EXAMPLE E summary: "Customer said he is still deciding between the Low Rider S and the Fat Bob and will think it over. No commitments either way."',
  'EXAMPLE E output: {"quoted_unit":"","discussed_unit":"","quoted_price":0,"otd_price":0,"budget_max":0,"wants_preowned":false,"preferences":[],"blockers":["still deciding between Low Rider S and Fat Bob"],"next_step_owner":"none","next_step_action":"","next_step_due_text":"","next_step_is_visit":false,"next_step_confidence":0,"confidence":0.9}',
  // The conditional staff promise, in the summarizer's own hedged register (see the guideline
  // block above). Deliberately NOT the James Bernsdorf wording that the eval fixture pins —
  // the fixture has to measure generalization, not recall of its own few-shot.
  'EXAMPLE F summary: "Customer wants to sell his 2019 Road King and is not buying a replacement. Dealer may reach out if interested in purchasing; no asking price was given and no appointment was set."',
  'EXAMPLE F output: {"quoted_unit":"","discussed_unit":"","quoted_price":0,"otd_price":0,"budget_max":0,"wants_preowned":false,"preferences":[],"blockers":[],"next_step_owner":"staff","next_step_action":"decide on a buy offer for the customer\'s 2019 Road King and call him back","next_step_due_text":"","next_step_is_visit":false,"next_step_confidence":0.9,"confidence":0.92}'
];
