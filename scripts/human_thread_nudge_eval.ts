/**
 * human_thread_nudge:eval — pins the quiet-thread nudge (Joe 2026-07-20: "as hands off as
 * possible"; Joe 2026-07-23 ruling: LIVE in draft mode + widened to manual-handoff threads).
 *
 * 1. decideHumanThreadNudge decision-table: fires ONLY on a human-owned (mode=human) OR handed-off
 *    (followUp.mode=manual_handoff) thread whose last delivered message is an outbound that has sat
 *    quiet >= N days — and never over an unanswered customer message, a dated staff promise, a
 *    pending draft, opt-out, closed, call-only, a booked appointment, a NON-SALES department
 *    handoff (apparel/parts/service — that team owns the thread), a thread quiet PAST the ceiling
 *    (Joe 8/01: 30 days — beyond that a bump is a cold re-open, not a continuation), the cap
 *    (2/thread), or unspaced repeats. Production pins: Zackary +17165985414 (human mode, last outbound was an
 *    AGENT send — must still fire) and Michael Spence +17169306602 (suggest mode + manual_handoff —
 *    must fire under the widening).
 * 2. Env helpers: feature LIVE by default (kill switch = explicit 0); autosend separately DARK;
 *    Number("") guards on the day knobs.
 * 3. Source pins: the tick lane is flag-gated and widened to the handoff class, drafts land as
 *    draft_ai (suggest queue), autosend is behind the SECOND flag only, the ledger records
 *    count+lastAt, and the composer refuses persona intros (voice continuity).
 * 4. isHumanThreadNudgeRestatement, EXECUTED against the reported pair: bump #2 may not be bump #1
 *    reworded (Joe, +17169467745, 2026-08-19), it is compared against the previous bump the ledger
 *    dates rather than a time window, a bump that ADVANCES still ships (Igor +17164442120), and a
 *    suppressed bump CONSUMES its attempt instead of re-composing every minute.
 * 5. THE THREAD IS DATED (William Higgins +17165233086, 2026-08-22): every anchor reaches the model
 *    stamped with its real date and age IN THE DEALER'S ZONE, the quiet gap is stated up front as a
 *    number, and a stale plan may not be asserted as happening today. Wiring is counted at the one
 *    call site (`at` + `nowMs`), the recency helpers are executed, and the reviewer's rendered line
 *    is pinned unchanged across the extraction into threadRecency.ts.
 * 6. THE DAY GUARD, which is what makes 5 complete. The prompt took "asserts a stale time as today"
 *    from 8/12 to 3/12 and a prompt cannot be trusted for the last 25%, so the invariant is
 *    enforced on the OUTPUT: this lane never fires on a booked appointment, therefore ANY day a
 *    bump names is unfounded. nudgeNamesAnUnfoundedDay is validated against 24 REAL model outputs
 *    from the 2026-08-22 replay, and resolveHumanThreadNudgeText (retry once, then suppress) is
 *    executed. End-to-end on the live anchors, n=24: 24 shipped, 5 retried, 0 suppressed, 0 bad.
 */
import fs from "node:fs";
import path from "node:path";
import {
  decideHumanThreadNudge,
  isHumanThreadNudgeEnabled,
  isHumanThreadNudgeAutosendEnabled,
  humanThreadNudgeQuietDays,
  humanThreadNudgeMaxCount,
  humanThreadNudgeSpacingDays,
  HUMAN_THREAD_NUDGE_MAX_QUIET_DAYS_DEFAULT,
  resolveHumanThreadNudgeComposeGate,
  isHumanThreadNudgeRestatement,
  selectHumanThreadNudgeThread,
  hasOpenFutureDatedTodo,
  anchorsHaveSomethingToContinue,
  buildHumanThreadNudgeComposeArgs,
  nudgeNamesAnUnfoundedDay,
  resolveHumanThreadNudgeText,
  HUMAN_THREAD_NUDGE_MIN_ANCHOR_CHARS
} from "../services/api/src/domain/humanThreadNudge.ts";
import { isThreadParkedOnInventoryPromise } from "../services/api/src/domain/conversationStore.ts";
import { buildHumanThreadNudgePrompt } from "../services/api/src/domain/humanThreadNudgePrompt.ts";
import { describeThreadLineAge, formatThreadLineStamp } from "../services/api/src/domain/threadRecency.ts";
import { renderClaudeReviewThreadLine } from "../services/api/src/domain/claudeDraftReview.ts";
import {
  isThreadParkedOnUpcomingClass,
  readEnrollmentClassStartMs
} from "../services/api/src/domain/firstTimeRiderPolicy.ts";

