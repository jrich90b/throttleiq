import { orchestrateInbound } from "../services/api/src/domain/orchestrator.ts";
import type { InboundMessageEvent } from "../services/api/src/domain/types.ts";
import type { FinanceDocsState } from "../services/api/src/domain/conversationStore.ts";

type Case = {
  id: string;
  event: InboundMessageEvent;
  financeDocs: FinanceDocsState | null;
  expectIncludes: string;
  history?: Array<{ direction: "in" | "out"; body: string }>;
};

const now = new Date().toISOString();

const cases: Case[] = [
  {
    id: "insurance_received_binder_pending",
    event: {
      channel: "sms",
      provider: "twilio",
      from: "+15555550101",
      to: "+15555550999",
      body: "Here is the ID card",
      mediaUrls: ["https://example.test/doc.pdf"],
      providerMessageId: "case1",
      receivedAt: now
    },
    financeDocs: {
      status: "pending",
      requestedAt: now,
      updatedAt: now,
      insuranceRequested: true,
      binderRequested: true,
      insuranceReceived: true,
      binderReceived: false
    },
    expectIncludes: "Once you send the binder"
  },
  {
    id: "binder_received_insurance_pending",
    event: {
      channel: "sms",
      provider: "twilio",
      from: "+15555550102",
      to: "+15555550999",
      body: "Uploading the binder now",
      mediaUrls: ["https://example.test/binder.pdf"],
      providerMessageId: "case2",
      receivedAt: now
    },
    financeDocs: {
      status: "pending",
      requestedAt: now,
      updatedAt: now,
      insuranceRequested: true,
      binderRequested: true,
      insuranceReceived: false,
      binderReceived: true
    },
    expectIncludes: "Once you send the insurance card"
  },
  {
    id: "all_docs_ready_for_esign",
    event: {
      channel: "sms",
      provider: "twilio",
      from: "+15555550103",
      to: "+15555550999",
      body: "Here is the binder",
      mediaUrls: ["https://example.test/binder2.pdf"],
      providerMessageId: "case3",
      receivedAt: now
    },
    financeDocs: {
      status: "complete",
      requestedAt: now,
      updatedAt: now,
      insuranceRequested: true,
      binderRequested: true,
      insuranceReceived: true,
      binderReceived: true
    },
    expectIncludes: "send the e-sign documents shortly"
  }
];

async function run() {
  const failures: Array<{ id: string; expected: string; got: string }> = [];
  for (const c of cases) {
    const result = await orchestrateInbound(
      c.event,
      c.history ?? [
        {
          direction: "out",
          body:
            "Sounds good. Once you add your insurance/binder I’ll send the e-sign documents. You can text a photo of the insurance card and binder."
        }
      ],
      {
        financeDocs: c.financeDocs
      }
    );
    const got = String(result.draft ?? "");
    if (!got.toLowerCase().includes(c.expectIncludes.toLowerCase())) {
      failures.push({ id: c.id, expected: c.expectIncludes, got });
    }
  }

  console.log(`Finance docs eval: ${cases.length - failures.length}/${cases.length} passed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) {
      console.log(`- [${f.id}] expected includes="${f.expected}" got="${f.got}"`);
    }
    process.exit(1);
  }
}

run().catch(err => {
  console.error("Finance docs eval failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
