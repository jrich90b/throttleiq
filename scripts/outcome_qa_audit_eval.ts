import { buildOutcomeQaReport } from "./outcome_qa_audit.ts";

type AnyObj = Record<string, any>;

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function assertCheck(id: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} ${id} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (!ok) {
    throw new Error(`${id} failed`);
  }
}

function hasIssue(report: AnyObj, issue: string): boolean {
  return Array.isArray(report.findings) && report.findings.some((row: AnyObj) => row.issue === issue);
}

function hasIssueForConv(report: AnyObj, issue: string, convId: string): boolean {
  return (
    Array.isArray(report.findings) &&
    report.findings.some((row: AnyObj) => row.issue === issue && String(row.caseId ?? "").includes(convId))
  );
}

function hasSeedCue(report: AnyObj, cue: string): boolean {
  return (
    Array.isArray(report.parserSeedCandidates) &&
    report.parserSeedCandidates.some((row: AnyObj) => Array.isArray(row.cueTags) && row.cueTags.includes(cue))
  );
}

const store = {
  conversations: [
    {
      id: "conv_dealer_missing",
      leadKey: "+17160000001",
      mode: "suggest",
      leadOwner: { name: "Stone Giuga" },
      lead: {
        leadRef: "DR1",
        firstName: "Annie",
        lastName: "Sweeney",
        phone: "7160000001"
      },
      dealerRide: {
        staffNotify: {
          outcome: {
            status: "follow_up",
            primaryStatus: "showed",
            secondaryStatus: "not_ready",
            note: "came in to ride with her daughter that is buying a bike",
            updatedAt: isoMinutesAgo(20)
          }
        }
      },
      messages: []
    },
    {
      id: "conv_dealer_risky",
      leadKey: "+17160000002",
      mode: "suggest",
      leadOwner: { name: "Stone Giuga" },
      lead: {
        leadRef: "DR2",
        firstName: "Bob",
        lastName: "Rider",
        phone: "7160000002"
      },
      dealerRide: {
        staffNotify: {
          outcome: {
            status: "follow_up",
            primaryStatus: "showed",
            secondaryStatus: "needs_follow_up",
            note: "came in with his daughter",
            updatedAt: isoMinutesAgo(30)
          }
        }
      },
      messages: [
        {
          id: "msg_dealer_risky",
          direction: "out",
          provider: "draft_ai",
          at: isoMinutesAgo(29),
          body: "Hi Bob - This is Alexandra at American Harley-Davidson. Thanks again for coming in for the test ride. I'll follow up with the next steps we talked about."
        }
      ]
    },
    {
      id: "conv_finance_unsafe",
      leadKey: "+17160000003",
      mode: "suggest",
      leadOwner: { name: "Joe Hartrich" },
      lead: {
        leadRef: "FIN1",
        firstName: "Joseph",
        lastName: "Highway",
        phone: "7160000003"
      },
      followUp: { mode: "active", reason: "credit_app_started" },
      financeOutcome: {
        status: "needs_more_info",
        reasonText: "Harley needs proof of income and insurance before moving forward.",
        updatedAt: isoMinutesAgo(40)
      },
      messages: [
        {
          id: "msg_finance_unsafe",
          direction: "out",
          provider: "draft_ai",
          at: isoMinutesAgo(39),
          body: "Hi Joseph - you are approved for 4.99% APR with a $250 monthly payment."
        }
      ]
    },
    {
      id: "conv_dealer_noted",
      leadKey: "+17160000005",
      mode: "suggest",
      leadOwner: { name: "Stone Giuga" },
      lead: {
        leadRef: "DR3",
        firstName: "Alex",
        lastName: "Weeks",
        phone: "7160000005"
      },
      dealerRide: {
        staffNotify: {
          outcome: {
            status: "hold",
            primaryStatus: "showed",
            secondaryStatus: "hold",
            note: "Heritage Classic is on hold",
            updatedAt: isoMinutesAgo(45)
          }
        }
      },
      messages: [
        {
          id: "msg_dealer_noted",
          direction: "out",
          provider: "draft_ai",
          at: isoMinutesAgo(44),
          body: "Hi Alex - This is Stone at American Harley-Davidson. Thanks again for coming in for the test ride on the Heritage Classic. I have the Heritage Classic noted while we work through the next steps. I’ll keep you posted."
        }
      ]
    },
    {
      id: "conv_appt_missing",
      leadKey: "+17160000004",
      mode: "suggest",
      leadOwner: { name: "Scott Hartrich" },
      lead: {
        leadRef: "APT1",
        firstName: "Megan",
        lastName: "Sweeney",
        phone: "7160000004"
      },
      appointment: {
        staffNotify: {
          outcome: {
            status: "no_show",
            primaryStatus: "did_not_show",
            secondaryStatus: "needs_follow_up",
            note: "call next week to reschedule",
            updatedAt: isoMinutesAgo(50)
          }
        }
      },
      messages: []
    },
    {
      // Charles Desalvo, 2026-08-01 — the ride ended in a SALE. The pre-outcome
      // thank-you draft is wrong once he owns the bike, so the publisher staled
      // it and the post_sale cadence took over with the next touch scheduled.
      // That is the system working; it must not read as a missing thank-you.
      id: "conv_dealer_sold_post_sale_lane",
      leadKey: "+17160000005",
      mode: "suggest",
      leadOwner: { name: "Giovanni Boccabella" },
      lead: {
        leadRef: "DR3",
        firstName: "Charles",
        lastName: "Desalvo",
        phone: "7160000005"
      },
      followUpCadence: {
        status: "active",
        kind: "post_sale",
        nextDueAt: isoMinutesAgo(-180)
      },
      dealerRide: {
        staffNotify: {
          followUpSentAt: isoMinutesAgo(31),
          outcome: {
            status: "sold",
            primaryStatus: "showed",
            secondaryStatus: "sold",
            note: "",
            updatedAt: isoMinutesAgo(30)
          }
        }
      },
      messages: [
        {
          id: "msg_dealer_ride_thank_you_staled",
          direction: "out",
          provider: "draft_ai",
          draftStatus: "stale",
          at: isoMinutesAgo(31),
          body:
            "Hey Charles, it's Alexandra over at American Harley-Davidson. Thanks again for coming in for the test ride on the 2024 Street Glide. If any questions come up, just text me anytime."
        }
      ]
    },
    {
      // Fail direction: a SOLD ride with no post-sale follow-through still flags —
      // nobody is talking to the buyer, and that is a real miss.
      id: "conv_dealer_sold_no_post_sale_cadence",
      leadKey: "+17160000006",
      mode: "suggest",
      leadOwner: { name: "Giovanni Boccabella" },
      lead: {
        leadRef: "DR4",
        firstName: "Dana",
        lastName: "Orphan",
        phone: "7160000006"
      },
      dealerRide: {
        staffNotify: {
          followUpSentAt: isoMinutesAgo(31),
          outcome: {
            status: "sold",
            primaryStatus: "showed",
            secondaryStatus: "sold",
            note: "",
            updatedAt: isoMinutesAgo(30)
          }
        }
      },
      messages: []
    },
    {
      // And a LIVE (non-stale) thank-you published at notify time, before the
      // salesperson answered the outcome prompt 74s later, still counts.
      id: "conv_dealer_thanked_before_outcome",
      leadKey: "+17160000007",
      mode: "suggest",
      leadOwner: { name: "Stone Giuga" },
      lead: {
        leadRef: "DR5",
        firstName: "Pat",
        lastName: "Rider",
        phone: "7160000007"
      },
      dealerRide: {
        staffNotify: {
          followUpSentAt: isoMinutesAgo(31),
          outcome: {
            status: "follow_up",
            primaryStatus: "showed",
            secondaryStatus: "needs_follow_up",
            note: "wants to think it over",
            updatedAt: isoMinutesAgo(30)
          }
        }
      },
      messages: [
        {
          id: "msg_dealer_ride_thank_you_live",
          direction: "out",
          provider: "draft_ai",
          at: isoMinutesAgo(31),
          body:
            "Hey Pat, it's Alexandra over at American Harley-Davidson. Thanks again for coming in for the test ride today — anything you want me to pull together while you think it over?"
        }
      ]
    },
    // JOHN ZIMMERMAN (+17169902571), rebuilt from the live store, 2026-08-12. The finance
    // outcome went `needs_more_info` at 13:59Z; he then CAME IN that afternoon and a rep
    // recorded the appointment outcome at 21:07Z ("approved... Need to stay in touch"), which
    // repointed the single `conv.followUp` slot at `appointment_outcome_follow_up` and armed the
    // right cadence. The finance routing check graded that LATER state against the EARLIER
    // outcome and raised a P1 — the release gate's `outcome QA P1 1 > 0` failure for 2026-08-13.
    // Nothing here went wrong, so nothing here may be reported.
    {
      id: "conv_finance_superseded",
      leadKey: "+17160000009",
      mode: "human",
      leadOwner: { name: "Joe Hartrich" },
      lead: {
        leadRef: "FIN9",
        firstName: "John",
        lastName: "Northfield",
        phone: "7160000009"
      },
      followUp: { mode: "active", reason: "appointment_outcome_follow_up", updatedAt: isoMinutesAgo(60) },
      followUpCadence: { status: "active", kind: "engaged", nextDueAt: isoMinutesAgo(-600) },
      financeOutcome: {
        status: "needs_more_info",
        reasonText: "Manual outbound indicated finance/credit application needs more information.",
        updatedAt: isoMinutesAgo(480)
      },
      appointment: {
        staffNotify: {
          outcome: {
            status: "follow_up",
            primaryStatus: "showed",
            secondaryStatus: "not_ready",
            note: "approved. went over numbers on new and pre-owned road glides. Need to stay in touch",
            updatedAt: isoMinutesAgo(60)
          }
        }
      },
      messages: []
    }
  ],
  todos: []
};

