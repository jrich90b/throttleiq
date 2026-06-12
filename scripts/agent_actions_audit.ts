/**
 * Agent actions audit — nightly grading of the agent's DEEDS, not its words
 * (Joe, 2026-06-11: "vehicle watches, to-dos and other deterministic actions
 * should be checked and graded as well").
 *
 * The voice/tone reports only read outbound text, so a lead silently parked
 * until 2027 by a date-parse bug never showed up anywhere (Dominik Roehre /
 * Nicholas Maly, 2026-06-11). This audit reads conversation STATE and flags
 * structurally broken actions. Read-only over the conversation store.
 *
 * Checks (graded counts use recency windows so legacy debt ages out of the
 * gate but still appears in totals):
 *   cadence_far_future        active cadence parked way beyond the lead's
 *                             stated buying timeframe (the 2027 class)
 *   cadence_stalled           active cadence whose nextDueAt is in the past —
 *                             the scheduler should have fired or re-bumped
 *   watch_orphaned            active inventory watch on a closed conversation
 *   appointment_outcome_missing  booked/confirmed appointment days in the
 *                             past with no staff outcome recorded
 *   draft_unactioned          open conversation whose newest message is a
 *                             pending AI draft staff never sent or replaced
 *
 * Usage:
 *   npx tsx scripts/agent_actions_audit.ts [--store PATH] [--out-dir DIR]
 *   npx tsx scripts/agent_actions_audit.ts --self-test
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type AnyObj = Record<string, any>;

type Offender = {
  convId: string;
  name: string;
  evidence: string;
  recent: boolean;
};

type CheckResult = {
  check: string;
  total: number;
  recent: number;
  offenders: Offender[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

function num(input: unknown, fallback = 0): number {
  const n = Number(input);
  return Number.isFinite(n) ? n : fallback;
}

function parseMs(input: unknown): number | null {
  const ms = Date.parse(String(input ?? ""));
  return Number.isFinite(ms) ? ms : null;
}

function leadName(conv: AnyObj): string {
  const lead = conv?.lead ?? {};
  return (
    [String(lead?.firstName ?? "").trim(), String(lead?.lastName ?? "").trim()]
      .filter(Boolean)
      .join(" ") || String(conv?.id ?? "")
  );
}

/** A stated long timeframe ("7-12 Months", "Over 1 Year", "next spring") justifies a far-future date. */
export function timeframeJustifiesMonths(raw: unknown): number {
  const text = String(raw ?? "").toLowerCase();
  if (!text.trim()) return 0;
  if (/over\s*(a|1|one)\s*year/.test(text) || /\b1\+?\s*year/.test(text)) return 12;
  const range = text.match(/(\d+)\s*[-–to]+\s*(\d+)\s*month/);
  if (range) return Math.max(num(range[1]), num(range[2]));
  const single = text.match(/(\d+)\s*month/);
  if (single) return num(single[1]);
  if (/\b(next\s+)?(spring|summer|fall|autumn|winter|season|year)\b/.test(text)) return 12;
  return 0;
}

