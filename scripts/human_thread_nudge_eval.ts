/**
 * human_thread_nudge:eval — pins the human-owned-thread quiet nudge (Joe 2026-07-20: "as hands off
 * as possible", DRAFT MODE FIRST).
 *
 * 1. decideHumanThreadNudge decision-table: fires ONLY on a human-mode thread whose last delivered
 *    message is a HUMAN outbound that has sat quiet >= N days — and never over an unanswered
 *    customer message, a dated staff promise, a pending draft, opt-out, closed, call-only, a booked
 *    appointment, the cap, or unspaced repeats.
 * 2. Env helpers: dark by default; autosend separately dark; Number("") guards on the day knobs.
 * 3. Source pins: the tick lane is flag-gated, drafts land as draft_ai (suggest queue), autosend is
 *    behind the SECOND flag only, the ledger records count+lastAt, and the composer refuses persona
 *    intros (voice continuity).
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
eq("feature_dark_by_default", isHumanThreadNudgeEnabled(), false);
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
  suppressed: false,
  conversationStatus: "open",
  contactPreference: null as string | null,
  appointmentBookedEventId: null as string | null,
  hasPendingDraft: false,
  lastMessageDirection: "out" as const,
  lastMessageAtMs: NOW - 4 * DAY,
  lastOutboundWasHuman: true,
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
eq("not_human_mode_no", D({ ...base, conversationMode: "suggest" }), { nudge: false, reason: "not_human_mode" });
eq("suppressed_no", D({ ...base, suppressed: true }).nudge, false);
eq("closed_no", D({ ...base, conversationStatus: "closed" }).nudge, false);
eq("call_only_no", D({ ...base, contactPreference: "call_only" }).nudge, false);
eq("appointment_no", D({ ...base, appointmentBookedEventId: "evt_1" }).nudge, false);
eq("pending_draft_no", D({ ...base, hasPendingDraft: true }).nudge, false);
eq("unanswered_customer_msg_no", D({ ...base, lastMessageDirection: "in" }), { nudge: false, reason: "owner_reply_needed" });
eq("agent_last_outbound_no", D({ ...base, lastOutboundWasHuman: false }), { nudge: false, reason: "no_human_outbound" });
eq("staff_promise_defers", D({ ...base, hasOpenFutureDatedTodo: true }), { nudge: false, reason: "staff_promise_pending" });
eq("not_quiet_enough_no", D({ ...base, lastMessageAtMs: NOW - 2 * DAY }), { nudge: false, reason: "not_quiet_long_enough" });
eq("cap_reached_no", D({ ...base, nudgeCount: 2 }), { nudge: false, reason: "cap_reached" });
eq("second_nudge_needs_spacing", D({ ...base, nudgeCount: 1, lastNudgeAtMs: NOW - 3 * DAY }), { nudge: false, reason: "spacing_not_elapsed" });
eq("second_nudge_after_spacing_fires", D({ ...base, nudgeCount: 1, lastNudgeAtMs: NOW - 6 * DAY, lastMessageAtMs: NOW - 6 * DAY }).nudge, true);
eq("no_anchor_no", D({ ...base, lastMessageAtMs: NaN }), { nudge: false, reason: "no_message_anchor" });

// --- source pins -------------------------------------------------------------
const idx = fs.readFileSync(path.join(process.cwd(), "services/api/src/index.ts"), "utf8");
const laneIdx = idx.indexOf("if (isHumanThreadNudgeEnabled()) {");
const lane = laneIdx >= 0 ? idx.slice(laneIdx, laneIdx + 5200) : "";
eq("tick_lane_exists_flag_gated", laneIdx >= 0, true);
eq("lane_calls_pure_decision", /decideHumanThreadNudge\(\{/.test(lane), true);
eq("lane_composes_via_llm", /composeHumanThreadNudgeWithLLM\(\{/.test(lane), true);
eq("draft_mode_lands_in_queue", /appendOutbound\(conv, "salesperson", nudgeTo, nudgeMessage, "draft_ai"\)/.test(lane), true);
eq("autosend_behind_second_flag", /if \(isHumanThreadNudgeAutosendEnabled\(\)\) \{/.test(lane), true);
eq("ledger_records_count_and_lastAt", /conv\.humanThreadNudge = \{\s*\n\s*count: \(conv\.humanThreadNudge\?\.count \?\? 0\) \+ 1,\s*\n\s*lastAt: nowIso\(\)/.test(lane), true);
eq("duplicate_guard_present", /isRecentDuplicateOutbound\(conv, nudgeTo, nudgeMessage/.test(lane), true);

const llm = fs.readFileSync(path.join(process.cwd(), "services/api/src/domain/llmDraft.ts"), "utf8");
const compIdx = llm.indexOf("export async function composeHumanThreadNudgeWithLLM");
const comp = compIdx >= 0 ? llm.slice(compIdx, compIdx + 4200) : "";
eq("composer_default_off", /HUMAN_THREAD_NUDGE_ENABLED \?\? "0"/.test(comp), true);
eq("composer_bans_persona_intro", /NEVER introduce yourself/.test(comp), true);
eq("composer_persona_backstop_regex", /this is\|my name is/.test(comp) || comp.includes("(this is|my name is|i'?m)"), true);
eq("composer_zero_new_facts_rule", /ZERO new facts/.test(comp), true);

if (failures.length) {
  console.error("FAIL human_thread_nudge eval:");
  for (const f of failures) console.error(f);
  process.exit(1);
}
console.log(
  "PASS human_thread_nudge eval — 15-case decision table, env defaults (dark; autosend separately dark), tick-lane + composer voice-continuity pins"
);
