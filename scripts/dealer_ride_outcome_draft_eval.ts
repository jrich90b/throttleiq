import fs from "node:fs";
import path from "node:path";

type Check = {
  id: string;
  actual: unknown;
  expected: unknown;
};

function check(id: string, actual: unknown, expected: unknown): Check {
  return { id, actual, expected };
}

const source = fs.readFileSync(path.join(process.cwd(), "services/api/src/index.ts"), "utf8");

const staffSmsQueueIndex = source.indexOf('source: "staff_outcome_sms"');
const staffSmsQueuedConfirmationIndex = source.indexOf("Saved FOLLOW UP outcome and queued a customer thank-you draft.");
const todoModalBlock = /source: "todo_done_modal"/.exec(source)?.index ?? -1;

const checks: Check[] = [
  check(
    "staff_sms_follow_up_queues_customer_thank_you_draft",
    /queueDealerRideOutcomeCustomerDraft\s*\(\{\s*conv,\s*unit,\s*outcome: "follow_up"[\s\S]{0,260}source: "staff_outcome_sms"/.test(
      source
    ),
    true
  ),
  check(
    "todo_done_modal_follow_up_queues_customer_thank_you_draft",
    /if \(isDealerRideOutcomeTask\) \{[\s\S]{0,320}queueDealerRideOutcomeCustomerDraft\s*\(\{[\s\S]{0,260}source: "todo_done_modal"/.test(
      source
    ),
    true
  ),
  check(
    "conversation_header_dealer_ride_outcome_queues_customer_thank_you_draft",
    /hasDealerRideOutcomePrompt[\s\S]{0,320}queueDealerRideOutcomeCustomerDraft\s*\(\{[\s\S]{0,260}source: "conversation_header"/.test(
      source
    ),
    true
  ),
  check(
    "todo_done_modal_not_ready_is_not_gated_out",
    source.includes('isDealerRideOutcomeTask && normalizedOutcome.secondaryStatus === "needs_follow_up"'),
    false
  ),
  check(
    "dealer_ride_outcome_draft_thanks_for_test_ride",
    /Thanks again for coming in for the test ride on the \$\{modelLabel\}/.test(source),
    true
  ),
  check(
    "dealer_ride_outcome_follow_up_does_not_assume_agreed_next_steps",
    source.includes("next steps we talked about"),
    false
  ),
  check(
    "draft_queue_happens_before_staff_sms_confirmation_text",
    staffSmsQueueIndex > 0 &&
      staffSmsQueuedConfirmationIndex > 0 &&
      staffSmsQueueIndex < staffSmsQueuedConfirmationIndex,
    true
  ),
  check("todo_done_modal_source_present", todoModalBlock > 0, true)
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
  console.error(`\n${checks.length - passed} failures out of ${checks.length} dealer ride outcome draft checks`);
  process.exit(1);
}

console.log(`\nAll ${checks.length} dealer ride outcome draft checks passed.`);
