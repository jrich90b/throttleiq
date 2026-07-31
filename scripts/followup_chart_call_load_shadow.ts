/**
 * SHADOW PRICING — what does the wall-chart follow-up cadence actually cost in phone calls?
 *
 * READ-ONLY. Changes no behavior, writes no store. Answers ONE question for Joe (7/31):
 * with his ruling in force — "if there is engagement it should not make call tasks; only
 * after there is no engagement" — how many call tasks per day would the printed
 * "FOLLOW UP CADENCE" chart put on the sales team?
 *
 * The chart (memory `followup-cadence-wall-chart`): touch days 1,2,3,5,7,10,14,18,21,27,30.
 * The agent owns text+email on those days; the SALESPERSON owns only the phone call.
 *
 * Simulation rules (Joe's rulings, `joe-rulings-7-31-decision-queue`):
 *  - A lead that has NEVER engaged runs the chart. Each chart day = one call task.
 *  - The chart STOPS the moment the customer first engages (engagement suppresses call
 *    tasks entirely) — or when the lead closes / opts out.
 *  - An ENGAGED lead gets no chart calls; it gets re-engagement calls at the 3-quiet-day
 *    rule instead, re-armed only by a new customer message.
 *
 * "Engagement" here is deliberately STRUCTURAL, not a comprehension judgement — this
 * prices volume, it does not decide behavior. It reuses the repo's own eval-pinned
 * exclusions so the count matches how the system already reasons about inbound:
 * a lead-intake (ADF/widget) payload, an automated sender, and an iOS tapback echo are
 * NOT customer replies. Excluding them makes engagement RARER, which makes the call
 * estimate HIGHER — i.e. the estimate errs toward over-stating the load, never under.
 *
 * Usage (on the box, where the data lives):
 *   CONVERSATIONS_DB_PATH=/home/ubuntu/leadrider-runtime/americanharley/data/conversations.json \
 *   npx tsx scripts/followup_chart_call_load_shadow.ts [--days 90]
 */

import fs from "node:fs";
import {
  isAutomatedSenderInbound,
  isQuotedReactionEchoInbound,
  isOptOutKeywordInbound
} from "../services/api/src/domain/scoringExclusions.js";

const CHART_DAYS = [1, 2, 3, 5, 7, 10, 14, 18, 21, 27, 30];
const QUIET_DAYS_FOR_CALL = 3; // Joe 7/31: "3 days should be a call"
const DAY_MS = 86_400_000;
const TZ_OFFSET_HOURS = -4; // America/New_York (EDT). Day-bucketing only; volume is insensitive to this.

// A structured lead-intake payload (ADF / web widget) is a SYSTEM re-sync, not a customer
// reply. Mirrors LEAD_INTAKE_MARKER_RE + LEAD_INTAKE_FIELD_RE in scoringExclusions.ts
// (both a marker AND a structured field required, so a customer merely saying "adf" can't match).
const LEAD_INTAKE_MARKER_RE = /(PHONE LOG \(ADF\)|WEB LEAD \(ADF\)|WEB TEXT WIDGET|\(ADF\))/i;
const LEAD_INTAKE_FIELD_RE = /\b(Source|Ref|Inquiry|Vehicle|Department|PreQual|Lead|Page|URL)\s*:/i;

function isLeadIntakePayload(body: string): boolean {
  return LEAD_INTAKE_MARKER_RE.test(body) && LEAD_INTAKE_FIELD_RE.test(body);
}

type Msg = { direction?: string; from?: string; body?: string; at?: string };
type Conv = {
  id: string;
  createdAt?: string;
  closedAt?: string;
  closedReason?: string;
  messages?: Msg[];
  leadOwner?: { id?: string; name?: string };
  followUp?: { mode?: string; reason?: string; updatedAt?: string };
  followUpCadence?: { stopReason?: string };
  appointment?: { bookedEventId?: string; bookedAt?: string; startAt?: string };
};

/**
 * Joe, 2026-07-31: "Watches should stop the cadence too, or if we tell them when a bike
 * should be coming in." Generalized: a KNOWN NEXT EVENT replaces the generic timetable —
 * the event is the cadence. These are the states that carry one.
 */
