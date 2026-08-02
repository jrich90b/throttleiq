/**
 * Prompt material for the conversation-state parser (`parseConversationStateWithLLM`), lifted out of
 * llmDraft.ts so that file — which holds every parser prompt and JSON schema in the product — can
 * keep shrinking under `source_size_ratchet:eval`. Pure data plus one pure predicate: no imports,
 * no I/O, nothing to run. The few-shots are the parser's comprehension, so they live together and
 * are reviewed together.
 */

/**
 * The certainty a `vendor_solicitation` verdict must clear before it is allowed to stand. Set well
 * above the parser's ordinary acceptance floor (0.74) on purpose: this is the only state intent
 * whose consequence is to STOP talking to the sender, so an uncertain verdict must decay to an
 * ordinary sales lead rather than silence a real buyer.
 */
export const VENDOR_SOLICITATION_CONFIDENCE_MIN = 0.88;

/**
 * The vendor demotion guard. Unlike hiring (a closed vocabulary: "resume", "hiring"), B2B pitch
 * language is open-ended, so a corroborating deterministic cue would be both leaky AND a new
 * comprehension regex (AGENTS.md forbids it; it would also push `twilio_comprehension_debt` off its
 * KEEP-floor). The guard is therefore the parser's OWN certainty.
 *
 * Fail direction: calling a real buyer a vendor silences them; calling a vendor a buyer merely
 * drafts a reply nobody sends. So anything short of explicit-and-confident reads as a customer.
 */
export function isVendorSolicitationVerdictConfident(parsed: {
  explicit_request?: unknown;
  confidence?: unknown;
}): boolean {
  return (
    !!parsed.explicit_request &&
    typeof parsed.confidence === "number" &&
    Number.isFinite(parsed.confidence) &&
    parsed.confidence >= VENDOR_SOLICITATION_CONFIDENCE_MIN
  );
}

/** Taxonomy + disambiguation lines spliced into the conversation-state parser prompt. */
export const VENDOR_SOLICITATION_PROMPT_RULES = [
  "",
  "Vendor solicitation rules (state_intent=vendor_solicitation) — the false-positive direction is the costly one:",
  "- IMPORTANT: a customer offering to SELL US THEIR OWN motorcycle (trade-in, 'what will you give me for my bike', 'sell my Road King') is NOT vendor_solicitation. That is a normal sales lead.",
  "- IMPORTANT: a customer asking about a bike, a price, financing for THEMSELVES, a test ride, or a service appointment is NEVER vendor_solicitation, no matter how formal or businesslike the wording, and no matter that they mention owning a company.",
  "- IMPORTANT: a job seeker is hiring_manager, not vendor_solicitation.",
  "- Use vendor_solicitation only when the sender is clearly selling something TO the dealership. If you are at all unsure whether they are a customer, do NOT use vendor_solicitation — choose the ordinary sales intent instead."
];