const failures: string[] = [];
const eq = (id: string, actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`  - ${id}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

// --- env helpers -------------------------------------------------------------
for (const k of ["HUMAN_THREAD_NUDGE_ENABLED", "HUMAN_THREAD_NUDGE_AUTOSEND", "HUMAN_THREAD_NUDGE_QUIET_DAYS"]) delete process.env[k];
// Joe 7/23: the draft-mode nudge is LIVE by default. The kill switch is an explicit 0.
eq("feature_live_by_default", isHumanThreadNudgeEnabled(), true);
process.env.HUMAN_THREAD_NUDGE_ENABLED = "0";
eq("feature_kill_switch_zero", isHumanThreadNudgeEnabled(), false);
delete process.env.HUMAN_THREAD_NUDGE_ENABLED;
// Autosend (zero-touch) stays DARK until Joe graduates it on draft evidence.
eq("autosend_dark_by_default", isHumanThreadNudgeAutosendEnabled(), false);
eq("quiet_days_default_3", humanThreadNudgeQuietDays(), 3);
eq("max_count_default_2", humanThreadNudgeMaxCount(), 2);
eq("spacing_days_default_5", humanThreadNudgeSpacingDays(), 5);
process.env.HUMAN_THREAD_NUDGE_QUIET_DAYS = "7";
eq("quiet_days_env_override", humanThreadNudgeQuietDays(), 7);
delete process.env.HUMAN_THREAD_NUDGE_QUIET_DAYS;

// --- decision table ----------------------------------------------------------
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const base = {
  conversationMode: "human",
  followUpMode: null as string | null,
  suppressed: false,
  conversationStatus: "open",
  contactPreference: null as string | null,
  appointmentBookedEventId: null as string | null,
  hasPendingDraft: false,
  lastMessageDirection: "out" as const,
  lastMessageAtMs: NOW - 4 * DAY,
  hasOpenFutureDatedTodo: false,
  nudgeCount: 0,
  lastNudgeAtMs: null as number | null,
  nowMs: NOW,
  quietDays: 3,
  maxCount: 2,
  spacingDays: 5
};
const D = decideHumanThreadNudge;
eq("happy_path_fires", D(base).nudge, true);
// Joe 7/23 widening — the two production shapes:
// Zackary +17165985414: human mode, but the last delivered outbound was an AGENT send (credit-app
// ack / event blast, no human actor). The old "last outbound must be human" gate blocked him
// through 7 quiet days; the ruling removes that gate. Same input shape as base (no
// lastOutboundWasHuman field exists any more) — pinned here so it never comes back.
eq("zackary_human_mode_agent_last_outbound_fires", D({ ...base, conversationMode: "human", followUpMode: "manual_handoff" }).nudge, true);
// Michael Spence +17169306602: suggest mode + followUp.mode=manual_handoff (web-widget sales
// handoff, price answered 7/06, silent since) — eligible under the widening.
eq("spence_suggest_mode_handoff_fires", D({ ...base, conversationMode: "suggest", followUpMode: "manual_handoff" }).nudge, true);
// Narendra +6282245353758 (open-critic 2026-08-01, duplicate_question_after_human_handoff): a
// Motor Clothes WEB TEXT WIDGET lead -> followUp {mode:"manual_handoff", reason:"apparel_request"}
// + an apparel staff todo. Joe then sent "Are you looking for factory racing t-shirts?"; the
// customer never answered; 12 quiet days later the nudge re-asked Joe's own question back at him.
// A non-sales department owns that thread — staff todo, never a customer bump.
const narendra = {
  ...base,
  conversationMode: "suggest",
  followUpMode: "manual_handoff",
  followUpReason: "apparel_request",
  lastMessageDirection: "out" as const,
  lastMessageAtMs: NOW - 12 * DAY
};
eq("narendra_apparel_handoff_no", D(narendra), { nudge: false, reason: "non_sales_department_handoff" });
eq("parts_handoff_no", D({ ...narendra, followUpReason: "parts_request" }).nudge, false);
eq("service_handoff_no", D({ ...narendra, followUpReason: "service_request" }).nudge, false);
// It is a CLASS exclusion, not a timing artifact — same verdict one day in.
eq("dept_stop_precedes_clock", D({ ...narendra, lastMessageAtMs: NOW - 1 * DAY }).reason, "non_sales_department_handoff");
// Regression pins — the widening Joe ruled in on 7/23 stays intact. A SALES handoff, an unknown/
// absent reason, and a thread a rep personally took over (mode=human) all still fire.
eq("spence_sales_handoff_still_fires", D({ ...narendra, followUpReason: "web_text_widget_sales" }).nudge, true);
eq("unknown_reason_still_fires", D({ ...narendra, followUpReason: null }).nudge, true);
eq("human_mode_beats_dept_reason", D({ ...narendra, conversationMode: "human" }).nudge, true);
// ---------------------------------------------------------------------------
// PARKED ON A PROMISE WE MADE (Joe, operator reports 2026-08-10 and 2026-08-11). The nudge asked
// "is this thread quiet?" and never "why?". Reproduced by executing decideHumanThreadNudge against
// the live records: three threads whose silence was deliberate got bumped anyway.
//   Jason Marshall +17165230421 — $500 deposit on a 2026 CVO Road Glide ST (hold.onOrder), active
//   watch, cadence stopped for it. We had just promised to text him when it lands; 3 days later the
//   nudge drafted "Any update on your timing for Unadilla, Jason...". Joe: "There is no reason to
//   follow up when he is waiting for a bike to be delivered."
//   Mark Griffin +15416478489 — active watch on a 2023 Fat Bob. Joe: "there should not be a cadence
//   or nudge on a set watch."
// Measured on the live store 2026-08-12: 17 of 376 nudge-eligible threads are parked, and 5 of the
// 33 nudges this feature has ever produced landed on one.
// ---------------------------------------------------------------------------
eq("parked_no", D({ ...base, parkedOnInventoryPromise: true }), { nudge: false, reason: "parked_on_inventory_promise" });
eq("handoff_parked_no", D({ ...base, conversationMode: "suggest", followUpMode: "manual_handoff", parkedOnInventoryPromise: true }).nudge, false);
// A CLASS exclusion like the department stop: the answer must not move with the quiet clock.
eq("parked_precedes_clock", D({ ...base, parkedOnInventoryPromise: true, lastMessageAtMs: NOW - 1 * DAY }).reason, "parked_on_inventory_promise");
eq("parked_precedes_ceiling", D({ ...base, parkedOnInventoryPromise: true, lastMessageAtMs: NOW - 200 * DAY }).reason, "parked_on_inventory_promise");
// FAIL DIRECTION: not-parked (and an absent field) changes nothing about the existing behaviour.
eq("not_parked_still_fires", D({ ...base, parkedOnInventoryPromise: false }).nudge, true);
eq("parked_field_absent_still_fires", D(base).nudge, true);
// The referee itself — ONE answer to "is there an active watch", shared with the watch lanes.
eq("referee_active_single_watch", isThreadParkedOnInventoryPromise({ inventoryWatch: { status: "active" } }), true);
eq("referee_active_in_array", isThreadParkedOnInventoryPromise({ inventoryWatches: [{ status: "active" }] }), true);
// Jason's shape: single + array + a cadence stopped for the watch + a unit on order.
eq(
  "referee_jason_marshall_shape",
  isThreadParkedOnInventoryPromise({
    inventoryWatch: { status: "active" },
    inventoryWatches: [{ status: "active" }],
    followUpCadence: { status: "stopped", stopReason: "inventory_watch" },
    hold: { onOrder: true }
  }),
  true
);
// A cadence STOPPED for a watch reads exactly like no cadence from the nudge's side — the stop
// reason is the only thing that tells them apart, so it has to be read on its own.
eq("referee_cadence_stopped_for_watch", isThreadParkedOnInventoryPromise({ followUpCadence: { status: "stopped", stopReason: "inventory_watch" } }), true);
eq("referee_unit_on_order", isThreadParkedOnInventoryPromise({ hold: { onOrder: true } }), true);
// ...and everything else is NOT parked. A paused watch is one the fire engine skips; a cadence
// stopped for some other reason, a hold that is not an order, and an empty/absent record all leave
// the nudge exactly as it was.
eq("referee_paused_watch_not_parked", isThreadParkedOnInventoryPromise({ inventoryWatch: { status: "paused" } }), false);
eq("referee_other_stop_reason_not_parked", isThreadParkedOnInventoryPromise({ followUpCadence: { status: "stopped", stopReason: "customer_declined" } }), false);
eq("referee_hold_not_on_order_not_parked", isThreadParkedOnInventoryPromise({ hold: { onOrder: false, reason: "test_ride" } }), false);
eq("referee_empty_conv_not_parked", isThreadParkedOnInventoryPromise({}), false);
eq("referee_null_conv_not_parked", isThreadParkedOnInventoryPromise(null), false);
eq("referee_junk_shapes_not_parked", isThreadParkedOnInventoryPromise({ inventoryWatches: "nope", followUpCadence: null, hold: null }), false);

// ---------------------------------------------------------------------------
// PARKED ON A CLASS THEY ALREADY BOOKED (Joe, operator report on Savannah Niver +13155211619,
// 2026-08-10): "between the sign up date and the class, there really should not be a follow up
// cadence for riding academy regsitrations." She enrolled, we acked, and three quiet days later the
// nudge drafted "Quick check — any questions about the Riding Academy before class starts,
// Savannah?" — nothing had happened and nothing was due to until the class itself.
//
// Reproduced by EXECUTING decideHumanThreadNudge against the live store 2026-08-12: three enrolled
// leads are nudge-eligible, held back today only by the quiet/spacing clocks. Advance the clock
// five days and two flip to nudge:true — Savannah legitimately (her 8/15 class is past by then) and
// Ulises HernandezPerez +17167857284 wrongly (his 8/22 class is still five days out). That split is
// why the stop is keyed to the CLASS DATE and is not a blanket Riding-Academy lane exclusion.
// ---------------------------------------------------------------------------
eq("class_no", D({ ...base, parkedOnUpcomingClass: true }), { nudge: false, reason: "parked_on_upcoming_class" });
eq("handoff_class_no", D({ ...base, conversationMode: "suggest", followUpMode: "manual_handoff", parkedOnUpcomingClass: true }).nudge, false);
// Above the quiet clock at BOTH ends, like the two stops before it.
eq("class_precedes_clock", D({ ...base, parkedOnUpcomingClass: true, lastMessageAtMs: NOW - 1 * DAY }).reason, "parked_on_upcoming_class");
eq("class_precedes_ceiling", D({ ...base, parkedOnUpcomingClass: true, lastMessageAtMs: NOW - 200 * DAY }).reason, "parked_on_upcoming_class");
// ...but the inventory promise still answers first when both are true, so the reason stays stable.
eq("inventory_promise_reported_first", D({ ...base, parkedOnInventoryPromise: true, parkedOnUpcomingClass: true }).reason, "parked_on_inventory_promise");
// FAIL DIRECTION: false and absent both leave every other thread exactly as it was.
eq("not_class_parked_still_fires", D({ ...base, parkedOnUpcomingClass: false }).nudge, true);
eq("class_field_absent_still_fires", D(base).nudge, true);

// The referee: Savannah's REAL enrollment blob, copied from the live store (machine record, machine
// read — customer prose is never parsed here).
const SAVANNAH_INQUIRY =
  "Enrollment Status: Enrolled-Course: New Rider Course - eCourse + Range-Class Start Date: 8/15/2026-Gender: Female-Motivation: Obtain a license-Motorcycle Riding History: I have operated an on-road motorcycle within the last 12 months-Training Experience: No-Payment Status: Failed-Future Motorcycle Purchase Expectation: Yes in 1-3 years-Future Motorcycle Purchase Brand: Honda-Accepted Terms and Conditions: true-Brand of Bike Owned:Honda";
const savannahConv = { lead: { inquiry: SAVANNAH_INQUIRY } };
const AUG_14 = new Date(2026, 7, 14, 12, 0, 0).getTime();
const AUG_15_NOON = new Date(2026, 7, 15, 12, 0, 0).getTime();
const AUG_16 = new Date(2026, 7, 16, 12, 0, 0).getTime();
// The whole point of the date read: it must survive the hyphen-packed record and stop at the next
// field label, exactly like the riding-history and course reads beside it.
eq("class_date_read_from_savannahs_record", readEnrollmentClassStartMs(SAVANNAH_INQUIRY), new Date(2026, 7, 16).getTime());
eq("referee_class_ahead_is_parked", isThreadParkedOnUpcomingClass(savannahConv, AUG_14), true);
// The class DAY itself still counts as ahead of them — a suppression that errs long fails toward
// NOT texting, which is the safe direction.
eq("referee_class_day_itself_is_parked", isThreadParkedOnUpcomingClass(savannahConv, AUG_15_NOON), true);
// ...and it lifts BY ITSELF the day after. Joe's rule has two ends; after the class this is an
// ordinary quiet thread and the nudge is welcome again.
eq("referee_class_past_is_not_parked", isThreadParkedOnUpcomingClass(savannahConv, AUG_16), false);
// Ulises +17167857284, the second report behind this: same lane, a later class, still parked on the
// day Savannah's has already run.
eq("referee_ulises_later_class_still_parked", isThreadParkedOnUpcomingClass({ lead: { inquiry: "Enrollment Status: Enrolled-Class Start Date: 8/22/2026-Gender: Male" } }, AUG_16), true);
// UNKNOWN never means "already happened": no record, no date, an unreadable one, an impossible
// calendar day, and junk shapes all leave the nudge exactly as it was.
eq("referee_no_enrollment_record_not_parked", isThreadParkedOnUpcomingClass({ lead: { inquiry: "I want a Road Glide" } }, AUG_14), false);
eq("referee_empty_conv_not_parked_class", isThreadParkedOnUpcomingClass({}, AUG_14), false);
eq("referee_null_conv_not_parked_class", isThreadParkedOnUpcomingClass(null, AUG_14), false);
eq("class_date_unreadable_reads_null", readEnrollmentClassStartMs("Class Start Date: soon-Gender: Female"), null);
eq("class_date_impossible_day_reads_null", readEnrollmentClassStartMs("Class Start Date: 2/31/2026-Gender: Female"), null);
eq("class_date_absent_reads_null", readEnrollmentClassStartMs("Enrollment Status: Enrolled-Gender: Female"), null);
// The field-boundary lookahead is load-bearing, not decoration: a run-on number must read UNKNOWN
// rather than silently truncating to a year we then act on. (A trailing LETTER is still a fine
// boundary — only more digits are ambiguous.)
eq("class_date_run_on_year_reads_null", readEnrollmentClassStartMs("Class Start Date: 8/15/20261-Gender: Female"), null);
eq("class_date_letter_boundary_still_reads", readEnrollmentClassStartMs("Class Start Date: 8/15/2026x"), new Date(2026, 7, 16).getTime());
eq("class_date_null_input_reads_null", readEnrollmentClassStartMs(null), null);

// A plain suggest-mode thread (no handoff) has its own cadence/auto-draft lane — never nudged.
eq("suggest_no_handoff_no", D({ ...base, conversationMode: "suggest" }), { nudge: false, reason: "not_human_or_handoff" });
eq("suggest_active_followup_no", D({ ...base, conversationMode: "suggest", followUpMode: "active" }), { nudge: false, reason: "not_human_or_handoff" });
eq("suggest_paused_indefinite_no", D({ ...base, conversationMode: "suggest", followUpMode: "paused_indefinite" }), { nudge: false, reason: "not_human_or_handoff" });
// Every stop-state applies to the widened (handoff) class too:
const handoff = { ...base, conversationMode: "suggest", followUpMode: "manual_handoff" };
eq("suppressed_no", D({ ...base, suppressed: true }).nudge, false);
eq("handoff_suppressed_no", D({ ...handoff, suppressed: true }).nudge, false);
eq("closed_no", D({ ...base, conversationStatus: "closed" }).nudge, false);
eq("handoff_closed_no", D({ ...handoff, closedReason: "sold" as any }).nudge, false);
eq("call_only_no", D({ ...base, contactPreference: "call_only" }).nudge, false);
eq("appointment_no", D({ ...base, appointmentBookedEventId: "evt_1" }).nudge, false);
eq("pending_draft_no", D({ ...base, hasPendingDraft: true }).nudge, false);
eq("handoff_pending_draft_no", D({ ...handoff, hasPendingDraft: true }).nudge, false);
eq("unanswered_customer_msg_no", D({ ...base, lastMessageDirection: "in" }), { nudge: false, reason: "owner_reply_needed" });
eq("handoff_unanswered_customer_msg_no", D({ ...handoff, lastMessageDirection: "in" }), { nudge: false, reason: "owner_reply_needed" });
eq("staff_promise_defers", D({ ...base, hasOpenFutureDatedTodo: true }), { nudge: false, reason: "staff_promise_pending" });
eq("not_quiet_enough_no", D({ ...base, lastMessageAtMs: NOW - 2 * DAY }), { nudge: false, reason: "not_quiet_long_enough" });
eq("handoff_not_quiet_enough_no", D({ ...handoff, lastMessageAtMs: NOW - 2 * DAY }), { nudge: false, reason: "not_quiet_long_enough" });
eq("cap_reached_no", D({ ...base, nudgeCount: 2 }), { nudge: false, reason: "cap_reached" });
eq("handoff_cap_reached_no", D({ ...handoff, nudgeCount: 2 }), { nudge: false, reason: "cap_reached" });
// Quiet-days CEILING (Joe 2026-08-01, condition 3 before the feature is re-enabled). Amy
// Szyminski +17168615133 (open-critic 2026-08-01, wrong_bucket_routing_employment_as_sales_lead):
// a March JOB APPLICATION, manual_handoff, last delivered message our own voicemail — bumped 131
// quiet days later with "any other details you want me to pass along to the hiring team?". At that
// age the bump is a cold re-open of a dead thread, and the composer is forbidden the new facts a
// re-open would need.
const amy = {
  ...base,
  conversationMode: "suggest",
  followUpMode: "manual_handoff",
  followUpReason: "room58_standard",
  lastMessageAtMs: NOW - 131 * DAY
};
eq("amy_131_quiet_days_no", D(amy), { nudge: false, reason: "quiet_too_long" });
// The other three dead threads from the same tick (130 / 110 / 87 days) — all blocked...
for (const d of [130, 110, 87]) {
  eq(`cold_reopen_${d}d_no`, D({ ...amy, lastMessageAtMs: NOW - d * DAY }), { nudge: false, reason: "quiet_too_long" });
}
// ...and every one of the twelve LEGITIMATE nudges from that tick still fires. This is the
// regression half: the ceiling must trim the tail, not the feature.
for (const d of [21, 13, 11, 10, 8, 7, 6, 3]) {
  eq(`quiet_${d}d_still_fires`, D({ ...amy, lastMessageAtMs: NOW - d * DAY }).nudge, true);
}
// The ceiling is ON without being wired: `base` never passes maxQuietDays, and the pure decision
// applies the default anyway — a safety stop a call site can forget is not a safety stop.
eq("ceiling_applies_when_caller_omits_it", D({ ...base, lastMessageAtMs: NOW - 60 * DAY }).reason, "quiet_too_long");
eq("ceiling_default_is_30_days", HUMAN_THREAD_NUDGE_MAX_QUIET_DAYS_DEFAULT, 30);
// Overridable, but NEVER to "no ceiling": junk and non-positive values fall back to the default.
eq("ceiling_override_widens", D({ ...amy, maxQuietDays: 200 }).nudge, true);
eq("ceiling_override_tightens", D({ ...amy, lastMessageAtMs: NOW - 10 * DAY, maxQuietDays: 7 }).reason, "quiet_too_long");
eq("ceiling_zero_falls_back_to_default", D({ ...amy, maxQuietDays: 0 }), { nudge: false, reason: "quiet_too_long" });
eq("ceiling_negative_falls_back_to_default", D({ ...amy, maxQuietDays: -5 }), { nudge: false, reason: "quiet_too_long" });
eq("ceiling_nan_falls_back_to_default", D({ ...amy, maxQuietDays: Number.NaN }), { nudge: false, reason: "quiet_too_long" });
eq("ceiling_null_falls_back_to_default", D({ ...amy, maxQuietDays: null }), { nudge: false, reason: "quiet_too_long" });
// A thread inside BOTH ends of the clock is unaffected by the ceiling's arrival.
eq("boundary_at_ceiling_still_fires", D({ ...amy, lastMessageAtMs: NOW - 30 * DAY }).nudge, true);
eq("boundary_past_ceiling_no", D({ ...amy, lastMessageAtMs: NOW - 31 * DAY }).reason, "quiet_too_long");
// Order pin: a cold thread that is ALSO an apparel handoff still reports the class exclusion —
// the ceiling is a timing stop and must not shadow the stop-states above it.
eq("dept_exclusion_still_precedes_ceiling", D({ ...amy, followUpReason: "apparel_request", lastMessageAtMs: NOW - 131 * DAY }).reason, "non_sales_department_handoff");
eq("second_nudge_needs_spacing", D({ ...base, nudgeCount: 1, lastNudgeAtMs: NOW - 3 * DAY }), { nudge: false, reason: "spacing_not_elapsed" });
eq("second_nudge_after_spacing_fires", D({ ...base, nudgeCount: 1, lastNudgeAtMs: NOW - 6 * DAY, lastMessageAtMs: NOW - 6 * DAY }).nudge, true);
eq("no_anchor_no", D({ ...base, lastMessageAtMs: NaN }), { nudge: false, reason: "no_message_anchor" });

// --- source pins -------------------------------------------------------------
const idx = fs.readFileSync(path.join(process.cwd(), "services/api/src/index.ts"), "utf8");
const laneIdx = idx.indexOf("if (isHumanThreadNudgeEnabled()) {");
// Bounded by the block that actually FOLLOWS, not a character count. A window standing in for
// "inside this block" silently stops being true the moment the block grows past it — which is how
// two other evals went stale on 2026-08-08.
const laneEndIdx = idx.indexOf("// Scheduling-leak safety net:", laneIdx);
const lane = laneIdx >= 0 && laneEndIdx > laneIdx ? idx.slice(laneIdx, laneEndIdx) : "";
eq("tick_lane_bounded_by_the_next_block", laneEndIdx > laneIdx, true);
eq("tick_lane_exists_flag_gated", laneIdx >= 0, true);
// The lane's pre-filter is the SHARED eligible-class helper, not a restatement that can drift from
// the pure decision's first branch.
eq("lane_widened_to_manual_handoff", /if \(!isHumanThreadNudgeEligibleClass\(\(conv as any\)\.mode, conv\.followUp\?\.mode\)\) continue;/.test(lane), true);
eq("lane_passes_followUpMode", /followUpMode: conv\.followUp\?\.mode \?\? null/.test(lane), true);
// Without the reason the decision cannot tell an apparel handoff from a sales handoff (Narendra).
eq("lane_passes_followUpReason", /followUpReason: conv\.followUp\?\.reason \?\? null/.test(lane), true);
// The parked answer comes from the SHARED referee in conversationStore (beside hasActiveInventoryWatch),
// not a second copy of "is there a watch" written here. Without this line the decision is blind to it.
eq("lane_passes_parked_from_the_referee", lane.includes("parkedOnInventoryPromise: isThreadParkedOnInventoryPromise(conv)"), true);
// Same for the class stop, and it must be handed the TICK's clock — a referee that read the wall
// clock itself would be untestable and would drift from every other date decision in this lane.
eq("lane_passes_class_from_the_referee", lane.includes("parkedOnUpcomingClass: isThreadParkedOnUpcomingClass(conv, now.getTime())"), true);
eq("lane_calls_pure_decision", /decideHumanThreadNudge\(\{/.test(lane), true);
eq("lane_composes_via_llm", /composeHumanThreadNudgeWithLLM\(/.test(lane), true);
eq("draft_mode_lands_in_queue", /appendOutbound\(conv, "salesperson", nudgeTo, nudgeMessage, "draft_ai"\)/.test(lane), true);
eq("autosend_behind_second_flag", /if \(isHumanThreadNudgeAutosendEnabled\(\)\) \{/.test(lane), true);
eq("ledger_records_count_and_lastAt", /conv\.humanThreadNudge = \{\s*\n\s*count: \(conv\.humanThreadNudge\?\.count \?\? 0\) \+ 1,\s*\n\s*lastAt: nowIso\(\)/.test(lane), true);
eq("duplicate_guard_present", /isRecentDuplicateOutbound\(conv, nudgeTo, nudgeMessage/.test(lane), true);

// ---------------------------------------------------------------------------
// THE RESTATEMENT GUARD (Joe, operator report 2026-08-19, Warren Gardner +17169467745: "The last
// nudge is too similar to the nudge previously sent").
//
// The lane ALREADY called isRecentDuplicateOutbound with nearDuplicate:true and it could not catch
// the pair, for two independent reasons — fixing either alone ships INERT:
//   (1) its window was 24h while the decision layer guarantees the two bumps are >= spacingDays (5)
//       apart, so it could never reach the message it exists to compare against (measured: 120.0h);
//   (2) nearDuplicate:true only enables similarity matching for INVENTORY-UNAVAILABLE cadence text,
//       which a bump never is, so it silently degraded to exact-match — and a reworded ask is not
//       an exact match (executed on five live bump bodies: false on all five).
// So these are EXECUTED against the real pair, not read out of the source.
// ---------------------------------------------------------------------------

// Warren's two bumps, verbatim from the store (8/14 sent, 8/19 drafted 120.0h later).
const WARREN_1 = "Warren — want to come by to take a look, or would you rather I send more photos/details first?";
const WARREN_2 =
  "Warren — did you want to come by to take a look, or would you prefer I send a few more photos/details first?";
const NUDGE_1_AT = "2026-08-14T21:59:00.000Z";
const warrenRows = [
  { direction: "out", provider: "twilio", to: "+17169467745", at: NUDGE_1_AT, body: WARREN_1 }
];
const restates = (over: Record<string, unknown> = {}) =>
  isHumanThreadNudgeRestatement({
    candidate: WARREN_2,
    messages: warrenRows,
    toE164: "+17169467745",
    lastNudgeAtMs: Date.parse(NUDGE_1_AT),
    ...over
  });

eq("restatement_catches_the_reported_pair", restates(), true);
// The defect itself: a 24h window cannot see a 120h-old bump. The ledger stamp is the anchor, so
// distance in time must not matter at all.
eq(
  "restatement_reaches_past_any_24h_window",
  isHumanThreadNudgeRestatement({
    candidate: WARREN_2,
    messages: [{ ...warrenRows[0], at: "2026-07-20T21:59:00.000Z" }],
    toE164: "+17169467745",
    lastNudgeAtMs: Date.parse("2026-07-20T21:59:00.000Z")
  }),
  true
);
// No previous bump ⇒ nothing to restate. Bump #1 is never suppressed by this guard.
eq("restatement_needs_a_previous_bump", restates({ lastNudgeAtMs: null }), false);
eq("restatement_ignores_unparseable_ledger", restates({ lastNudgeAtMs: Number.NaN }), false);
// Anything we said BEFORE bump #1 is out of scope — that is the cadence guard's job, not this one.
eq(
  "restatement_ignores_messages_before_the_previous_bump",
  isHumanThreadNudgeRestatement({
    candidate: WARREN_2,
    messages: warrenRows,
    toE164: "+17169467745",
    lastNudgeAtMs: Date.parse("2026-08-19T21:58:00.000Z")
  }),
  false
);
// A bump that genuinely ADVANCES is not a restatement. Igor +17164442120 is the live counter-case:
// staff texted him in between, the composer had new input, token overlap measured 0.25.
eq(
  "restatement_allows_a_bump_that_advanced",
  isHumanThreadNudgeRestatement({
    candidate: "Think you might be able to make this weekend if that spot opens up, Igor?",
    messages: [
      {
        direction: "out",
        provider: "draft_ai",
        to: "+17164442120",
        at: NUDGE_1_AT,
        body: "Just circling back on the Riding Academy wait list — still want me to keep you posted as soon as a spot opens?"
      }
    ],
    toE164: "+17164442120",
    lastNudgeAtMs: Date.parse(NUDGE_1_AT)
  }),
  false
);
// Structural guards: another lead's thread, an inbound, a provider we never send on.
eq("restatement_scoped_to_this_number", restates({ toE164: "+17165551234" }), false);
eq(
  "restatement_ignores_inbound",
  restates({ messages: [{ ...warrenRows[0], direction: "in" }] }),
  false
);
eq(
  "restatement_ignores_internal_providers",
  restates({ messages: [{ ...warrenRows[0], provider: "voice_summary" }] }),
  false
);
// draft_ai counts ON PURPOSE: Joe read the repeat in the approval queue, not on his phone.
eq(
  "restatement_counts_an_unapproved_draft",
  restates({ messages: [{ ...warrenRows[0], provider: "draft_ai", draftStatus: "stale" }] }),
  true
);

// Wiring: a suppressed bump must CONSUME its attempt, not retry. The tick runs every minute and the
// composer's only input is a thread that has not moved, so a retry buys the same sentence at LLM
// prices — the 2026-07-31 incident in miniature. It reaches the ledger write, then returns.
const restateIdx = lane.indexOf("isHumanThreadNudgeRestatement({");
const ledgerIdx = lane.indexOf("conv.humanThreadNudge = {");
eq("lane_calls_the_restatement_guard", restateIdx > 0, true);
eq("lane_checks_restatement_after_compose", restateIdx > lane.indexOf("await resolveHumanThreadNudgeText("), true);
// NOT just "the write comes later in the file" — that stays true when an early `continue` skips it,
// which is exactly the shape this pin was written to catch (it passed a sabotage that inserted one).
// Nothing between the guard and the ledger may leave the iteration.
const consumeSlice = restateIdx > 0 && ledgerIdx > restateIdx ? lane.slice(restateIdx, ledgerIdx) : "MISSING";
eq("restatement_consumes_the_attempt", consumeSlice !== "MISSING" && !consumeSlice.includes("continue;"), true);
// ...and a suppressed bump writes nothing to the thread on its way there.
const suppressedBranch = lane.slice(
  lane.indexOf("if (nudgeRestates) {"),
  lane.indexOf("} else if (isHumanThreadNudgeAutosendEnabled()) {")
);
eq("restatement_branch_sends_nothing", suppressedBranch.includes("appendOutbound"), false);
eq(
  "restatement_suppression_is_recorded",
  lane.includes('recordRouteOutcome("manual", "human_thread_nudge_restatement_suppressed"'),
  true
);
// The ledger keeps ONE writer: the suppressed path falls THROUGH to the same write, it does not
// grow a second copy beside it.
eq("ledger_still_has_exactly_one_writer", lane.split("conv.humanThreadNudge = {").length - 1, 1);
// A suppressed bump is not a bump — it must not be counted or logged as one.
eq("restatement_not_counted_as_a_nudge", lane.split("humanNudges += 1").length - 1, 1);
eq("autosend_reached_only_when_not_a_restatement", lane.includes("} else if (isHumanThreadNudgeAutosendEnabled()) {"), true);

// ---------------------------------------------------------------------------
// THE COST BOUND (incident 2026-07-31). Enabling this feature took the one-minute follow-up tick
// from ~13s to 150-220s: the per-tick cap counted only nudges that fully SUCCEEDED, so every
// rejected composition was a free, uncounted LLM call and one tick could compose across the whole
// store. Only 16 threads were ever nudged while every tick burned three minutes.
// ---------------------------------------------------------------------------

// (a) What can be known WITHOUT paying — executed, not read.
const COST_NOW = Date.parse("2026-08-08T12:00:00Z");
// A substantive default thread: with `anchors: []` every case below would trip the "nothing to
// continue" rule instead of the one it means to test.
const REAL_ANCHOR = [{ body: "Looks like you were approved contingent, they just want proof of income before we go further." }];
const gate = (over: Record<string, unknown> = {}) =>
  resolveHumanThreadNudgeComposeGate({ toE164: "+17165551234", anchors: REAL_ANCHOR, nowMs: COST_NOW, ...over });

eq("gate_clean_thread_composes", gate().compose, true);
eq("gate_unroutable_phone_blocks", gate({ toE164: "7165551234" }).compose, false);
eq("gate_unroutable_reason", (gate({ toE164: "" }) as any).reason, "unroutable_phone");
eq("gate_missing_phone_blocks", gate({ toE164: null }).compose, false);
// The Don Soto miss: the ANCHOR carried the stale date, not the bump. Known before composing.
const staleAnchor = [{ body: "Come by for the Taste of Country pre-party on June 20th, food and demo rides all afternoon!" }];
eq("gate_past_dated_anchor_blocks", gate({ anchors: staleAnchor }).compose, false);
eq("gate_past_dated_reason", (gate({ anchors: staleAnchor }) as any).reason, "past_dated_anchor");
// Any-of over the anchors, so splitting the old single call into anchors-here / composed-text-there
// is exactly equivalent — one stale row anywhere in the thread is enough.
eq(
  "gate_scans_every_anchor_not_just_the_last",
  gate({ anchors: [...staleAnchor, { body: "sounds good" }] }).compose,
  false
);
eq(
  "gate_future_date_is_fine",
  gate({ anchors: [{ body: "Great — see you December 24th, 2099 for the test ride we talked about, bring your endorsement." }] })
    .compose,
  true
);
// Junk anchors must not throw — and now they BLOCK rather than compose, because an unreadable
// thread is indistinguishable from no thread. Fail direction: silence.
eq("gate_junk_anchors_do_not_throw", gate({ anchors: "not-an-array" as never }).compose, false);
eq("gate_junk_anchors_reason", (gate({ anchors: "not-an-array" as never }) as any).reason, "nothing_to_continue");

// (a2) A BUMP CONTINUES A CONVERSATION — so there has to be one (Dennis Kowalczyk +17163459354).
// His entire thread was "stone from harley Reply STOP to opt out." — a rep announcing himself. With
// nothing to continue, the composer manufactured "You still getting those messages or want me to
// stop them, Dennis?", inviting a customer to unsubscribe from a conversation that never happened.
const DENNIS_THREAD = [{ body: "stone from harley Reply STOP to opt out." }];
eq("dennis_thread_has_nothing_to_continue", anchorsHaveSomethingToContinue(DENNIS_THREAD), false);
eq("dennis_thread_blocks_the_compose", gate({ anchors: DENNIS_THREAD }).compose, false);
eq("dennis_reason", (gate({ anchors: DENNIS_THREAD }) as any).reason, "nothing_to_continue");

// The other three below the line in the live store, all correctly excluded.
eq("bare_signature_is_not_a_conversation", anchorsHaveSomethingToContinue([{ body: "Scott Hartrich American H-D" }]), false);
eq("bare_stop_is_not_a_conversation", anchorsHaveSomethingToContinue([{ body: "STOP" }]), false);
eq("empty_thread_is_not_a_conversation", anchorsHaveSomethingToContinue([]), false);
eq("junk_anchors_do_not_throw", anchorsHaveSomethingToContinue("nope" as never), false);

// The footer must not COUNT as substance — otherwise every outbound clears the bar on boilerplate.
const footerOnly = [{ body: "Reply STOP to opt out. Reply STOP to opt out. Reply STOP to opt out." }];
eq("the_compliance_footer_is_not_substance", anchorsHaveSomethingToContinue(footerOnly), false);
// ...but a real message still qualifies WITH the footer attached, which is how they actually arrive.
eq(
  "a_real_message_with_a_footer_still_qualifies",
  anchorsHaveSomethingToContinue([
    { body: "Looks like you were approved contingent, they just want proof of income. Reply STOP to opt out." }
  ]),
  true
);
// One substantive message anywhere in the thread is enough — it need not be the last.
eq(
  "one_substantive_message_anywhere_is_enough",
  anchorsHaveSomethingToContinue([{ body: "We will probably ask $21,495 for the 2019 Road Glide you asked about" }, { body: "ok" }]),
  true
);
// The threshold is picked from a GAP in the live data (2026-08-08: zero threads at 40-59 chars,
// 352 at 100+, p5 = 146). Moving it is a data decision, so the number is pinned.
eq("threshold_is_the_measured_forty", HUMAN_THREAD_NUDGE_MIN_ANCHOR_CHARS, 40);
eq("just_under_the_bar_is_blocked", anchorsHaveSomethingToContinue([{ body: "x".repeat(39) }]), false);
eq("exactly_the_bar_qualifies", anchorsHaveSomethingToContinue([{ body: "x".repeat(40) }]), true);

// (b) The thread a bump is written FROM excludes rows the customer never received.
const picked = selectHumanThreadNudgeThread([
  { provider: "twilio", body: "first" },
  { provider: "draft_ai", body: "a draft nobody approved" },
  { provider: "voice_transcript", body: "internal log" },
  { provider: "human", body: "  " },
  { provider: "human", body: "last real one" }
]);
eq("thread_keeps_only_delivered_rows", picked.thread.length, 2);
eq("thread_last_is_the_newest_delivered", String(picked.last?.body), "last real one");
eq("thread_drops_empty_bodies", picked.thread.every((m: any) => String(m.body).trim().length > 0), true);
eq("thread_handles_missing_messages", selectHumanThreadNudgeThread(undefined).last, null);

// (c) A future-dated staff promise owns the follow-up.
const todos = [{ convId: "+1", dueAt: new Date(COST_NOW + 86_400_000).toISOString() }];
eq("future_dated_todo_blocks", hasOpenFutureDatedTodo(todos, "+1", COST_NOW), true);
eq("past_dated_todo_does_not", hasOpenFutureDatedTodo([{ convId: "+1", dueAt: new Date(COST_NOW - 1).toISOString() }], "+1", COST_NOW), false);
eq("other_thread_todo_ignored", hasOpenFutureDatedTodo(todos, "+2", COST_NOW), false);
eq("undated_todo_ignored", hasOpenFutureDatedTodo([{ convId: "+1", dueAt: "" }], "+1", COST_NOW), false);

// (d) The loop itself cannot be invoked from here, so its ORDER is asserted against the bounded
// lane. These are the three facts the incident turned on.
const composeIdx = lane.indexOf("await resolveHumanThreadNudgeText(");
const counterIdx = lane.indexOf("nudgeCompositions += 1;");
const gateIdx = lane.indexOf("resolveHumanThreadNudgeComposeGate({");
eq("lane_composes", composeIdx > 0, true);
eq("lane_counts_compositions_BEFORE_paying", counterIdx > 0 && counterIdx < composeIdx, true);
eq("lane_gates_certain_rejects_BEFORE_paying", gateIdx > 0 && gateIdx < composeIdx, true);
eq("lane_break_tests_the_composition_counter", /if \(nudgeCompositions >= 10\) break;/.test(lane), true);
eq("lane_break_no_longer_tests_successes", /if \(humanNudges >= 10\) break;/.test(lane), false);
// Deliberate: the near-duplicate check needs the composed body, so it stays downstream. The counter
// is what bounds it now — this asserts the choice is still the choice, not an oversight.
eq(
  "near_duplicate_check_remains_after_compose",
  lane.indexOf("isRecentDuplicateOutbound(") > composeIdx,
  true
);

const llm = fs.readFileSync(path.join(process.cwd(), "services/api/src/domain/llmDraft.ts"), "utf8");
const compIdx = llm.indexOf("export async function composeHumanThreadNudgeWithLLM");
// To the END of the function, not a magic character count: a fixed 4200-char window silently
// stopped covering the tail of the prompt the moment the prompt grew (2026-08-21), so rules added
// at the bottom read as absent and pins on rules already there started failing for no reason.
const compEnd = llm.indexOf("\nexport ", compIdx + 1);
const comp = compIdx >= 0 ? llm.slice(compIdx, compEnd > compIdx ? compEnd : undefined) : "";
eq("composer_default_on_kill_switch_zero", /HUMAN_THREAD_NUDGE_ENABLED \?\? "1"/.test(comp), true);
const nudgePrompt = buildHumanThreadNudgePrompt({
  firstName: "Michael",
  recentMessages: [{ direction: "out", body: "As long as the credit application was submitted to HDFS withing 30 days I can submit an application without it being another hard inquiry" }]
});
eq("composer_advance_never_restate_rule", /ADVANCE, NEVER RESTATE/.test(nudgePrompt), true);
eq("composer_carries_the_live_counter_example", /re-reads the rep/.test(nudgePrompt), true);
// The other half of the same rule. "Never restate" over-applied would silence the threads where a
// bump is MOST useful — chasing a document that never arrived (+17166090270, +17164728139) repeats
// an ask by nature, and that is the lane working, not a defect.
eq("composer_allows_chasing_an_unanswered_ask", /Chasing something we ASKED FOR is not restating/.test(nudgePrompt), true);
eq("composer_carries_the_chase_example", /able to send it over/.test(nudgePrompt), true);
// The prompt is a real string now, so the thread actually reaches the model.
eq("composer_prompt_carries_the_thread", nudgePrompt.includes("another hard inquiry"), true);
eq("composer_prompt_uses_first_name", nudgePrompt.includes("first name is Michael"), true);

// The PROMPT rules moved to domain/humanThreadNudgePrompt.ts (2026-08-21) — assert the string the
// model is actually handed. The runtime backstop that REJECTS a persona intro the model produced
// anyway still lives in llmDraft.ts, so that one stays pinned to this file's source.
eq("composer_bans_persona_intro", /NEVER introduce yourself/.test(nudgePrompt), true);
eq("composer_zero_new_facts_rule", /ZERO new facts/.test(nudgePrompt), true);
eq("composer_persona_backstop_regex", /this is\|my name is/.test(comp) || comp.includes("(this is|my name is|i'?m)"), true);

// --- ADVANCE, NEVER RESTATE (Joe 2026-08-21) --------------------------------------------------
// "The nudge really should not repeat what was already relayed to the customer." Michael Layman
// +15856894382: Scott explained the HDFS 30-day / hard-inquiry rule on 8/18; the bump restated it
// almost sentence for sentence on 8/21. The old prompt CAUSED it — "anchor on the last thing sent"
// plus "zero new facts" left restating as the lowest-effort output satisfying both. Fixed where it
// was caused (the composer), not with a lexical suppressor downstream: measured over all 29 live
// nudge threads, word-overlap cannot separate re-explaining a policy (a defect) from chasing a
// document we already asked for (the lane working) — +17166090270 and +17164728139 are chases and
// would have been silently killed.

// --- THE THREAD IS DATED (William Higgins +17165233086, 2026-08-22) ---------------------------
// On Tue 8/18 he said "I could get there about 3pm if that works" and Scott replied "That should
// work!". On Fri 8/21 this lane drafted "Still good for about 3pm today, William — want me to hold
// it and have paperwork ready when you arrive?" — a three-day-old time asserted as TODAY, on a
// thread with NO appointment on the record. The operator's report was "he mentioned he would be in
// at 3 on the 18th, but the nudge asked if he was good for today at 3."
//
// CAUSE: index.ts had `at` on every anchor and mapped it away, so eight messages spanning four
// days reached the model as one continuous exchange. Identical to the reviewer defect fixed on
// 8/21 (`7ef1cb29`), and worse here — the nudge is the ONE composer that only ever fires after a
// thread has been quiet for days.
//
// ⚠️ WHAT THESE PINS DO AND DO NOT PROVE. They prove the model RECEIVES the dates, the gap and the
// rule. They do not prove what it then writes: replayed against the real anchors (n=12/side, same
// model), asserting a stale time as "today" went 8/12 -> 3/12. That is a large, real reduction and
// NOT an elimination, so no vote is asserted here — an LLM assertion on a 1-in-4 residual would be
// a coin flip that red-lines the gate for everyone (trap 8). The residual is caught downstream by
// the reviewer's own "a day agreed earlier does not carry forward" rule, and staff approve every
// draft. If this regresses, it regresses to 8/12, so the pins below are the guard that matters.
const willAnchors = [
  { direction: "out" as const, body: "Hey Will- we just finished the title and registration paperwork. When did you want to pick up your new bike?", at: "2026-08-18T15:42:23.221Z" },
  { direction: "in" as const, body: "Oh great, I  could get there about 3pm if that works ", at: "2026-08-18T15:52:27.524Z" },
  { direction: "out" as const, body: "That should work!", at: "2026-08-18T15:53:22.267Z" }
];
const WILL_NOW_MS = Date.parse("2026-08-21T15:54:13.676Z"); // the instant the real bad draft was written
const datedPrompt = buildHumanThreadNudgePrompt({ firstName: "William", recentMessages: willAnchors, nowMs: WILL_NOW_MS });

// 1. Every line carries its real date + age, so "about 3pm" has a day attached to it.
eq("nudge_thread_lines_are_stamped", datedPrompt.includes("Customer (Tue, Aug 18, 11:52 AM, 3 days ago): Oh great"), true);
eq("nudge_thread_header_announces_stamps", /each line stamped with when it was sent/.test(datedPrompt), true);
// 2. The GAP is stated up front as a number. Per-line stamps alone measured 2/6 still saying
//    "today"; the vague "quiet a few days ago" opener was doing real damage.
eq("nudge_states_the_gap_up_front", datedPrompt.includes("NOTHING HAS BEEN SAID IN THIS THREAD SINCE 3 DAYS AGO"), true);
// 3. The rule "ZERO new facts" did NOT cover this: the 3pm was genuinely in the thread, only the
//    DAY was invented. A stored time and a stored day are separable and only the time was covered.
eq("nudge_forbids_asserting_a_stale_plan_as_today", /does NOT carry forward to today on its own/.test(datedPrompt), true);
eq("nudge_carries_the_william_counter_example", /the 3pm was days ago; "today" is invented/.test(datedPrompt), true);
// 4. Back-compat: no nowMs ⇒ undated, and none of the dated-only scaffolding appears. Keeps every
//    existing caller and fixture byte-identical rather than half-dating a thread.
const undatedPrompt = buildHumanThreadNudgePrompt({ firstName: "William", recentMessages: willAnchors });
eq("nudge_undated_without_now", undatedPrompt.includes("Customer: Oh great"), true);
eq("nudge_undated_has_no_gap_header", /NOTHING HAS BEEN SAID/.test(undatedPrompt), false);
eq("nudge_undated_has_no_stale_plan_rule", /does NOT carry forward/.test(undatedPrompt), false);

// 5. WIRING — the ratchet cannot prove this and a mapped-away field is exactly how the bug shipped.
//    ONE call site, and it must pass BOTH halves; `at` alone renders a stamp with no "now" to
//    measure against, `nowMs` alone dates nothing.
//    The mapping itself now lives in the domain module, so EXECUTE it rather than grep for it: a
//    source pin on `at: m.at` proves a lambda exists, not that the field survives the trip.
const builtArgs = buildHumanThreadNudgeComposeArgs({
  firstName: "William",
  anchors: [{ direction: "in", body: "Oh great, I  could get there about 3pm if that works ", at: "2026-08-18T15:52:27.524Z" }],
  nowMs: WILL_NOW_MS
});
eq("compose_args_carry_the_timestamp", builtArgs.recentMessages[0].at, "2026-08-18T15:52:27.524Z");
eq("compose_args_carry_now", builtArgs.nowMs, WILL_NOW_MS);
eq("compose_args_normalise_direction", builtArgs.recentMessages.map(m => m.direction), ["in"]);
// A row with no timestamp must degrade to null, never to the string "undefined" (which parses as
// NaN and would render a blank stamp while looking like a real value in a log).
eq("compose_args_missing_at_is_null", buildHumanThreadNudgeComposeArgs({ anchors: [{ direction: "out", body: "hi" }], nowMs: WILL_NOW_MS }).recentMessages[0].at, null);
// The built args are what the lane actually hands the composer — one call site, no inline mapping.
const nudgeComposeCalls = (lane.match(/composeHumanThreadNudgeWithLLM\(/g) ?? []).length;
eq("nudge_compose_call_site_count", nudgeComposeCalls, 1);
const composeArgs = lane.slice(lane.indexOf("const nudgeArgs ="), lane.indexOf("const nudgeText = nudge.text;"));
eq("nudge_lane_uses_the_builder", /buildHumanThreadNudgeComposeArgs\(\{/.test(composeArgs), true);
eq("nudge_lane_passes_now", /\bnowMs:\s*now\.getTime\(\)/.test(composeArgs), true);
eq("nudge_lane_maps_nothing_inline", /recentMessages:/.test(composeArgs), false);
// The lane must route the composition THROUGH the resolver — calling the composer directly is how
// both output invariants get bypassed, and it would look perfectly reasonable in review.
eq("nudge_lane_goes_through_the_resolver", /await resolveHumanThreadNudgeText\(\{/.test(composeArgs), true);
eq("nudge_lane_records_the_suppression_reason", /human_thread_nudge_\$\{nudge\.suppressedReason\}/.test(composeArgs), true);
// The lane may only ADAPT the past-event predicate for the resolver, never branch on it itself:
// one occurrence (the callback), and no `if (referencesPastDatedEvent(...))` statement left behind.
// A guard duplicated in two places is a guard that will drift out of agreement with itself.
eq("nudge_lane_only_adapts_the_past_event_predicate", (lane.match(/referencesPastDatedEvent\(/g) ?? []).length, 1);
eq("nudge_lane_keeps_no_inline_past_event_branch", /if \(referencesPastDatedEvent\(/.test(lane), false);

// 6. TIMEZONE. Measured on the box 2026-08-22: it runs UTC, the dealership does not. Host-local
//    rendering stamps an 11:52 AM ET message as "3:52 PM" and, after 8pm ET, lands it on the WRONG
//    CALENDAR DAY — the very error these stamps exist to prevent. Asserted against a zone far from
//    the test machine's so the assertion fails if the parameter is ever ignored again.
eq("stamp_honours_the_requested_zone", formatThreadLineStamp("2026-08-18T15:52:27.524Z", WILL_NOW_MS, "America/New_York"), " (Tue, Aug 18, 11:52 AM, 3 days ago)");
eq("stamp_zone_is_not_cosmetic", formatThreadLineStamp("2026-08-18T15:52:27.524Z", WILL_NOW_MS, "Asia/Tokyo"), " (Wed, Aug 19, 12:52 AM, 3 days ago)");
eq("stamp_blank_without_a_timestamp", formatThreadLineStamp(null, WILL_NOW_MS, "America/New_York"), "");
// CALENDAR days, not elapsed hours: 20 hours across midnight is "yesterday", never "today".
eq("age_today", describeThreadLineAge(Date.parse("2026-08-21T12:00:00Z"), Date.parse("2026-08-21T23:00:00Z"), "America/New_York"), "today");
eq("age_yesterday_across_midnight_20h", describeThreadLineAge(Date.parse("2026-08-20T23:00:00Z"), Date.parse("2026-08-21T19:00:00Z"), "America/New_York"), "yesterday");
eq("age_counts_calendar_days", describeThreadLineAge(Date.parse("2026-08-18T15:52:00Z"), WILL_NOW_MS, "America/New_York"), "3 days ago");
// The zoned day boundary itself: 00:30Z on 8/22 is still 8/21 in ET, so it is "yesterday" not "today".
eq("age_uses_the_dealer_day_not_utc", describeThreadLineAge(Date.parse("2026-08-22T00:30:00Z"), Date.parse("2026-08-22T18:00:00Z"), "America/New_York"), "yesterday");

// 7. The extraction is BEHAVIOUR-PRESERVING for the reviewer that shipped this renderer on 8/21.
//    Its own eval pins the prompt; this pins the rendered line, because a silent drift here would
//    change a lane nobody in this file is thinking about.
eq(
  "reviewer_line_unchanged_by_extraction",
  renderClaudeReviewThreadLine({ direction: "in", body: "Oh great, I could get there about 3pm if that works", at: "2026-08-18T15:52:27.524Z" }, WILL_NOW_MS),
  `CUSTOMER${formatThreadLineStamp("2026-08-18T15:52:27.524Z", WILL_NOW_MS)}: Oh great, I could get there about 3pm if that works`
);
// No stale private copy left behind — two divergent day-maths is how the next one of these starts.
const reviewSrc = fs.readFileSync(path.join(process.cwd(), "services/api/src/domain/claudeDraftReview.ts"), "utf8");
eq("reviewer_uses_the_shared_stamp", /from "\.\/threadRecency\.js"/.test(reviewSrc), true);
eq("reviewer_kept_no_private_age_helper", /function describeReviewThreadAge/.test(reviewSrc), false);

// --- THE DAY GUARD: what makes the dated-thread fix COMPLETE ------------------------------------
// The prompt above is a large improvement and not a cure: replayed on the real +17165233086
// anchors, n=12/side, asserting a stale time as "today" went 8/12 -> 3/12. A prompt cannot be
// relied on for the last 25%, so the invariant is enforced on the OUTPUT.
//
// WHY IT CAN BE ABSOLUTE: decideHumanThreadNudge refuses to fire when appointmentBookedEventId is
// set ("appointment_booked", asserted in the decision table above). On every thread this lane
// reaches there is therefore NO confirmed appointment, so any day a bump names is a day nobody
// agreed to. No legitimate exception exists — which is what makes this an invariant rather than a
// judgement, and deterministic rather than a parser question. Fail direction is silence, the
// direction pastEventGuard.ts already declares for this lane.
//
// THE FIXTURE IS 24 REAL MODEL OUTPUTS, not invented strings — the exact replies gpt-5-mini
// produced on the live anchors during the 2026-08-22 measurement (12 undated, 12 dated). Written
// with plausible-looking invented wordings this guard would have "passed" and proved nothing.
const NUDGE_OUTPUTS_UNDATED_RUN: [string, boolean][] = [
  ["You still good for 3pm today to pick it up?", true],
  ["Want me to hold it for you at 3pm or should I plan on you possibly coming a bit later if anything changes?", false],
  ["Still good for about 3pm today to pick it up?", true],
  ["You still good for 3pm today to pick it up?", true],
  ["Still good for 3pm today to pick it up?", true],
  ["Want me to hold it for 3pm\u2014need a quick confirmation so I don't promise it to someone else.", false],
  ["Still good for 3pm today to pick it up?", true],
  ["Still good for 3pm today to pick it up?", true],
  ["You still planning to come by around 3pm to pick it up?", false],
  ["Still good for about 3pm today to pick it up? Want me to hold it for you until then?", true],
  ["Planning on the 3pm pickup then \u2014 want me to have the bike warmed up and paperwork ready when you arrive?", false],
  ["You still good for 3pm to pick it up today?", true]
];
const NUDGE_OUTPUTS_DATED_RUN: [string, boolean][] = [
  ["You still good to come by around 3pm? Want me to hold it and have the paperwork ready?", false],
  ["You still good to come by around 3pm today to pick it up, or want to pick a different time?", true],
  ["You still good for about 3pm\u2014want me to hold it and have the paperwork ready when you arrive?", false],
  ["You still good for about 3pm \u2014 want me to have it warmed up and paperwork ready when you arrive?", false],
  ["Still planning on coming around 3pm today to pick it up?", true],
  ["You still good for about 3pm\u2014want me to mark it and have paperwork ready?", false],
  ["Still good for about 3pm\u2014do you want me to hold the bike and have paperwork ready when you arrive?", false],
  ["Want me to hold it for you for that 3pm window, or would you rather me open it up if your plans change?", false],
  ["Still good for about 3pm \u2014 you planning to come by then or want me to hold it a different time?", false],
  ["Want me to hold it for you around 3pm, or should I tee up another time that works better?", false],
  ["You still planning to come by around 3pm today to pick it up, or want to pick a different time?", true],
  ["You still good for about 3pm \u2014 want me to hold it and have paperwork ready when you arrive?", false]
];
for (const [label, rows] of [["undated", NUDGE_OUTPUTS_UNDATED_RUN], ["dated", NUDGE_OUTPUTS_DATED_RUN]] as [string, [string, boolean][]][]) {
  rows.forEach(([text, shouldFlag], i) => {
    eq(`day_guard_${label}_${i}`, nudgeNamesAnUnfoundedDay(text) !== null, shouldFlag);
  });
}
// The measured rates the fix is claimed on, re-derived from the fixture rather than asserted from
// memory. If either moves, the claim in the PR and the commit message is stale.
eq("day_guard_catches_8_of_12_undated", NUDGE_OUTPUTS_UNDATED_RUN.filter(([t]) => nudgeNamesAnUnfoundedDay(t)).length, 8);
eq("day_guard_catches_3_of_12_dated", NUDGE_OUTPUTS_DATED_RUN.filter(([t]) => nudgeNamesAnUnfoundedDay(t)).length, 3);

// A bare clock time is NOT a day — flagging it would suppress the lane working, which is the exact
// over-application that got the ADVANCE-NEVER-RESTATE lexical suppressor rejected.
eq("day_guard_allows_a_bare_time", nudgeNamesAnUnfoundedDay("Still good for about 3pm to pick it up?"), null);
// Every RIGHT example the prompt itself teaches must survive its own guard, including the one that
// contains both "day" and "week" — an open horizon is the CORRECT bump, not a violation.
for (const ok of [
  "Any thoughts since you looked over that dyno sheet? Happy to dig up anything else on the Breakout.",
  "Wanted to circle back on the trike \u2014 still want me to keep that build moving for you?",
  "Been thinking it over? If the trade numbers helped, I can line up a time for you to swing in whenever works.",
  "Still want me to get that application going on our end? Takes me two minutes if you are good with it.",
  "Still need that licence number to run the approval \u2014 able to send it over?",
  "Never did catch up with you on picking it up \u2014 what day works this week?"
]) eq(`day_guard_allows_prompt_right_example_${ok.slice(0, 22)}`, nudgeNamesAnUnfoundedDay(ok), null);
// ...and every shape that IS a day gets named, so the route outcome can say which.
eq("day_guard_names_today", nudgeNamesAnUnfoundedDay("see you today"), "today");
eq("day_guard_names_tomorrow", nudgeNamesAnUnfoundedDay("still on for tomorrow?"), "tomorrow");
eq("day_guard_names_weekday", nudgeNamesAnUnfoundedDay("see you Saturday"), "weekday");
eq("day_guard_names_this_afternoon", nudgeNamesAnUnfoundedDay("stopping by this afternoon?"), "this <part of day>");
eq("day_guard_names_a_date", nudgeNamesAnUnfoundedDay("locked in for Aug 25"), "month + date");
eq("day_guard_names_a_numeric_date", nudgeNamesAnUnfoundedDay("good for 8/25?"), "numeric date");
eq("day_guard_names_an_ordinal", nudgeNamesAnUnfoundedDay("good for the 25th?"), "ordinal date");

// --- THE RESOLVER: bad text NEVER ships, and one retry saves most of the touches ----------------
// Executed, not source-pinned: the whole point is what comes out the far end.
const noPast = () => false;
const resolved1 = await resolveHumanThreadNudgeText({ compose: async () => "Still good for 3pm today?", referencesPastDatedEvent: noPast });
eq("resolver_suppresses_when_both_attempts_name_a_day", resolved1, { text: null, suppressedReason: "day_reference_suppressed" });
let calls = 0;
const resolved2 = await resolveHumanThreadNudgeText({
  compose: async retry => { calls++; return retry ? "What day works this week?" : "Still good for 3pm today?"; },
  referencesPastDatedEvent: noPast
});
eq("resolver_retries_once_and_keeps_the_clean_retry", resolved2, { text: "What day works this week?", suppressedReason: null });
eq("resolver_retried_exactly_once", calls, 2);
// The retry must be TOLD what was rejected, or it is just a second roll of the same dice.
let sawRetryArg: string | undefined;
await resolveHumanThreadNudgeText({
  compose: async retry => { sawRetryArg = retry; return retry ? "what day works?" : "see you Saturday"; },
  referencesPastDatedEvent: noPast
});
eq("resolver_tells_the_retry_what_was_rejected", sawRetryArg, "weekday");
// A clean first attempt costs exactly one call — no gratuitous second LLM round-trip.
let cleanCalls = 0;
const resolved3 = await resolveHumanThreadNudgeText({
  compose: async () => { cleanCalls++; return "Any thoughts on that dyno sheet?"; },
  referencesPastDatedEvent: noPast
});
eq("resolver_single_call_on_a_clean_first_attempt", [resolved3.text, cleanCalls], ["Any thoughts on that dyno sheet?", 1]);
// The past-dated-event invariant moved in here from index.ts and must still bite, with its own reason.
const resolved4 = await resolveHumanThreadNudgeText({ compose: async () => "see you at the party", referencesPastDatedEvent: () => true });
eq("resolver_keeps_the_past_event_invariant", resolved4, { text: null, suppressedReason: "past_event_suppressed" });
// The retry prompt names the rejected word rather than repeating the rule louder.
const retryPrompt = buildHumanThreadNudgePrompt({ firstName: "William", recentMessages: willAnchors, nowMs: WILL_NOW_MS, retryAfterDayReference: "today" });
eq("retry_prompt_names_the_rejected_reference", /RETRY \u2014 your previous attempt was REJECTED for naming a day \(today\)/.test(retryPrompt), true);
eq("first_attempt_prompt_has_no_retry_block", /RETRY \u2014 your previous attempt/.test(datedPrompt), false);

if (failures.length) {
  console.error("FAIL human_thread_nudge eval:");
  for (const f of failures) console.error(f);
  process.exit(1);
}
console.log(
  "PASS human_thread_nudge eval — decision table incl. manual-handoff widening + Zackary/Spence production pins, env defaults (LIVE draft mode, kill switch =0; autosend dark), tick-lane + composer voice-continuity pins, the ADVANCE-NEVER-RESTATE rule + its live counter-example (Joe 8/21, Michael Layman), restatement guard executed on the Warren/Igor pairs, dated-thread stamps + zoned recency helpers + the William Higgins stale-plan rule and its call-site wiring, the day-reference invariant validated on 24 real model outputs, and the retry-then-suppress resolver executed"
);
