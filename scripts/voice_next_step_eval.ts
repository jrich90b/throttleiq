/**
 * Decision-table eval for the voice next-step plan (domain/voiceNextStep.ts).
 *
 * Pins the pure decision that turns a live call's parsed next step into cadence
 * holds / staff tasks / the post-call breather — and, critically, the fail
 * direction: voicemails change nothing, and every uncertain branch leaves the
 * cadence running (at most the breather). See Joe's 2026-07-19 ruling.
 */
import {
  decideVoiceNextStep,
  resolveVoiceLiveCallBreatherHours,
  resolveVoiceNextStepConfidenceMin,
  VOICE_LIVE_CALL_BREATHER_HOURS_DEFAULT,
  VOICE_NEXT_STEP_CONFIDENCE_MIN_DEFAULT,
  type VoiceNextStepDecision,
  type VoiceNextStepInput
} from "../services/api/src/domain/voiceNextStep.ts";

const TZ = "America/New_York";
// Fixed clock: Wednesday 2026-07-15 12:00 ET (16:00Z). July ET = UTC-4.
const NOW_MS = Date.UTC(2026, 6, 15, 16, 0, 0);
const BREATHER_ISO = new Date(NOW_MS + VOICE_LIVE_CALL_BREATHER_HOURS_DEFAULT * 3600_000).toISOString();

type Case = {
  id: string;
  input: Partial<VoiceNextStepInput>;
  expect: (d: VoiceNextStepDecision) => string | null; // null = pass, string = failure detail
};

function base(overrides: Partial<VoiceNextStepInput>): VoiceNextStepInput {
  return {
    isVoicemail: false,
    nowMs: NOW_MS,
    timeZone: TZ,
    cadenceKind: "standard",
    followUpMode: "active",
    conversationStatus: "open",
    nextStepOwner: "none",
    nextStepAction: "",
    nextStepConfidence: 0,
    dueDate: null,
    ...overrides
  };
}

