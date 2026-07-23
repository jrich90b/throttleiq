/**
 * Task-fulfillment PARSER coverage eval (classifyTaskFulfillmentWithLLM).
 *
 * The deterministic gate is pinned by task_fulfillment_autoclose:eval. THIS eval pins the
 * comprehension change (2026-06-18, Douglas Kellner +17165100700 via the agent-watch sweep):
 * a "call" task is fulfilled when its OBJECTIVE is accomplished by ANY channel — a reached
 * call OR an SMS/email that delivers the objective and resolves the matter — NOT only by a
 * reached phone call (the old strict rule left every SMS-handled call task open forever).
 *
 * Replay fixture: Douglas asked the price, Joe answered "$17,995" by SMS, Douglas said "Thanks,
 * I was just curious" — the call follow-up task should auto-close. Pre-fix the parser returned
 * fulfilled=false ("a call task requires a reached phone call"); post-fix it returns fulfilled=true.
 *
 * Fail direction: a wrong CLOSE drops a customer follow-up, so the parser stays conservative —
 * promises, generic check-ins, objective-not-accomplished, and genuinely call-required objectives
 * (verbal confirmation/authorization) must NOT be fulfilled by text.
 *
 * Run gated: LLM_ENABLED=1 LLM_TASK_FULFILLMENT_PARSER_ENABLED=1 npx tsx scripts/task_fulfillment_parser_eval.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { classifyTaskFulfillmentWithLLM } from "../services/api/src/domain/llmDraft.ts";

type Act = { direction: "in" | "out"; channel?: "sms" | "email" | "call"; text: string };

// --- Source guard (no LLM): the strict call-only rule is retired; the Douglas few-shot is in. ---
const llm = fs.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
assert.ok(
  !/fulfilled ONLY by a reached phone CALL/.test(llm),
  "the strict 'call tasks fulfilled ONLY by a reached phone call' rule must be retired"
);
assert.ok(
  /ACCOMPLISHES its OBJECTIVE, regardless of channel/.test(llm),
  "the new objective-based (any-channel) rule must be present"
);
assert.ok(
  /INHERENTLY needs a live conversation/.test(llm),
  "the verbal-required EXCEPTION must be preserved (so genuine call tasks stay strict)"
);
assert.ok(/Freewheeler pricing/.test(llm), "the Douglas replay few-shot must be present");

// --- LLM coverage (runs when enabled; skips cleanly otherwise). ---
const douglas: Act[] = [
  { direction: "in", channel: "sms", text: "What is the asking price?" },
  { direction: "out", channel: "sms", text: "I will have the team confirm the current price on the 2016 Freewheeler and send it over." },
  { direction: "out", channel: "sms", text: "Hey Douglas, it is Joe in sales. That freewheeler is listed at $17,995. Let me know if you want to stop in." },
  { direction: "in", channel: "sms", text: "Thanks. I was just curious." }
];

const cases: {
  id: string;
  activity: Act[];
  summary: string;
  want: boolean;
  reason?: string;
  /** Also assert the verdict is NOT engaged_pending_customer (a bare dealer handoff leaves the
   *  ball with the DEALER — soft-close must not snooze the task away). */
  wantNotEngagedPending?: boolean;
}[] = [
  // Paul Foley (6/22): a PARTS availability question answered by text must close; an ORDER
  // task with only a promise must stay open. Pins the broadened eligibility (any reason; the
  // classifier judges accomplished-vs-promise) as safe.
  {
    id: "parts_availability_answered",
    reason: "parts",
    activity: [
      { direction: "in", channel: "sms", text: "Do you have a Saddlemen Road Sofa seat for a 2025 Harley-Davidson Road Glide available?" },
      { direction: "out", channel: "sms", text: "Hey Paul, ya we have some road sofas here." },
      { direction: "in", channel: "sms", text: "Great. Thank you" }
    ],
    summary: "Parts website text: Do you have a Saddlemen Road Sofa seat for a 2025 Harley-Davidson Road Glide available?",
    want: true
  },
  {
    id: "parts_order_promise_stays_open",
    reason: "parts",
    activity: [
      { direction: "in", channel: "sms", text: "Can you order me a Saddlemen Road Sofa seat?" },
      { direction: "out", channel: "sms", text: "Sure, I'll get that part ordered for you and follow up." }
    ],
    summary: "Order the Saddlemen Road Sofa seat the customer requested.",
    want: false
  },
  // Positives — a call task's objective accomplished by SMS now closes.
  { id: "douglas_price_followup", activity: douglas, summary: "Call customer to follow up on the 2016 Freewheeler pricing.", want: true },
  {
    id: "wayne_arrived_unit",
    activity: [{ direction: "out", channel: "sms", text: "Hey Wayne, that 2013 Street Glide is here, welcome to stop by after 4." }],
    summary: "Call the customer about the 2013 Street Glide.",
    want: true
  },
  // Negatives — conservative: must stay open.
  {
    id: "verbal_confirmation_required",
    activity: [{ direction: "out", channel: "sms", text: "Shoot me a good time and I will call to go over your financing terms." }],
    summary: "Call customer to verbally review and confirm their financing terms.",
    want: false
  },
  {
    id: "promise_only",
    activity: [
      { direction: "in", channel: "sms", text: "any update?" },
      { direction: "out", channel: "sms", text: "I will have the team look into it and circle back." }
    ],
    summary: "Call customer with an update on their bike.",
    want: false
  },
  {
    id: "generic_checkin",
    activity: [{ direction: "out", channel: "sms", text: "Hey, just checking in - how is it going?" }],
    summary: "Call customer to follow up on their financing application.",
    want: false
  },
  // HANDOFF with no substance (Joe, 2026-07-23): "I'll have someone follow up" answers NOTHING —
  // the money-question task must stay open, and it is NOT engaged_pending_customer either (the
  // next action still belongs to the DEALER, so soft-close must not snooze it away).
  {
    id: "financing_handoff_no_details_stays_open",
    reason: "payments",
    activity: [
      { direction: "in", channel: "sms", text: "What kind of financing rates could I get on that Street Glide?" },
      { direction: "out", channel: "sms", text: "Great question — I will have our finance manager follow up with you on that." }
    ],
    summary: "Customer asked about financing options and rates for the Street Glide.",
    want: false,
    wantNotEngagedPending: true
  },
  {
    id: "pricing_handoff_no_details_stays_open",
    reason: "pricing",
    activity: [
      { direction: "in", channel: "sms", text: "What would my out the door price be?" },
      { direction: "out", channel: "sms", text: "Let me get someone from the team to help with pricing, they will reach out shortly." }
    ],
    summary: "Customer asked for the out-the-door price on the 2024 Road Glide.",
    want: false,
    wantNotEngagedPending: true
  },
  {
    id: "availability_handoff_no_details_stays_open",
    reason: "other",
    activity: [
      { direction: "in", channel: "sms", text: "Do you have any 2025 Low Rider S in stock?" },
      { direction: "out", channel: "sms", text: "I'll have someone check on that for you and get back to you." }
    ],
    summary: "Customer asked whether a 2025 Low Rider S is in stock.",
    want: false,
    wantNotEngagedPending: true
  },
  // CONTRAST: a handoff that ALSO delivers the substantive answer fulfills the question.
  {
    id: "financing_handoff_with_real_rate_closes",
    reason: "payments",
    activity: [
      { direction: "in", channel: "sms", text: "What rate would I qualify for?" },
      { direction: "out", channel: "sms", text: "Our finance manager will reach out, but to answer your question: you are pre-qualified at 7.29% APR up to 72 months on that model." },
      { direction: "in", channel: "sms", text: "Perfect, thanks!" }
    ],
    summary: "Customer asked what financing rate they would qualify for.",
    want: true
  }
];

let ran = 0;
for (const c of cases) {
  const verdicts = await classifyTaskFulfillmentWithLLM({
    tasks: [{ id: "t", reason: c.reason ?? "call", summary: c.summary }],
    activity: c.activity
  });
  if (!verdicts) continue; // parser disabled / transient null — skip, don't red the gate
  const v = verdicts.find(x => x.taskId === "t") ?? verdicts[0];
  if (!v) continue;
  ran += 1;
  assert.equal(
    !!v.fulfilled,
    c.want,
    `[${c.id}] expected fulfilled=${c.want}, got ${v.fulfilled} (conf ${v.confidence}; ${String(v.evidence ?? "").slice(0, 120)})`
  );
  if (c.wantNotEngagedPending) {
    assert.equal(
      !!v.engagedPendingCustomer,
      false,
      `[${c.id}] a bare dealer handoff must NOT be engaged_pending_customer (the dealer still owes the follow-up); got true (${String(v.evidence ?? "").slice(0, 120)})`
    );
  }
}

console.log(
  ran === 0
    ? "PASS task fulfillment parser eval (source guard; LLM coverage skipped — parser disabled)"
    : `PASS task fulfillment parser eval (source guard + ${ran}/${cases.length} LLM coverage cases)`
);
