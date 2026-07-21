/**
 * Backfill — service-scheduling misroute on a sales thread (Justin Alley +17163390288, 2026-07-21).
 *
 * The code fix (parseVisitDepartmentPurposeWithLLM + decideServiceSchedulingHandoffTurn, both
 * paths) keeps the NEXT such visit-time turn in the sales scheduling cluster. This corrects the
 * records the bug already left wrong: a SALES conversation (real sale unit, customer coming in
 * to see it) whose classification got rewritten to bucket=service / cta=service_request and
 * whose dialog state got parked at service_handoff by the misrouted turn.
 *
 * Bug-class predicate (TIGHT, so real service threads are never touched):
 *   - dialogState is service_handoff AND classification bucket/cta says service, AND
 *   - the lead is a REAL sale unit (concrete model + stock# or VIN — not a placeholder), AND
 *   - NO INBOUND customer message ever asked for service WORK: after removing mentions of the
 *     sale bike's "service history/records" (a buyer's question, not a work request), no
 *     customer text contains service-work terms. The "service" soak came from OUR outbound
 *     descriptions of the sale bike's maintenance.
 * Correction: classification -> general_inquiry/unknown (the sanitize precedent), dialogState ->
 * schedule_request (the customer has an active visit plan). followUp/manual_handoff is left
 * alone — staff are actively working these threads. Any open service todo is called out in the
 * summary for manual review (todos live outside the conversations store).
 *
 *   self-test (deterministic, no store):
 *     npx tsx scripts/backfill_service_visit_misroute.ts --self-test
 *   dry-run against a store (writes nothing):
 *     CONVERSATIONS_DB_PATH=/path/conversations.json npx tsx scripts/backfill_service_visit_misroute.ts
 *   APPLY (mutates + persists — approve-first):
 *     CONVERSATIONS_DB_PATH=/path/conversations.json npx tsx scripts/backfill_service_visit_misroute.ts --apply
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { planBackfill, applyBackfill, renderBackfillReport } from "../services/api/src/domain/backfillRunner.ts";

const SERVICE_WORK_RE = /\b(service|servicing|oil change|maintenance|repair|inspection|inspect|recall|warranty work)\b/i;
const SALE_BIKE_RECORDS_RE = /\bservice\s+(history|records?)\b/gi;

function isPlaceholderModelLabel(model: unknown): boolean {
  const t = String(model ?? "").trim().toLowerCase();
  return !t || /^(other|full line|full lineup|null|unknown)$/.test(t) || /\bfull line(up)?$/.test(t);
}

function customerAskedForServiceWork(conv: any): boolean {
  const inbound = (conv?.messages ?? [])
    .filter((m: any) => m?.direction === "in")
    .map((m: any) => String(m?.body ?? ""))
    .join("\n");
  // A buyer asking about the SALE bike's "service history/records" is not a work request.
  const withoutRecordsAsk = inbound.replace(SALE_BIKE_RECORDS_RE, " ");
  return SERVICE_WORK_RE.test(withoutRecordsAsk);
}

/** The bug-class corrector. Returns the proposed change or null. NO mutation in the predicate body. */
export function correctServiceVisitMisroute(conv: any): { summary: string; mutate: () => void } | null {
  // The durable wrong label is the CLASSIFICATION — the dialog state naturally rotates as later
  // turns process (Justin's was already back to small_talk by the evening), but bucket=service
  // keeps feeding hasServiceDepartmentContext on every future turn.
  const bucket = String(conv?.classification?.bucket ?? "").toLowerCase();
  const cta = String(conv?.classification?.cta ?? "").toLowerCase();
  if (bucket !== "service" && cta !== "service_request") return null;
  const dialogName = String(conv?.dialogState?.name ?? "").toLowerCase();
  const vehicle = conv?.lead?.vehicle ?? {};
  const isRealSaleUnit =
    !isPlaceholderModelLabel(vehicle?.model) &&
    (String(vehicle?.stockId ?? "").trim().length > 0 || String(vehicle?.vin ?? "").trim().length > 0);
  if (!isRealSaleUnit) return null; // no concrete sale unit — could be a genuine service lead
  if (customerAskedForServiceWork(conv)) return null; // customer really asked for work — leave it

  const fixDialogState = dialogName === "service_handoff" || dialogName === "service_request";
  const summary =
    `reclassify service/service_request -> general_inquiry/unknown` +
    (fixDialogState ? `; dialogState ${dialogName} -> schedule_request` : ` (dialogState "${dialogName}" left as-is)`) +
    ` (sales thread on ${[vehicle?.year, vehicle?.model].filter(Boolean).join(" ")}, ` +
    `customer never asked for service work); check for an open service todo to close manually`;
  return {
    summary,
    mutate: () => {
      if (conv.classification) {
        conv.classification.bucket = "general_inquiry";
        conv.classification.cta = "unknown";
      }
      if (fixDialogState) {
        conv.dialogState = { name: "schedule_request", updatedAt: new Date().toISOString() };
      }
    }
  };
}