const CASES: Case[] = [
  {
    id: "voicemail_changes_nothing",
    input: { isVoicemail: true, nextStepOwner: "customer", nextStepAction: "come in", nextStepConfidence: 0.95 },
    expect: d => (d.kind === "none" && d.reason === "voicemail_no_change" ? null : `got ${JSON.stringify(d)}`)
  },
  {
    id: "closed_conversation_untouched",
    input: { conversationStatus: "closed", nextStepOwner: "staff", nextStepAction: "send numbers", nextStepConfidence: 0.95 },
    expect: d => (d.kind === "none" && d.reason === "conversation_closed" ? null : `got ${JSON.stringify(d)}`)
  },
  {
    id: "manual_handoff_untouched",
    input: { followUpMode: "manual_handoff", nextStepOwner: "staff", nextStepAction: "send numbers", nextStepConfidence: 0.95 },
    expect: d => (d.kind === "none" && d.reason === "held_mode_manual_handoff" ? null : `got ${JSON.stringify(d)}`)
  },
  {
    id: "paused_indefinite_untouched",
    input: { followUpMode: "paused_indefinite", nextStepOwner: "customer", nextStepAction: "come in", nextStepConfidence: 0.95 },
    expect: d => (d.kind === "none" && d.reason === "held_mode_paused_indefinite" ? null : `got ${JSON.stringify(d)}`)
  },
  {
    id: "post_sale_cadence_untouched",
    input: { cadenceKind: "post_sale", nextStepOwner: "staff", nextStepAction: "send numbers", nextStepConfidence: 0.95 },
    expect: d => (d.kind === "none" && d.reason === "post_sale_cadence" ? null : `got ${JSON.stringify(d)}`)
  },
  {
    id: "no_next_step_gets_breather_only",
    input: {},
    expect: d =>
      d.kind === "breather_only" && d.holdUntilIso === BREATHER_ISO ? null : `got ${JSON.stringify(d)}`
  },
  {
    id: "low_confidence_falls_to_breather",
    input: { nextStepOwner: "customer", nextStepAction: "come in Saturday", nextStepConfidence: 0.4, dueDate: { year: 2026, month: 7, day: 18 } },
    expect: d => (d.kind === "breather_only" ? null : `got ${JSON.stringify(d)}`)
  },
  {
    id: "owner_without_action_falls_to_breather",
    input: { nextStepOwner: "customer", nextStepAction: "", nextStepConfidence: 0.95, dueDate: { year: 2026, month: 7, day: 18 } },
    expect: d => (d.kind === "breather_only" ? null : `got ${JSON.stringify(d)}`)
  },
  {
    id: "customer_saturday_holds_until_sunday_morning",
    // Committed Sat 7/18 → resume Sun 7/19 10:30 ET = 14:30Z (after the committed day).
    input: { nextStepOwner: "customer", nextStepAction: "come by to look at the Breakout", nextStepConfidence: 0.94, dueDate: { year: 2026, month: 7, day: 18 } },
    expect: d =>
      d.kind === "hold_for_customer" && d.holdUntilIso === "2026-07-19T14:30:00.000Z" && d.dueLabel.includes("Jul 18")
        ? null
        : `got ${JSON.stringify(d)}`
  },
  {
    id: "customer_no_parsable_day_falls_to_breather",
    input: { nextStepOwner: "customer", nextStepAction: "think it over and call back", nextStepConfidence: 0.9, dueDate: null },
    expect: d => (d.kind === "breather_only" && d.holdUntilIso === BREATHER_ISO ? null : `got ${JSON.stringify(d)}`)
  },
  {
    id: "customer_same_day_hold_never_shortens_breather",
    // Committed TODAY (7/15) → day-after 10:30 ET (7/16 14:30Z) is EARLIER than the
    // 48h breather (7/17 16:00Z) → breather wins; a hold can only push later.
    input: { nextStepOwner: "customer", nextStepAction: "swing by later today", nextStepConfidence: 0.9, dueDate: { year: 2026, month: 7, day: 15 } },
    expect: d => (d.kind === "hold_for_customer" && d.holdUntilIso === BREATHER_ISO ? null : `got ${JSON.stringify(d)}`)
  },
  {
    id: "customer_far_future_capped_to_breather",
    // 35 days out (> 30d cap): a misparse must never park a lead — breather only.
    input: { nextStepOwner: "customer", nextStepAction: "come in", nextStepConfidence: 0.9, dueDate: { year: 2026, month: 8, day: 19 } },
    expect: d => (d.kind === "breather_only" && d.holdUntilIso === BREATHER_ISO ? null : `got ${JSON.stringify(d)}`)
  },
  {
    id: "customer_past_day_falls_to_breather",
    input: { nextStepOwner: "customer", nextStepAction: "come in", nextStepConfidence: 0.9, dueDate: { year: 2026, month: 7, day: 13 } },
    expect: d => (d.kind === "breather_only" && d.holdUntilIso === BREATHER_ISO ? null : `got ${JSON.stringify(d)}`)
  },
  {
    id: "staff_monday_promise_dated_task_and_hold",
    // Promised numbers by Mon 7/20 → task due Mon 10:30 ET (14:30Z), cadence holds
    // until Tue 7/21 10:30 ET so a generic text can't contradict the promise.
    input: { nextStepOwner: "staff", nextStepAction: "send exact payment numbers", nextStepConfidence: 0.95, dueDate: { year: 2026, month: 7, day: 20 } },
    expect: d =>
      d.kind === "staff_task" &&
      d.taskDueIso === "2026-07-20T14:30:00.000Z" &&
      d.holdUntilIso === "2026-07-21T14:30:00.000Z" &&
      d.taskSummary === "Promised on the call: send exact payment numbers — by Mon, Jul 20"
        ? null
        : `got ${JSON.stringify(d)}`
  },
  {
    id: "staff_promise_without_day_due_tomorrow",
    // No stated day → due in 24h so the promise can't quietly age out; hold = breather.
    input: { nextStepOwner: "staff", nextStepAction: "get the trade appraised", nextStepConfidence: 0.9, dueDate: null },
    expect: d =>
      d.kind === "staff_task" &&
      d.taskDueIso === new Date(NOW_MS + 24 * 3600_000).toISOString() &&
      d.holdUntilIso === BREATHER_ISO &&
      d.taskSummary === "Promised on the call: get the trade appraised"
        ? null
        : `got ${JSON.stringify(d)}`
  },
  {
    id: "custom_breather_hours_respected",
    input: { breatherHours: 12 },
    expect: d =>
      d.kind === "breather_only" && d.holdUntilIso === new Date(NOW_MS + 12 * 3600_000).toISOString()
        ? null
        : `got ${JSON.stringify(d)}`
  },
  // ── Customer VISIT commitment on a live call (Zackary Hauff +17165985414, operator-reported:
  // "agreed to come in Saturday between 1:30 and 2:00" said ON THE CALL created no task — said
  // over SMS it would have). A dated visit gets the cadence hold AND a dated staff task so the
  // store expects them; a non-visit customer step keeps the quiet hold exactly as before. ──
  {
    id: "customer_dated_visit_creates_task_and_holds",
    input: {
      nextStepOwner: "customer",
      nextStepAction: "come in Saturday between 1:30 and 2:00 to look at bikes",
      nextStepConfidence: 0.94,
      customerVisitPlanned: true,
      dueDate: { year: 2026, month: 7, day: 18 }
    },
    expect: d =>
      d.kind === "customer_visit_task" &&
      d.taskDueIso === "2026-07-18T14:30:00.000Z" && // 10:30 ET the visit morning
      d.holdUntilIso === "2026-07-19T14:30:00.000Z" && // cadence resumes morning after
      /customer plans to VISIT Sat, Jul 18/.test(d.taskSummary)
        ? null
        : `got ${JSON.stringify(d)}`
  },
  {
    id: "customer_visit_without_day_stays_breather",
    // "I'll stop by sometime" — no day => no dated task to make; the breather is the guard.
    input: { nextStepOwner: "customer", nextStepAction: "stop by sometime", nextStepConfidence: 0.9, customerVisitPlanned: true, dueDate: null },
    expect: d => (d.kind === "breather_only" ? null : `got ${JSON.stringify(d)}`)
  },
  {
    id: "customer_nonvisit_step_still_quiet_hold",
    // Non-visit customer step (call back after payday) is UNCHANGED: quiet hold, no task.
    input: { nextStepOwner: "customer", nextStepAction: "call back after the MSF course", nextStepConfidence: 0.9, customerVisitPlanned: false, dueDate: { year: 2026, month: 7, day: 20 } },
    expect: d => (d.kind === "hold_for_customer" ? null : `got ${JSON.stringify(d)}`)
  }
];

