import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
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

// ---------------------------------------------------------------------------
// RECAP DRAFT (Joe ruling 2026-07-30) — a phone log that records something the DEALERSHIP owes the
// customer queues a short recap for staff to approve, instead of sending nothing.
//
// Scott filed "did not generate a response" on Rich Retzlaff (+17168640008, 2026-07-24) and then
// hand-typed the message himself three hours later: "Thank you for your time over the phone this
// morning about the 2026 Deadwood we have coming in. I will let you know…"
// ---------------------------------------------------------------------------
const {
  decidePhoneLogRecapDraft,
  buildPhoneLogRecapDraft,
  phoneLogRecapUnitLabel,
  phoneLogRecapPromiseLine,
  PHONE_LOG_RECAP_MIN_CONFIDENCE
} = await import("../services/api/src/domain/phoneLogRecap.ts");

const recapBase = { hasDeliverablePhone: true, alreadyContacted: false };

assert.deepEqual(
  decidePhoneLogRecapDraft({
    parse: { promisePresent: true, kind: "send_info", confidence: 0.9 },
    ...recapBase
  }),
  { draft: true, reason: "promise_recorded", kind: "send_info" },
  "Lisa Snyder ('told her I would send her photos') drafts a recap"
);
assert.equal(
  decidePhoneLogRecapDraft({
    parse: { promisePresent: true, kind: "prepare_something", confidence: 0.88 },
    ...recapBase
  }).draft,
  true,
  "Fred Suchan ('Stone will write up a quote') drafts a recap"
);

// Every uncertain / not-ours path falls through to today's behavior: task + handoff, no message.
for (const [label, parse] of [
  ["parser off or errored", null],
  ["no promise at all (Kody's PreQual data)", { promisePresent: false, kind: "none", confidence: 0.95 }],
  [
    "the CUSTOMER committed, not us (John Elsbury 'Says he will stop in')",
    { promisePresent: false, kind: "none", confidence: 0.9 }
  ],
  ["unsure read", { promisePresent: true, kind: "send_info", confidence: 0.5 }],
  ["appointment talk belongs to the appointment arm", { promisePresent: true, kind: "appointment", confidence: 0.95 }],
  ["contradictory kind", { promisePresent: true, kind: "none", confidence: 0.99 }]
] as const) {
  assert.equal(
    decidePhoneLogRecapDraft({ parse: parse as any, ...recapBase }).draft,
    false,
    `${label} => no draft (fail toward today's silence)`
  );
}
assert.equal(
  decidePhoneLogRecapDraft({
    parse: { promisePresent: true, kind: "send_info", confidence: 0.9 },
    hasDeliverablePhone: false,
    alreadyContacted: false
  }).draft,
  false,
  "phone logs strip the email address, so no deliverable phone means no channel"
);
assert.equal(
  decidePhoneLogRecapDraft({
    parse: { promisePresent: true, kind: "send_info", confidence: 0.9 },
    hasDeliverablePhone: true,
    alreadyContacted: true
  }).draft,
  false,
  "never stack a recap on a thread the customer has already heard from"
);
assert.equal(
  decidePhoneLogRecapDraft({
    parse: { promisePresent: true, kind: "other", confidence: PHONE_LOG_RECAP_MIN_CONFIDENCE },
    ...recapBase
  }).draft,
  true,
  "confidence exactly at the floor drafts"
);

