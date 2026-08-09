// Everything about the business-hours question PARSE except the API call: the strict JSON schema
// and the prompt. Split out of llmDraft.ts (16,385 lines and the second-largest file in the API)
// so the hours slice pays for itself, and so the schema sits next to the prose that explains it.
// The raw-JSON -> typed mapping lives in inboundPipeline.ts beside the referee that consumes it.

export const BUSINESS_HOURS_QUESTION_JSON_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  additionalProperties: false,
  required: ["is_hours_question", "scope", "day", "other_ask", "confidence"],
  properties: {
    is_hours_question: { type: "boolean" },
    // See BusinessHoursQuestionParse — only "dealership" is answerable from our hours config.
    scope: { type: "string", enum: ["dealership", "staff_person", "appointment_slot", "none"] },
    day: { type: ["string", "null"] },
    // Does the turn ALSO ask something our posted hours would not answer? The hours branch replies
    // with one line and ends the turn, so a turn carrying a second question loses it entirely
    // (Ulises HernandezPerez, Ref 11755, 2026-08-08: "they close early today ... I will make it a
    // point to call at 9am on Monday ... is that going to be too late, WILL I LOSE MY SEAT?" — the
    // hours read is correct, the hours ANSWER is not what he asked). Verbatim so a human reading the
    // log can see what we would have dropped; empty string when the turn asks only about hours.
    other_ask: { type: "string" },
    confidence: { type: "number" }
  }
};

export function buildBusinessHoursQuestionPrompt(args: {
  text: string;
  history?: string[];
}): string {
  const text = String(args.text ?? "").trim();
  const history = args.history ?? [];
  return [
    "You read SMS in a Harley dealership sales thread and decide whether the customer is asking",
    "WHEN THE DEALERSHIP IS OPEN — its business hours — however they phrase it. Many customers",
    "never say the word 'hours': they ask if we are 'available', 'around', 'there', or 'working'.",
    "Return only JSON that matches the provided schema.",
    "",
    "scope (this is the important field):",
    '- "dealership": the STORE\'s hours / whether the store is open at some time. Answerable from',
    "  our posted hours.",
    '- "staff_person": whether a NAMED PERSON (or "you" meaning the individual rep they have been',
    "  texting) is working / in that day. Store hours would be a wrong answer.",
    '- "appointment_slot": whether a specific APPOINTMENT time is free ("anything open at 2?",',
    '  "do you have a slot Thursday?"). The scheduling handler owns these.',
    '- "none": not an availability question (inventory, pricing, trade, photos, chit-chat).',
    "",
    "Hard rules:",
    '- "are you guys ..." / "are you open ..." / "your availability" with no person named = dealership.',
    "  A dealership 'we' question is about the store even when it says 'you'.",
    "- A named rep, or 'is he/she in', or a question that only makes sense about one person =",
    "  staff_person.",
    '- Asking to BOOK or whether a TIME is free = appointment_slot, even though it sounds similar.',
    '- "any Road Glides available?" is inventory = none. "Available" alone is not an hours word.',
    "- is_hours_question is true whenever scope is dealership, staff_person, or appointment_slot.",
    "- confidence is 0..1; use >= 0.7 only when the scope read is clear.",
    "- day: the day/window the customer named, verbatim, else null.",
    "",
    "other_ask (this decides whether a one-line hours answer is ENOUGH):",
    "- Copy, verbatim, any OTHER question in the turn that our posted opening hours would not",
    "  answer. Empty string when the turn asks only about hours/availability.",
    "- Hours are often the CONTEXT for the real question, not the question. If the customer",
    "  mentions our hours only to explain WHY they are asking something else, that something else",
    "  goes in other_ask.",
    "- A statement is not a question. Only copy something they are actually asking.",
    "- Rebooking/timing chatter that the hours answer does settle is NOT an other_ask.",
    "",
    "Examples:",
    '- "Are you guys available weekends?" -> {"is_hours_question":true,"scope":"dealership","day":"weekends","confidence":0.93}',
    '- "I do work days what is your availability like?" -> {"is_hours_question":true,"scope":"dealership","day":null,"confidence":0.85}',
    '- "you guys around on Sunday?" -> {"is_hours_question":true,"scope":"dealership","day":"Sunday","confidence":0.9}',
    '- "what time do you close today?" -> {"is_hours_question":true,"scope":"dealership","day":"today","confidence":0.95}',
    '- "is Giovanni working Saturday?" -> {"is_hours_question":true,"scope":"staff_person","day":"Saturday","confidence":0.9}',
    '- "are you in tomorrow? wanted to see you specifically" -> {"is_hours_question":true,"scope":"staff_person","day":"tomorrow","confidence":0.82}',
    '- "do you have anything open at 2 on Thursday?" -> {"is_hours_question":true,"scope":"appointment_slot","day":"Thursday","confidence":0.9}',
    '- "any Road Glides available?" -> {"is_hours_question":false,"scope":"none","day":null,"confidence":0.92}',
    '- "what would my payment be?" -> {"is_hours_question":false,"scope":"none","day":null,"other_ask":"","confidence":0.95}',
    "",
    "other_ask examples (the hours read is RIGHT and the hours answer is still not what they asked):",
    '- "I tried calling but they close early today. I will call at 9am Monday, is that too late,',
    '   will I lose my seat?" -> {"is_hours_question":true,"scope":"dealership","day":"Monday",',
    '   "other_ask":"is that going to be too late, will I lose my seat","confidence":0.85}',
    '- "are you open til 6? also can you send pics of the road glide" ->',
    '   {"is_hours_question":true,"scope":"dealership","day":null,',
    '   "other_ask":"can you send pics of the road glide","confidence":0.9}',
    '- "what time do you close today?" (nothing else asked) ->',
    '   {"is_hours_question":true,"scope":"dealership","day":"today","other_ask":"","confidence":0.95}',
    "",
    history.length ? `Recent messages:\n${history.join("\n")}` : "Recent messages: (none)",
    `Message: ${text}`
  ].join("\n");
}