/** Few-shot examples for the conversation-state parser, in prompt order. */
export const CONVERSATION_STATE_FEW_SHOT_EXAMPLES = [
    'input: "Customer: can service quote an LED headlight install?" output: {"state_intent":"service_request","corporate_topic":"none","department_intent":"service","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"service_request","confidence":0.97}',
    'input: "Customer: can parts order drag specialties for me?" output: {"state_intent":"parts_request","corporate_topic":"none","department_intent":"parts","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"parts_request","confidence":0.97}',
    'input: "Customer: can you order a sissy bar for my Low Rider ST?" output: {"state_intent":"parts_request","corporate_topic":"none","department_intent":"parts","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"parts_request","confidence":0.97}',
    'input: "Customer: do you have a modular helmet in XL?" output: {"state_intent":"apparel_request","corporate_topic":"none","department_intent":"apparel","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"apparel_request","confidence":0.97}',
    'input: "Customer: If you get anyone yanking out their 114/117 M-8 to upgrade let me know as I am in the market for one." output: {"state_intent":"parts_request","corporate_topic":"none","department_intent":"parts","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"parts_request","confidence":0.97}',
    'input: "Customer: Who is the hiring manager for American Harley Davidson?" output: {"state_intent":"hiring_manager","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"hiring_manager_inquiry","confidence":0.97}',
    'input: "Customer: I wanted to apply for a job at your dealership. Who should I talk to?" output: {"state_intent":"hiring_manager","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"hiring_manager_inquiry","confidence":0.96}',
    'input: "Customer: Are you hiring?" output: {"state_intent":"hiring_manager","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"hiring_manager_inquiry","confidence":0.96}',
    'input: "Customer: Where do I send a resume?" output: {"state_intent":"hiring_manager","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"hiring_manager_inquiry","confidence":0.96}',
    'input: "Customer: I applied online, who handles that?" output: {"state_intent":"hiring_manager","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"hiring_manager_inquiry","confidence":0.94}',
    // vendor_solicitation — a BUSINESS pitching us. The pinned production turn is Jessica Miller
    // +12168596131 (Room58 "Contact Us" ADF, 2026-07-31): a virtual-assistant/AI-services pitch that
    // drew a sales draft AND a standard follow-up chase. The three negatives below carry the boundary
    // that actually matters: a customer who happens to sound businesslike is still a customer.
    'input: "Customer: Hi, We offer trained human Virtual Assistants supported by our custom-built AI system, MAVIS (My Advanced Virtual Intelligent System), that easily replaces the workload of a 10-person team handling marketing, admin, social media, lead generation, CRM management, content creation, customer support, and more. Open for discussion?" output: {"state_intent":"vendor_solicitation","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"vendor_inquiry","confidence":0.96}',
    'input: "Customer: I represent a digital marketing agency and we can get your dealership more leads. Can we set up 15 minutes this week?" output: {"state_intent":"vendor_solicitation","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"vendor_inquiry","confidence":0.95}',
    'input: "Customer: Our company supplies OEM-grade tooling to powersports dealers nationwide. Who handles purchasing for your store?" output: {"state_intent":"vendor_solicitation","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"vendor_inquiry","confidence":0.93}',
    'input: "Customer: I want to sell you my 2019 Road King, what will you give me for it?" output: {"state_intent":"general","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":false,"clear_pricing_need_model":false,"manual_handoff_reason":"none","confidence":0.93}',
    'input: "Customer: I own a landscaping business and I am looking to buy a Street Glide for myself." output: {"state_intent":"general","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":false,"clear_pricing_need_model":false,"manual_handoff_reason":"none","confidence":0.93}',
    'input: "Customer: Do you offer a corporate or fleet discount for my company?" output: {"state_intent":"pricing","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":false,"manual_handoff_reason":"none","confidence":0.92}',
    'input: "Customer: PreQual: N, PreQualified Amount; $0 Please note non-prequalified customers can still be considered for approval with a completed credit application." output: {"state_intent":"finance_docs","corporate_topic":"none","department_intent":"none","explicit_request":false,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"credit_app","confidence":0.96}',
    'input: "Customer: can service call me saturday morning around 10?" output: {"state_intent":"service_request","corporate_topic":"none","department_intent":"service","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"service_request","confidence":0.97}',
    'input: "Customer: i need parts for my 572 fl. can someone call me saturday around ten?" output: {"state_intent":"parts_request","corporate_topic":"none","department_intent":"parts","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"parts_request","confidence":0.96}',
    'input: "Customer: keep an eye out for a black road glide and text me when one lands" output: {"state_intent":"inventory_watch","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":false,"clear_pricing_need_model":true,"manual_handoff_reason":"none","confidence":0.96}',
    'input: "Customer: I do not want to waste your time. I am looking for a low mileage used one, not new." output: {"state_intent":"used_low_mileage_watch","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":false,"clear_pricing_need_model":true,"manual_handoff_reason":"used_low_mileage_watch","confidence":0.96}',
    'input: "Customer: I want a pre owned breakout with low miles, not a new one." output: {"state_intent":"used_low_mileage_watch","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":false,"clear_pricing_need_model":true,"manual_handoff_reason":"used_low_mileage_watch","confidence":0.97}',
    'input: "Customer: tuesday around 4 works for me" output: {"state_intent":"scheduling","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"none","confidence":0.94}',
    'input: "Customer: saturday morning works. does 9:30 work for you?" output: {"state_intent":"scheduling","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"none","confidence":0.95}',
    'input: "Customer: how about a tri glide instead. it has to be saturday morning." output: {"state_intent":"scheduling","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"none","confidence":0.95}',
    'input: "Customer: how about a triglycerides instead. let me know about saturday." output: {"state_intent":"scheduling","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"none","confidence":0.93}',
    'input: "Customer: I have to cancel coming to you Tuesday. I am having service done on the bike and inspection. I need to do a few more things before I can sell. I will get back to you." output: {"state_intent":"general","corporate_topic":"none","department_intent":"none","explicit_request":false,"clear_inventory_watch_pending":false,"clear_pricing_need_model":true,"manual_handoff_reason":"none","confidence":0.92}',
    'input: "Customer: we still have to service and detail the bike before delivery" output: {"state_intent":"general","corporate_topic":"none","department_intent":"none","explicit_request":false,"clear_inventory_watch_pending":false,"clear_pricing_need_model":false,"manual_handoff_reason":"none","confidence":0.9}',
    'input: "Customer: i can do 2500 down and want to stay under 500 monthly" output: {"state_intent":"pricing","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":false,"manual_handoff_reason":"none","confidence":0.95}',
    'input: "Customer: i had a bad experience at another harley dealer and need corporate to step in" output: {"state_intent":"corporate_misroute","corporate_topic":"other_dealer_experience","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"none","confidence":0.95}',
    'input: "Customer: hi i just want to let you know about an experience i had at dealership abc" output: {"state_intent":"corporate_misroute","corporate_topic":"other_dealer_experience","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":true,"clear_pricing_need_model":true,"manual_handoff_reason":"none","confidence":0.92}',
    'input: "Customer: is this bike still under harley factory warranty?" output: {"state_intent":"general","corporate_topic":"none","department_intent":"none","explicit_request":true,"clear_inventory_watch_pending":false,"clear_pricing_need_model":false,"manual_handoff_reason":"none","confidence":0.9}',
    'input: "Customer: ok sounds good thanks" output: {"state_intent":"general","corporate_topic":"none","department_intent":"none","explicit_request":false,"clear_inventory_watch_pending":false,"clear_pricing_need_model":true,"manual_handoff_reason":"none","confidence":0.9}'
];
