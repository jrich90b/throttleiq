import { evaluateTurnToneQuality } from "./lib/toneQuality.ts";
import { matchInboundReply } from "./lib/toneResponseMatch.ts";

type Fixture = {
  id: string;
  inboundText: string;
  outboundText: string;
  expect: {
    minScore?: number;
    maxScore?: number;
    mustIncludeIssues?: string[];
    mustNotIncludeIssues?: string[];
  };
};

const FIXTURES: Fixture[] = [
  {
    id: "pricing_answered_directly",
    inboundText: "What would monthly payments be on this bike?",
    outboundText:
      "Ballpark, on about $24,999, you’re around $550–$570/mo at 60 months before taxes and fees. What monthly payment are you trying to stay around?",
    expect: { minScore: 85, mustNotIncludeIssues: ["intent_mismatch", "question_not_answered_first"] }
  },
  {
    id: "availability_hijacked_by_pricing",
    inboundText: "Do you have any black street glides in stock?",
    outboundText: "The price we have listed for T19-26 is $24,999. Final price can change with tax and fees.",
    expect: { maxScore: 65, mustIncludeIssues: ["intent_mismatch", "question_not_answered_first"] }
  },
  {
    id: "status_update_with_clean_ack",
    inboundText: "I received all my paperwork and I’m headed to the DMV this afternoon.",
    outboundText: "Sounds good. Keep me posted, and I’m here if you need anything.",
    expect: { minScore: 85, mustNotIncludeIssues: ["pushy_cta_on_ack"] }
  },
  {
    id: "status_update_pushy_schedule",
    inboundText: "I got everything filed at the DMV, thanks.",
    outboundText: "Great. Stop by tomorrow and let’s lock in a time to review options.",
    expect: { maxScore: 75, mustIncludeIssues: ["pushy_cta_on_ack"] }
  },
  {
    id: "duplicate_self_identification",
    inboundText: "Do you have any deals right now?",
    outboundText:
      "Hi Aaron — This is Alexandra at American Harley-Davidson. This is Giovanni at American Harley-Davidson. We can review current specials.",
    expect: { maxScore: 75, mustIncludeIssues: ["role_inconsistency"] }
  },
  {
    id: "generic_reask_when_model_given",
    inboundText: "I’m looking at a 2017 orange Street Glide and can come in tomorrow.",
    outboundText: "Thanks for the update. Which model are you interested in?",
    expect: { maxScore: 75, mustIncludeIssues: ["generic_model_reask"] }
  },
  {
    id: "night_rod_mid_controls_fact_conflict",
    inboundText: "Night rod with the mid controls",
    outboundText:
      "Understood. I can check on Night Rods with mid controls and see what options we have. Are you looking for a new or pre-owned Night Rod?",
    expect: { maxScore: 75, mustIncludeIssues: ["known_fact_conflict"] }
  },
  {
    id: "consignment_request_hijacked_by_scheduling",
    inboundText: "Can you sell a bike for me for a commission?",
    outboundText: "I can set up a time to stop in. I have Tuesday at 9:30 AM or 11:30 AM — do any of these times work?",
    expect: { maxScore: 75, mustIncludeIssues: ["intent_mismatch", "question_not_answered_first"] }
  },
  {
    id: "specific_day_reasked_generically",
    inboundText: "Thank you for that. Can you let me know about the check and if Saturday is okay?",
    outboundText: "Absolutely — what day and time works for you?",
    expect: { maxScore: 85, mustIncludeIssues: ["generic_day_reask"] }
  },
  {
    id: "schedule_correction_answered_wrong_topic",
    inboundText:
      "Happy Easter! I see that the location is closed on Mondays. I think I made a mistake on telling you Monday. Wednesday at 3:45pm would work!",
    outboundText: "We’re located at 1149 Erie Ave., North Tonawanda, NY 14120. Do you want pricing details or a quick model comparison?",
    expect: { maxScore: 75, mustIncludeIssues: ["intent_mismatch"] }
  },
  {
    id: "service_records_overcommitted_availability_watch",
    inboundText:
      "I wanted to know about any service records, including the age of the battery and tires. I'll be back in Westfield, NY in early May. So if this bike is still available at that time, I would love to drop by.",
    outboundText:
      "Thanks for the details — I’ll have the team check service records (battery/tires) and follow up. I’ll also keep an eye on availability for early May.",
    expect: { maxScore: 85, mustIncludeIssues: ["overcommitted_availability_watch"] }
  },
  {
    id: "current_bike_photo_request_not_stock_count",
    inboundText: "Is it pretty beat up or? Any quick pics of it? I'm a ways away so it is a bit of a haul.",
    outboundText: "We do have 1 used 2003 1200 Custom in Silver in stock. Want photos or details?",
    expect: { maxScore: 85, mustIncludeIssues: ["redundant_current_bike_stock_count"] }
  },
  {
    id: "appointment_status_answered_as_new_schedule",
    inboundText: "Hey is my appointment today Dalton Magill ?",
    outboundText: "Sounds good — I’ll check available times for today and follow up.",
    expect: { maxScore: 70, mustIncludeIssues: ["appointment_status_answer_mismatch"] }
  },
  {
    id: "post_sale_key_backseat_answered_as_schedule_time",
    inboundText:
      "Absolutely! Btw.  I'm hoping you guys still have my garage key on my sporster keyring I left with y'all?\n\nAlso, I'm stopping by after work today dropping off the backseat for sporster.  Thanks",
    outboundText: "Sounds good — I’ll check that time and follow up.",
    expect: { maxScore: 65, mustIncludeIssues: ["post_sale_logistics_schedule_mismatch"] }
  },
  {
    id: "adf_location_cost_question_missing_location",
    inboundText:
      "WEB LEAD (ADF)\nSource: Room58 - Book test ride\nRef: 11361\nName: Camille Knight\nYear: 2026\nVehicle: Harley-Davidson Breakout\n\nInquiry:\nNot sure where this is located or what s the cost, but I m located in New York, NY. Thank you!",
    outboundText:
      "Hi Camille — This is Alexandra at American Harley-Davidson. I don’t see a published price in the inventory feed for the 2026 Breakout, so I’ll have the team confirm it and send it over.",
    expect: { maxScore: 70, mustIncludeIssues: ["adf_direct_ask_unanswered"] }
  },
  {
    id: "adf_model_trim_special_not_pricing",
    inboundText:
      "WEB LEAD (ADF)\nSource: Room58 - Book test ride\nRef: 11450\nName: Todd Herian\nYear: 2023\nVehicle: Harley-Davidson Road Glide Special\n\nInquiry:\nTest ride request for Road Glide Special. Preferred date: 6/20/2026. Preferred time: Whenever.",
    outboundText:
      "Yes — the 2023 Road Glide Special in Heirloom Red Fade is available. What day and time works best to stop in and take a look?",
    expect: { minScore: 85, mustNotIncludeIssues: ["adf_direct_ask_unanswered"] }
  },
  {
    // Hardship disclosed on a normal sales/logistics turn (Nicholas Braun: deposit/hold request
    // texted from a hospital bed). A tone-deaf sales push that never acknowledges the hardship
    // must flag hardship_ack_missing. The runtime fix (hardshipEmpathyAck.ts) prepends the ack;
    // this scorer net catches any reply that goes out without it.
    id: "hardship_disclosure_unacknowledged_sales_push",
    inboundText:
      "Thank you Joe I am still very much interested and want to hold it, I've had a medical emergency since we've talked and I'm currently still in the hospital, is there a way I can send the money to hold it?",
    outboundText:
      "Love it — those limited runs move quick. I'll have Stone reach out to get one reserved for you.",
    expect: { maxScore: 70, mustIncludeIssues: ["hardship_ack_missing"] }
  },
  {
    // The acknowledged reply (your rewrite shape) clears it.
    id: "hardship_disclosure_acknowledged_passes",
    inboundText:
      "Thank you Joe I am still very much interested and want to hold it, I've had a medical emergency since we've talked and I'm currently still in the hospital, is there a way I can send the money to hold it?",
    outboundText:
      "I'm really sorry to hear that — take all the time you need to heal. Yes, we can absolutely hold it; I'll get a hold of you tomorrow and we can arrange the deposit over the phone if that's easier.",
    expect: { mustNotIncludeIssues: ["hardship_ack_missing"] }
  },
  {
    // Traffic Log Pro deal-progression note (Dana Carr): the "Inquiry" body is a
    // staff CRM note ("Left a $2,000 deposit ... finalize deal. (Step 6)"), not a
    // customer pricing question. The pricing keyword `deal` must NOT fabricate an
    // adf_direct_ask_unanswered; the soft re-engagement reply is correct.
    id: "adf_deal_progression_step_note_not_pricing_ask",
    inboundText:
      "WEB LEAD (ADF) Source: Traffic Log Pro Ref: 11473 Name: Dana Carr Email: danacarr25@aol.com Phone: 7162607633 Stock: U889-21 VIN: 1HD1KRP10MB626979 Year: 2021 Vehicle: Harley-Davidson Street Glide Special (Snake Venom - Black Finish)  Inquiry: Left a $2,000 deposit on the motorcycle. will be back either Friday or next week to finalize deal. (Step 6)",
    outboundText:
      "Hey Dana, It's Stone. Thanks again for coming in today. We will talk either Friday or next week Reply STOP to opt out.",
    expect: { minScore: 85, mustNotIncludeIssues: ["adf_direct_ask_unanswered"] }
  },
  {
    id: "adf_genuine_specials_ask_still_pricing",
    inboundText:
      "WEB LEAD (ADF)\nSource: Website contact form\nRef: 20003\nName: Deal Hunter\nYear: 2026\nVehicle: Harley-Davidson Road Glide\n\nInquiry:\nAny specials or deals running on a Road Glide right now?",
    outboundText:
      "Hi — This is Brooke at American Harley-Davidson. Thanks — I saw you wanted to learn more about a Road Glide. I’m here to help.",
    expect: { mustIncludeIssues: ["adf_direct_ask_unanswered"] }
  },
  {
    // Model-less "Request a Quote" ADF (Vehicle: Other). The old draft-state
    // repair ("I'll have the team check current options that fit...") named no
    // next step and carried no pricing signal, so it scored intent_mismatch +
    // adf_direct_ask_unanswered. This pins that the vague team-check style is
    // still caught.
    id: "adf_quote_model_less_generic_team_check_fails",
    inboundText:
      "WEB LEAD (ADF) Source: HD.com Request a Quote Ref: 11456 Name: Nicholas Braun Email: nicholasmbraun95@gmail.com Phone: 7166286477 Year: 2026 Vehicle: Harley-Davidson Other  Inquiry: Customer Comments: PreferredMethodOfContact - text(sms), InterestedInCustomizingMotorcycle - no-",
    outboundText:
      "I’ll have the team check current options that fit what you’re asking for and follow up shortly. Reply STOP to opt out.",
    expect: { maxScore: 70, mustIncludeIssues: ["intent_mismatch", "adf_direct_ask_unanswered"] }
  },
  {
    // The repaired opener for the same lead: asks which bike (the only way to
    // advance a quote with no model) and names the pricing follow-through.
    id: "adf_quote_model_less_repaired_opener_passes",
    inboundText:
      "WEB LEAD (ADF) Source: HD.com Request a Quote Ref: 11456 Name: Nicholas Braun Email: nicholasmbraun95@gmail.com Phone: 7166286477 Year: 2026 Vehicle: Harley-Davidson Other  Inquiry: Customer Comments: PreferredMethodOfContact - text(sms), InterestedInCustomizingMotorcycle - no-",
    outboundText:
      "Happy to help! Which Harley are you eyeing? Once I know the model, I’ll check what we’ve got in stock and pull current pricing for you.",
    expect: { minScore: 85, mustNotIncludeIssues: ["adf_direct_ask_unanswered", "intent_mismatch"] }
  },
  {
    id: "adf_service_question_hijacked_by_inventory",
    inboundText:
      "WEB LEAD (ADF)\nSource: ROOM 58 LTD\nRef: 20001\nName: Sam Service\nYear: 2018\nVehicle: Harley-Davidson Street Glide\n\nInquiry:\nDo you do NYS inspections on Harleys?",
    outboundText:
      "Hi Sam — This is Brooke at American Harley-Davidson. Thanks — I saw you wanted to learn more about the 2018 Street Glide. I’m here to help.",
    expect: { maxScore: 70, mustIncludeIssues: ["adf_direct_ask_unanswered"] }
  },
  {
    id: "adf_parts_question_hijacked_by_inventory",
    inboundText:
      "WEB LEAD (ADF)\nSource: Website contact form\nRef: 20002\nName: Pat Parts\n\nInquiry:\nCan you order part number 67800589 for my Road Glide?",
    outboundText:
      "Hi Pat — This is Brooke at American Harley-Davidson. Thanks — I saw you wanted to learn more about a Road Glide. I’m here to help.",
    expect: { maxScore: 70, mustIncludeIssues: ["adf_direct_ask_unanswered"] }
  },
  {
    id: "warranty_question_answered",
    inboundText: "What warranty comes with a new Harley?",
    outboundText:
      "New Harley-Davidson motorcycles include a 2-year factory limited warranty, and we can review optional extended coverage plans.",
    expect: { minScore: 85, mustNotIncludeIssues: ["intent_mismatch"] }
  },
  {
    id: "scheduling_question_answered",
    inboundText: "Can I come in Saturday at 9:30?",
    outboundText: "Saturday at 9:30 can work. Want me to lock that in now?",
    expect: { minScore: 85, mustNotIncludeIssues: ["intent_mismatch", "question_not_answered_first"] }
  },
  {
    // "Book test ride" forms auto-populate the structured Trade-In field with
    // the SAME model the customer wants to ride (Sanjeev Goms, 2026-06-29).
    // That mirror is a form artifact, not a customer trade ask — the scheduling
    // reply must NOT be dinged for an unanswered trade.
    id: "adf_mirrored_tradein_is_not_a_trade_ask",
    inboundText:
      "WEB LEAD (ADF) Source: Room58 - Book test ride Ref: 11546 Name: Sanjeev Goms Email: x@x.com Phone: 18610167776 Year: 2026 Vehicle: Harley-Davidson Sportster S Trade-In: Sportster S Inquiry: Test ride request for Sportster S. Preferred date: 29/6/2026. Preferred time: 12 pm.",
    outboundText:
      "Hey Sanjeev, it's Alexandra over at American Harley-Davidson. Thanks — I saw you’re interested in a test ride on the 2026 Sportster S. I’m not seeing that exact bike available right now, but I can help pick an in-stock bike to ride.",
    expect: { mustNotIncludeIssues: ["adf_direct_ask_unanswered"] }
  },
  {
    // A DISTINCT structured trade vehicle (not a mirror) IS a genuine trade ask
    // — leaving it unaddressed must still flag.
    id: "adf_distinct_structured_trade_must_flag",
    inboundText:
      "WEB LEAD (ADF) Source: Room58 - Book test ride Ref: 20010 Name: Real Trade Email: x@x.com Phone: 17160000000 Year: 2026 Vehicle: Harley-Davidson Road Glide Trade-In: 2019 Indian Chief Inquiry: Test ride request for Road Glide. Preferred date: 7/1/2026.",
    outboundText:
      "Hey there, it's Alexandra over at American Harley-Davidson. Thanks — I saw you’re interested in a test ride on the 2026 Road Glide. I can help line that up.",
    expect: { mustIncludeIssues: ["adf_direct_ask_unanswered"] }
  },
  {
    // Trade language in the inquiry BODY (Dante Turello, 2026-06-29) is a real
    // trade ask even with no structured Trade-In field — must still flag.
    id: "adf_body_stated_trade_must_flag",
    inboundText:
      "WEB LEAD (ADF) Source: Room58 Ref: 11549 Name: Dante Turello Email: x@x.com Phone: 17169085899 Stock: U588-23 Year: 2023 Vehicle: Harley-Davidson Low Rider S Inquiry: Checking on the price, have a 2022 Suzuki gsx-s750 I'd be looking to trade in as well.",
    outboundText:
      "Hey Dante, it's Alexandra over at American Harley-Davidson. I’ll have our team confirm the out-the-door number on the 2023 Low Rider S and follow up with exact numbers.",
    expect: { mustIncludeIssues: ["adf_direct_ask_unanswered"] }
  }
];

