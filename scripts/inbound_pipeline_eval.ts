import {
  canInviteScheduleAfterBusinessHours,
  classifyInboundPreParserTurn,
  decorateBusinessHoursReply,
  resolveDealerTransactionPolicyRoute,
  resolveInboundTerminalRoute,
  shouldParseBusinessHoursQuestion,
  businessHoursTurnCarriesAnotherAsk,
  mapBusinessHoursQuestionParse
} from "../services/api/src/domain/inboundPipeline.ts";
import fs from "node:fs";
import path from "node:path";

type Case = {
  id: string;
  actual: unknown;
  expected: unknown;
};

const cases: Case[] = [
  {
    id: "twilio_hours_question_routes_to_pre_parser",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "Like to see tomorrow. You open till when"
    })?.routeOutcome,
    expected: "business_hours_question_pre_parser"
  },
  {
    id: "twilio_hours_with_time_marks_schedule_time_signal",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "Are you open Monday at 1?"
    })?.hasScheduleTimeSignal,
    expected: true
  },
  {
    id: "color_preference_open_word_not_hours",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "I am open to either color tomorrow"
    }),
    expected: null
  },
  {
    id: "service_time_request_not_hours",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "Do you have anything Thursday afternoon?"
    }),
    expected: null
  },
  {
    id: "after_hours_courtesy_with_real_question_not_hours",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text:
        "Hi Joe, sorry to text you after hours but had a quick question. Would you be able to facilitate a trade for a used bike I found with a private seller?"
    }),
    expected: null
  },
  {
    id: "adf_hours_question_does_not_use_twilio_pre_parser",
    actual: classifyInboundPreParserTurn({
      provider: "sendgrid_adf",
      channel: "sms",
      text: "What are your hours?"
    }),
    expected: null
  },
  // Production miss, Dustin Jordan +17163277383 (2026-07-29): two consecutive hours questions
  // with no hours word were punted to the lead owner. The regex alone must still miss them
  // (that pins WHY the parser is needed); the parser must route them.
  {
    id: "hours_question_without_hours_word_misses_lexical_gate",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "Are you guys available weekends?"
    }),
    expected: null
  },
  {
    id: "hours_question_without_hours_word_routes_on_parser",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "Are you guys available weekends?",
      hoursQuestionParse: {
        isHoursQuestion: true,
        scope: "dealership",
        day: "weekends",
        confidence: 0.93
      }
    })?.routeOutcome,
    expected: "business_hours_question_pre_parser"
  },
  {
    id: "hours_question_parser_route_is_labeled_parser_sourced",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "I do work days what is your availability like?",
      hoursQuestionParse: { isHoursQuestion: true, scope: "dealership", day: null, confidence: 0.85 }
    })?.source,
    expected: "parser"
  },
  {
    id: "lexical_hours_question_stays_lexical_sourced",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "Are you open Saturday?"
    })?.source,
    expected: "lexical"
  },
  // ═══ THE PARSER'S NARROW VETO (+17163975098, 2026-07-16) ═══
  // He wrote: "…If it looks like it'll be close I'll get ahold of you guys before hand.  Should I
  // send a photo of my id and my insurance over for it?" — isBusinessHoursQuestionText fires on
  // "close" (as in CUTTING IT CLOSE) plus a question mark, so the turn was answered "Our hours
  // tomorrow are 9:00 AM–6:00 PM." and his real question was never answered by anyone.
  // The live parser reads this false/none at 0.90–0.95 (measured 5/5 on 2026-08-09).
  {
    id: "confident_parser_none_vetoes_an_accidental_keyword_hours_claim",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text:
        "I should be able to swing in around then tomorrow. If it looks like it'll be close I'll " +
        "get ahold of you guys before hand.\n\nShould I send a photo of my id and my insurance over for it?",
      hoursQuestionParse: { isHoursQuestion: false, scope: "none", day: null, confidence: 0.95 }
    }),
    expected: null
  },
  // UNKNOWN NEVER VETOES — the three ways the parser can fail to speak all keep today's behaviour,
  // so an LLM outage cannot silently retire the hours answer.
  {
    id: "veto_needs_a_parse_at_all_outage_keeps_todays_answer",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "If it looks like it'll be close I'll get ahold of you guys. Should I send my id over?"
    })?.routeOutcome,
    expected: "business_hours_question_pre_parser"
  },
  {
    id: "veto_needs_confidence_at_or_above_the_floor",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "If it looks like it'll be close I'll get ahold of you guys. Should I send my id over?",
      hoursQuestionParse: { isHoursQuestion: false, scope: "none", day: null, confidence: 0.5 }
    })?.routeOutcome,
    expected: "business_hours_question_pre_parser"
  },
  // Only scope "none" vetoes. staff_person / appointment_slot are REAL availability questions the
  // hours path handles acceptably; vetoing them would fail toward saying nothing at all.
  {
    id: "staff_person_read_does_not_veto_a_real_hours_question",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "what time do you close today?",
      hoursQuestionParse: { isHoursQuestion: false, scope: "staff_person", day: null, confidence: 0.95 }
    })?.routeOutcome,
    expected: "business_hours_question_pre_parser"
  },
  {
    id: "appointment_slot_read_does_not_veto_a_real_hours_question",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "what time do you close today?",
      hoursQuestionParse: { isHoursQuestion: false, scope: "appointment_slot", day: null, confidence: 0.95 }
    })?.routeOutcome,
    expected: "business_hours_question_pre_parser"
  },
  // The veto never fights the accept: a parser that CLAIMS the turn still routes it.
  {
    id: "a_claiming_parse_still_routes_and_is_never_vetoed",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "what time do you close today?",
      hoursQuestionParse: { isHoursQuestion: true, scope: "dealership", day: "today", confidence: 0.95 }
    })?.routeOutcome,
    expected: "business_hours_question_pre_parser"
  },
  // A SELF-CONTRADICTORY parse is not a confident "no". The schema says is_hours_question is true
  // whenever scope is dealership/staff_person/appointment_slot, so `true` + `none` is a shape the
  // parser should never emit — but nothing enforces that, and a malformed parse must not be able to
  // silence a turn. It reads as unknown, and unknown never vetoes.
  {
    id: "a_self_contradictory_parse_never_vetoes",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "what time do you close today?",
      hoursQuestionParse: { isHoursQuestion: true, scope: "none", day: null, confidence: 0.95 }
    })?.routeOutcome,
    expected: "business_hours_question_pre_parser"
  },
  // A plain hours ask the parser confidently agrees is NOT about hours is a contradiction we do not
  // invent behaviour for — the parser wins, because that is the whole point of the veto.
  {
    id: "veto_applies_even_when_the_keyword_read_looks_obvious",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "are you open to trading for my Road King?",
      hoursQuestionParse: { isHoursQuestion: false, scope: "none", day: null, confidence: 0.9 }
    }),
    expected: null
  },
  // ═══ THE ONE-LINE ANSWER IS NOT ENOUGH (Ulises HernandezPerez, Ref 11755, 2026-08-08) ═══
  // An enrolled Riding Academy student: "...they close early today. I will make it a point to call
  // at 9am on Monday when they open again, is that going to be too late, WILL I LOSE MY SEAT?"
  // The hours READ is correct — the live parser says dealership at 0.85-0.90, 4/4 — and the hours
  // ANSWER is still not what he asked. The queued reply was "Our hours today are 9:00 AM-6:00 PM".
  // The live parser extracts other_ask verbatim on 4/4 runs, and empty on 4/4 plain hours asks.
  {
    id: "a_second_question_hands_the_turn_to_the_full_draft",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text:
        "I tried calling but its the weekend and they close early today. I will call at 9am on " +
        "Monday when they open again, is that going to be too late, will I lose my seat?",
      hoursQuestionParse: {
        isHoursQuestion: true,
        scope: "dealership",
        day: "Monday",
        otherAsk: "is that going to be too late, will I lose my seat",
        confidence: 0.9
      }
    }),
    expected: null
  },
  {
    id: "an_hours_only_turn_still_takes_the_one_line_shortcut",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "what time do you close today?",
      hoursQuestionParse: {
        isHoursQuestion: true,
        scope: "dealership",
        day: "today",
        otherAsk: "",
        confidence: 0.95
      }
    })?.routeOutcome,
    expected: "business_hours_question_pre_parser"
  },
  {
    id: "a_missing_other_ask_field_keeps_todays_behaviour",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "what time do you close today?",
      hoursQuestionParse: { isHoursQuestion: true, scope: "dealership", day: "today", confidence: 0.95 }
    })?.routeOutcome,
    expected: "business_hours_question_pre_parser"
  },
  {
    id: "whitespace_only_other_ask_is_not_another_ask",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "what time do you close today?",
      hoursQuestionParse: {
        isHoursQuestion: true,
        scope: "dealership",
        day: "today",
        otherAsk: "   ",
        confidence: 0.95
      }
    })?.routeOutcome,
    expected: "business_hours_question_pre_parser"
  },
  // Independent of scope — "one line is not enough" is true however the hours read landed.
  {
    id: "a_second_question_wins_over_a_staff_person_read_too",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      // The text must trip the KEYWORD gate, or the turn is never claimed and this case would pass
      // for the wrong reason — measured: the "is Giovanni working" phrasing does not trip it.
      text: "are you open Saturday? and can you send pics of the road glide",
      hoursQuestionParse: {
        isHoursQuestion: true,
        scope: "staff_person",
        day: "Saturday",
        otherAsk: "can you send pics of the road glide",
        confidence: 0.9
      }
    }),
    expected: null
  },
  // scope is the safety discriminator: store hours are a WRONG answer to these two.
  {
    id: "staff_person_availability_is_not_a_dealership_hours_answer",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "Is Giovanni working Saturday?",
      hoursQuestionParse: {
        isHoursQuestion: true,
        scope: "staff_person",
        day: "Saturday",
        confidence: 0.95
      }
    }),
    expected: null
  },
  {
    id: "appointment_slot_question_is_not_a_dealership_hours_answer",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      // Deliberately NOT the "anything open at 2" phrasing — that one carries the word "open"
      // and the pre-existing lexical gate has always routed it, so it proves nothing here.
      text: "Any chance you could fit me in at 2 on Thursday?",
      hoursQuestionParse: {
        isHoursQuestion: true,
        scope: "appointment_slot",
        day: "Thursday",
        confidence: 0.9
      }
    }),
    expected: null
  },
  {
    id: "low_confidence_hours_parse_does_not_route",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "you around this weekend?",
      hoursQuestionParse: { isHoursQuestion: true, scope: "dealership", day: null, confidence: 0.4 }
    }),
    expected: null
  },
  {
    id: "hours_parse_false_flag_does_not_route",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "any Road Glides available?",
      hoursQuestionParse: { isHoursQuestion: false, scope: "none", day: null, confidence: 0.95 }
    }),
    expected: null
  },
  // ADDITIVE-ONLY: a confident non-dealership parse must never take away a turn the regex
  // already answers. Fail direction of a veto would be silence on a real hours question.
  {
    id: "parser_never_vetoes_a_lexical_hours_question",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "What time do you close today?",
      hoursQuestionParse: {
        isHoursQuestion: true,
        scope: "staff_person",
        day: "today",
        confidence: 0.99
      }
    })?.routeOutcome,
    expected: "business_hours_question_pre_parser"
  },
  {
    id: "hours_parser_stays_off_non_twilio_channels",
    actual: classifyInboundPreParserTurn({
      provider: "sendgrid_adf",
      channel: "sms",
      text: "Are you guys available weekends?",
      hoursQuestionParse: { isHoursQuestion: true, scope: "dealership", day: null, confidence: 0.95 }
    }),
    expected: null
  },
  // The parser-claimed turn still carries its scheduling signals to the reply decorator.
  {
    id: "parser_routed_hours_question_keeps_day_signal",
    actual: classifyInboundPreParserTurn({
      provider: "twilio",
      channel: "sms",
      text: "are you guys available Saturday?",
      hoursQuestionParse: {
        isHoursQuestion: true,
        scope: "dealership",
        day: "Saturday",
        confidence: 0.9
      }
    })?.hasScheduleDaySignal,
    expected: true
  },
  // ⚠️ THE ANTI-INERTNESS ASSERTION. This gate used to return FALSE for any turn the regex already
  // claimed, on the reasoning that an additive-only parser could not change the outcome. Once the
  // parser gained a say over those turns (#630's veto, then the other-ask fallthrough), that skip
  // made BOTH features dead code in production — while every unit check still passed, because they
  // hand the referee a parse this gate would never have produced. A turn worth an hours ANSWER is
  // a turn worth an hours PARSE. Measured cost of the change: 7 extra calls in 30 days (0.2/day).
  {
    id: "regex_claimed_turn_is_STILL_worth_a_parse_or_the_veto_is_dead_code",
    actual: shouldParseBusinessHoursQuestion({
      provider: "twilio",
      channel: "sms",
      text: "What time do you close today?"
    }),
    expected: true
  },
  {
    id: "the_other_ask_turn_reaches_the_parser_at_all",
    actual: shouldParseBusinessHoursQuestion({
      provider: "twilio",
      channel: "sms",
      text:
        "I tried calling but its the weekend and they close early today. I will call at 9am on " +
        "Monday when they open again, is that going to be too late, will I lose my seat?"
    }),
    expected: true
  },
  {
    id: "the_630_veto_turn_reaches_the_parser_at_all",
    actual: shouldParseBusinessHoursQuestion({
      provider: "twilio",
      channel: "sms",
      text: "If it looks like it'll be close I'll get ahold of you guys. Should I send my id over?"
    }),
    expected: true
  },
  {
    id: "hours_parser_called_on_the_production_miss",
    actual: shouldParseBusinessHoursQuestion({
      provider: "twilio",
      channel: "sms",
      text: "Are you guys available weekends?"
    }),
    expected: true
  },
  {
    id: "hours_parser_called_on_the_availability_phrasing",
    actual: shouldParseBusinessHoursQuestion({
      provider: "twilio",
      channel: "sms",
      text: "I do work days what is your availability like?"
    }),
    expected: true
  },
  {
    id: "hours_parser_not_called_on_inventory_availability",
    actual: shouldParseBusinessHoursQuestion({
      provider: "twilio",
      channel: "sms",
      text: "Do you have any Road Glides available?"
    }),
    expected: false
  },
  {
    id: "hours_parser_not_called_on_email",
    actual: shouldParseBusinessHoursQuestion({
      provider: "twilio",
      channel: "email",
      text: "Are you guys available weekends?"
    }),
    expected: false
  },
  {
    id: "dealer_policy_route_accepts_parser_decision",
    actual: resolveDealerTransactionPolicyRoute({
      provider: "twilio",
      channel: "sms",
      hasDecision: true,
      source: "parser",
      asksRiderToRiderFinancing: true,
      asksPrivateSellerFacilitation: true,
      asksExternalDealerFacilitation: false
    })?.routeOutcome,
    expected: "dealer_transaction_policy"
  },
  {
    id: "dealer_policy_route_ignores_empty_decision",
    actual: resolveDealerTransactionPolicyRoute({
      provider: "twilio",
      channel: "sms",
      hasDecision: false,
      source: null,
      asksRiderToRiderFinancing: true,
      asksPrivateSellerFacilitation: true,
      asksExternalDealerFacilitation: false
    }),
    expected: null
  },
  {
    id: "business_hours_sales_invite_allowed",
    actual: canInviteScheduleAfterBusinessHours({
      isSalesLead: true,
      schedulingAllowed: true,
      followUpMode: "active",
      outboundHoldNotice: false
    }),
    expected: true
  },
  {
    id: "business_hours_manual_handoff_blocks_invite",
    actual: canInviteScheduleAfterBusinessHours({
      isSalesLead: true,
      schedulingAllowed: true,
      followUpMode: "manual_handoff",
      outboundHoldNotice: false
    }),
    expected: false
  },
  {
    id: "business_hours_with_time_gets_availability_guard",
    actual: decorateBusinessHoursReply({
      baseReply: "Our hours on Monday are 9:00 AM-6:00 PM.",
      decision: classifyInboundPreParserTurn({
        provider: "twilio",
        channel: "sms",
        text: "Are you open Monday at 1?"
      })!,
      canInviteSchedule: true
    }),
    expected:
      "Our hours on Monday are 9:00 AM-6:00 PM. That time is during open hours, but I still need to check appointment availability before locking it in."
  },
  {
    id: "business_hours_without_time_gets_schedule_invite",
    actual: decorateBusinessHoursReply({
      baseReply: "Our hours on Saturday are 9:00 AM-3:00 PM.",
      decision: classifyInboundPreParserTurn({
        provider: "twilio",
        channel: "sms",
        text: "Are you open Saturday?"
      })!,
      canInviteSchedule: true
    }),
    expected:
      "Our hours on Saturday are 9:00 AM-3:00 PM. If you're thinking about coming in, what time works best? I can put you down on the schedule."
  },
  {
    id: "terminal_watch_stop_wins_before_disposition_closeout",
    actual: resolveInboundTerminalRoute({
      provider: "twilio",
      channel: "sms",
      hasInventoryWatchStopContext: true,
      watchStopRequested: true,
      watchStopSource: "semantic_slot",
      customerDispositionDecision: {
        reason: "customer_stepping_back",
        state: "customer_stepping_back"
      },
      customerDispositionAllowed: true,
      responseControlNotInterested: true
    })?.kind,
    expected: "inventory_watch_optout"
  },
  {
    id: "terminal_watch_context_without_stop_does_not_clear_watch",
    actual: resolveInboundTerminalRoute({
      provider: "twilio",
      channel: "sms",
      hasInventoryWatchStopContext: true,
      watchStopRequested: false,
      watchStopSource: null,
      customerDispositionDecision: null,
      customerDispositionAllowed: false,
      responseControlNotInterested: true
    }),
    expected: null
  },
  {
    id: "terminal_response_control_not_interested_does_not_close_without_disposition",
    actual: resolveInboundTerminalRoute({
      provider: "twilio",
      channel: "sms",
      hasInventoryWatchStopContext: false,
      watchStopRequested: false,
      watchStopSource: null,
      customerDispositionDecision: null,
      customerDispositionAllowed: false,
      responseControlNotInterested: true
    }),
    expected: null
  },
  {
    id: "terminal_customer_disposition_closeout_requires_allowed_gate",
    actual: resolveInboundTerminalRoute({
      provider: "twilio",
      channel: "sms",
      hasInventoryWatchStopContext: false,
      watchStopRequested: false,
      watchStopSource: null,
      customerDispositionDecision: {
        reason: "customer_stepping_back",
        state: "customer_stepping_back"
      },
      customerDispositionAllowed: false,
      responseControlNotInterested: true
    }),
    expected: null
  },
  {
    id: "terminal_customer_disposition_closeout_routes_after_gate",
    actual: resolveInboundTerminalRoute({
      provider: "twilio",
      channel: "sms",
      hasInventoryWatchStopContext: false,
      watchStopRequested: false,
      watchStopSource: null,
      customerDispositionDecision: {
        reason: "customer_stepping_back",
        state: "customer_stepping_back"
      },
      customerDispositionAllowed: true,
      responseControlNotInterested: true
    })?.routeOutcome,
    expected: "customer_disposition_closeout"
  },
  {
    id: "terminal_sendgrid_adf_ignored",
    actual: resolveInboundTerminalRoute({
      provider: "sendgrid_adf",
      channel: "sms",
      hasInventoryWatchStopContext: true,
      watchStopRequested: true,
      watchStopSource: "lexical",
      customerDispositionDecision: {
        reason: "customer_stepping_back",
        state: "customer_stepping_back"
      },
      customerDispositionAllowed: true,
      responseControlNotInterested: true
    }),
    expected: null
  }
];

