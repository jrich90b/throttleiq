/**
 * Next-Move resolver SHADOW report — phase 1 (2026-07-31).
 *
 * READ-ONLY. Writes no store, changes no behavior, touches no screen. Answers the question
 * Joe asked before committing to any of this: "show me the rewritten task list against real
 * leads." Prints, per lead, what the board says TODAY vs what the resolver would say.
 *
 * The measured problem it is checked against (live American Harley store, 2026-07-31):
 * 39 open tasks, 69% with no due date, 18% with no owner, oldest 36 days, and 204 independent
 * task-producing call sites with nothing re-evaluating an open task on a timer.
 *
 * ENGAGEMENT IS APPROXIMATED HERE, DELIBERATELY. Joe's ruling makes engagement the gate that
 * decides whether a lead gets called, and by law that judgement belongs to a typed LLM parser
 * (AGENTS.md: comprehend, never regex). This SHADOW report is a volume/shape estimate, not a
 * behavior path, so it uses the repo's own eval-pinned STRUCTURAL exclusions instead — a
 * lead-intake payload, an automated sender, and a tapback echo are not customer replies.
 * Those exclusions make engagement RARER, so the report errs toward MORE calls, never fewer.
 * The parser slots into this same seam at phase 3; nothing here should be promoted to a reply
 * path as-is.
 *
 * Usage (on the box, where the data lives):
 *   CONVERSATIONS_DB_PATH=/home/ubuntu/leadrider-runtime/americanharley/data/conversations.json \
 *   npm run next_move_resolver:shadow -- --sample 25
 */

import fs from "node:fs";

import {
  isAutomatedSenderInbound,
  isOptOutKeywordInbound,
  isQuotedReactionEchoInbound
} from "../services/api/src/domain/scoringExclusions.js";
import { decideNextMove, type KnownNextEvent } from "../services/api/src/domain/nextMoveResolver.js";

// Mirrors LEAD_INTAKE_MARKER_RE + LEAD_INTAKE_FIELD_RE in scoringExclusions.ts: a structured
// ADF / widget payload is a SYSTEM re-sync of lead data, never a customer-authored reply.
const LEAD_INTAKE_MARKER_RE = /(PHONE LOG \(ADF\)|WEB LEAD \(ADF\)|WEB TEXT WIDGET|\(ADF\))/i;
const LEAD_INTAKE_FIELD_RE = /\b(Source|Ref|Inquiry|Vehicle|Department|PreQual|Lead|Page|URL)\s*:/i;

const KNOWN_EVENT_BY_MODE: Record<string, KnownNextEvent["kind"]> = {
  holding_inventory: "inventory_watch",
  manual_handoff: "manual_handoff",
  paused_indefinite: "paused"
};
const KNOWN_EVENT_BY_REASON: Record<string, KnownNextEvent["kind"]> = {
  inventory_watch: "inventory_watch",
  order_hold: "order_hold",
  unit_hold: "unit_hold",
  appointment_hold: "appointment"
};

type Msg = { direction?: string; from?: string; body?: string; at?: string };
type Conv = {
  id: string;
  createdAt?: string;
  closedAt?: string;
  closedReason?: string;
  messages?: Msg[];
  lead?: { firstName?: string; name?: string };
  leadOwner?: { name?: string };
  followUp?: { mode?: string; reason?: string; updatedAt?: string };
  followUpCadence?: { stopReason?: string };
  appointment?: { bookedEventId?: string; bookedAt?: string; startAt?: string };
};

function isCustomerReply(m: Msg, convId: string): boolean {
  if (String(m?.direction ?? "") !== "in") return false;
  const body = String(m?.body ?? "").trim();
  if (!body) return false;
  if (LEAD_INTAKE_MARKER_RE.test(body) && LEAD_INTAKE_FIELD_RE.test(body)) return false;
  if (isAutomatedSenderInbound({ from: m.from, body, convId })) return false;
  if (isQuotedReactionEchoInbound(body)) return false;
  return true;
}

function knownNextEvent(c: Conv): KnownNextEvent | null {
  const mode = String(c?.followUp?.mode ?? "").trim();
  const reason = String(c?.followUp?.reason ?? "").trim();
  const stopReason = String(c?.followUpCadence?.stopReason ?? "").trim();
  const at = c?.followUp?.updatedAt ?? null;
  if (c?.appointment?.bookedEventId) {
    return { kind: "appointment", at: c.appointment.bookedAt ?? c.appointment.startAt ?? at };
  }
  const kind =
    KNOWN_EVENT_BY_MODE[mode] ?? KNOWN_EVENT_BY_REASON[reason] ?? KNOWN_EVENT_BY_REASON[stopReason];
  return kind ? { kind, at } : null;
}

