import { pickRegenerateInbound } from "../services/api/src/domain/regenerateSelection.ts";

type Case = {
  id: string;
  expected: {
    provider: string | null;
    creditAdf: boolean;
    dlaNoPurchaseAdf: boolean;
  };
  run: () => {
    provider: string | null;
    creditAdf: boolean;
    dlaNoPurchaseAdf: boolean;
  };
};

const cases: Case[] = [
  {
    id: "prefers_latest_non_adf_inbound_for_standard_regen",
    expected: {
      provider: "twilio",
      creditAdf: false,
      dlaNoPurchaseAdf: false
    },
    run: () => {
      const picked = pickRegenerateInbound({
        latestDraftAt: "2026-04-05T14:03:00.000Z",
        messages: [
          {
            direction: "in",
            provider: "sendgrid_adf",
            body: "WEB LEAD (ADF)\nSource: Room58 - Request details",
            at: "2026-04-05T14:00:00.000Z"
          },
          {
            direction: "in",
            provider: "twilio",
            body: "What would payments be?",
            at: "2026-04-05T14:02:00.000Z"
          },
          {
            direction: "out",
            provider: "draft_ai",
            body: "Draft body",
            at: "2026-04-05T14:03:00.000Z"
          }
        ]
      });
      return {
        provider: picked.inbound?.provider ?? null,
        creditAdf: picked.latestInboundIsCreditAdf,
        dlaNoPurchaseAdf: picked.latestInboundIsDlaNoPurchaseAdf
      };
    }
  },
  {
    id: "keeps_credit_adf_as_regen_source",
    expected: {
      provider: "sendgrid_adf",
      creditAdf: true,
      dlaNoPurchaseAdf: false
    },
    run: () => {
      const picked = pickRegenerateInbound({
        latestDraftAt: "2026-04-05T15:10:00.000Z",
        messages: [
          {
            direction: "in",
            provider: "twilio",
            body: "checking in",
            at: "2026-04-05T15:00:00.000Z"
          },
          {
            direction: "in",
            provider: "sendgrid_adf",
            body: "WEB LEAD (ADF)\nSource: HDFS COA Online\nInquiry:\ncredit app complete",
            at: "2026-04-05T15:09:00.000Z"
          },
          {
            direction: "out",
            provider: "draft_ai",
            body: "Draft body",
            at: "2026-04-05T15:10:00.000Z"
          }
        ]
      });
      return {
        provider: picked.inbound?.provider ?? null,
        creditAdf: picked.latestInboundIsCreditAdf,
        dlaNoPurchaseAdf: picked.latestInboundIsDlaNoPurchaseAdf
      };
    }
  },
  {
    id: "keeps_dla_no_purchase_adf_as_regen_source",
    expected: {
      provider: "sendgrid_adf",
      creditAdf: false,
      dlaNoPurchaseAdf: true
    },
    run: () => {
      const picked = pickRegenerateInbound({
        latestDraftAt: "2026-04-05T16:01:00.000Z",
        messages: [
          {
            direction: "in",
            provider: "sendgrid_adf",
            body:
              "WEB LEAD (ADF)\nSource: Dealer Lead App\nInquiry:\npurchase timeframe: I am not interested in purchasing at this time",
            at: "2026-04-05T16:00:00.000Z"
          },
          {
            direction: "out",
            provider: "draft_ai",
            body: "Draft body",
            at: "2026-04-05T16:01:00.000Z"
          }
        ]
      });
      return {
        provider: picked.inbound?.provider ?? null,
        creditAdf: picked.latestInboundIsCreditAdf,
        dlaNoPurchaseAdf: picked.latestInboundIsDlaNoPurchaseAdf
      };
    }
  },
  {
    id: "without_draft_still_prefers_non_adf_when_not_special",
    expected: {
      provider: "twilio",
      creditAdf: false,
      dlaNoPurchaseAdf: false
    },
    run: () => {
      const picked = pickRegenerateInbound({
        messages: [
          {
            direction: "in",
            provider: "twilio",
            body: "Any photos?",
            at: "2026-04-05T17:00:00.000Z"
          },
          {
            direction: "in",
            provider: "sendgrid_adf",
            body: "WEB LEAD (ADF)\nSource: Room58 - Request details",
            at: "2026-04-05T17:01:00.000Z"
          }
        ]
      });
      return {
        provider: picked.inbound?.provider ?? null,
        creditAdf: picked.latestInboundIsCreditAdf,
        dlaNoPurchaseAdf: picked.latestInboundIsDlaNoPurchaseAdf
      };
    }
  }
];

let passed = 0;
for (const c of cases) {
  const actual = c.run();
  const ok =
    actual.provider === c.expected.provider &&
    actual.creditAdf === c.expected.creditAdf &&
    actual.dlaNoPurchaseAdf === c.expected.dlaNoPurchaseAdf;
  if (ok) passed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${c.id} expected=${JSON.stringify(c.expected)} actual=${JSON.stringify(actual)}`
  );
}

if (passed !== cases.length) {
  console.error(`\n${cases.length - passed} failures out of ${cases.length} cases`);
  process.exit(1);
}

console.log(`\nAll ${cases.length} regenerate selection checks passed.`);