export function auditConversations(
  conversations: AnyObj[],
  opts: { nowMs?: number; openTodoConvIds?: Set<string> } = {}
): CheckResult[] {
  const nowMs = opts.nowMs ?? Date.now();
  const openTodoConvIds = opts.openTodoConvIds ?? new Set<string>();
  const farFuture: Offender[] = [];
  const stalled: Offender[] = [];
  const watchOrphans: Offender[] = [];
  const apptMissing: Offender[] = [];
  const draftUnactioned: Offender[] = [];

  for (const conv of conversations ?? []) {
    if (!conv?.id) continue;
    const open = conv.status !== "closed";
    const cadence = conv.followUpCadence ?? null;
    const isPostSale = String(cadence?.kind ?? "") === "post_sale";

    if (open && cadence?.status === "active" && !isPostSale) {
      const dueMs = parseMs(cadence.nextDueAt);
      if (dueMs != null) {
        // Far-future park: due >90d out without a stated timeframe that covers it.
        const daysOut = (dueMs - nowMs) / DAY_MS;
        const justifiedMonths = timeframeJustifiesMonths(conv?.lead?.purchaseTimeframe);
        const justifiedDays = justifiedMonths * 31 + 45; // stated window + grace
        if (daysOut > 90 && daysOut > justifiedDays) {
          const touchedMs =
            parseMs(cadence.contextTagUpdatedAt) ?? parseMs(cadence.anchorAt) ?? parseMs(conv.updatedAt);
          farFuture.push({
            convId: String(conv.id),
            name: leadName(conv),
            evidence: `nextDueAt ${cadence.nextDueAt} (${Math.round(daysOut)}d out, stated timeframe: ${
              String(conv?.lead?.purchaseTimeframe ?? "").trim() || "none"
            })`,
            recent: touchedMs != null && nowMs - touchedMs <= 7 * DAY_MS
          });
        }
        // Stalled: due in the past beyond the scheduler's normal catch-up.
        // Holds, handoffs, and open staff todos intentionally park the
        // cadence (the scheduler skips them by design) — those are staff
        // queues, not scheduler failures.
        const followUpMode = String(conv?.followUp?.mode ?? "").trim().toLowerCase();
        const intentionallyParked =
          followUpMode === "holding_inventory" ||
          followUpMode === "manual_handoff" ||
          followUpMode === "paused_indefinite" ||
          openTodoConvIds.has(String(conv.id));
        const daysLate = (nowMs - dueMs) / DAY_MS;
        if (daysLate > 2 && !intentionallyParked) {
          stalled.push({
            convId: String(conv.id),
            name: leadName(conv),
            evidence: `nextDueAt ${cadence.nextDueAt} is ${Math.round(daysLate)}d overdue`,
            recent: daysLate <= 14
          });
        }
      }
    }

    const watches: AnyObj[] = [
      ...(Array.isArray(conv.inventoryWatches) ? conv.inventoryWatches : []),
      ...(conv.inventoryWatch ? [conv.inventoryWatch] : [])
    ].filter(w => String(w?.status ?? "active") === "active");
    if (!open && watches.length) {
      const closedMs = parseMs(conv.closedAt);
      watchOrphans.push({
        convId: String(conv.id),
        name: leadName(conv),
        evidence: `${watches.length} active watch(es) on a conversation closed ${conv.closedAt ?? "(unknown)"}`,
        recent: closedMs != null && nowMs - closedMs <= 14 * DAY_MS
      });
    }

    const appt = conv.appointment ?? null;
    const apptStatus = String(appt?.status ?? "");
    if ((apptStatus === "booked" || apptStatus === "confirmed") && !appt?.staffNotify?.outcome?.note) {
      const startMs = parseMs(appt?.matchedSlot?.start ?? appt?.start);
      if (startMs != null && nowMs - startMs > 3 * DAY_MS) {
        apptMissing.push({
          convId: String(conv.id),
          name: leadName(conv),
          evidence: `${apptStatus} appointment started ${new Date(startMs).toISOString().slice(0, 10)}, no outcome recorded`,
          recent: nowMs - startMs <= 14 * DAY_MS
        });
      }
    }

    if (open) {
      const msgs: AnyObj[] = Array.isArray(conv.messages) ? conv.messages : [];
      const last = msgs[msgs.length - 1];
      if (last?.direction === "out" && last?.provider === "draft_ai") {
        const draftMs = parseMs(last.at);
        if (draftMs != null) {
          const ageDays = (nowMs - draftMs) / DAY_MS;
          if (ageDays > 1.5) {
            draftUnactioned.push({
              convId: String(conv.id),
              name: leadName(conv),
              evidence: `pending draft from ${last.at} (${Math.round(ageDays)}d old) never sent or replaced`,
              recent: ageDays <= 7
            });
          }
        }
      }
    }
  }

  const result = (check: string, offenders: Offender[]): CheckResult => ({
    check,
    total: offenders.length,
    recent: offenders.filter(o => o.recent).length,
    offenders: offenders.slice(0, 50)
  });

  return [
    result("cadence_far_future", farFuture),
    result("cadence_stalled", stalled),
    result("watch_orphaned", watchOrphans),
    result("appointment_outcome_missing", apptMissing),
    result("draft_unactioned", draftUnactioned)
  ];
}

