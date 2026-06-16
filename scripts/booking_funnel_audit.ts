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
  const manualHandoff: any = { id: "handoff", status: "open", messages: [custIn], followUp: { mode: "manual_handoff", reason: "composite_sales_inquiry" } };
  const holding: any = { id: "holding", status: "open", messages: [custIn], followUp: { mode: "holding_inventory", reason: "inventory_watch" } };
  const notEngaged: any = { id: "silent", status: "open", messages: [{ direction: "in", provider: "sendgrid_adf", at: inboundAt, body: "WEB LEAD (ADF)" }] };
  const won: any = { id: "won", status: "closed", closedReason: "sold", closedAt: inboundAt, messages: [custIn], appointment: { bookedEventId: "evt_2" } };
  const lost: any = { id: "lost", status: "closed", closedReason: "no_response", closedAt: inboundAt, messages: [custIn] };
  // NON-sales leads — must never count as a booking leak.
  const rideChallenge: any = { id: "ride", status: "open", messages: [custIn], followUp: { mode: "active", reason: "ride_challenge_signup" } };
  const eventRsvp: any = { id: "rsvp", status: "open", messages: [custIn], classification: { bucket: "event_promo", cta: "event_rsvp" } };
  const rentalSource: any = { id: "rental", status: "open", messages: [custIn], lead: { source: "Eagle Rider" } };
  const serviceAdf: any = { id: "service", status: "open", messages: [custIn], classification: { bucket: "service", cta: "service_request" } };
  const partsAdf: any = { id: "parts", status: "open", messages: [custIn], classification: { bucket: "parts", cta: "parts_request" } };
  // DLA demo-ride that ended in no purchase — looks like a sales bucket, but they already came in and passed.
  const dlaNoPurchase: any = { id: "dla", status: "open", messages: [custIn], classification: { bucket: "test_ride", cta: "schedule_test_ride" }, followUp: { mode: "manual_handoff", reason: "dealer_ride_no_purchase" } };
  // The offered_no_book split: deferred (not a miss) vs soft-visit (coming in) vs the real watch bucket.
  const customerNotReady: any = { id: "deferred", status: "open", messages: [custIn], followUp: { mode: "active", reason: "future_timeframe" } };
  const softVisitPending: any = { id: "softvisit", status: "open", messages: [custIn], scheduleSoft: { windowLabel: "Saturday" } };

  const financeTodos = [{ convId: "finance", reason: "approval", summary: "Credit approval task" }];
  const c = (conv: any, todos?: any[]) => classifyBookingFunnel(conv, { nowMs, openTodos: todos });

  assert.equal(c(booked).leak, "booked", "bookedEventId -> booked");
  assert.equal(c(booked).booked, true);
  assert.equal(c(booked).salesIntent, true, "a bike shopper is sales-intent");
  assert.equal(c(offeredNoBook).leak, "accepted_no_time", "scheduling-prompt outbound + no defer/soft-visit/booking -> accepted_no_time (the real gap)");
  assert.equal(c(offeredNoBook).offered, true);
  assert.equal(c(offeredViaSlots).leak, "accepted_no_time", "suggested slots, no booking -> accepted_no_time");
  assert.equal(c(customerNotReady).leak, "customer_not_ready", "future_timeframe (system-tagged defer) -> customer_not_ready, not a miss");
  assert.equal(c(softVisitPending).leak, "soft_visit_pending", "soft-visit window set -> soft_visit_pending (coming in, no slot)");
  assert.equal(c(notOffered).leak, "not_offered", "answered but never offered a time -> not_offered (coverage leak)");
  assert.equal(c(notOffered).offered, false);
  assert.equal(c(financePending, financeTodos).leak, "finance_pending", "active credit deal -> finance_pending (deferred by design)");
  assert.equal(c(manualHandoff).leak, "manual_handoff", "sales handoff (non-service) -> manual_handoff");
  assert.equal(c(holding).leak, "holding_inventory", "waiting on stock -> holding_inventory");
  assert.equal(c(notEngaged).leak, "not_engaged", "ADF-only / no reply -> not_engaged");
  assert.equal(c(won).leak, "closed_won", "sold -> closed_won");
  assert.equal(c(lost).leak, "closed_lost", "closed no-sale -> closed_lost");
  // Non-sales: excluded from the funnel regardless of engagement.
  assert.equal(c(rideChallenge).leak, "not_sales", "ride-challenge signup -> not_sales (never asked to book)");
  assert.equal(c(rideChallenge).salesIntent, false);
  assert.equal(c(eventRsvp).leak, "not_sales", "event RSVP -> not_sales");
  assert.equal(c(eventRsvp).salesIntent, false);
  assert.equal(c(rentalSource).leak, "not_sales", "rental source -> not_sales");
  assert.equal(c(serviceAdf).leak, "not_sales", "service ADF -> not_sales");
  assert.equal(c(serviceAdf).salesIntent, false);
  assert.equal(c(partsAdf).leak, "not_sales", "parts ADF -> not_sales");
  assert.equal(c(dlaNoPurchase).leak, "not_sales", "DLA demo-ride with no purchase -> not_sales (already came in, don't re-push)");
  assert.equal(c(dlaNoPurchase).salesIntent, false);

  const rows = [booked, offeredNoBook, offeredViaSlots, notOffered, manualHandoff, holding, notEngaged, won, lost, rideChallenge, eventRsvp, serviceAdf, partsAdf, dlaNoPurchase, customerNotReady, softVisitPending].map(x => c(x));
  rows.push(c(financePending, financeTodos));
  const s = buildBookingFunnelSummary(rows);
  assert.equal(s.population, 17, "summary covers all rows");
  assert.equal(s.notSales, 5, "five non-sales rows excluded (rsvp, ride-challenge, service, parts, dla-no-purchase)");
  assert.equal(s.salesPopulation, 12, "sales population = population - notSales");
  assert.equal(s.leaks.accepted_no_time, 2, "offered_no_book split: 2 real watch-bucket leads");
  assert.equal(s.leaks.customer_not_ready, 1, "1 deferred lead pulled out of the leak");
  assert.equal(s.leaks.soft_visit_pending, 1, "1 soft-visit lead pulled out of the leak");
  const bucketSum = Object.values(s.leaks).reduce((a, b) => a + b, 0);
  assert.equal(bucketSum, 17, "buckets are mutually exclusive + exhaustive (incl. not_sales)");
  // engaged = SALES leads where the customer replied = all sales rows except the ADF-only one (11)
  assert.equal(s.engaged, 11, "engaged excludes the ADF-only lead AND all non-sales leads");
  assert.equal(s.offered, 5, "offered among sales-engaged: booked + 2 offered + won + soft-visit");
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

  // Actionable examples: the two leaks the agent CAN fix — never offered, and offered-but-
  // accepted-with-no-time (the real conversion gap, with the deferred/soft-visit cases removed).
  const examples: Record<string, Array<{ convId: string; name: string; lastInbound: string }>> = {
    not_offered: [],
    accepted_no_time: []
  };
  inWindow.forEach((c, i) => {
    const leak = rows[i].leak;
    if ((leak === "not_offered" || leak === "accepted_no_time") && examples[leak].length < maxExamples) {
      examples[leak].push({ convId: String(c?.id ?? c?.leadKey ?? ""), name: name(c), lastInbound: lastInbound(c) });
    }
  });

  const report = { generatedAt: new Date(nowMs).toISOString(), sinceDays, conversationsPath, summary, examples };

  const outDir = arg("--out-dir", "") || process.env.BOOKING_FUNNEL_OUT_DIR || path.resolve(process.cwd(), "reports", "booking_funnel");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "booking_funnel_summary.json"), JSON.stringify(report, null, 2));

  const s = summary;
  console.log(`Booking funnel — last ${sinceDays} days`);
  console.log(`  Scope: ${s.population} convs -> ${s.salesPopulation} sales-intent (${s.notSales} non-sales excluded: ride challenge / RSVP / rental / hiring / …)`);
  console.log(`  Sales-intent engaged: ${s.engaged}`);
  console.log(`  Offered a time:   ${s.offered}/${s.engaged} engaged  (${s.offeredRatePct}%)`);
  console.log(`  Booked appt:      ${s.booked}/${s.engaged} engaged  (${s.bookRatePct}%)`);
  console.log(`  Offer -> book:    ${s.offerToBookPct}%  (booked / offered)`);
  console.log(`  Showed:           ${s.showed}`);
  console.log("  Where engaged leads sit:");
  console.log(`    not_offered (coverage leak):       ${s.leaks.not_offered}`);
  console.log(`    accepted_no_time (REAL conv. gap): ${s.leaks.accepted_no_time}`);
  console.log(`    customer_not_ready (deferred):     ${s.leaks.customer_not_ready}`);
  console.log(`    soft_visit_pending (coming in):    ${s.leaks.soft_visit_pending}`);
  console.log(`    finance_pending (by design):       ${s.leaks.finance_pending}`);
  console.log(`    manual_handoff (staff-owned):      ${s.leaks.manual_handoff}`);
  console.log(`    holding_inventory:                 ${s.leaks.holding_inventory}`);
  console.log(`    booked / won / lost:               ${s.leaks.booked} / ${s.leaks.closed_won} / ${s.leaks.closed_lost}`);
  console.log(`  Report: ${path.join(outDir, "booking_funnel_summary.json")}`);
}

main();
