/**
 * Decision-table eval for the staff-text promise arm (domain/manualOutboundPromise.ts) —
 * the TEXT-channel sibling of voice_next_step:eval. Pins: kind exclusions (watch/
 * appointment promises stay with their dedicated arms), the staff-task shape with the
 * "Promised over text:" lead-in, the no-breather mapping (manual sends already pause),
 * and the cost-hint recall/precision on real phrasings.
 */
import {
  decideManualOutboundPromise,
  hasManualPromiseHint,
  isActionablePromiseKind,
  type ManualOutboundPromiseInput
} from "../services/api/src/domain/manualOutboundPromise.ts";
import type { ManualOutboundPromiseParse } from "../services/api/src/domain/llmDraft.ts";

const TZ = "America/New_York";
// Fixed clock: Wednesday 2026-07-15 12:00 ET (16:00Z).
const NOW_MS = Date.UTC(2026, 6, 15, 16, 0, 0);

function parse(overrides: Partial<ManualOutboundPromiseParse>): ManualOutboundPromiseParse {
  return {
    promisePresent: true,
    kind: "send_info",
    action: "send payment numbers",
    dueText: "",
    confidence: 0.95,
    ...overrides
  };
}

function base(overrides: Partial<ManualOutboundPromiseInput>): ManualOutboundPromiseInput {
  return {
    parse: parse({}),
    nowMs: NOW_MS,
    timeZone: TZ,
    cadenceKind: "standard",
    followUpMode: "active",
    conversationStatus: "open",
    dueDate: null,
    ...overrides
  };
}

let failures = 0;
function check(id: string, ok: boolean, detail?: string) {
  if (ok) console.log(`PASS ${id}`);
  else {
    failures += 1;
    console.error(`FAIL ${id}${detail ? `: ${detail}` : ""}`);
  }
}

// --- decision table ---
{
  const d = decideManualOutboundPromise(base({ parse: null }));
  check("null_parse_none", d.kind === "none");
}
{
  const d = decideManualOutboundPromise(base({ parse: parse({ promisePresent: false, kind: "none" }) }));
  check("no_promise_none", d.kind === "none");
}
{
  const d = decideManualOutboundPromise(base({ parse: parse({ kind: "inventory_notify", action: "text when a Street Bob arrives" }) }));
  check("inventory_notify_excluded", d.kind === "none" && d.reason === "kind_inventory_notify", JSON.stringify(d));
}
{
  const d = decideManualOutboundPromise(base({ parse: parse({ kind: "appointment" }) }));
  check("appointment_excluded", d.kind === "none" && d.reason === "kind_appointment", JSON.stringify(d));
}
{
  // Promised numbers by Mon 7/20 → task due Mon 10:30 ET (14:30Z), hold to Tue 7/21,
  // "Promised over text:" lead-in.
  const d = decideManualOutboundPromise(
    base({ parse: parse({ dueText: "Monday" }), dueDate: { year: 2026, month: 7, day: 20 } })
  );
  check(
    "monday_promise_dated_task",
    d.kind === "staff_task" &&
      d.taskDueIso === "2026-07-20T14:30:00.000Z" &&
      d.holdUntilIso === "2026-07-21T14:30:00.000Z" &&
      d.taskSummary === "Promised over text: send payment numbers — by Mon, Jul 20",
    JSON.stringify(d)
  );
}
{
  // No stated day → due in 24h so the promise can't quietly age out.
  const d = decideManualOutboundPromise(base({ parse: parse({ action: "get the trade appraised" }) }));
  check(
    "no_day_due_tomorrow",
    d.kind === "staff_task" &&
      d.taskDueIso === new Date(NOW_MS + 24 * 3600_000).toISOString() &&
      d.taskSummary === "Promised over text: get the trade appraised",
    JSON.stringify(d)
  );
}
{
  const d = decideManualOutboundPromise(base({ parse: parse({ confidence: 0.4 }) }));
  check("low_confidence_none", d.kind === "none", JSON.stringify(d));
}
{
  const d = decideManualOutboundPromise(base({ conversationStatus: "closed" }));
  check("closed_conversation_none", d.kind === "none" && d.reason === "conversation_closed", JSON.stringify(d));
}
{
  const d = decideManualOutboundPromise(base({ followUpMode: "manual_handoff" }));
  check("manual_handoff_none", d.kind === "none", JSON.stringify(d));
}
{
  const d = decideManualOutboundPromise(base({ cadenceKind: "post_sale" }));
  check("post_sale_none", d.kind === "none", JSON.stringify(d));
}

// --- kind eligibility ---
check("kind_send_info_actionable", isActionablePromiseKind("send_info"));
check("kind_other_actionable", isActionablePromiseKind("other"));
check("kind_appointment_not_actionable", !isActionablePromiseKind("appointment"));
check("kind_none_not_actionable", !isActionablePromiseKind("none"));

// --- cost hint (recall on promise phrasings, quiet on non-promises) ---
const HINT_YES = [
  "I'll get those payment numbers together and send them over Monday.",
  "Let me check with my manager on the trade value and get back to you tomorrow.",
  "We'll work up an out-the-door quote and send it today.",
  "I'm going to find out about that part and follow up with you.",
  "I'll have the bike pulled up front and ready for you."
];
const HINT_NO = [
  "Thanks for stopping in today, it was great meeting you!",
  "Sounds good, see you Saturday!",
  "Congrats on the new bike!",
  "The price on that one is $24,999 plus tax and fees."
];
for (const t of HINT_YES) check(`hint_yes:${t.slice(0, 34)}`, hasManualPromiseHint(t), t);
for (const t of HINT_NO) check(`hint_no:${t.slice(0, 34)}`, !hasManualPromiseHint(t), t);

if (failures) {
  console.error(`manual outbound promise eval: ${failures} failure(s)`);
  process.exit(1);
}
console.log("manual outbound promise eval: all checks passed");
