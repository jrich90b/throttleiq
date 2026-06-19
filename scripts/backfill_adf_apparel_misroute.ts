/**
 * Backfill — ADF apparel/parts/service misroute (2026-06-19, Kelly Gantzer "small womens black leather
 * vest").
 *
 * The code fix (parseAdfDepartmentInterestWithLLM + decideAdfDepartmentRoute, wired into ADF intake)
 * routes the NEXT such lead to the right department. This cleans up the records ALREADY misrouted: an
 * initial ADF lead whose Inquiry was actually apparel/parts/service got classified inventory_interest
 * and had an inventory watch built on the placeholder vehicle (note "initial_adf_unavailable_inventory"),
 * plus a bogus "not in stock" reply. We can't unsend the reply, but we can correct the record so the UI
 * reflects reality:
 *   - PAUSE the bogus watch(es) (the engine already skips paused; stops spamming "in stock" alerts),
 *   - reclassify the conversation bucket/cta to the real department,
 *   - set the dialog state to that department's handoff.
 *
 * Bug-class predicate (TIGHT, so legit watches are never touched): an active inventory watch whose
 * note is "initial_adf_unavailable_inventory" AND whose lead Inquiry carries a catalog apparel/parts
 * term OR whose watch model is a "...full line" placeholder.
 *
 *   self-test (deterministic, for ci-style verification, no store):
 *     npx tsx scripts/backfill_adf_apparel_misroute.ts --self-test
 *   dry-run against a store (writes nothing):
 *     CONVERSATIONS_DB_PATH=/path/conversations.json npx tsx scripts/backfill_adf_apparel_misroute.ts
 *   APPLY (mutates + persists — approve-first):
 *     CONVERSATIONS_DB_PATH=/path/conversations.json npx tsx scripts/backfill_adf_apparel_misroute.ts --apply
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { matchPartsCatalogLexicon } from "../services/api/src/domain/partsCatalogLexicon.ts";
import { planBackfill, applyBackfill, renderBackfillReport } from "../services/api/src/domain/backfillRunner.ts";

function isFullLinePlaceholder(model: unknown): boolean {
  const t = String(model ?? "").trim().toLowerCase();
  return !!t && (/^(other|full line|full lineup|null)$/.test(t) || /\bfull line(up)?$/.test(t));
}

function leadInquiryText(conv: any): string {
  const lead = conv?.lead ?? {};
  return [lead.inquiry, lead.comment, lead.vehicleDescription, conv?.lastInboundText]
    .filter(Boolean)
    .join("\n");
}

function activeInitialAdfWatches(conv: any): any[] {
  const all = [
    ...(Array.isArray(conv?.inventoryWatches) ? conv.inventoryWatches : []),
    ...(conv?.inventoryWatch ? [conv.inventoryWatch] : [])
  ];
  // de-dup the single + array overlap by identity
  const seen = new Set<any>();
  return all.filter(w => {
    if (!w || seen.has(w)) return false;
    seen.add(w);
    return w.status === "active" && w.note === "initial_adf_unavailable_inventory";
  });
}

/** The bug-class corrector. Returns the proposed change or null. NO mutation in the predicate body. */
export function correctAdfApparelMisroute(conv: any): { summary: string; mutate: () => void } | null {
  const watches = activeInitialAdfWatches(conv);
  if (!watches.length) return null;
  const inquiry = leadInquiryText(conv);
  const catalog = matchPartsCatalogLexicon(inquiry);
  const placeholder = watches.some(w => isFullLinePlaceholder(w.model));
  // Department from the catalog match; placeholder-only (no catalog term) is ambiguous -> skip.
  let department: "apparel" | "parts" | "service" | null =
    catalog.departmentIntent === "apparel" || catalog.departmentIntent === "parts"
      ? catalog.departmentIntent
      : null;
  if (!department && placeholder && catalog.apparelTerms.length) department = "apparel";
  if (!department && placeholder && catalog.partsTerms.length) department = "parts";
  if (!department) return null; // not confidently the apparel/parts misroute class — leave it alone

  const cta = department === "apparel" ? "apparel_request" : department === "parts" ? "parts_request" : "service_request";
  const summary = `pause ${watches.length} initial-ADF watch(es) [${watches
    .map(w => w.model)
    .join(", ")}]; reclassify inventory_interest -> ${department}; dialogState -> ${department}_handoff`;
  return {
    summary,
    mutate: () => {
      for (const w of watches) w.status = "paused";
      if (conv.classification) {
        conv.classification.bucket = department;
        conv.classification.cta = cta;
        conv.classification.ruleName = `adf_department_${department}_backfill`;
      }
      conv.dialogState = { name: `${department}_handoff`, updatedAt: new Date().toISOString() };
    }
  };
}

