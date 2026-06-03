import { resolveTlpContactLeadRefs } from "../services/api/src/domain/tlpLeadRefs.js";

type Check = {
  id: string;
  actual: unknown;
  expected: unknown;
};

function check(id: string, actual: unknown, expected: unknown): Check {
  return { id, actual, expected };
}

const francisLikeConversation = {
  id: "+17173823519",
  leadKey: "+17173823519",
  lead: {
    leadRef: "11362",
    firstName: "Francis",
    lastName: "Kross",
    phone: "7173823519"
  },
  messages: [
    {
      direction: "in",
      provider: "sendgrid_adf",
      at: "2026-06-03T15:14:52.331Z",
      body: "WEB LEAD (ADF)\nSource: Marketplace - Prequal\nRef: 11362\nName: Francis Kross\nInquiry:\nPreQual: N"
    },
    {
      direction: "out",
      provider: "draft_ai",
      at: "2026-06-03T15:15:06.177Z",
      body: "Hi Francis..."
    },
    {
      direction: "in",
      provider: "sendgrid_adf",
      at: "2026-06-03T15:20:59.202Z",
      body: "WEB LEAD (ADF)\nSource: HDFS COA Online\nRef: 11363\nName: Francis Kross\nInquiry:\nApp ID: 1013932961"
    },
    {
      id: "manual_send",
      direction: "out",
      provider: "twilio",
      at: "2026-06-03T16:34:11.792Z",
      body: "Hey Francis, this is Joe at American Harley-Davidson..."
    }
  ]
};

const stalePriorLeadConversation = {
  id: "+17170000000",
  leadKey: "+17170000000",
  lead: { leadRef: "20002" },
  messages: [
    {
      direction: "in",
      provider: "sendgrid_adf",
      at: "2026-05-01T14:00:00.000Z",
      body: "WEB LEAD (ADF)\nRef: 10001\nName: Old Lead"
    },
    {
      direction: "in",
      provider: "sendgrid_adf",
      at: "2026-06-03T15:00:00.000Z",
      body: "WEB LEAD (ADF)\nRef: 20002\nName: Current Lead"
    }
  ]
};

const checks: Check[] = [
  check(
    "manual_send_logs_latest_and_recent_prior_adf_refs",
    resolveTlpContactLeadRefs(francisLikeConversation, { multiRefWindowHours: 72 }),
    ["11363", "11362"]
  ),
  check(
    "explicit_lead_ref_limits_logging_to_requested_ref",
    resolveTlpContactLeadRefs(francisLikeConversation, { explicitLeadRef: "11362", multiRefWindowHours: 72 }),
    ["11362"]
  ),
  check(
    "old_stale_adf_ref_is_not_logged_with_current_thread",
    resolveTlpContactLeadRefs(stalePriorLeadConversation, { multiRefWindowHours: 72 }),
    ["20002"]
  )
];

let passed = 0;
for (const c of checks) {
  const ok = JSON.stringify(c.actual) === JSON.stringify(c.expected);
  if (ok) passed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${c.id} expected=${JSON.stringify(c.expected)} actual=${JSON.stringify(c.actual)}`
  );
}

if (passed !== checks.length) {
  console.error(`\n${checks.length - passed} failures out of ${checks.length} TLP lead ref resolution checks`);
  process.exit(1);
}

console.log(`\nAll ${checks.length} TLP lead ref resolution checks passed.`);
