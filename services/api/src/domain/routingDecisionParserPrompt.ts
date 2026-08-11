import type { Conversation } from "./conversationStore.js";
// ---------------------------------------------------------------------------
// Routing-decision parser prompt surface: the strict JSON schema, the rules and
// the few-shot corpus for parseRoutingDecisionWithLLM (llmDraft.ts).
//
// Extracted from llmDraft.ts (behavior-preserving move) so the prompt this
// parser keeps growing lives in a file a human can read, and so llmDraft.ts
// pays for its own growth under source_size_ratchet:eval.
// ---------------------------------------------------------------------------
export const ROUTING_DECISION_PARSER_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["primary_intent", "explicit_request", "fallback_action", "clarify_prompt", "confidence"],
  properties: {
    primary_intent: {
      type: "string",
      enum: ["pricing_payments", "scheduling", "callback", "availability", "general", "none"]
    },
    explicit_request: { type: "boolean" },
    fallback_action: { type: "string", enum: ["none", "clarify", "no_response"] },
    clarify_prompt: { type: "string" },
    confidence: { type: "number" }
  }
};

export function buildRoutingDecisionParserPrompt(args: {
  text: string;
  history: string[];
  lead?: Conversation["lead"];
  followUp?: any;
  dialogState?: string | null;
  classification?: { bucket?: string | null; cta?: string | null } | null;
}): string {
  const { history } = args;
  const lead = args.lead ?? ({} as any);
  const followUp = args.followUp ?? {};
  const text = args.text;
  const examples = [
    `EXAMPLE A
inbound: "Do you have any black street glides in stock?"
output: {"primary_intent":"availability","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.97}`,
    `EXAMPLE B
inbound: "I have $2,500 down and want to stay under $500/mo"
output: {"primary_intent":"pricing_payments","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.97}`,
    `EXAMPLE C
inbound: "Can I come in Wednesday at 1?"
output: {"primary_intent":"scheduling","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.98}`,
    `EXAMPLE C2
inbound: "I begin my riding academy next Monday and was told you do the jumpstart experience prior."
output: {"primary_intent":"scheduling","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.97}`,
    `EXAMPLE D
inbound: "Can you call me after 3?"
output: {"primary_intent":"callback","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.95}`,
    `EXAMPLE D2
inbound: "If you call me around 1-2pm I should be up. I work night shift."
output: {"primary_intent":"callback","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.98}`,
    `EXAMPLE D3
inbound: "Hi Joe, I'm available to chat right now if that works for you."
output: {"primary_intent":"callback","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.94}`,
    `EXAMPLE E
inbound: "Ok thanks"
output: {"primary_intent":"none","explicit_request":false,"fallback_action":"no_response","clarify_prompt":"","confidence":0.96}`,
    `EXAMPLE F
inbound: "Yeah maybe"
output: {"primary_intent":"none","explicit_request":false,"fallback_action":"clarify","clarify_prompt":"Quick check — are you asking about payments, availability, or setting a time to come in?","confidence":0.86}`
    ,
    `EXAMPLE G
inbound: "I have $2,500 down and want to stay under $500/mo."
output: {"primary_intent":"pricing_payments","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.98}`,
    `EXAMPLE H
inbound: "Can you run it at 84 months with no money down?"
output: {"primary_intent":"pricing_payments","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.98}`,
    `EXAMPLE I
inbound: "Do you have any black street glides in stock?"
output: {"primary_intent":"availability","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.98}`,
    `EXAMPLE J
inbound: "What size motor is in this one?"
output: {"primary_intent":"general","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.9}`,
    `EXAMPLE K
inbound: "Any deals or finance specials right now?"
output: {"primary_intent":"pricing_payments","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.96}`,
    `EXAMPLE K1
inbound: "Sorry to text after hours but quick question. Would you be able to facilitate a trade for a used bike I found with a private seller? Would rider to rider work?"
output: {"primary_intent":"pricing_payments","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.98}`,
    `EXAMPLE K2
inbound: "I have cash. coming to look at the orange street glide tomorrow. let's make a deal"
output: {"primary_intent":"scheduling","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.97}`,
    `EXAMPLE K3
inbound: "i have cash and can come in tomorrow for that 2017 orange street glide"
output: {"primary_intent":"scheduling","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.98}`,
    `EXAMPLE K4
inbound: "ready to buy. i can stop by saturday morning"
output: {"primary_intent":"scheduling","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.97}`,
    `EXAMPLE K5
inbound: "let's make a deal tomorrow on the street glide"
output: {"primary_intent":"scheduling","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.96}`,
    `EXAMPLE L
inbound: "Ok sounds great"
output: {"primary_intent":"none","explicit_request":false,"fallback_action":"no_response","clarify_prompt":"","confidence":0.97}`
    ,
    `EXAMPLE L2
inbound: "Okay. Thank you. The bike would be for my husband but I'm doing the financing, hopefully."
output: {"primary_intent":"none","explicit_request":false,"fallback_action":"no_response","clarify_prompt":"","confidence":0.94}`
    ,
    `EXAMPLE M
inbound: "Hi Gio, I received all my paperwork yesterday. I am going to the notary/DMV this afternoon."
output: {"primary_intent":"general","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.93}`
    ,
    `EXAMPLE N
inbound: "Did you watch the Sabres game last night?"
output: {"primary_intent":"general","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.92}`,
    `EXAMPLE O
inbound: "You ready for nhl playoffs?"
output: {"primary_intent":"general","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.91}`,
    `EXAMPLE P
inbound: "Actually do you have any black street glides in stock?"
output: {"primary_intent":"availability","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.97}`,
    `EXAMPLE Q
inbound: "Ignore payments for now — what black options do you have in stock?"
output: {"primary_intent":"availability","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.97}`
    ,
    `EXAMPLE R
inbound: "Well only partly. Not happy about the lack of navigating or being able to put my Android maps on display."
output: {"primary_intent":"general","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.95}`,
    `EXAMPLE S
inbound: "Android Auto won’t connect and I’m pretty frustrated with this infotainment."
output: {"primary_intent":"general","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.95}`,
    `EXAMPLE T
inbound: "I’m annoyed this thing won’t show Google Maps from my phone."
output: {"primary_intent":"general","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.94}`,
    `EXAMPLE U
inbound: "Thinking ab 72 months with about 1000 down"
output: {"primary_intent":"pricing_payments","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.97}`,
    `EXAMPLE V
inbound: "Joe, thank you for your help today. Scott should have insurance cards and insurance binder. Can we bump pickup to Tuesday between 11:00 and 11:30?"
output: {"primary_intent":"scheduling","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.97}`,
    `EXAMPLE W
inbound: "Scott should have insurance cards and the binder from Progressive."
output: {"primary_intent":"general","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.9}`,
    `EXAMPLE X
inbound: "No need, I called and spoke with them already. Thanks Alexandra."
output: {"primary_intent":"none","explicit_request":false,"fallback_action":"no_response","clarify_prompt":"","confidence":0.95}`,
    `EXAMPLE Y
inbound: "Sorry it took so long."
output: {"primary_intent":"none","explicit_request":false,"fallback_action":"no_response","clarify_prompt":"","confidence":0.9}`,
    `EXAMPLE Z1 (the customer answers OUR question — the question supplies the ask)
last outbound: "Thanks — I received your credit application. Are you looking at the Road Glide, or open to a couple of options?"
inbound: "Couple options"
output: {"primary_intent":"availability","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.93}`,
    `EXAMPLE Z2 (answer supplies the fact we asked for)
last outbound: "What day works best for you to come take a look?"
inbound: "Saturday"
output: {"primary_intent":"scheduling","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.96}`,
    `EXAMPLE Z3 (answer supplies the number we asked for)
last outbound: "Were you hoping to keep the monthly payment under a certain number?"
inbound: "around 400"
output: {"primary_intent":"pricing_payments","explicit_request":true,"fallback_action":"none","clarify_prompt":"","confidence":0.95}`,
    `EXAMPLE Z4 (no question in the preceding turn — an ambiguous fragment is still ambiguous)
last outbound: "We sure do — plenty on the floor right now."
inbound: "Yeah maybe"
output: {"primary_intent":"none","explicit_request":false,"fallback_action":"clarify","clarify_prompt":"Quick check — are you asking about payments, availability, or setting a time to come in?","confidence":0.86}`,
    `EXAMPLE Z5 (we asked a question, but a courtesy acknowledgment is not an answer)
last outbound: "I can have our finance team call you — what time of day is best?"
inbound: "Ok thanks"
output: {"primary_intent":"none","explicit_request":false,"fallback_action":"no_response","clarify_prompt":"","confidence":0.95}`
  ];
  const prompt = [
    "You are a strict routing parser for dealership inbound messages.",
    "Return only JSON matching the schema.",
    "",
    "Choose one primary_intent:",
    "- pricing_payments: price, payments, APR, term, down payment, or explicit finance promos/specials/incentives.",
    "- availability: in stock, still available, colors/trims/years inventory availability.",
    "- scheduling: appointment/day/time/come in/stop by requests.",
    "- callback: customer asks for a phone call or says they are available/free to chat/talk right now.",
    "- general: clear request but not one of the above.",
    "- none: no actionable request.",
    "",
    "Rules:",
    "- Use the latest inbound ask as source of truth even if prior turns were different.",
    "- The immediately-preceding outbound turn is the LAST line beginning \"out:\" under Recent messages; the examples below write it as \"last outbound\".",
    "- ANSWERING OUR OWN QUESTION: when the IMMEDIATELY-PRECEDING outbound turn ended in a question and the inbound reads as an answer to it — picking one of the options we offered, or supplying the fact we asked for — that question supplies the ask. Set explicit_request=true and route by what WE asked about. Never fallback_action=clarify there (re-asking the question we just asked is always wrong), and never no_response. This applies ONLY to the immediately-preceding outbound turn: a short reply that merely fits some older turn is still governed by the rule above.",
    "- The exception to that rule is a bare courtesy acknowledgment (\"ok thanks\", \"sounds good\", \"you too\"): an acknowledgment is not an answer, so it stays primary_intent=none with fallback_action=no_response even when we just asked a question.",
    "- If inbound is a short acknowledgment or an informational finance/context update with no ask, use primary_intent=none and fallback_action=no_response.",
    "- If a message mentions 'after hours' but then asks a finance/private-seller/Rider-to-Rider question, route the real ask, not business hours.",
    "- Rider-to-Rider, R2R, private-seller financing/paperwork, or dealership-facilitated third-party purchase questions route to pricing_payments.",
    "- Use fallback_action=clarify only when message is ambiguous and not safely routable.",
    "- Only choose callback when the customer explicitly asks for a phone call (e.g., call me, have X call me, can you call) or says they are available/free to chat/talk right now.",
    "- If message says cash-ready / ready to buy / make a deal and includes a visit timing cue (today/tomorrow/day/time/coming in), choose scheduling, not callback.",
    "- Jump start / jumpstart / riding-academy prep requests should route to scheduling (in-store stop-in), not availability or pricing by default.",
    "- Dissatisfaction/complaint about feature behavior (for example Android maps, infotainment, navigation, connectivity) without a clear inventory/pricing/scheduling/callback ask should route to general with fallback_action=none.",
    "- For clear complaint/support messages, set explicit_request=true even if phrased as a statement.",
    "- confidence is 0..1.",
    "",
    ...examples,
    "",
    `Known lead info: ${JSON.stringify({
      model: lead?.vehicle?.model ?? lead?.vehicle?.description ?? null,
      year: lead?.vehicle?.year ?? null,
      source: lead?.source ?? null
    })}`,
    `Known workflow state: ${JSON.stringify({
      followUpMode: followUp?.mode ?? null,
      followUpReason: followUp?.reason ?? null,
      dialogState: args.dialogState ?? null,
      bucket: args.classification?.bucket ?? null,
      cta: args.classification?.cta ?? null
    })}`,
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");
  return prompt;
}
