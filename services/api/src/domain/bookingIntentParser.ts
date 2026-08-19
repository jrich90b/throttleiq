/**
 * The CUSTOMER-side booking-intent parser's PROMPT (guidelines + few-shots).
 *
 * WHY IT LIVES HERE. Its staff-side sibling already does
 * (`manualOutboundAppointment.ts`), and the two now share one comprehension rule: carry a day the
 * recent messages ALREADY settle. #676 taught the staff parser that on 2026-08-12. This file is the
 * customer half, added 2026-08-19 for Paul Harrigan `+17169467451`, operator-reported as
 * *"This did not seem to book an appointment at 11 today"*:
 *
 *   12:49  customer: "I'm off today... can I come out this morning to test ride the 2021 again"
 *   13:55  rep:      "Hey Paul, what time are you thinking?"
 *   13:56  customer: "would 11 o'clock be OK?"    <- parsed day:"" time:"11 o'clock"
 *
 * The day-less phrase went straight into the todo we mint (`Appointment requested. Requested: 11
 * o'clock.`), and `parseRequestedDayTime` returns null without a day token, so the staff confirm
 * had nothing to book. The customer had already settled the day two turns earlier.
 *
 * Measured on the live store 2026-08-19: of 54 pending appointment requests carrying a phrase, 30
 * do not resolve, and 9 of those are a bare clock time with the day sitting in the thread.
 *
 * BOUNDED ON PURPOSE. Only carry a day the recent messages actually settle. An unresolvable
 * request books nothing, so the cost of leaving the day empty is a lost appointment; the cost of
 * guessing is a WRONG-DAY appointment, which is worse. The `9ish works` / `after 4 is best`
 * few-shots keep day empty precisely because their day comes from a suggested slot, not the thread.
 */

/** Guidelines, in prompt order. */
export const BOOKING_INTENT_PROMPT_RULES: string[] = [
  "- explicit_request is true only if the customer is asking to schedule/stop in/reschedule/cancel.",
  "- If an appointment exists and the customer says it is the wrong place, wrong dealer, wrong dealership, wrong store, or meant for another location, classify as cancel with reference last_appointment.",
  "- If the customer gives a day without a time, set requested.day and set time_text to an empty string.",
  "- If the customer gives multiple acceptable windows, use the first acceptable window in requested and keep the other option in normalized_text.",
  "- Ordinal dates like 'the 9th' or '16th' are real date requests; keep requested.day as '9th' / '16th'.",
  "- If the customer references a prior offer (e.g., 'that time', 'earlier', 'later'), set reference to last_suggested.",
  "- normalized_text should be a compact day/time phrase when possible; otherwise empty string.",
  "- Use empty strings for unknown requested.day and requested.time_text.",
  "- confidence is a number from 0 to 1.",
  // The day-from-context rule, mirroring MANUAL_OUTBOUND_APPOINTMENT_PROMPT_RULES. Paul Harrigan
  // +17169467451: "would 11 o'clock be OK?" two turns after "I'm off today... can I come out this
  // morning". The day was settled; only the clock time was new.
  "- If the customer names only a clock time and the recent messages already settle which day it is (they said 'today', 'this morning', 'tomorrow', 'on my way', or a weekday that is now being answered), put that day in requested.day and start normalized_text with it.",
  "- Only carry a day the recent messages actually settle. If nothing in them names a day, leave requested.day empty rather than guessing.",
];

