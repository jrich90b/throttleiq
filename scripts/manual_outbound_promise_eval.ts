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
  resolveManualPromiseApplyPlan,
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
    // Every fixture below models a PERSON typing. The agent-authored branch is exercised
    // explicitly at the bottom, so a fixture can never drift into the wrong author by accident.
    humanAuthored: true,
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
  // A HELD-MODE thread still gets the dated task — with NO cadence hold (there is no cadence
  // to hold). This row used to pin `manual_handoff → none`, which was the defect: staff type
  // into human-owned threads BY DESIGN, so the held_mode bail suppressed the arm's main
  // population. Beverly Hennig +17169839279 (operator report 2026-08-11): "I'll have one of
  // the guys check the numbers out tomorrow" — parser 0.90-0.93 (4/4), zero todos minted.
  // Measured 2026-08-14: 75 promise-shaped staff texts on held-mode threads since 6/1, none
  // minted a task.
  const d = decideManualOutboundPromise(
    base({
      followUpMode: "manual_handoff",
      parse: parse({
        kind: "check_and_get_back",
        action: "have sales check the numbers and see what they can come up with",
        dueText: "tomorrow"
      }),
      // "tomorrow" from the fixed Wed 7/15 clock.
      dueDate: { year: 2026, month: 7, day: 16 }
    })
  );
  check(
    "manual_handoff_promise_still_tasks_no_hold",
    d.kind === "staff_task" &&
      d.taskDueIso === "2026-07-16T14:30:00.000Z" &&
      d.holdUntilIso === null &&
      d.taskSummary ===
        "Promised over text: have sales check the numbers and see what they can come up with — by Thu, Jul 16",
    JSON.stringify(d)
  );
  // And the apply plan carries the task with no hold — the shape index.ts executes.
  const plan = resolveManualPromiseApplyPlan(d);
  check(
    "manual_handoff_plan_task_no_hold",
    !!plan && plan.taskDueIso === "2026-07-16T14:30:00.000Z" && plan.holdUntilIso === null &&
      plan.outcomeKey === "manual_outbound_promise_task",
    JSON.stringify(plan)
  );
}
{
  // paused_indefinite is the same held-mode class (Rick's parked thread is this shape).
  const d = decideManualOutboundPromise(base({ followUpMode: "paused_indefinite" }));
  check(
    "paused_indefinite_promise_still_tasks_no_hold",
    d.kind === "staff_task" && d.holdUntilIso === null,
    JSON.stringify(d)
  );
}
{
  // An ACTIVE-mode promise keeps its cadence hold exactly as before — the held-mode change
  // must not leak into the population that was already working.
  const d = decideManualOutboundPromise(
    base({ parse: parse({ dueText: "Monday" }), dueDate: { year: 2026, month: 7, day: 20 } })
  );
  check(
    "active_mode_keeps_cadence_hold",
    d.kind === "staff_task" && d.holdUntilIso === "2026-07-21T14:30:00.000Z",
    JSON.stringify(d)
  );
}
{
  // Closed conversations still bail even in held mode — held-mode is not a bypass of the
  // closed gate.
  const d = decideManualOutboundPromise(
    base({ followUpMode: "manual_handoff", conversationStatus: "closed" })
  );
  check("held_mode_closed_still_none", d.kind === "none" && d.reason === "conversation_closed", JSON.stringify(d));
}
{
  // Low confidence still bails in held mode (breather_only maps to none as before).
  const d = decideManualOutboundPromise(
    base({ followUpMode: "manual_handoff", parse: parse({ confidence: 0.4 }) })
  );
  check("held_mode_low_confidence_none", d.kind === "none", JSON.stringify(d));
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
  //
  // ⚠️ CLOCK-SAFE, and it has to be: `nextWeek` above comes from the REAL clock, while every other
  // fixture here runs on the pinned 2026-07-15 NOW_MS. Feeding a real-clock date to a pinned clock
  // is a countdown, not a test — the referee drops any due beyond its 30-day hold cap, so this case
  // passed all summer and went red on its own at midnight ET on 2026-08-10, when "next Monday"
  // stepped from 08-10 (26 days out) to 08-17 (33 days, over the cap) and reddened `main` for every
  // routine with zero commits behind it. The relationship under test — a resolved next-week due
  // becomes a DATED Monday task instead of the tomorrow default — holds on any date, so anchor this
  // one case to the same clock its date came from and the two can never drift apart again.
  if (nextWeek) {
    const d = decideManualOutboundPromise(
      base({
        parse: parse({ kind: "check_and_get_back", action: "call when the trade with the backrest arrives", dueText: "next week" }),
        dueDate: nextWeek,
        nowMs: Date.now()
      })
    );
    if (d.kind !== "staff_task" || !/Mon/.test(d.dueLabel)) {
      console.error(`event-conditioned promise with "next week" must yield a Monday-due staff task, got ${JSON.stringify(d)}`);
      failures += 1;
    }
  }
  // …and the same relationship on a FULLY PINNED pair — the Monday after the fixture's own
  // Wednesday. This is the deterministic guard: it cannot drift with the calendar, so if the
  // referee ever stops dating a next-week promise, this fails on any day of any year.
  {
    const pinnedMonday = { year: 2026, month: 7, day: 20, dayOfWeek: "monday" as const };
    const d = decideManualOutboundPromise(
      base({
        parse: parse({ kind: "check_and_get_back", action: "call when the trade with the backrest arrives", dueText: "next week" }),
        dueDate: pinnedMonday
      })
    );
    check(
      "next_week_promise_is_a_dated_monday_task",
      d.kind === "staff_task" && /Mon/.test(d.dueLabel),
      JSON.stringify(d)
    );
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
  const gateAt = index.indexOf("hasManualPromiseHint(text)");
  if (gateAt < 0) {
    console.error("could not find the manual-promise gate in services/api/src/index.ts");
    failures += 1;
  } else if (!/isHumanAuthoredOutbound\(/.test(index.slice(gateAt, gateAt + 900))) {
    console.error("the manual-promise gate must consult isHumanAuthoredOutbound before arming a task");
    failures += 1;
  }
}

// ---------------------------------------------------------------------------------------------
// THE AGENT'S OWN PROMISE NEEDS AN OWNER (Joe, 2026-08-07).
//
// #450 stopped an unedited agent draft from arming a dated staff task, correctly: 8 of the 20
// "Promised over text" tasks on the box were the agent's boilerplate, not a person's commitment.
// But it dropped the promise entirely. On 2026-08-07 the agent began answering an accepted offer
// with "I'll pull the current incentives that apply to the 2026 Street Glide Limited and text you
// the exact breakdown" — and the system has NO incentives data (domain/offers.ts resolves a URL to
// the promotions page, nothing more). It promised a person's work and told nobody.
//
// Same parse, same confidence gate, same excluded kinds — only the OUTCOME differs by author.
// ---------------------------------------------------------------------------------------------
{
  const incentives = parse({
    kind: "send_info",
    action: "send the current incentives that apply to the Street Glide Limited"
  });

  const human = decideManualOutboundPromise(base({ parse: incentives, humanAuthored: true }));
  check(
    "human_promise_still_dated_task",
    human.kind === "staff_task",
    `a person's promise must still get today's dated task, got ${JSON.stringify(human)}`
  );

  const agent = decideManualOutboundPromise(base({ parse: incentives, humanAuthored: false }));
  check(
    "agent_promise_raises_owner_task",
    agent.kind === "agent_promise_owner_task",
    `the agent's own promise must raise an owner task, got ${JSON.stringify(agent)}`
  );
  check(
    "agent_promise_task_names_the_promise",
    agent.kind === "agent_promise_owner_task" && /incentives/.test(agent.taskSummary),
    "the owner task must say WHAT was promised, or nobody knows what to do"
  );
  check(
    "agent_promise_carries_no_due_or_hold",
    agent.kind === "agent_promise_owner_task" &&
      !("taskDueIso" in agent) &&
      !("holdUntilIso" in agent),
    "the agent's promise is not evidence about when a HUMAN will act: no due pressure, no cadence hold"
  );

  // EVERY OTHER GATE STILL APPLIES TO THE AGENT BRANCH — it loosens the AUTHOR, nothing else.
  for (const [id, over] of [
    ["agent_low_confidence_still_nothing", { parse: parse({ confidence: 0.4 }) }],
    ["agent_inventory_notify_still_nothing", { parse: parse({ kind: "inventory_notify", action: "text when a Street Bob arrives" }) }],
    ["agent_appointment_still_nothing", { parse: parse({ kind: "appointment" }) }],
    ["agent_no_promise_still_nothing", { parse: parse({ promisePresent: false, kind: "none" }) }],
    ["agent_closed_lead_still_nothing", { conversationStatus: "closed" }]
  ] as const) {
    const d = decideManualOutboundPromise(base({ ...(over as any), humanAuthored: false }));
    check(id, d.kind === "none", `expected none, got ${JSON.stringify(d)}`);
  }

  // ------------------------------------------------------------------------------------------
  // WHAT THE SEND PATH DOES — EXECUTED, not pinned as source text.
  //
  // The first cut of this asserted `pauseFollowUpCadence(` did not appear within 600 characters of
  // the agent arm. That is a claim about FORMATTING: merging the two apply branches broke it while
  // the agent branch still held no cadence, and equally, a rename could have satisfied it while the
  // behaviour rotted. resolveManualPromiseApplyPlan is the real decision, so run it.
  // ------------------------------------------------------------------------------------------
  const agentPlan = resolveManualPromiseApplyPlan(
    decideManualOutboundPromise(base({ parse: incentives, humanAuthored: false }))
  );
  check("agent_plan_exists", !!agentPlan, "the agent's promise must still produce a plan (an owner task)");
  check(
    "agent_plan_has_no_due_date",
    agentPlan?.taskDueIso === null,
    `the agent's promise must carry NO due date, got ${JSON.stringify(agentPlan?.taskDueIso)}`
  );
  check(
    "agent_plan_holds_no_cadence",
    agentPlan?.holdUntilIso === null,
    `the agent's promise must NOT hold cadence, got ${JSON.stringify(agentPlan?.holdUntilIso)}`
  );
  check(
    "agent_plan_records_its_own_outcome",
    agentPlan?.outcomeKey === "agent_promise_owner_task",
    "an arm that ends in a task must record why, under its own key (2026-08-07 rule)"
  );

  // The PERSON's branch must be untouched by all of this: still dated, still holding cadence.
  const humanPlan = resolveManualPromiseApplyPlan(
    decideManualOutboundPromise(base({ parse: incentives, humanAuthored: true }))
  );
  check("human_plan_exists", !!humanPlan, "a person's promise must still produce a plan");
  check(
    "human_plan_keeps_its_due_date",
    typeof humanPlan?.taskDueIso === "string" && humanPlan.taskDueIso.length > 0,
    `a person's promise must keep its due date, got ${JSON.stringify(humanPlan?.taskDueIso)}`
  );
  check(
    "human_plan_keeps_its_cadence_hold",
    typeof humanPlan?.holdUntilIso === "string" && humanPlan.holdUntilIso.length > 0,
    `a person's promise must keep its cadence hold, got ${JSON.stringify(humanPlan?.holdUntilIso)}`
  );
  check(
    "human_plan_keeps_its_outcome_key",
    humanPlan?.outcomeKey === "manual_outbound_promise_task",
    "the person branch must keep recording under its original key"
  );

  // A decision the send path does not recognise must stay SILENT — no task, no hold.
  check(
    "unknown_decision_is_quiet",
    resolveManualPromiseApplyPlan({ kind: "none", reason: "whatever" }) === null,
    "a non-task decision must produce no plan at all"
  );

  // WIRING (the one thing execution cannot see from here): index.ts must consult the referee and
  // apply the hold CONDITIONALLY. `.includes` on purpose — an escaped paren here trips the
  // source-pin ratchet. See scripts/eval_source_pin_ratchet_eval.ts.
  const fs4 = await import("node:fs");
  const idx4 = fs4.readFileSync("services/api/src/index.ts", "utf8");
  check(
    "send_path_asks_the_referee",
    idx4.includes("resolveManualPromiseApplyPlan(promiseDecision)"),
    "index.ts must derive its apply plan from the referee, or the referee is decoration"
  );
  check(
    "send_path_holds_cadence_only_when_the_plan_says_to",
    idx4.includes("if (promisePlan.holdUntilIso) pauseFollowUpCadence"),
    "the cadence hold must be gated on the plan — an unconditional call re-freezes the agent branch"
  );
}

if (failures) {
  console.error(`manual outbound promise eval: ${failures} failure(s)`);
  process.exit(1);
}
console.log("manual outbound promise eval: all checks passed");