function main() {
  const dbPath =
    process.env.CONVERSATIONS_DB_PATH ||
    "/home/ubuntu/leadrider-runtime/americanharley/data/conversations.json";
  const sIdx = process.argv.indexOf("--sample");
  const sample = sIdx > -1 ? Number(process.argv[sIdx + 1]) || 20 : 20;

  const raw = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const convs: Conv[] = Array.isArray(raw.conversations)
    ? raw.conversations
    : Object.values(raw.conversations || {});
  const todos: any[] = Array.isArray(raw.todos) ? raw.todos : Object.values(raw.todos || {});
  const nowMs = Date.now();

  const openByConv = new Map<string, any[]>();
  for (const t of todos) {
    if (String(t?.status ?? "") !== "open") continue;
    const list = openByConv.get(String(t.convId)) ?? [];
    list.push(t);
    openByConv.set(String(t.convId), list);
  }

  let boardToday = 0;
  let boardResolver = 0;
  let backlog = 0;
  const reasons: Record<string, number> = {};
  const rows: string[] = [];

  for (const c of convs) {
    const open = openByConv.get(c.id) ?? [];
    const msgs = [...(c.messages ?? [])].sort(
      (a, b) => Date.parse(String(a?.at ?? 0)) - Date.parse(String(b?.at ?? 0))
    );
    const replies = msgs.filter(m => isCustomerReply(m, c.id));
    const optedOut = msgs.some(
      m => String(m?.direction) === "in" && isOptOutKeywordInbound(String(m?.body ?? ""))
    );

    const decision = decideNextMove({
      nowMs,
      leadCreatedAt: String(c.createdAt ?? ""),
      engagement: {
        engaged: replies.length > 0,
        lastCustomerReplyAt: replies.length ? String(replies[replies.length - 1].at) : null
      },
      knownNextEvent: knownNextEvent(c),
      closed: !!c.closedAt || !!c.closedReason,
      optedOut
    });

    reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1;
    boardToday += open.length;
    if (decision.move !== "none") boardResolver += 1;
    // Leads whose move came due long ago: a ONE-TIME backlog to sweep or write off, never
    // part of the steady-state daily board.
    if (decision.reason === "chart_lapsed" || decision.reason === "reengage_lapsed") backlog += 1;

    // Show the leads where the two disagree — that IS the change Joe is being asked to approve.
    if (rows.length < sample && (open.length > 1 || (open.length > 0) !== (decision.move !== "none"))) {
      const who = c.lead?.firstName || c.lead?.name || "(no name)";
      const owner = c.leadOwner?.name || "unassigned";
      const todayTxt = open.length
        ? open.map(t => `[${t.taskClass ?? "?"}] ${String(t.summary ?? "").replace(/\s+/g, " ").slice(0, 68)}`).join(" || ")
        : "(nothing)";
      const nextTxt =
        decision.move === "none"
          ? `(nothing — ${decision.reason})`
          : `CALL — ${decision.reason}${decision.chartDay ? ` day ${decision.chartDay}` : ""}, due ${String(decision.dueAt).slice(0, 10)}`;
      rows.push(
        `\n  ${who} (${owner})\n    today (${open.length}): ${todayTxt}\n    resolver:    ${nextTxt}`
      );
    }
  }

  console.log(`\n=== NEXT-MOVE RESOLVER — shadow report ===`);
  console.log(`\nConversations evaluated: ${convs.length}`);
  console.log(`Open tasks on the board TODAY:      ${boardToday}`);
  console.log(`Moves the resolver would surface:   ${boardResolver}   <== the daily board`);
  console.log(`One-time backlog (lapsed, never called): ${backlog}   (sweep or write off, once)`);
  console.log(`\nWhy the resolver stays silent (or doesn't):`);
  for (const [r, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${r.padEnd(28)} ${n}`);
  }
  console.log(`\n--- sample leads where today's board and the resolver disagree ---`);
  console.log(rows.join("\n") || "  (none)");
  console.log("");
}

main();