// Copy: names the unit from STRUCTURED fields, promises follow-through, and invents nothing.
const recapDraft = buildPhoneLogRecapDraft({
  firstName: "Rich",
  agentName: "Alexandra",
  dealerName: "American Harley-Davidson",
  unitLabel: phoneLogRecapUnitLabel({ year: "2026", model: "FLHD Deadwood" }),
  kind: "inventory_notify"
});
assert.match(recapDraft, /^Hey Rich, /, "opens with the house greeting, by first name");
assert.match(recapDraft, /it's Alexandra over at American Harley-Davidson\./, "house intro phrase");
assert.match(recapDraft, /Thanks for your time on the phone about the 2026 FLHD Deadwood\./);
assert.match(recapDraft, /I'll let you know as soon as it's here and ready to show\./);
// The agent was NOT on that call — a first-person account of it is the fabricated-frame failure mode.
assert.ok(
  !/great (?:talking|speaking)|nice (?:talking|speaking)|enjoyed (?:talking|speaking)/i.test(recapDraft),
  "the recap must not claim the agent personally had the conversation"
);
assert.ok(
  !/this morning|this afternoon|yesterday|earlier today/i.test(recapDraft),
  "the recap must not invent a time of day — the phone log carries no reliable call timestamp"
);
assert.ok(!/Stone|told her|told him/i.test(recapDraft), "no staff shorthand from the note leaks into the copy");

// Unit label: structured year+model only, never a half-named bike.
assert.equal(phoneLogRecapUnitLabel({ year: "2026", model: "FLHD Deadwood" }), "2026 FLHD Deadwood");
assert.equal(phoneLogRecapUnitLabel({ year: "2026", model: "" }), "", "model missing => no unit phrase");
assert.equal(phoneLogRecapUnitLabel({ year: "", model: "Street Glide" }), "", "year missing => no unit phrase");
assert.equal(phoneLogRecapUnitLabel({ year: "Full Line", model: "x" }), "", "a non-year value is not a year");
assert.equal(phoneLogRecapUnitLabel(null), "");
assert.match(
  buildPhoneLogRecapDraft({
    firstName: null,
    agentName: "Alexandra",
    dealerName: "American Harley-Davidson",
    unitLabel: "",
    kind: "check_and_get_back"
  }),
  /Thanks for your time on the phone\. I'm checking on that/
);
for (const kind of ["send_info", "check_and_get_back", "prepare_something", "inventory_notify", "other"] as const) {
  const line = phoneLogRecapPromiseLine(kind);
  assert.ok(line.length > 0, `${kind} has a promise line`);
  assert.ok(
    !/\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\$\d/i.test(line),
    `${kind} promise line must not invent a date or a price`
  );
}

// Source pins: the intake branch is parser-gated and never pastes the internal note into a message.
{
  const sg = await fs.readFile(path.resolve("services/api/src/routes/sendgridInbound.ts"), "utf8");
  const branchIdx = sg.indexOf("if (isTlpPhoneLog) {");
  assert.ok(branchIdx > 0, "the phone-log intake branch must exist");
  const branch = sg.slice(branchIdx, branchIdx + 4000);
  assert.match(
    branch,
    /parseManualOutboundPromiseWithLLM\(\{ text: note \}\)/,
    "the recap must be gated on the typed staff-promise parser, never on keywords"
  );
  assert.match(branch, /decidePhoneLogRecapDraft\(\{/, "the pure decision owns the gate");
  assert.match(branch, /buildPhoneLogRecapDraft\(\{/, "copy comes from the deterministic builder");
  assert.match(branch, /"draft_ai"/, "the recap is published as a staff DRAFT, never auto-sent");
  assert.match(branch, /Phone log follow-up for \$\{customerName\}/, "the follow-up task still gets created");
}

// LLM arm (opportunistic): prove the parser actually reads real phone-log write-ups the way the
// gate assumes. Third-person staff shorthand is a different register from a direct staff outbound,
// so this is the riskiest assumption in the change. Runs only with a key + LLM_ENABLED.
if (process.env.LLM_ENABLED === "1" && process.env.OPENAI_API_KEY) {
  const { parseManualOutboundPromiseWithLLM } = await import("../services/api/src/domain/llmDraft.ts");
  const REAL_PHONE_LOGS: { label: string; text: string; expectPromise: boolean }[] = [
    {
      label: "Lisa Snyder — we owe photos",
      text: "Called in asking if we had a 2021 Street Glide and I told her I just took in a Snake Venom 2021 Street Glide on trade and told her I would send her photos.",
      expectPromise: true
    },
    {
      label: "Fred Suchan — we owe a quote",
      text: "Called looking for trike. Stone told him about the pre-owned freewheeler that is on the floor. Stone will write up a quote.",
      expectPromise: true
    },
    {
      label: "John Elsbury — the CUSTOMER committed, not us",
      text: "Called looking for pre-owned trikes. Told him about Road Glide 3 we have on the floor and the 2 we have coming in on trade (2016 Freewheeler & 2014 Tri-Glide) Says he will stop in to check them out",
      expectPromise: false
    },
    {
      label: "Kody — prequal data, no promise",
      text: "PreQual: N, PreQualified Amount; $0 Please note non-prequalified customers can still be considered for approval with a completed credit application.",
      expectPromise: false
    }
  ];
  for (const row of REAL_PHONE_LOGS) {
    const parse = await parseManualOutboundPromiseWithLLM({ text: row.text });
    const decision = decidePhoneLogRecapDraft({ parse, ...recapBase });
    assert.equal(
      decision.draft,
      row.expectPromise,
      `${row.label}: expected draft=${row.expectPromise}, got ${decision.draft} (parse=${JSON.stringify(parse)})`
    );
  }
  console.log(`  phone-log recap LLM arm: ${REAL_PHONE_LOGS.length} real write-ups classified correctly`);
}

console.log("tlp_phone_log_eval passed");