if (process.argv.includes("--self-test")) {
  // MATCH: the vest miss — active initial-ADF watch on a "Full Line" placeholder + an apparel inquiry.
  const vest = {
    id: "c-vest",
    leadKey: "+1555000001",
    lead: { inquiry: "small womens black leather vest" },
    classification: { bucket: "inventory_interest", cta: "check_availability", ruleName: "catalog_2779" },
    inventoryWatch: { model: "Harley-Davidson Full Line", status: "active", note: "initial_adf_unavailable_inventory" },
    dialogState: { name: "inventory_watch_active" }
  };
  // SKIP: a legitimate customer-requested watch on a real bike — must NEVER be touched.
  const legitBike = {
    id: "c-bike",
    leadKey: "+1555000002",
    lead: { inquiry: "keep an eye out for a black Street Glide" },
    inventoryWatch: { model: "Street Glide", status: "active", note: "customer_requested_watch" }
  };
  // SKIP: an initial-ADF watch on a REAL bike model (not a department inquiry) — out of scope.
  const adfRealBike = {
    id: "c-adf-bike",
    leadKey: "+1555000003",
    lead: { inquiry: "interested in a Road Glide" },
    inventoryWatch: { model: "Road Glide", status: "active", note: "initial_adf_unavailable_inventory" }
  };

  const plan = planBackfill({ conversations: [vest, legitBike, adfRealBike], correct: correctAdfApparelMisroute });
  assert.equal(plan.changes.length, 1, `expected 1 change, got ${plan.changes.length}: ${plan.changes.map(c => c.convId)}`);
  assert.equal(plan.changes[0].convId, "c-vest", "only the vest misroute must be corrected");
  // dry-run did NOT mutate
  assert.equal(vest.inventoryWatch.status, "active", "planBackfill must not mutate");
  assert.equal(vest.classification.bucket, "inventory_interest", "planBackfill must not mutate classification");

  const applied = applyBackfill(plan);
  assert.equal(applied, 1);
  assert.equal(vest.inventoryWatch.status, "paused", "apply must pause the bogus watch");
  assert.equal(vest.classification.bucket, "apparel", "apply must reclassify to apparel");
  assert.equal(vest.dialogState.name, "apparel_handoff", "apply must set the apparel handoff state");
  assert.equal(legitBike.inventoryWatch.status, "active", "a legit customer watch must be untouched");
  assert.equal(adfRealBike.inventoryWatch.status, "active", "an ADF real-bike watch must be untouched");
  console.log("PASS backfill adf apparel misroute (self-test: 3-fixture predicate; 1 corrected, 2 untouched)");
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
const plan = planBackfill({ conversations, correct: correctAdfApparelMisroute, cap: 100 });
console.log(renderBackfillReport(plan, { title: "ADF apparel/parts misroute", applied: false }));
if (apply && plan.changes.length) {
  const applied = applyBackfill(plan);
  fs.writeFileSync(convPath, JSON.stringify(raw, null, 2));
  console.log(`\n${renderBackfillReport(plan, { title: "ADF apparel/parts misroute", applied: true })}`);
  console.log(`\nApplied ${applied} change(s) and persisted ${convPath}.`);
} else if (!apply) {
  console.log("\n(dry-run — re-run with --apply to write these changes)");
}