/** Few-shots. The last two are the day-from-context production cases. */
export const BOOKING_INTENT_EXAMPLES: string[] = [
  'input: "Customer: can we do Tuesday around 4?" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"tuesday","time_text":"around 4","time_window":"range"},"reference":"none","normalized_text":"tuesday around 4","confidence":0.96}',
  'input: "Customer: i can come in next week sometime afternoon" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"next week","time_text":"afternoon","time_window":"range"},"reference":"none","normalized_text":"next week afternoon","confidence":0.92}',
  'input: "Customer: i work m-f 7/4... does sat morning work 4 u" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"saturday","time_text":"morning","time_window":"range"},"reference":"none","normalized_text":"saturday morning","confidence":0.95}',
  'input: "Customer: how about a tri glide instead. can it be saturday morning?" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"saturday","time_text":"morning","time_window":"range"},"reference":"none","normalized_text":"saturday morning","confidence":0.96}',
  'input: "Customer: how about a triglycerides instead. it has to be on a saturday." output: {"intent":"schedule","explicit_request":true,"requested":{"day":"saturday","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"saturday","confidence":0.92}',
  'input: "Customer: can i come in saturday at 9:30?" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"saturday","time_text":"9:30","time_window":"exact"},"reference":"none","normalized_text":"saturday 9:30","confidence":0.97}',
  'input: "Customer: Either the 9th after 1:30 or any time on the 16th" output: {"intent":"availability","explicit_request":true,"requested":{"day":"9th","time_text":"after 1:30","time_window":"range"},"reference":"none","normalized_text":"9th after 1:30 or 16th any time","confidence":0.95}',
  'input: "Customer: tomorrow around 11/12 would work best for me" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"tomorrow","time_text":"around 11/12","time_window":"range"},"reference":"last_suggested","normalized_text":"tomorrow around 11/12","confidence":0.95}',
  'input: "Customer: yes saturday at 930 works" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"saturday","time_text":"9:30","time_window":"exact"},"reference":"last_suggested","normalized_text":"saturday 9:30","confidence":0.96}',
  'input: "Customer: saturday works for me" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"saturday","time_text":"","time_window":"unknown"},"reference":"last_suggested","normalized_text":"saturday","confidence":0.93}',
  'input: "Customer: 11am can you send photos of street glide limited" output: {"intent":"none","explicit_request":false,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"","confidence":0.96}',
  'input: "Customer: never mind photo. test ride street glide limited 3. thanks" output: {"intent":"none","explicit_request":false,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"","confidence":0.95}',
  'input: "Customer: 9ish works" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"","time_text":"9ish","time_window":"range"},"reference":"last_suggested","normalized_text":"9ish","confidence":0.9}',
  'input: "Customer: after 4 is best" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"","time_text":"after 4","time_window":"range"},"reference":"last_suggested","normalized_text":"after 4","confidence":0.91}',
  'input: "Customer: Thanks for info. And any appointments later this month same time." output: {"intent":"availability","explicit_request":true,"requested":{"day":"later this month","time_text":"same time","time_window":"range"},"reference":"last_suggested","normalized_text":"later this month same time","confidence":0.92}',
  'input: "Customer: can we move that to saturday morning?" output: {"intent":"reschedule","explicit_request":true,"requested":{"day":"saturday","time_text":"morning","time_window":"range"},"reference":"last_appointment","normalized_text":"saturday morning","confidence":0.94}',
  'input: "Customer: I will have to reschedule unfortunately" output: {"intent":"reschedule","explicit_request":true,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"last_appointment","normalized_text":"","confidence":0.94}',
  'input: "Customer: Hey Scott I’m not going to be able to make the test ride this morning. I have a family matter that needs attention. I apologize" output: {"intent":"reschedule","explicit_request":true,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"last_appointment","normalized_text":"","confidence":0.94}',
  'input: "Customer: I couldn’t make it yesterday. How does half an hour sound? I can get there before the weather gets bad." output: {"intent":"schedule","explicit_request":true,"requested":{"day":"","time_text":"in half an hour","time_window":"range"},"reference":"none","normalized_text":"in half an hour","confidence":0.93}',
  'input: "Customer: wrong place actually. Supposed to be Cartersville, Georgia" output: {"intent":"cancel","explicit_request":true,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"last_appointment","normalized_text":"wrong location","confidence":0.95}',
  'input: "Customer: that appointment is for the wrong dealership" output: {"intent":"cancel","explicit_request":true,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"last_appointment","normalized_text":"wrong dealership","confidence":0.95}',
  'input: "Customer: hey! Could we do 9:30-10" output: {"intent":"reschedule","explicit_request":true,"requested":{"day":"","time_text":"9:30-10","time_window":"range"},"reference":"last_appointment","normalized_text":"9:30-10","confidence":0.94}',
  'input: "Customer: can you move me later than that time?" output: {"intent":"reschedule","explicit_request":true,"requested":{"day":"","time_text":"later","time_window":"range"},"reference":"last_suggested","normalized_text":"later than last suggested","confidence":0.9}',
  'input: "Customer: what openings do you have friday?" output: {"intent":"availability","explicit_request":true,"requested":{"day":"friday","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"friday","confidence":0.95}',
  'input: "Customer: Ooh that looks sharp! Friday morning, early afternoon, or anytime Saturday I can come out and take a look" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"friday","time_text":"morning","time_window":"range"},"reference":"none","normalized_text":"friday morning or saturday any time","confidence":0.94}',
  'input: "Customer: i will let you know a time later today" output: {"intent":"none","explicit_request":false,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"","confidence":0.95}',
  'input: "Customer: I just filled out the paperwork to get the free hat. Talked to Scott the other day, told him I would probably come in shortly with a couple friends they can ride, but I can’t. I had my hip replaced last Thursday." output: {"intent":"none","explicit_request":false,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"","confidence":0.96}',
  'input: "Customer: payments are too high right now" output: {"intent":"none","explicit_request":false,"requested":{"day":"","time_text":"","time_window":"unknown"},"reference":"none","normalized_text":"","confidence":0.93}',
  'input: "Recent messages:\\nin: I\u2019m off today, can I come out this morning to test ride the 2021 again?\\nout: Hey Paul, what time are you thinking?\\nCustomer: would 11 o\u2019clock be OK?" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"today","time_text":"11 o\u2019clock","time_window":"exact"},"reference":"none","normalized_text":"today 11 o\u2019clock","confidence":0.93}',
  'input: "Recent messages:\\nout: When did you want to pick up your new bike?\\nCustomer: Oh great, I could get there about 3pm if that works" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"today","time_text":"about 3pm","time_window":"range"},"reference":"none","normalized_text":"today about 3pm","confidence":0.9}',
  'input: "Recent messages:\\nin: Do you have that Road Glide in stock?\\nCustomer: 3:45 works" output: {"intent":"schedule","explicit_request":true,"requested":{"day":"","time_text":"3:45","time_window":"exact"},"reference":"last_suggested","normalized_text":"3:45","confidence":0.85}'
];