function hasIssue(issues: string[], issue: string): boolean {
  return issues.includes(issue);
}

// --- Reply-matching fixtures (Joe ruling 2026-07-13: a reply after the 30-min
// window is a LATE reply, not a missing_response miss). Exercises the extracted
// matchInboundReply so the "did this turn get answered" rule stays pinned.
const WINDOW_MIN = 30;
const T0 = Date.parse("2026-07-12T15:00:00.000Z");
const at = (minAfter: number) => new Date(T0 + minAfter * 60 * 1000).toISOString();

type MatchFixture = {
  id: string;
  messages: Array<{ direction: "in" | "out"; at: string; body: string }>;
  inboundIndex: number;
  expect: { matched: boolean; withinWindow?: boolean };
};

const MATCH_FIXTURES: MatchFixture[] = [
  {
    id: "prompt_reply_within_window",
    messages: [
      { direction: "in", at: at(0), body: "Can I look at it Saturday?" },
      { direction: "out", at: at(10), body: "Saturday works — what time?" }
    ],
    inboundIndex: 0,
    expect: { matched: true, withinWindow: true }
  },
  {
    id: "late_reply_hours_later_is_not_a_miss",
    // Davey Cash shape: real, good reply ~4h later, no re-nudge in between.
    messages: [
      { direction: "in", at: at(0), body: "Hi Alexandra can I look at it on Saturday?" },
      { direction: "out", at: at(262), body: "Happy to help. Saturday can work. Just let me know what time." }
    ],
    inboundIndex: 0,
    expect: { matched: true, withinWindow: false }
  },
  {
    id: "reply_just_past_window_is_late_not_miss",
    messages: [
      { direction: "in", at: at(0), body: "Do you have black street glides?" },
      { direction: "out", at: at(31), body: "Yes — a couple in stock. Want details?" }
    ],
    inboundIndex: 0,
    expect: { matched: true, withinWindow: false }
  },
  {
    id: "no_reply_at_all_is_a_miss",
    messages: [{ direction: "in", at: at(0), body: "Still interested, any update?" }],
    inboundIndex: 0,
    expect: { matched: false }
  },
  {
    id: "customer_renudged_before_reply_is_a_miss",
    // First text sat unanswered until the customer re-pinged → the first turn is a
    // genuine drop; the reply attaches to the second inbound instead.
    messages: [
      { direction: "in", at: at(0), body: "Can you send pricing?" },
      { direction: "in", at: at(90), body: "Hello? Anyone there?" },
      { direction: "out", at: at(300), body: "So sorry for the delay — pricing coming right up." }
    ],
    inboundIndex: 0,
    expect: { matched: false }
  },
  {
    id: "reply_attaches_to_second_inbound_after_renudge",
    messages: [
      { direction: "in", at: at(0), body: "Can you send pricing?" },
      { direction: "in", at: at(90), body: "Hello? Anyone there?" },
      { direction: "out", at: at(300), body: "So sorry for the delay — pricing coming right up." }
    ],
    inboundIndex: 1,
    expect: { matched: true, withinWindow: false }
  }
];

