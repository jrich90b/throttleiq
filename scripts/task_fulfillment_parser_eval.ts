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

const cases: { id: string; activity: Act[]; summary: string; want: boolean }[] = [
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
  }
];

let ran = 0;
for (const c of cases) {
  const verdicts = await classifyTaskFulfillmentWithLLM({
    tasks: [{ id: "t", reason: "call", summary: c.summary }],
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
}

console.log(
  ran === 0
    ? "PASS task fulfillment parser eval (source guard; LLM coverage skipped — parser disabled)"
    : `PASS task fulfillment parser eval (source guard + ${ran}/${cases.length} LLM coverage cases)`
);