let failures = 0;
for (const c of CASES) {
  const decision = decideVoiceNextStep(base(c.input));
  const problem = c.expect(decision);
  if (problem) {
    failures += 1;
    console.error(`FAIL ${c.id}: ${problem}`);
  } else {
    console.log(`PASS ${c.id}`);
  }
}

// Env resolver guards (bad values fall back to safe defaults).
const resolverChecks: Array<[string, boolean]> = [
  ["confidence_min_default_on_garbage", resolveVoiceNextStepConfidenceMin("abc") === VOICE_NEXT_STEP_CONFIDENCE_MIN_DEFAULT],
  ["confidence_min_rejects_over_1", resolveVoiceNextStepConfidenceMin("3") === VOICE_NEXT_STEP_CONFIDENCE_MIN_DEFAULT],
  ["confidence_min_accepts_valid", resolveVoiceNextStepConfidenceMin("0.8") === 0.8],
  ["breather_default_on_garbage", resolveVoiceLiveCallBreatherHours("") === VOICE_LIVE_CALL_BREATHER_HOURS_DEFAULT],
  ["breather_accepts_valid", resolveVoiceLiveCallBreatherHours("24") === 24]
];
for (const [id, ok] of resolverChecks) {
  if (!ok) {
    failures += 1;
    console.error(`FAIL resolver:${id}`);
  } else {
    console.log(`PASS resolver:${id}`);
  }
}

if (failures) {
  console.error(`voice next-step eval: ${failures} failure(s)`);
  process.exit(1);
}
console.log(`voice next-step eval: all ${CASES.length + resolverChecks.length} checks passed`);
