/**
 * human_thread_nudge:eval — pins the quiet-thread nudge (Joe 2026-07-20: "as hands off as
 * possible"; Joe 2026-07-23 ruling: LIVE in draft mode + widened to manual-handoff threads).
 *
 * 1. decideHumanThreadNudge decision-table: fires ONLY on a human-owned (mode=human) OR handed-off
 *    (followUp.mode=manual_handoff) thread whose last delivered message is an outbound that has sat
 *    quiet >= N days — and never over an unanswered customer message, a dated staff promise, a
 *    pending draft, opt-out, closed, call-only, a booked appointment, the cap (2/thread), or
 *    unspaced repeats. Production pins: Zackary +17165985414 (human mode, last outbound was an
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
  humanThreadNudgeSpacingDays
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
eq("second_nudge_needs_spacing", D({ ...base, nudgeCount: 1, lastNudgeAtMs: NOW - 3 * DAY }), { nudge: false, reason: "spacing_not_elapsed" });
eq("second_nudge_after_spacing_fires", D({ ...base, nudgeCount: 1, lastNudgeAtMs: NOW - 6 * DAY, lastMessageAtMs: NOW - 6 * DAY }).nudge, true);
eq("no_anchor_no", D({ ...base, lastMessageAtMs: NaN }), { nudge: false, reason: "no_message_anchor" });

// --- source pins -------------------------------------------------------------
const idx = fs.readFileSync(path.join(process.cwd(), "services/api/src/index.ts"), "utf8");
const laneIdx = idx.indexOf("if (isHumanThreadNudgeEnabled()) {");
const lane = laneIdx >= 0 ? idx.slice(laneIdx, laneIdx + 5200) : "";
eq("tick_lane_exists_flag_gated", laneIdx >= 0, true);
eq("lane_widened_to_manual_handoff", /nudgeConvMode !== "human" && nudgeFollowUpMode !== "manual_handoff"/.test(lane), true);
eq("lane_passes_followUpMode", /followUpMode: conv\.followUp\?\.mode \?\? null/.test(lane), true);
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
