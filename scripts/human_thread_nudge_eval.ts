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
  HUMAN_THREAD_NUDGE_MAX_QUIET_DAYS_DEFAULT
} from "../services/api/src/domain/humanThreadNudge.ts";

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
const lane = laneIdx >= 0 ? idx.slice(laneIdx, laneIdx + 5200) : "";
eq("tick_lane_exists_flag_gated", laneIdx >= 0, true);
// The lane's pre-filter is the SHARED eligible-class helper, not a restatement that can drift from
// the pure decision's first branch.
eq("lane_widened_to_manual_handoff", /if \(!isHumanThreadNudgeEligibleClass\(\(conv as any\)\.mode, conv\.followUp\?\.mode\)\) continue;/.test(lane), true);
eq("lane_passes_followUpMode", /followUpMode: conv\.followUp\?\.mode \?\? null/.test(lane), true);
// Without the reason the decision cannot tell an apparel handoff from a sales handoff (Narendra).
eq("lane_passes_followUpReason", /followUpReason: conv\.followUp\?\.reason \?\? null/.test(lane), true);
eq("lane_calls_pure_decision", /decideHumanThreadNudge\(\{/.test(lane), true);
eq("lane_composes_via_llm", /composeHumanThreadNudgeWithLLM\(\{/.test(lane), true);
eq("draft_mode_lands_in_queue", /appendOutbound\(conv, "salesperson", nudgeTo, nudgeMessage, "draft_ai"\)/.test(lane), true);
eq("autosend_behind_second_flag", /if \(isHumanThreadNudgeAutosendEnabled\(\)\) \{/.test(lane), true);
eq("ledger_records_count_and_lastAt", /conv\.humanThreadNudge = \{\s*\n\s*count: \(conv\.humanThreadNudge\?\.count \?\? 0\) \+ 1,\s*\n\s*lastAt: nowIso\(\)/.test(lane), true);
eq("duplicate_guard_present", /isRecentDuplicateOutbound\(conv, nudgeTo, nudgeMessage/.test(lane), true);

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
  "PASS human_thread_nudge eval — decision table incl. manual-handoff widening + Zackary/Spence production pins, env defaults (LIVE draft mode, kill switch =0; autosend dark), tick-lane + composer voice-continuity pins"
);