if (process.argv.includes("--self-test")) {
  // MATCH: the Justin Alley shape — sale unit thread, service words only in OUR outbound +
  // the customer's "service history" records ask, classification rewritten to service. The
  // dialog state has ALREADY rotated on (small_talk) — only the classification is corrected.
  const justin = {
    id: "c-justin",
    leadKey: "+1555000001",
    lead: { vehicle: { year: "2017", model: "Breakout", stockId: "U590-17", vin: "1HD1BFV17HB019839", condition: "used" } },
    classification: { bucket: "service", cta: "service_request", ruleName: "catalog_2779" },
    dialogState: { name: "small_talk", updatedAt: "2026-07-21T18:20:05.610Z" },
    messages: [
      { direction: "in", body: "Photos, service history, any known mods/upgrades from stock?" },
      { direction: "out", body: "we actually have it on the lift doing a 5,000 mile service and a brake fluid flush right now" },
      { direction: "in", body: "Yea it'll probably be between 5 and 6 p then" }
    ]
  };
  // MATCH: same class, still parked at service_handoff — classification AND dialog state fixed.
  const parked = {
    id: "c-parked",
    leadKey: "+1555000005",
    lead: { vehicle: { year: "2019", model: "Street Glide", stockId: "U100-19", condition: "used" } },
    classification: { bucket: "service", cta: "service_request" },
    dialogState: { name: "service_handoff", updatedAt: "2026-07-21T16:54:38.121Z" },
    messages: [
      { direction: "out", body: "the 5,000 mile service was just done on it" },
      { direction: "in", body: "I'll swing by around 5 to check it out" }
    ]
  };
  // SKIP: a REAL service customer — asked for an oil change; must never be touched.
  const realService = {
    id: "c-real-service",
    leadKey: "+1555000002",
    lead: { vehicle: { year: "2019", model: "Road Glide", stockId: "X1", condition: "used" } },
    classification: { bucket: "service", cta: "service_request" },
    dialogState: { name: "service_handoff" },
    messages: [{ direction: "in", body: "Can I bring my bike in for an oil change Thursday?" }]
  };
  // SKIP: service-classified but NO concrete sale unit — could be a genuine service lead.
  const noUnit = {
    id: "c-no-unit",
    leadKey: "+1555000003",
    lead: { vehicle: { model: "Other" } },
    classification: { bucket: "service", cta: "service_request" },
    dialogState: { name: "service_handoff" },
    messages: [{ direction: "in", body: "What time are you open til?" }]
  };
  // SKIP: sales thread NOT in service_handoff — nothing to fix.
  const healthySales = {
    id: "c-healthy",
    leadKey: "+1555000004",
    lead: { vehicle: { year: "2023", model: "Fat Bob 114", stockId: "U1", condition: "used" } },
    classification: { bucket: "general_inquiry", cta: "unknown" },
    dialogState: { name: "schedule_request" },
    messages: [{ direction: "in", body: "Saturday works" }]
  };

  const plan = planBackfill({
    conversations: [justin, parked, realService, noUnit, healthySales],
    correct: correctServiceVisitMisroute
  });
  assert.equal(plan.changes.length, 2, `expected 2 changes, got ${plan.changes.length}: ${plan.changes.map(c => c.convId)}`);
  assert.deepEqual(plan.changes.map(c => c.convId).sort(), ["c-justin", "c-parked"], "only the sales-thread misroutes must be corrected");
  assert.equal(justin.classification.bucket, "service", "planBackfill must not mutate");

  const applied = applyBackfill(plan);
  assert.equal(applied, 2);
  assert.equal(justin.classification.bucket, "general_inquiry", "apply must reclassify");
  assert.equal(justin.classification.cta, "unknown", "apply must clear the service cta");
  assert.equal(justin.dialogState.name, "small_talk", "an already-rotated dialog state is left alone");
  assert.equal(parked.classification.bucket, "general_inquiry", "parked thread reclassified");
  assert.equal(parked.dialogState.name, "schedule_request", "a parked service_handoff state is restored to scheduling");
  assert.equal(realService.dialogState.name, "service_handoff", "a real service thread must be untouched");
  assert.equal(realService.classification.bucket, "service", "a real service classification must be untouched");
  assert.equal(noUnit.classification.bucket, "service", "a no-unit service lead must be untouched");
  assert.equal(healthySales.classification.bucket, "general_inquiry", "a healthy sales thread is untouched");
  console.log("PASS backfill service-visit misroute (self-test: 5-fixture predicate; 2 corrected, 3 untouched)");
  process.exit(0);
}

// --- real run ---
const apply = process.argv.includes("--apply");
const convPath =
  process.env.CONVERSATIONS_DB_PATH ||
  (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "conversations.json") : "");
if (!convPath || !fs.existsSync(convPath)) {
  console.error("Set CONVERSATIONS_DB_PATH (or DATA_DIR) to the conversations.json to scan.");
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(convPath, "utf8"));
const conversations: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.conversations) ? raw.conversations : [];
const plan = planBackfill({ conversations, correct: correctServiceVisitMisroute, cap: 50 });
console.log(renderBackfillReport(plan, { title: "Service-visit misroute (sales thread)", applied: false }));
if (apply && plan.changes.length) {
  const applied = applyBackfill(plan);
  fs.writeFileSync(convPath, JSON.stringify(raw, null, 2));
  console.log(`\n${renderBackfillReport(plan, { title: "Service-visit misroute (sales thread)", applied: true })}`);
  console.log(`\nApplied ${applied} change(s) and persisted ${convPath}.`);
} else if (!apply) {
  console.log("\n(dry-run — re-run with --apply to write these changes)");
}
