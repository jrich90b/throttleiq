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
  HUMAN_THREAD_NUDGE_MIN_ANCHOR_CHARS
} from "../services/api/src/domain/humanThreadNudge.ts";
import { isThreadParkedOnInventoryPromise } from "../services/api/src/domain/conversationStore.ts";
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
eq("lane_composes_via_llm", /composeHumanThreadNudgeWithLLM\(\{/.test(lane), true);
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
eq("lane_checks_restatement_after_compose", restateIdx > lane.indexOf("await composeHumanThreadNudgeWithLLM("), true);
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
const composeIdx = lane.indexOf("await composeHumanThreadNudgeWithLLM(");
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
const comp = compIdx >= 0 ? llm.slice(compIdx, compIdx + 4200) : "";
eq("composer_default_on_kill_switch_zero", /HUMAN_THREAD_NUDGE_ENABLED \?\? "1"/.test(comp), true);
eq("composer_bans_persona_intro", /NEVER introduce yourself/.test(comp), true);
eq("composer_persona_backstop_regex", /this is\|my name is/.test(comp) || comp.includes("(this is|my name is|i'?m)"), true);
eq("composer_zero_new_facts_rule", /ZERO new facts/.test(comp), true);

if (failures.length) {
  console.error("FAIL human_thread_nudge eval:");
  for (const f of failures) console.error(f);
  process.exit(1);
}
console.log(
  "PASS human_thread_nudge eval — decision table incl. manual-handoff widening + Zackary/Spence production pins, env defaults (LIVE draft mode, kill switch =0; autosend dark), tick-lane + composer voice-continuity pins, restatement guard executed on the Warren/Igor pairs"
);