function selfTest() {
  const nowMs = Date.parse("2026-06-12T00:00:00.000Z");
  const convs: AnyObj[] = [
    // The Nicholas/Dominik class: parked a year out, no stated timeframe, touched recently.
    {
      id: "+1",
      status: "open",
      updatedAt: "2026-06-11T19:00:00.000Z",
      lead: { firstName: "Nick" },
      followUpCadence: { status: "active", kind: "standard", nextDueAt: "2027-06-01T09:00:00.000Z", anchorAt: "2026-06-11T19:00:00.000Z" }
    },
    // Justified long park: stated 7-12 months.
    {
      id: "+2",
      status: "open",
      lead: { firstName: "Carl", purchaseTimeframe: "7-12 Months" },
      followUpCadence: { status: "active", kind: "standard", nextDueAt: "2027-05-06T14:00:00.000Z", anchorAt: "2026-06-01T00:00:00.000Z" }
    },
    // Stalled: 5 days overdue.
    {
      id: "+3",
      status: "open",
      lead: { firstName: "Stan" },
      followUpCadence: { status: "active", kind: "standard", nextDueAt: "2026-06-07T00:00:00.000Z" }
    },
    // Orphaned watch on recently closed conv.
    {
      id: "+4",
      status: "closed",
      closedAt: "2026-06-10T00:00:00.000Z",
      lead: { firstName: "Wanda" },
      inventoryWatches: [{ model: "Street Glide", status: "active" }]
    },
    // Appointment 5 days past, no outcome.
    {
      id: "+5",
      status: "open",
      lead: { firstName: "Abe" },
      appointment: { status: "confirmed", matchedSlot: { start: "2026-06-07T15:00:00.000Z" } }
    },
    // Unactioned draft, 3 days old.
    {
      id: "+6",
      status: "open",
      lead: { firstName: "Dre" },
      messages: [
        { direction: "in", provider: "twilio", at: "2026-06-08T20:00:00.000Z", body: "how much" },
        { direction: "out", provider: "draft_ai", at: "2026-06-09T00:00:00.000Z", body: "draft" }
      ]
    },
    // Healthy conv: nothing flagged.
    {
      id: "+7",
      status: "open",
      lead: { firstName: "Hank" },
      followUpCadence: { status: "active", kind: "standard", nextDueAt: "2026-06-14T00:00:00.000Z" },
      messages: [
        { direction: "out", provider: "twilio", at: "2026-06-11T00:00:00.000Z", body: "hi" }
      ]
    },
    // Post-sale cadences are exempt from far-future/stalled grading.
    {
      id: "+8",
      status: "closed",
      closedReason: "sold",
      lead: { firstName: "Sold" },
      followUpCadence: { status: "active", kind: "post_sale", nextDueAt: "2027-04-08T00:00:00.000Z" }
    },
    // Overdue but intentionally parked: inventory hold and open staff todo.
    {
      id: "+9",
      status: "open",
      lead: { firstName: "Held" },
      followUp: { mode: "holding_inventory" },
      followUpCadence: { status: "active", kind: "standard", nextDueAt: "2026-06-05T00:00:00.000Z" }
    },
    {
      id: "+10",
      status: "open",
      lead: { firstName: "Tasked" },
      followUp: { mode: "active" },
      followUpCadence: { status: "active", kind: "standard", nextDueAt: "2026-06-05T00:00:00.000Z" }
    }
  ];
  const results = auditConversations(convs, { nowMs, openTodoConvIds: new Set(["+10"]) });
  const byCheck = Object.fromEntries(results.map(r => [r.check, r]));
  const fail = (label: string) => {
    console.error(`SELF-TEST FAIL: ${label}`);
    process.exit(1);
  };
  if (byCheck.cadence_far_future.total !== 1 || byCheck.cadence_far_future.recent !== 1) {
    fail(`far_future expected 1/1, got ${byCheck.cadence_far_future.total}/${byCheck.cadence_far_future.recent}`);
  }
  if (byCheck.cadence_far_future.offenders[0].convId !== "+1") fail("far_future flags the 2027 park");
  if (byCheck.cadence_stalled.total !== 1 || byCheck.cadence_stalled.offenders[0].convId !== "+3") {
    fail("stalled flags the overdue cadence only");
  }
  if (byCheck.watch_orphaned.total !== 1 || byCheck.watch_orphaned.offenders[0].convId !== "+4") {
    fail("watch_orphaned flags the closed conv watch");
  }
  if (byCheck.appointment_outcome_missing.total !== 1 || byCheck.appointment_outcome_missing.offenders[0].convId !== "+5") {
    fail("appointment_outcome_missing flags the past appointment");
  }
  if (byCheck.draft_unactioned.total !== 1 || byCheck.draft_unactioned.offenders[0].convId !== "+6") {
    fail("draft_unactioned flags the stale pending draft");
  }
  if (timeframeJustifiesMonths("Over 1 Year") !== 12) fail("timeframe parse: over 1 year");
  if (timeframeJustifiesMonths("4-6 Months") !== 6) fail("timeframe parse: range");
  if (timeframeJustifiesMonths("") !== 0) fail("timeframe parse: empty");
  console.log("PASS agent actions audit self-test");
}

