/**
 * The static instruction + few-shot block for the vehicle-choice confidence parser
 * (`parseVehicleChoiceConfidenceWithLLM` in llmDraft.ts). Lifted out verbatim so this prompt
 * surface can keep growing without spending llmDraft.ts's `source_size_ratchet` budget — the same
 * move as domain/customerAckActionExemplars.ts. Nothing here interpolates: the bike under
 * discussion, the history and the message are appended by the caller.
 *
 * The stance this parser returns is what `decideVehicleChoiceConfidenceTurn` branches on, and a
 * false `open_to_alternatives` tells a customer who has already chosen a bike that we would like
 * to show them other ones. Precision here is the whole point of the block.
 */
const VEHICLE_CHOICE_CONFIDENCE_PROMPT_LINES: string[] = [
  "You read how SETTLED a motorcycle shopper is on the SPECIFIC bike they're discussing in an SMS",
  "thread with a Harley dealership. The dealership may proactively offer a couple of OTHER bikes,",
  "but only when the customer is lukewarm — never when they've made up their mind.",
  "Return only JSON that matches the provided schema.",
  "",
  "Classify stance:",
  '- "committed": the customer has decided on / clearly wants THIS bike. Examples: "this is the one",',
  '  "I want the Street Glide", "let\'s do it", "I\'ve decided on the Road Glide", "I\'ll take it",',
  '  "yeah let\'s move forward on that one", "the Low Rider S is exactly what I want".',
  '- "open_to_alternatives": lukewarm, undecided, or comparison-shopping about the bike CHOICE.',
  '  Examples: "what else do you have", "I\'m torn between the Street Glide and the Road Glide",',
  '  "not sure this is the one", "are there other options", "is there something cheaper",',
  '  "anything newer?", "do you have something with less miles", "still looking around",',
  '  "I\'m not totally sold on it", "what would you recommend instead".',
  '- "unclear": no stance about which bike to buy — a different topic (pricing math, scheduling,',
  '  trade, financing, hours, directions), a bare acknowledgement, or genuinely ambiguous.',
  "",
  "Hard rules (precision matters — a false 'open_to_alternatives' undercuts a confident buyer):",
  "- A question about the SAME bike (its price, payment, color, miles, availability, a test ride) is",
  '  NOT "open_to_alternatives" — it is "unclear" here unless they signal they\'re weighing other bikes.',
  "- Wanting MORE info on the same bike (photos, specs) is not openness to alternatives.",
  "- A BARE AFFIRMATIVE (\"That would be great\", \"Sounds good\", \"Yes please\", \"Perfect\", \"Ok\") answers the dealer's IMMEDIATELY PRECEDING message and NOTHING earlier. Read the LAST `out:` line in the history and judge only that. Do not reach back to an older dealer message to find something the yes could have been answering — the customer replied to what they had just read.",
  "- When that last dealer message offered to SEND something about the same bike (incentives, photos, specs, a price sheet, a video), a yes is a request for THAT INFORMATION about the bike they are already discussing. It says nothing about their bike choice: return \"unclear\". Only a yes to an explicit offer of OTHER BIKES (\"want me to pull a few similar ones?\", \"should I send some alternatives?\") is \"open_to_alternatives\".",
  '- Default to "unclear" when the turn does not clearly express the bike-choice stance.',
  "- confidence is 0..1; only use >= 0.8 when the stance is unambiguous.",
  "",
  "Examples:",
  '- "this is the one I want" -> {"stance":"committed","confidence":0.96}',
  '- "I\'ll take the Road Glide" -> {"stance":"committed","confidence":0.95}',
  '- "let\'s do it" -> {"stance":"committed","confidence":0.9}',
  '- "what else do you have?" -> {"stance":"open_to_alternatives","confidence":0.92}',
  '- "I\'m torn between the Street Glide and the Road Glide" -> {"stance":"open_to_alternatives","confidence":0.93}',
  '- "not sure this is the one honestly" -> {"stance":"open_to_alternatives","confidence":0.9}',
  '- "is there anything cheaper?" -> {"stance":"open_to_alternatives","confidence":0.88}',
  '- "any newer ones?" -> {"stance":"open_to_alternatives","confidence":0.85}',
  '- "what\'s the out the door price on it?" -> {"stance":"unclear","confidence":0.9}',
  '- "can I come by Saturday?" -> {"stance":"unclear","confidence":0.92}',
  '- "send me a couple photos" -> {"stance":"unclear","confidence":0.85}',
  '- "thanks!" -> {"stance":"unclear","confidence":0.95}',
  // A BARE AFFIRMATIVE, judged against the LAST dealer line only. Michael +16076549423,
  // 2026-06-09: three days after we offered "a simple compare", we offered current INCENTIVES and
  // he said "That would be great". Given the whole thread the parser reached back past the
  // incentives offer to the compare offer and called it open_to_alternatives (0.83-0.85, over the
  // 0.8 floor, 3 of 4 runs) — so a lead already quoted on a specific unit got "happy to line up a
  // couple of other options" plus new/used/budget, all of which he had answered. Given only the
  // last line it reads "unclear" 3/3, which is correct. These pin that reading.
  '- "That would be great" after out: "I can also check current incentives on the Street Glide Limited and send only what applies." -> {"stance":"unclear","confidence":0.9}',
  '- "That would be great" after out: "I can grab a few photos of that Street Glide and text them over if you want." -> {"stance":"unclear","confidence":0.9}',
  '- "Yes please" after out: "Want me to pull a few similar bikes so you can compare?" -> {"stance":"open_to_alternatives","confidence":0.9}',
  "",
];

/**
 * Assemble the full prompt. The static block above plus the three turn-specific tails, so the
 * whole prompt surface for this parser lives in ONE file — which is also what lets
 * `llm_parser_contract:eval` resolve it (it follows `const prompt = build<Name>Prompt(...)` into
 * the module, exactly as it already does for buildWalkInOutcomePrompt).
 */
export function buildVehicleChoiceConfidencePrompt(args: {
  referencedModel?: string | null;
  history?: string[];
  text: string;
}): string {
  const referenced = String(args.referencedModel ?? "").trim();
  const history = args.history ?? [];
  return [
    ...VEHICLE_CHOICE_CONFIDENCE_PROMPT_LINES,
    referenced ? `Bike under discussion: ${referenced}` : "Bike under discussion: (unspecified)",
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${args.text}`
  ].join("\n");
}
