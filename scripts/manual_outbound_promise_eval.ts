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
  isHumanAuthoredOutbound,
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

// ── "probably next week" resolves to a real date (Nicholas Braun +17166286477, operator-
// reported: "I told him I'd call when the trade comes in, probably next week — but the call
// task is for tomorrow"). parseRequestedDateOnly now anchors relative week phrases to next
// MONDAY, so an event-conditioned promise with a stated timeframe comes due when the promise
// does, not on the no-date tomorrow default. The parser-side few-shot (EXAMPLE G) makes the
// LLM carry due_text "next week" for such promises; this pins the deterministic resolution. ──
{
  const { parseRequestedDateOnly } = await import("../services/api/src/domain/conversationStore.ts");
  const nextWeek = parseRequestedDateOnly("probably next week", "America/New_York");
  if (!nextWeek || nextWeek.dayOfWeek !== "monday") {
    console.error(`"probably next week" must resolve to next Monday, got ${JSON.stringify(nextWeek)}`);
    failures += 1;
  }
  const couple = parseRequestedDateOnly("in a couple weeks", "America/New_York");
  if (!couple || couple.dayOfWeek !== "monday") {
    console.error(`"in a couple weeks" must resolve to a Monday, got ${JSON.stringify(couple)}`);
    failures += 1;
  } else if (nextWeek) {
    const gap =
      Date.UTC(couple.year, couple.month - 1, couple.day) - Date.UTC(nextWeek.year, nextWeek.month - 1, nextWeek.day);
    if (gap !== 7 * 86_400_000) {
      console.error(`"couple weeks" must land one week after "next week", gap=${gap}`);
      failures += 1;
    }
  }
  // A resolved next-week due flows through the decision as a dated staff task (not tomorrow).
  if (nextWeek) {
    const d = decideManualOutboundPromise(
      base({
        parse: parse({ kind: "check_and_get_back", action: "call when the trade with the backrest arrives", dueText: "next week" }),
        dueDate: nextWeek
      })
    );
    if (d.kind !== "staff_task" || !/Mon/.test(d.dueLabel)) {
      console.error(`event-conditioned promise with "next week" must yield a Monday-due staff task, got ${JSON.stringify(d)}`);
      failures += 1;
    }
  }
  // The parser prompt must carry the event-conditioned few-shot so due_text survives the parse.
  const fs2 = await import("node:fs");
  const llm = fs2.readFileSync("services/api/src/domain/llmDraft.ts", "utf8");
  if (!/probably next week/.test(llm) || !/EXAMPLE G/.test(llm)) {
    console.error("the manual-promise parser must keep the event-conditioned-timeframe few-shot (EXAMPLE G)");
    failures += 1;
  }
  // Conditional OFFER ≠ promise (Mark Walsh +17736151296, operator-reported): an offer of a
  // walkaround/photos "if that would help, just let me know" wrongly armed a promise task. The
  // hint is intentionally loose (high recall) — "let me" + "check out" fire it — so precision
  // must live in the parser. Pin the negative few-shot + the conditional-offer guideline so the
  // parser keeps reading pure offers as promise_present:false.
  if (!/EXAMPLE H/.test(llm) || !/CONDITIONAL OFFER is NOT a promise/.test(llm)) {
    console.error("the manual-promise parser must keep the conditional-offer negative few-shot (EXAMPLE H)");
    failures += 1;
  }
}

// A parse where the corrected parser read a pure offer as no-promise must yield no task
// (decision-side guard for the Mark Walsh case, independent of the LLM).
{
  const d = decideManualOutboundPromise(base({ parse: parse({ promisePresent: false, kind: "none", action: "" }) }));
  check("conditional_offer_no_task", d.kind === "none", JSON.stringify(d));
}