function main() {
  const argv = process.argv.slice(2);
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--self-test") {
      selfTest();
      return;
    }
    if (argv[i].startsWith("--")) args.set(argv[i], argv[i + 1] ?? "");
  }

  const storePath =
    args.get("--store") ||
    process.env.ACTIONS_AUDIT_STORE_PATH ||
    path.join(process.env.DATA_DIR || path.resolve(process.cwd(), "data"), "conversations.json");
  const reportRoot = process.env.REPORT_ROOT || path.resolve(process.cwd(), "reports");
  const outDir = args.get("--out-dir") || process.env.ACTIONS_AUDIT_OUT_DIR || path.join(reportRoot, "actions_audit");

  const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
  const conversations: AnyObj[] = Array.isArray(raw) ? raw : raw?.conversations ?? [];
  const storeTodos: AnyObj[] = Array.isArray(raw?.todos) ? raw.todos : [];
  const openTodoConvIds = new Set<string>(
    storeTodos.filter(t => String(t?.status ?? "") === "open").map(t => String(t?.convId ?? ""))
  );
  const results = auditConversations(conversations, { openTodoConvIds });

  fs.mkdirSync(outDir, { recursive: true });
  const summary = {
    ok: true,
    generatedAt: new Date().toISOString(),
    source: { storePath, conversationCount: conversations.length },
    summary: {
      byCheck: results.map(r => ({ check: r.check, total: r.total, recent: r.recent }))
    },
    offenders: Object.fromEntries(results.map(r => [r.check, r.offenders]))
  };
  fs.writeFileSync(path.join(outDir, "actions_audit_summary.json"), JSON.stringify(summary, null, 2) + "\n");

  const md = [
    "# Agent Actions Audit",
    "",
    `Generated: ${summary.generatedAt} — ${conversations.length} conversations`,
    "",
    "Grades the agent's deterministic actions (cadence schedules, watches,",
    "appointment follow-through, pending drafts). \"recent\" counts feed the",
    "release gate; totals include legacy debt.",
    "",
    ...results.flatMap(r => [
      `## ${r.check} — total ${r.total}, recent ${r.recent}`,
      ...(r.offenders.length
        ? r.offenders.slice(0, 15).map(o => `- ${o.name} (${o.convId})${o.recent ? " [recent]" : ""}: ${o.evidence}`)
        : ["- none"]),
      ""
    ])
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "actions_audit_report.md"), md + "\n");

  console.log(
    JSON.stringify({
      ok: true,
      outDir,
      counts: Object.fromEntries(results.map(r => [r.check, { total: r.total, recent: r.recent }]))
    })
  );
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) main();