const report = buildOutcomeQaReport(store, {
  conversationsPath: "fixture",
  sinceHours: 24
});

// 10 = the original 8 plus the two the superseded fixture carries (its finance outcome and the
// later appointment outcome that supersedes it). Both are still INSPECTED; only the routing
// verdict on the older one is withheld.
assertCheck("outcome_count", report.summary.outcomeCount, 10);
assertCheck("missing_dealer_ride_thank_you_detected", hasIssue(report, "missing_dealer_ride_customer_thank_you"), true);
assertCheck(
  "missing_dealer_ride_thank_you_still_fires_when_absent",
  hasIssueForConv(report, "missing_dealer_ride_customer_thank_you", "conv_dealer_missing"),
  true
);
assertCheck(
  "sold_ride_handed_to_post_sale_lane_is_not_a_miss",
  hasIssueForConv(report, "missing_dealer_ride_customer_thank_you", "conv_dealer_sold_post_sale_lane"),
  false
);
assertCheck(
  "sold_ride_without_post_sale_cadence_still_flags",
  hasIssueForConv(report, "missing_dealer_ride_customer_thank_you", "conv_dealer_sold_no_post_sale_cadence"),
  true
);
assertCheck(
  "thank_you_published_before_outcome_is_not_a_miss",
  hasIssueForConv(report, "missing_dealer_ride_customer_thank_you", "conv_dealer_thanked_before_outcome"),
  false
);
assertCheck("assumed_next_steps_detected", hasIssue(report, "assumed_agreed_next_steps"), true);
assertCheck("vague_noted_language_detected", hasIssue(report, "dealer_ride_vague_noted_language"), true);
assertCheck("wrong_salesperson_identity_detected", hasIssue(report, "wrong_salesperson_identity"), true);
assertCheck("finance_needs_info_state_detected", hasIssue(report, "finance_needs_info_missing_manual_handoff"), true);
// The negative control for the pair below: conv_finance_unsafe is the SAME needs-more-info state
// with NO later outcome, and it must keep firing. If this ever goes false the guard has stopped
// discriminating and is simply silencing the check.
assertCheck(
  "finance_needs_info_still_fires_without_a_later_outcome",
  hasIssueForConv(report, "finance_needs_info_missing_manual_handoff", "conv_finance_unsafe"),
  true
);
// The phantom itself: a finance outcome whose follow-up slot was rewritten by a LATER outcome
// cannot be graded on that slot, so it must not be reported.
assertCheck(
  "finance_needs_info_superseded_by_later_outcome_is_not_a_finding",
  hasIssueForConv(report, "finance_needs_info_missing_manual_handoff", "conv_finance_superseded"),
  false
);
assertCheck("finance_unsafe_claim_detected", hasIssue(report, "finance_outcome_unsafe_specific_claim"), true);
assertCheck("appointment_missing_action_detected", hasIssue(report, "appointment_outcome_missing_follow_up_action"), true);
assertCheck("related_party_seed_detected", hasSeedCue(report, "related_party_context"), true);
assertCheck("finance_docs_seed_detected", hasSeedCue(report, "docs_or_info_needed"), true);

console.log(`\nAll outcome QA audit eval checks passed.`);