// ── AN UNEDITED AGENT DRAFT IS NOT A STAFF PROMISE (Scott Hartrich +17167130279,
// operator-reported 2026-08-02: "Why did this create a call back"). In suggest mode the
// agent's draft is released through the same /conversations/:id/send endpoint a person
// types into, so the agent's own "I'll follow up with the numbers we discussed" armed a
// dated task for the salesperson plus a cadence hold. 8 of the 20 promise tasks on the box
// came from agent copy this way. The pending draft is the discriminator. ──
{
  const AGENT_DRAFT =
    "Hi Scott — this is Stone at American Harley-Davidson. Thanks again for sitting down with me. " +
    "I'll follow up with the numbers we discussed and next steps. Just so I've got it right, " +
    "you're looking for a new Street Glide.";

  // The production turn: the hint still fires (it is only a cost gate), but the author check
  // is what keeps the arm from running.
  check("scott_agent_draft_still_hints", hasManualPromiseHint(AGENT_DRAFT));
  check(
    "scott_unedited_agent_draft_not_human_authored",
    !isHumanAuthoredOutbound({ pendingDraftBody: AGENT_DRAFT, sentBody: AGENT_DRAFT })
  );
  // formatSmsLayout can re-wrap the draft on its way out; whitespace alone must not read as
  // a human edit, or the guard would leak on every send.
  check(
    "whitespace_reflow_is_not_an_edit",
    !isHumanAuthoredOutbound({
      pendingDraftBody: AGENT_DRAFT,
      sentBody: AGENT_DRAFT.replace(/\. /g, ".\n\n")
    })
  );

  // Everything else keeps today's behaviour — the guard suppresses only the provable case.
  check(
    "staff_typed_with_no_draft_is_human",
    isHumanAuthoredOutbound({
      pendingDraftBody: null,
      sentBody: "I'll get those payment numbers together and send them over Monday."
    })
  );
  check(
    "edited_draft_is_human",
    isHumanAuthoredOutbound({
      pendingDraftBody: AGENT_DRAFT,
      sentBody: `${AGENT_DRAFT} I'll have your trade number by Monday.`
    })
  );
  check(
    "empty_draft_body_is_human",
    isHumanAuthoredOutbound({ pendingDraftBody: "   ", sentBody: "I'll call you tomorrow with the figure." })
  );
  check(
    "empty_send_body_fails_open",
    isHumanAuthoredOutbound({ pendingDraftBody: AGENT_DRAFT, sentBody: "" })
  );
  // ensureInitialSmsOptOutFooter appends the compliance line to the FIRST sms of a thread —
  // which is exactly the first-touch ADF draft this arm sees most. We appended it, so it is
  // not a human edit; without this the guard would leak on every genuine first touch.
  check(
    "optout_footer_is_not_an_edit",
    !isHumanAuthoredOutbound({
      pendingDraftBody: AGENT_DRAFT,
      sentBody: `${AGENT_DRAFT} Reply STOP to opt out.`
    })
  );
  // …but the footer must not swallow a real edit that happens to sit before it.
  check(
    "edit_before_the_footer_is_still_an_edit",
    isHumanAuthoredOutbound({
      pendingDraftBody: AGENT_DRAFT,
      sentBody: `${AGENT_DRAFT} I'll have your trade number Monday. Reply STOP to opt out.`
    })
  );

  // SOURCE PIN: the send path must actually consult the author check before arming the
  // promise. Both channels share reconcileManualOutboundState, so pinning the one gate keeps
  // SMS and email in lockstep. Fails loudly if the gate is renamed rather than reading -1.
  const fs3 = await import("node:fs");
  const index = fs3.readFileSync("services/api/src/index.ts", "utf8");
  const gateAt = index.indexOf("hasManualPromiseHint(text) &&");
  if (gateAt < 0) {
    console.error("could not find the manual-promise gate in services/api/src/index.ts");
    failures += 1;
  } else if (!/isHumanAuthoredOutbound\(/.test(index.slice(gateAt, gateAt + 500))) {
    console.error("the manual-promise gate must consult isHumanAuthoredOutbound before arming a task");
    failures += 1;
  }
}

if (failures) {
  console.error(`manual outbound promise eval: ${failures} failure(s)`);
  process.exit(1);
}
console.log("manual outbound promise eval: all checks passed");
