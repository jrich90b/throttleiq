/**
 * Few-shot examples for the first-time-rider guidance parser (parseFirstTimeRiderGuidanceWithLLM).
 * They sit beside the parser instead of inside it so the prompt surface is editable on its own —
 * the same split already used by inboundReplyActionPrompt.ts and conversationStateParserPrompt.ts.
 *
 * D6-D9 are the enrolled-student boundary: someone who ALREADY HOLDS A SEAT asking about attending
 * (what to bring, when to arrive) must not be answered with sign-up copy. D9 is the counter-example
 * that keeps a genuine sign-up question on rider_course_info.
 */
export const FIRST_TIME_RIDER_GUIDANCE_EXAMPLES: string[] = [
    `EXAMPLE A
inbound: "This would be my first bike. What do you recommend?"
output: {"intent":"first_time_rider","explicit_request":true,"endorsement_status":"unknown","asks_test_ride":false,"asks_beginner_bike":true,"asks_rider_course":false,"confidence":0.97}`,
    `EXAMPLE B
inbound: "I've never ridden before but can I test ride the Nightster?"
output: {"intent":"first_time_rider","explicit_request":true,"endorsement_status":"unknown","asks_test_ride":true,"asks_beginner_bike":false,"asks_rider_course":false,"confidence":0.98}`,
    `EXAMPLE C
inbound: "I don't have my motorcycle license yet. Can I ride it?"
output: {"intent":"no_motorcycle_endorsement","explicit_request":true,"endorsement_status":"no","asks_test_ride":true,"asks_beginner_bike":false,"asks_rider_course":false,"confidence":0.98}`,
    `EXAMPLE D
inbound: "Do you know where I can take the rider course?"
output: {"intent":"rider_course_info","explicit_request":true,"endorsement_status":"unknown","asks_test_ride":false,"asks_beginner_bike":false,"asks_rider_course":true,"confidence":0.96}`,
    `EXAMPLE D2
inbound: "Your course and price"
output: {"intent":"rider_course_info","explicit_request":true,"endorsement_status":"unknown","asks_test_ride":false,"asks_beginner_bike":false,"asks_rider_course":true,"confidence":0.97}`,
    `EXAMPLE D3
inbound: "How much is the Riding Academy course?"
output: {"intent":"rider_course_info","explicit_request":true,"endorsement_status":"unknown","asks_test_ride":false,"asks_beginner_bike":false,"asks_rider_course":true,"confidence":0.98}`,
    `EXAMPLE D4
inbound: "Yes, I'm looking for a course motorcycle so I can get my license."
output: {"intent":"rider_course_info","explicit_request":true,"endorsement_status":"no","asks_test_ride":false,"asks_beginner_bike":false,"asks_rider_course":true,"confidence":0.97}`,
    `EXAMPLE D5
inbound: "I need a motorcycle course to get my license."
output: {"intent":"rider_course_info","explicit_request":true,"endorsement_status":"no","asks_test_ride":false,"asks_beginner_bike":false,"asks_rider_course":true,"confidence":0.98}`,
    `EXAMPLE D6 (ALREADY ENROLLED — the class itself, not signing up)
inbound: "What do I need to bring to class?"
output: {"intent":"enrolled_class_logistics","explicit_request":true,"endorsement_status":"unknown","asks_test_ride":false,"asks_beginner_bike":false,"asks_rider_course":false,"asks_class_logistics":true,"confidence":0.97}`,
    `EXAMPLE D7
inbound: "What time should I show up on Saturday?"
output: {"intent":"enrolled_class_logistics","explicit_request":true,"endorsement_status":"unknown","asks_test_ride":false,"asks_beginner_bike":false,"asks_rider_course":false,"asks_class_logistics":true,"confidence":0.96}`,
    `EXAMPLE D8
inbound: "Do you guys provide the helmet or do I need my own?"
output: {"intent":"enrolled_class_logistics","explicit_request":true,"endorsement_status":"unknown","asks_test_ride":false,"asks_beginner_bike":false,"asks_rider_course":false,"asks_class_logistics":true,"confidence":0.95}`,
    `EXAMPLE D9 (still SIGNING UP — price/link, not logistics)
inbound: "When is your next class and how much?"
output: {"intent":"rider_course_info","explicit_request":true,"endorsement_status":"unknown","asks_test_ride":false,"asks_beginner_bike":false,"asks_rider_course":true,"asks_class_logistics":false,"confidence":0.94}`,
    `EXAMPLE E
inbound: "I have my endorsement but I'm a new rider and want something manageable."
output: {"intent":"beginner_bike_advice","explicit_request":true,"endorsement_status":"yes","asks_test_ride":false,"asks_beginner_bike":true,"asks_rider_course":false,"confidence":0.97}`,
    `EXAMPLE F
inbound: "I used to ride years ago and want to get back into it."
output: {"intent":"none","explicit_request":false,"endorsement_status":"unknown","asks_test_ride":false,"asks_beginner_bike":false,"asks_rider_course":false,"confidence":0.82}`
];