let passed = 0;
for (const c of cases) {
  const ok = JSON.stringify(c.actual) === JSON.stringify(c.expected);
  if (ok) passed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${c.id} expected=${JSON.stringify(c.expected)} actual=${JSON.stringify(
      c.actual
    )}`
  );
}

if (passed !== cases.length) {
  console.error(`\n${cases.length - passed} failures out of ${cases.length} inbound-pipeline cases`);
  process.exit(1);
}

// BOTH hours doors must ask this referee. The second door used to re-run the raw keyword scan
// (`isBusinessHoursQuestionText(event.body ?? "")`) and publish the canned line itself, which made
// the veto above INERT on exactly the turns it exists for — the customer's turn was still ended by
// a keyword. `.includes()` on purpose: an escaped paren here would count as a net source pin under
// eval_source_pin_ratchet.
const assertWiring = (ok: boolean, msg: string) => {
  if (!ok) {
    console.error(`\nFAIL ${msg}`);
    process.exit(1);
  }
  console.log(`PASS ${msg}`);
};
const liveHandler = fs.readFileSync(path.resolve("services/api/src/index.ts"), "utf8");

// The parser's OWN mapping, executed on raw model JSON — no LLM call. Without this, the parser
// could stop carrying other_ask through entirely and every decision-table case above would still
// pass, because they hand the referee a hand-built parse.
const mapped = mapBusinessHoursQuestionParse({
  is_hours_question: true,
  scope: "dealership",
  day: "Monday",
  other_ask: "  will I lose my seat  ",
  confidence: 0.9
});
assertWiring(mapped.otherAsk === "will I lose my seat", "the parser carries other_ask through, trimmed");
assertWiring(businessHoursTurnCarriesAnotherAsk(mapped), "a mapped parse with another ask reads as one");
const mappedEmpty = mapBusinessHoursQuestionParse({
  is_hours_question: true,
  scope: "dealership",
  day: "today",
  other_ask: "",
  confidence: 0.95
});
assertWiring(mappedEmpty.otherAsk === null, "an empty other_ask maps to null, not an empty string");
assertWiring(!businessHoursTurnCarriesAnotherAsk(mappedEmpty), "an hours-only parse carries no other ask");
const mappedMissing = mapBusinessHoursQuestionParse({ is_hours_question: true, scope: "dealership", confidence: 0.95 });
assertWiring(!businessHoursTurnCarriesAnotherAsk(mappedMissing), "a parse with no other_ask field at all is not another ask");

assertWiring(
  liveHandler.includes('livePreParserDecision?.kind === "business_hours_question"'),
  "the live hours door is gated on the shared pre-parser referee"
);
assertWiring(
  !liveHandler.includes('isBusinessHoursQuestionText(event.body ?? "")) {'),
  "no hours door opens on the raw keyword scan alone (that door made the parser veto inert)"
);
assertWiring(
  liveHandler.includes('regenPreParserDecision?.kind === "business_hours_question"'),
  "the regenerate hours door asks the same referee, so both paths carry the veto"
);

console.log(`\nAll ${cases.length} inbound-pipeline checks passed.`);