function runMatchFixtures(): number {
  let failing = 0;
  for (const f of MATCH_FIXTURES) {
    const match = matchInboundReply(f.messages, f.inboundIndex, WINDOW_MIN);
    let pass = true;
    if (f.expect.matched !== Boolean(match)) pass = false;
    if (match && f.expect.withinWindow !== undefined && match.withinWindow !== f.expect.withinWindow) pass = false;
    if (!pass) failing += 1;
    const got = match ? `matched(withinWindow=${match.withinWindow})` : "no-match";
    console.log(`${pass ? "PASS" : "FAIL"} match:${f.id} -> ${got}`);
  }
  return failing;
}

function main() {
  let passCount = 0;
  const rows = FIXTURES.map(f => {
    const actual = evaluateTurnToneQuality({
      inboundText: f.inboundText,
      outboundText: f.outboundText
    });
    const issueCodes = actual.issues.map(x => x.code);
    let pass = true;

    if (Number.isFinite(f.expect.minScore) && actual.score < Number(f.expect.minScore)) pass = false;
    if (Number.isFinite(f.expect.maxScore) && actual.score > Number(f.expect.maxScore)) pass = false;

    for (const issue of f.expect.mustIncludeIssues ?? []) {
      if (!hasIssue(issueCodes, issue)) pass = false;
    }
    for (const issue of f.expect.mustNotIncludeIssues ?? []) {
      if (hasIssue(issueCodes, issue)) pass = false;
    }

    if (pass) passCount += 1;
    return {
      id: f.id,
      pass,
      score: actual.score,
      issues: issueCodes
    };
  });

  for (const row of rows) {
    console.log(`${row.pass ? "PASS" : "FAIL"} ${row.id} score=${row.score} issues=${row.issues.join("|") || "-"}`);
  }

  const matchFailing = runMatchFixtures();

  const failing = rows.length - passCount + matchFailing;
  if (failing > 0) {
    console.error(`\n${failing} tone-quality fixture checks failed.`);
    process.exit(1);
  }
  console.log(
    `\nAll ${rows.length} tone-grader + ${MATCH_FIXTURES.length} reply-matching fixture checks passed.`
  );
}

main();