const KNOWN_NEXT_EVENT_MODES = new Set(["holding_inventory", "manual_handoff", "paused_indefinite"]);
const KNOWN_NEXT_EVENT_REASONS = new Set([
  "inventory_watch", // customer waiting on a watched bike
  "order_hold", // we told them a bike is on order
  "unit_hold", // a unit is being held for them
  "appointment_hold",
  "post_sale"
]);

/**
 * When this lead acquired a known next event, or Infinity if it never did. Uses
 * `followUp.updatedAt` — the last time the state changed — so suppression starts at that
 * moment rather than being credited retroactively over the lead's whole life. If the state
 * changed more than once, this is the LATEST change, so the chart is allowed to run longer
 * than it truly should: the estimate errs toward MORE calls, never fewer.
 */
function knownNextEventAt(c: Conv): number {
  const candidates: number[] = [];
  const mode = String(c?.followUp?.mode ?? "").trim();
  const reason = String(c?.followUp?.reason ?? "").trim();
  const stopReason = String(c?.followUpCadence?.stopReason ?? "").trim();
  if (
    KNOWN_NEXT_EVENT_MODES.has(mode) ||
    KNOWN_NEXT_EVENT_REASONS.has(reason) ||
    KNOWN_NEXT_EVENT_REASONS.has(stopReason)
  ) {
    const at = Date.parse(String(c?.followUp?.updatedAt ?? ""));
    if (Number.isFinite(at)) candidates.push(at);
  }
  if (c?.appointment?.bookedEventId) {
    const at = Date.parse(String(c.appointment.bookedAt ?? c.appointment.startAt ?? c?.followUp?.updatedAt ?? ""));
    if (Number.isFinite(at)) candidates.push(at);
  }
  return candidates.length ? Math.min(...candidates) : Infinity;
}

/** A real customer-authored reply — the thing that counts as engagement. */
function isCustomerReply(m: Msg, convId: string): boolean {
  if (String(m?.direction ?? "") !== "in") return false;
  const body = String(m?.body ?? "").trim();
  if (!body) return false;
  if (isLeadIntakePayload(body)) return false;
  if (isAutomatedSenderInbound({ from: m.from, body, convId })) return false;
  if (isQuotedReactionEchoInbound(body)) return false;
  return true;
}

function localDateKey(ms: number): string {
  return new Date(ms + TZ_OFFSET_HOURS * 3600_000).toISOString().slice(0, 10);
}

