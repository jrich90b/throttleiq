import assert from "node:assert/strict";
import {
  buildTrafficLogProPhoneLogLeadKey,
  isPhoneLogConversation,
  isTrafficLogProPhoneLog,
  shouldPreserveHandoffReasonOverPhoneLog,
  shouldSuppressPhoneLogEmail
} from "../services/api/src/domain/phoneLogLead.ts";
import { inferDisplayWalkIn, inferWalkIn, type Conversation } from "../services/api/src/domain/conversationStore.ts";
import { buildKpiOverview } from "../services/api/src/domain/kpiAnalytics.ts";

const note =
  "called asking about the 2019 Street Glide Special we had in stock. I told him I would check to see if we had anything else coming in and send pictures of the 2022 Street Glide we just took in.";

assert.equal(
  isTrafficLogProPhoneLog({
    leadSource: "Traffic Log Pro",
    inquiry: note,
    comment: ""
  }),
  true,
  "Traffic Log Pro call notes should classify as phone logs"
);

assert.equal(
  isTrafficLogProPhoneLog({
    leadSource: "Traffic Log Pro",
    inquiry: "Step 2 - stopped in and is watching for an Iron 883"
  }),
  false,
  "Traffic Log Pro walk-in notes should not be reclassified as phone logs"
);

assert.equal(
  shouldSuppressPhoneLogEmail({ isPhoneLog: true }),
  true,
  "Phone logs should not trust the ADF email slot as a customer email channel"
);
assert.equal(buildTrafficLogProPhoneLogLeadKey("11338"), "tlp_phone_log_11338");

const conv: Conversation = {
  id: "conv_phone_log",
  leadKey: "tlp_phone_log_11338",
  mode: "suggest",
  status: "open",
  createdAt: "2026-05-30T17:00:06.000Z",
  updatedAt: "2026-05-30T17:00:06.000Z",
  lead: {
    leadRef: "11338",
    source: "Traffic Log Pro",
    firstName: "Ralph",
    lastName: "Wagonblott",
    inquiry: note,
    vehicle: {
      year: "2022",
      make: "Harley-Davidson",
      model: "Street Glide Special",
      condition: "used"
    }
  },
  classification: {
    bucket: "callback_request",
    cta: "callback",
    channel: "task",
    ruleName: "traffic_log_pro_phone_log"
  },
  messages: [
    {
      id: "m1",
      direction: "in",
      from: "tlp_phone_log_11338",
      to: "dealership",
      provider: "sendgrid_adf",
      at: "2026-05-30T17:00:06.000Z",
      body: `PHONE LOG (ADF)\nSource: Traffic Log Pro\nRef: 11338\nName: Ralph Wagonblott\nYear: 2022\nVehicle: Harley-Davidson Street Glide Special\n\nInquiry:\n${note}`
    }
  ]
};

assert.equal(isPhoneLogConversation(conv), true, "phone log should be visible from conversation state");
assert.equal(inferWalkIn(conv), false, "phone logs should not render/count as walk-ins");
assert.equal(inferDisplayWalkIn(conv), false, "phone logs should not get the walk-in card icon");

const kpi = buildKpiOverview(
  [conv],
  {
    from: "2026-05-30T00:00:00.000Z",
    to: "2026-05-31T00:00:00.000Z",
    leadScope: "phone_log_only"
  },
  {
    businessHours: {
      timezone: "America/New_York",
      businessHours: {}
    }
  }
);
assert.equal(kpi.totals.leadVolume, 1, "phone-log KPI scope should include phone logs");
assert.equal(kpi.bySource[0]?.source, "Phone Log", "phone logs should get their own KPI source row");

const onlineKpi = buildKpiOverview(
  [conv],
  {
    from: "2026-05-30T00:00:00.000Z",
    to: "2026-05-31T00:00:00.000Z",
    leadScope: "online_only"
  },
  {
    businessHours: {
      timezone: "America/New_York",
      businessHours: {}
    }
  }
);
assert.equal(onlineKpi.totals.leadVolume, 0, "phone logs should not inflate online lead close rates");

// A duplicate phone-log re-sync must NOT downgrade a specific active finance/
// credit handoff reason (Kody Erhard +17163975098 7/10: a 21:25 duplicate PHONE
// LOG (ADF) clobbered the 15:53 credit_app_needs_info handoff → outcome-QA P1).
for (const reason of [
  "credit_app_needs_info",
  "credit_app_needs_info_voice_hold",
  "credit_app_cosigner",
  "credit_app_approved",
  "financing_declined"
]) {
  assert.equal(
    shouldPreserveHandoffReasonOverPhoneLog({ existingMode: "manual_handoff", existingReason: reason }),
    true,
    `phone-log must not downgrade an active ${reason} handoff`
  );
}
// A generic/absent reason IS overwritten by the phone-log reason (the default).
assert.equal(
  shouldPreserveHandoffReasonOverPhoneLog({ existingMode: "manual_handoff", existingReason: "traffic_log_pro_phone_log" }),
  false
);
assert.equal(shouldPreserveHandoffReasonOverPhoneLog({ existingMode: "manual_handoff", existingReason: "" }), false);
// Not currently in a manual handoff → phone-log reason applies normally.
assert.equal(
  shouldPreserveHandoffReasonOverPhoneLog({ existingMode: "active", existingReason: "credit_app_needs_info" }),
  false
);

console.log("tlp_phone_log_eval passed");
