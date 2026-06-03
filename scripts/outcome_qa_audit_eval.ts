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
    }
  ],
  todos: []
};

const report = buildOutcomeQaReport(store, {
  conversationsPath: "fixture",
  sinceHours: 24
});

assertCheck("outcome_count", report.summary.outcomeCount, 5);
assertCheck("missing_dealer_ride_thank_you_detected", hasIssue(report, "missing_dealer_ride_customer_thank_you"), true);
assertCheck("assumed_next_steps_detected", hasIssue(report, "assumed_agreed_next_steps"), true);
assertCheck("vague_noted_language_detected", hasIssue(report, "dealer_ride_vague_noted_language"), true);
assertCheck("wrong_salesperson_identity_detected", hasIssue(report, "wrong_salesperson_identity"), true);
assertCheck("finance_needs_info_state_detected", hasIssue(report, "finance_needs_info_missing_manual_handoff"), true);
assertCheck("finance_unsafe_claim_detected", hasIssue(report, "finance_outcome_unsafe_specific_claim"), true);
assertCheck("appointment_missing_action_detected", hasIssue(report, "appointment_outcome_missing_follow_up_action"), true);
assertCheck("related_party_seed_detected", hasSeedCue(report, "related_party_context"), true);
assertCheck("finance_docs_seed_detected", hasSeedCue(report, "docs_or_info_needed"), true);

console.log(`\nAll outcome QA audit eval checks passed.`);
