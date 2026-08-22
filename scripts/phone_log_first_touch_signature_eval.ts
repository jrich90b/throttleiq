/**
 * A PHONE-LOG first touch signs as the rep who took the call — not the dealer persona.
 *
 * TRIGGER (Zack Busch, +17162489119, operator-reported 2026-08-19, routing):
 *   "should have introduced as salesperson which is joe, not alexandra."
 * Joe took Zack's call, logged it in Traffic Log Pro, and the ADF landed with
 * `leadOwner: Joe Hartrich`. Nothing had been sent on the thread yet, so the manual-sender lock
 * was unset, and a phone log does not raise `lead.walkIn` — every arm of the ladder missed and
 * the draft opened "Hey Zackary, it's Alexandra over at American Harley-Davidson." Joe rewrote
 * it to "Hey Zack, it's Joe over at American Harley-Davidson" before sending.
 *
 * MEASURED over the whole americanharley store (883 conversations, 2026-08-22): 10 are phone
 * logs. Of the 7 first touches a HUMAN wrote, 7 sign as the lead owner — "this is Scott from
 * American H-D", "it's Joe over at American Harley" — and none sign as the persona. The one
 * machine draft we can read is Zack's, and it was rewritten. Unanimous.
 *
 * WHAT IS PINNED IS THE DECISION (who we say we are), not the wording of any reply — a phone-log
 * first touch resolves to the lead owner's FIRST name, and every narrower arm above it still wins.
 * Case 2 is the one that keeps this honest: strip the phone-log evidence and the SAME record must
 * go back to the persona, so a change that simply always returned the owner would fail here.
 */
import assert from "node:assert/strict";
import { resolveConversationAgentName } from "../services/api/src/domain/agentVoice.js";

const PERSONA = "Alexandra";
const failures: string[] = [];
const check = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err: any) {
    failures.push(`${name}: ${err?.message ?? err}`);
    console.log(`FAIL ${name}: ${err?.message ?? err}`);
  }
};

/** Zack's record, reduced to the state the composer saw: the ADF has landed, nothing sent. */
function phoneLogConvBeforeAnySend() {
  return {
    id: "+17162489119",
    mode: "suggest",
    lead: { firstName: "Zackary", lastName: "Busch", source: "Traffic Log Pro" },
    leadOwner: { id: "u-joe", name: "Joe Hartrich", assignedAt: "2026-08-19T19:45:10.179Z" },
    messages: [
      {
        id: "m1",
        direction: "in",
        provider: "sendgrid_adf",
        at: "2026-08-19T19:45:10.295Z",
        body:
          "PHONE LOG (ADF)\nSource: Traffic Log Pro\nRef: 11814\nName: Zackary Busch\nPhone: 7162489119\n" +
          "Year: 2008\nVehicle: Flhtcu\n\nInquiry:\nZack called looking to see if we had any pre-owned " +
          "ultras under $7,500. I showed him the 2008 FLHTCU that i just took in on trade."
      }
    ]
  };
}

check("phone_log_first_touch_signs_as_the_rep_who_took_the_call", () => {
  const name = resolveConversationAgentName(phoneLogConvBeforeAnySend(), PERSONA);
  assert.equal(
    name,
    "Joe",
    `a Traffic Log Pro phone log owned by Joe Hartrich must sign as Joe, got ${name}`
  );
});

check("web_lead_with_the_same_owner_still_signs_as_the_persona", () => {
  // Identical record MINUS the phone-log evidence: an ordinary web lead the owner has never
  // spoken to. If this also returned "Joe" the arm would not be scoped to phone logs at all.
  const conv: any = phoneLogConvBeforeAnySend();
  conv.lead.source = "Website Text Widget";
  conv.messages[0].body =
    "WEB LEAD (ADF)\nSource: Website Text Widget\nRef: 11814\nName: Zackary Busch\nPhone: 7162489119\n" +
    "Year: 2008\nVehicle: Flhtcu\n\nInquiry:\nInterested in pre-owned ultras.";
  const name = resolveConversationAgentName(conv, PERSONA);
  assert.equal(name, PERSONA, `a plain web lead must keep the persona, got ${name}`);
});

check("traffic_log_pro_without_call_evidence_still_signs_as_the_persona", () => {
  // Traffic Log Pro ALSO carries in-store walk-in notes. The phone-log test needs both the
  // source and language about a call; a TLP note with neither must not take this arm.
  const conv: any = phoneLogConvBeforeAnySend();
  conv.messages[0].body =
    "PHONE LOG (ADF)\nSource: Traffic Log Pro\nRef: 11814\nName: Zackary Busch\n\nInquiry:\n" +
    "Stopped by the showroom to look at pre-owned ultras.";
  const name = resolveConversationAgentName(conv, PERSONA);
  assert.equal(name, PERSONA, `a TLP note with no call language must keep the persona, got ${name}`);
});

check("a_rep_who_already_took_the_thread_over_still_outranks_the_phone_log", () => {
  // The send-time lock is a deliberate act and stays the most specific arm. Scott took this
  // thread over; the phone-log owner is Joe. Scott must win.
  const conv: any = phoneLogConvBeforeAnySend();
  conv.manualSender = {
    userId: "u-scott",
    userName: "Scott Hartrich",
    activatedAt: "2026-08-19T20:00:00.000Z",
    source: "manual_takeover"
  };
  const name = resolveConversationAgentName(conv, PERSONA);
  assert.equal(name, "Scott", `the manual-sender lock must still win, got ${name}`);
});

check("never_signs_as_the_customer_when_the_owner_shares_their_name", () => {
  // +15858803917 in the live store is a lead literally named Joe owned by Scott; the mirror
  // case (owner and customer sharing a first name) must not have us text "it's Joe" to Joe.
  const conv: any = phoneLogConvBeforeAnySend();
  conv.lead.firstName = "Joe";
  conv.lead.lastName = "Hartrich";
  const name = resolveConversationAgentName(conv, PERSONA);
  assert.equal(name, PERSONA, `owner colliding with the customer must fall back, got ${name}`);
});

check("no_owner_on_the_phone_log_falls_back_rather_than_inventing_a_name", () => {
  const conv: any = phoneLogConvBeforeAnySend();
  delete conv.leadOwner;
  const name = resolveConversationAgentName(conv, PERSONA);
  assert.equal(name, PERSONA, `an unowned phone log must fall back to the persona, got ${name}`);
});

if (failures.length) {
  console.error(`\nphone_log_first_touch_signature: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nphone_log_first_touch_signature: OK");
