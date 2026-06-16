/**
 * booking_funnel:audit — measures the agent's core objective (answer -> book an
 * appointment). Reports, over a window of conversations:
 *   - OFFERED-A-TIME rate (of engaged leads, how often the agent proposed a time)
 *   - OFFER -> BOOK conversion (of leads offered a time, how many booked)
 *   - WHERE LEADS LEAK (engaged-but-not-booked, bucketed: never offered / offered-no-book
 *     / finance-deferred / manual-handoff / holding-inventory)
 * Deterministic, read-only. No customer impact. Classification lives in the pure
 * domain module services/api/src/domain/bookingFunnel.ts (so it's unit-tested).
 *
 * Usage:
 *   CONVERSATIONS_DB_PATH=/path/conversations.json npx tsx scripts/booking_funnel_audit.ts [--since-days N] [--max N] [--out-dir DIR]
 *   npx tsx scripts/booking_funnel_audit.ts --self-test     # deterministic, no IO, for ci:eval
 *
 * Env: CONVERSATIONS_DB_PATH or DATA_DIR (DATA_DIR/conversations.json); BOOKING_FUNNEL_OUT_DIR.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  classifyBookingFunnel,
  buildBookingFunnelSummary,
  type BookingFunnelClass
} from "../services/api/src/domain/bookingFunnel.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? String(process.argv[i + 1]) : fallback;
}

function lastActivityMs(conv: any): number {
  let last = Date.parse(String(conv?.createdAt ?? "")) || 0;
  for (const m of conv?.messages ?? []) {
    const t = Date.parse(String(m?.at ?? ""));
    if (Number.isFinite(t) && t > last) last = t;
  }
  return last;
}

function name(conv: any): string {
  const l = conv?.lead ?? {};
  return [l?.firstName, l?.lastName].filter(Boolean).join(" ").trim() || conv?.leadKey || conv?.id || "lead";
}

function lastInbound(conv: any): string {
  const ins = (conv?.messages ?? []).filter((m: any) => m?.direction === "in" && String(m?.body ?? "").trim());
  const m = ins[ins.length - 1];
  return String(m?.body ?? "").replace(/\s+/g, " ").slice(0, 120);
}

// ---- self-test: synthetic conversations, one per bucket ----
function selfTest(): void {
  const nowMs = Date.parse("2026-06-16T18:00:00.000Z");
  const inboundAt = "2026-06-15T18:00:00.000Z";
  const custIn = { direction: "in", provider: "twilio", at: inboundAt, body: "how much for the road glide?" };

  const booked: any = { id: "booked", status: "open", messages: [custIn], appointment: { status: "confirmed", bookedEventId: "evt_1" } };
  const offeredNoBook: any = {
    id: "offered", status: "open", messages: [custIn, { direction: "out", provider: "draft_ai", at: inboundAt, body: "Happy to help — what day and time works best to stop in?" }]
  };
  const offeredViaSlots: any = { id: "slots", status: "open", messages: [custIn], scheduler: { lastSuggestedSlots: [{ startLocal: "Sat 10am" }] } };
  const notOffered: any = { id: "not_offered", status: "open", messages: [custIn, { direction: "out", provider: "draft_ai", at: inboundAt, body: "It's $24,995 out the door." }] };
  const financePending: any = {
    id: "finance", status: "open", messages: [custIn], followUp: { mode: "manual_handoff", reason: "credit_app" }
  };
  const manualHandoff: any = { id: "handoff", status: "open", messages: [custIn], followUp: { mode: "manual_handoff", reason: "service_request" } };
  const holding: any = { id: "holding", status: "open", messages: [custIn], followUp: { mode: "holding_inventory", reason: "inventory_watch" } };
  const notEngaged: any = { id: "silent", status: "open", messages: [{ direction: "in", provider: "sendgrid_adf", at: inboundAt, body: "WEB LEAD (ADF)" }] };
  const won: any = { id: "won", status: "closed", closedReason: "sold", closedAt: inboundAt, messages: [custIn], appointment: { bookedEventId: "evt_2" } };
  const lost: any = { id: "lost", status: "closed", closedReason: "no_response", closedAt: inboundAt, messages: [custIn] };

  const financeTodos = [{ convId: "finance", reason: "approval", summary: "Credit approval task" }];
  const c = (conv: any, todos?: any[]) => classifyBookingFunnel(conv, { nowMs, openTodos: todos });

  assert.equal(c(booked).leak, "booked", "bookedEventId -> booked");
  assert.equal(c(booked).booked, true);
  assert.equal(c(offeredNoBook).leak, "offered_no_book", "scheduling-prompt outbound + no booking -> offered_no_book");
  assert.equal(c(offeredNoBook).offered, true);
  assert.equal(c(offeredViaSlots).leak, "offered_no_book", "suggested slots count as offered");
  assert.equal(c(notOffered).leak, "not_offered", "answered but never offered a time -> not_offered (coverage leak)");
  assert.equal(c(notOffered).offered, false);
  assert.equal(c(financePending, financeTodos).leak, "finance_pending", "active credit deal -> finance_pending (deferred by design)");
  assert.equal(c(manualHandoff).leak, "manual_handoff", "staff-owned -> manual_handoff");
  assert.equal(c(holding).leak, "holding_inventory", "waiting on stock -> holding_inventory");
  assert.equal(c(notEngaged).leak, "not_engaged", "ADF-only / no reply -> not_engaged");
  assert.equal(c(won).leak, "closed_won", "sold -> closed_won");
  assert.equal(c(lost).leak, "closed_lost", "closed no-sale -> closed_lost");

  const rows = [booked, offeredNoBook, offeredViaSlots, notOffered, manualHandoff, holding, notEngaged, won, lost].map(x => c(x));
  rows.push(c(financePending, financeTodos));
  const s = buildBookingFunnelSummary(rows);
  assert.equal(s.population, 10, "summary covers all rows");
  assert.equal(s.leaks.booked + s.leaks.closed_won + s.leaks.closed_lost + s.leaks.not_engaged + s.leaks.finance_pending + s.leaks.manual_handoff + s.leaks.holding_inventory + s.leaks.offered_no_book + s.leaks.not_offered, 10, "buckets are mutually exclusive + exhaustive");
  // engaged = all except not_engaged (9); offered among engaged = booked + offeredNoBook + slots + won = 4
  assert.equal(s.engaged, 9, "engaged excludes the ADF-only lead");
  assert.equal(s.offered, 4, "offered among engaged: booked + 2 offered + won");
  assert.equal(s.booked, 2, "booked: confirmed appt + won-with-event");
  assert.ok(s.offerToBookPct > 0 && s.offerToBookPct <= 100, "offer->book conversion is a sane %");

  console.log("PASS booking-funnel audit self-test (classification + summary buckets + rates)");
}

function main(): void {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }
  const sinceDays = Number(arg("--since-days", "30")) || 30;
  const maxExamples = Number(arg("--max", "12")) || 12;
  const nowMs = Date.now();
  const windowMs = sinceDays * 24 * 60 * 60 * 1000;

  const conversationsPath =
    process.env.CONVERSATIONS_DB_PATH ||
    (process.env.DATA_DIR
      ? path.join(process.env.DATA_DIR, "conversations.json")
      : path.resolve(process.cwd(), "services", "api", "data", "conversations.json"));
  const raw = JSON.parse(fs.readFileSync(conversationsPath, "utf8"));
  const conversations: any[] = Array.isArray(raw) ? raw : raw?.conversations ?? [];
  const openTodos: any[] = Array.isArray(raw?.todos) ? raw.todos.filter((t: any) => t?.status === "open") : [];

  const inWindow = conversations.filter(c => nowMs - lastActivityMs(c) <= windowMs);
  const rows: BookingFunnelClass[] = inWindow.map(c => classifyBookingFunnel(c, { nowMs, openTodos }));
  const summary = buildBookingFunnelSummary(rows);

  // Actionable examples: the two leaks the agent CAN fix (never offered, offered-no-book).
  const examples: Record<string, Array<{ convId: string; name: string; lastInbound: string }>> = {
    not_offered: [],
    offered_no_book: []
  };
  inWindow.forEach((c, i) => {
    const leak = rows[i].leak;
    if ((leak === "not_offered" || leak === "offered_no_book") && examples[leak].length < maxExamples) {
      examples[leak].push({ convId: String(c?.id ?? c?.leadKey ?? ""), name: name(c), lastInbound: lastInbound(c) });
    }
  });

  const report = { generatedAt: new Date(nowMs).toISOString(), sinceDays, conversationsPath, summary, examples };

  const outDir = arg("--out-dir", "") || process.env.BOOKING_FUNNEL_OUT_DIR || path.resolve(process.cwd(), "reports", "booking_funnel");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "booking_funnel_summary.json"), JSON.stringify(report, null, 2));

  const s = summary;
  console.log(`Booking funnel — last ${sinceDays} days (${s.population} convs, ${s.engaged} engaged)`);
  console.log(`  Offered a time:   ${s.offered}/${s.engaged} engaged  (${s.offeredRatePct}%)`);
  console.log(`  Booked appt:      ${s.booked}/${s.engaged} engaged  (${s.bookRatePct}%)`);
  console.log(`  Offer -> book:    ${s.offerToBookPct}%  (booked / offered)`);
  console.log(`  Showed:           ${s.showed}`);
  console.log("  Where engaged leads sit:");
  console.log(`    not_offered (coverage leak):   ${s.leaks.not_offered}`);
  console.log(`    offered_no_book (conv. leak):  ${s.leaks.offered_no_book}`);
  console.log(`    finance_pending (by design):   ${s.leaks.finance_pending}`);
  console.log(`    manual_handoff (staff-owned):  ${s.leaks.manual_handoff}`);
  console.log(`    holding_inventory:             ${s.leaks.holding_inventory}`);
  console.log(`    booked / won / lost:           ${s.leaks.booked} / ${s.leaks.closed_won} / ${s.leaks.closed_lost}`);
  console.log(`  Report: ${path.join(outDir, "booking_funnel_summary.json")}`);
}

main();