/** Store-closed approximation: no call task lands on a Sunday. */
function isStoreClosed(ms: number): boolean {
  return new Date(ms + TZ_OFFSET_HOURS * 3600_000).getUTCDay() === 0;
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function main() {
  const dbPath =
    process.env.CONVERSATIONS_DB_PATH ||
    "/home/ubuntu/leadrider-runtime/americanharley/data/conversations.json";
  const argIdx = process.argv.indexOf("--days");
  const windowDays = argIdx > -1 ? Number(process.argv[argIdx + 1]) || 90 : 90;

  const raw = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const convs: Conv[] = Array.isArray(raw.conversations)
    ? raw.conversations
    : Object.values(raw.conversations || {});
  const todosRaw = Array.isArray(raw.todos) ? raw.todos : Object.values(raw.todos || {});

  const now = Date.now();
  const windowStart = now - windowDays * DAY_MS;

  // Scenario A = the chart as printed (call on every touch day, including day 1).
  // Scenario B = the chart with Joe's 3-quiet-day floor (no call before day 3).
  const callsA: Record<string, number> = {};
  const callsB: Record<string, number> = {};
  const callsC: Record<string, number> = {};
  const reengageCalls: Record<string, number> = {};
  const reengageCallsC: Record<string, number> = {};
  const byOwnerA: Record<string, number> = {};
  const byOwnerB: Record<string, number> = {};
  const byOwnerC: Record<string, number> = {};

  let leadsInWindow = 0;
  let neverEngaged = 0;
  let engaged = 0;
  let optedOut = 0;
  let withKnownEvent = 0;
  let chartCallsA = 0;
  let chartCallsB = 0;
  let chartCallsC = 0;
  let reCalls = 0;
  let reCallsC = 0;
  const reCallsPerLead: number[] = [];

  for (const c of convs) {
    const created = Date.parse(String(c?.createdAt ?? ""));
    if (!Number.isFinite(created) || created < windowStart) continue;
    leadsInWindow += 1;

    const owner = String(c?.leadOwner?.name ?? "(unassigned)");
    const msgs = [...(c.messages ?? [])]
      .filter(m => Number.isFinite(Date.parse(String(m?.at ?? ""))))
      .sort((a, b) => Date.parse(String(a.at)) - Date.parse(String(b.at)));

    const replies = msgs.filter(m => isCustomerReply(m, c.id));
    const optOut = msgs.find(m => String(m?.direction) === "in" && isOptOutKeywordInbound(String(m?.body ?? "")));
    const optOutAt = optOut ? Date.parse(String(optOut.at)) : Infinity;
    if (optOut) optedOut += 1;

    const closedAt = Number.isFinite(Date.parse(String(c?.closedAt ?? ""))) ? Date.parse(String(c!.closedAt)) : Infinity;
    const firstEngagementAt = replies.length ? Date.parse(String(replies[0].at)) : Infinity;

    // The chart runs only while the lead is unengaged, open, and not opted out.
    const chartEndsAt = Math.min(firstEngagementAt, closedAt, optOutAt, now);
    // Scenario C additionally stops it at a known next event (watch / ETA / appointment / handoff).
    const eventAt = knownNextEventAt(c);
    if (Number.isFinite(eventAt)) withKnownEvent += 1;
    const chartEndsAtC = Math.min(chartEndsAt, eventAt);

    if (!replies.length) neverEngaged += 1;
    else engaged += 1;

    for (const d of CHART_DAYS) {
      const at = created + d * DAY_MS;
      if (at > chartEndsAt) break;
      if (isStoreClosed(at)) continue;
      const key = localDateKey(at);
      callsA[key] = (callsA[key] ?? 0) + 1;
      byOwnerA[owner] = (byOwnerA[owner] ?? 0) + 1;
      chartCallsA += 1;
      if (d >= QUIET_DAYS_FOR_CALL) {
        callsB[key] = (callsB[key] ?? 0) + 1;
        byOwnerB[owner] = (byOwnerB[owner] ?? 0) + 1;
        chartCallsB += 1;
        if (at <= chartEndsAtC) {
          callsC[key] = (callsC[key] ?? 0) + 1;
          byOwnerC[owner] = (byOwnerC[owner] ?? 0) + 1;
          chartCallsC += 1;
        }
      }
    }

    // Re-engagement ladder: an ENGAGED lead that goes quiet 3+ days earns ONE call,
    // re-armed only by a further customer message.
    if (replies.length) {
      let perLead = 0;
      for (let i = 0; i < replies.length; i += 1) {
        const at = Date.parse(String(replies[i].at));
        const nextReplyAt = i + 1 < replies.length ? Date.parse(String(replies[i + 1].at)) : Infinity;
        const callAt = at + QUIET_DAYS_FOR_CALL * DAY_MS;
        if (callAt >= Math.min(nextReplyAt, closedAt, optOutAt, now)) continue;
        if (isStoreClosed(callAt)) continue;
        const key = localDateKey(callAt);
        reengageCalls[key] = (reengageCalls[key] ?? 0) + 1;
        reCalls += 1;
        perLead += 1;
        // A known next event silences the re-engagement call too — same principle.
        if (callAt < eventAt) {
          reengageCallsC[key] = (reengageCallsC[key] ?? 0) + 1;
          reCallsC += 1;
        }
      }
      if (perLead) reCallsPerLead.push(perLead);
    }
  }

  // What actually happens today, same window: call tasks really created.
  const actualByDay: Record<string, number> = {};
  let actualTotal = 0;
  for (const t of todosRaw as any[]) {
    const at = Date.parse(String(t?.createdAt ?? ""));
    if (!Number.isFinite(at) || at < windowStart) continue;
    if (String(t?.reason ?? "") !== "call") continue;
    const key = localDateKey(at);
    actualByDay[key] = (actualByDay[key] ?? 0) + 1;
    actualTotal += 1;
  }

  const spanDays = Math.max(1, Math.round((now - windowStart) / DAY_MS));
  const summarize = (m: Record<string, number>, label: string) => {
    const vals: number[] = [];
    for (let i = 0; i < spanDays; i += 1) vals.push(m[localDateKey(windowStart + i * DAY_MS)] ?? 0);
    const sorted = [...vals].sort((a, b) => a - b);
    const total = vals.reduce((s, v) => s + v, 0);
    console.log(
      `  ${label.padEnd(34)} total=${String(total).padStart(5)}  per-day avg=${(total / spanDays).toFixed(
        1
      )}  median=${pct(sorted, 50)}  p90=${pct(sorted, 90)}  max=${sorted[sorted.length - 1] ?? 0}`
    );
  };

  console.log(`\n=== WALL-CHART CALL LOAD — shadow pricing (last ${windowDays} days) ===`);
  console.log(`\nLeads in window: ${leadsInWindow}`);
  console.log(`  never engaged (chart runs):   ${neverEngaged}  (${((neverEngaged / leadsInWindow) * 100).toFixed(0)}%)`);
  console.log(`  engaged (chart suppressed):   ${engaged}  (${((engaged / leadsInWindow) * 100).toFixed(0)}%)`);
  console.log(`  opted out:                    ${optedOut}`);
  console.log(`  have a KNOWN NEXT EVENT:      ${withKnownEvent}  (watch / ETA / appt / handoff)`);

  console.log(`\nCALL TASKS PER DAY:`);
  summarize(actualByDay, "TODAY (actual call tasks)");
  summarize(callsA, "A: chart as printed (day 1+)");
  summarize(callsB, "B: chart w/ 3-day floor");
  summarize(callsC, "C: B + known-next-event stops it");
  summarize(reengageCalls, "re-engagement (3-day quiet)");
  summarize(reengageCallsC, "re-engagement, event-suppressed");
  const combinedB: Record<string, number> = { ...reengageCalls };
  for (const [k, v] of Object.entries(callsB)) combinedB[k] = (combinedB[k] ?? 0) + v;
  summarize(combinedB, "TOTAL: B + re-engage");
  const combinedC: Record<string, number> = { ...reengageCallsC };
  for (const [k, v] of Object.entries(callsC)) combinedC[k] = (combinedC[k] ?? 0) + v;
  summarize(combinedC, "TOTAL: C + re-engage  <== ship this");
  console.log(`\n  (C removes ${chartCallsB - chartCallsC} chart calls and ${reCalls - reCallsC} re-engagement calls vs B)`);

  console.log(`\nChart calls that never fire because the lead engaged first: ${
    neverEngaged + engaged > 0 ? `${engaged} leads exited the chart early` : "n/a"
  }`);
  console.log(`Avg chart calls per never-engaged lead (A): ${(chartCallsA / Math.max(1, neverEngaged)).toFixed(1)} of ${CHART_DAYS.length}`);
  console.log(`Avg chart calls per never-engaged lead (B): ${(chartCallsB / Math.max(1, neverEngaged)).toFixed(1)}`);

  const reSorted = [...reCallsPerLead].sort((a, b) => a - b);
  console.log(`\nRe-engagement calls: ${reCalls} across ${reCallsPerLead.length} leads` +
    (reSorted.length ? `  (median ${pct(reSorted, 50)}/lead, p90 ${pct(reSorted, 90)}, max ${reSorted[reSorted.length - 1]})` : ""));
  console.log(`Leads that would take >3 re-engagement calls: ${reCallsPerLead.filter(n => n > 3).length}`);

  console.log(`\nPER-OWNER (scenario C chart calls, whole window):`);
  for (const [o, n] of Object.entries(byOwnerC).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${o.padEnd(24)} ${String(n).padStart(4)}   (~${(n / spanDays).toFixed(1)}/day)`);
  }
  console.log("");
}

main();
