/**
 * Context-fidelity anchor: the judge must be told when a visit / test ride is ON RECORD.
 *
 * WHY (Mark Sorrentino, +17163160886, 2026-08-05): a Dealer Lead App lead whose ADF says
 * "Demo Bikes Ridden: 2025,TOURING,ROAD GLIDE" got the draft "Thanks again for coming in for the
 * test ride on the Road Glide." — TRUE — and the live context-fidelity judge HELD it as
 * stale_intent ("Do not assume the customer has already done the test ride"). A real buyer got
 * silence. The judge's anchor carried modelOfRecord / leadType / appointmentBooked / dialogState and
 * NOTHING about whether a visit was established, so it could not tell a true ride reference from a
 * fabricated one.
 *
 * This EXECUTES the pure helpers (scripts/ is not covered by tsc, and a source-text assertion cannot
 * prove a predicate still returns the right answer). Both directions are pinned: the guard must keep
 * holding a fabricated visit (the Tim Williams class it was built for) while no longer holding a
 * ride the dealership itself logged.
 */
import {
  buildContextFidelityAnchor,
  decideContextFidelityHold
} from "../services/api/src/domain/contextFidelityHold.ts";
import { customerVisitConfirmed, dealerRecordedDemoRide } from "../services/api/src/domain/visitFraming.ts";

type Case = { name: string; actual: unknown; expected: unknown };

const MARK_ADF = [
  "WEB LEAD (ADF)",
  "Source: Dealer Lead App",
  "Name: Mark Sorrentino",
  "Year: 2025",
  "Vehicle: Harley-Davidson Road Glide",
  "",
  "Inquiry:",
  "Customer Comments: Stone Giuga Marketing Questions: Dealer Lead App - Type: Y SalesPerson: Stone Giuga",
  "- Which model of motorcycle are you interested in? 2025,TOURING,ROAD GLIDE",
  "Demo Bikes Ridden: 2025,TOURING,ROAD GLIDE Email Opt-In:Yes-"
].join("\n");

/** Same Dealer Lead App shape, but the salesperson recorded NO ride. */
const NO_DEMO_ADF = MARK_ADF.replace(
  "Demo Bikes Ridden: 2025,TOURING,ROAD GLIDE",
  "Demo Bikes Ridden: None recorded."
);

/** A plain web lead — never been in, no dealer record of any kind. */
const PLAIN_WEB_ADF = [
  "WEB LEAD (ADF)",
  "Source: Website",
  "Name: Tim Williams",
  "Vehicle: Harley-Davidson Street Glide 3 Limited"
].join("\n");

const convWith = (inboundBody: string, extra: Record<string, unknown> = {}) => ({
  id: "+15550001111",
  lead: { source: "Dealer Lead App", vehicle: { model: "Road Glide", year: "2025" } },
  dialogState: { name: "test_ride_init" },
  messages: [{ direction: "in", body: inboundBody }],
  ...extra
});

const cases: Case[] = [];

// ---- the miss itself: a dealer-logged demo ride must reach the judge as visit_confirmed --------
const markAnchor = buildContextFidelityAnchor(convWith(MARK_ADF));
cases.push({ name: "dealer-logged demo ride => anchor.visitConfirmed true", actual: markAnchor.visitConfirmed, expected: true });
cases.push({ name: "dealer-logged demo ride => dealerRecordedDemoRide true", actual: dealerRecordedDemoRide(convWith(MARK_ADF)), expected: true });

// The rest of the anchor must survive unchanged — this is an ADDITIVE field, not a rewrite.
cases.push({ name: "anchor keeps modelOfRecord", actual: markAnchor.modelOfRecord, expected: "Road Glide" });
cases.push({ name: "anchor keeps dialogState", actual: markAnchor.dialogState, expected: "test_ride_init" });
cases.push({ name: "anchor keeps appointmentBooked", actual: markAnchor.appointmentBooked, expected: false });

// ---- fail direction: nothing on record must stay FALSE ------------------------------------------
cases.push({
  name: "'None recorded.' is not a ride",
  actual: buildContextFidelityAnchor(convWith(NO_DEMO_ADF)).visitConfirmed,
  expected: false
});
cases.push({
  name: "plain web lead (Tim Williams class) is not a ride",
  actual: buildContextFidelityAnchor(convWith(PLAIN_WEB_ADF)).visitConfirmed,
  expected: false
});

// ---- the read-our-own-words trap: OUR outbound must never become the evidence -------------------
const ourOwnWords = {
  id: "+15550002222",
  lead: { source: "Website" },
  messages: [
    { direction: "in", body: "Do you have any Road Glides?" },
    { direction: "out", body: "Thanks again for coming in for the test ride. Demo Bikes Ridden: 2025,TOURING,ROAD GLIDE" }
  ]
};
cases.push({
  name: "our own outbound naming a demo ride is NOT evidence",
  actual: buildContextFidelityAnchor(ourOwnWords).visitConfirmed,
  expected: false
});

// ---- the established signals must still work ---------------------------------------------------
const showed = {
  id: "+15550003333",
  lead: { source: "Website" },
  appointment: { staffNotify: { outcome: { primaryStatus: "showed" } } },
  messages: [{ direction: "in", body: "See you then" }]
};
cases.push({ name: "a SHOWED outcome still confirms a visit", actual: buildContextFidelityAnchor(showed).visitConfirmed, expected: true });
cases.push({ name: "customerVisitConfirmed unchanged on the dealer-log lead", actual: customerVisitConfirmed(convWith(MARK_ADF)), expected: false });

// ---- the hold decision itself is untouched: this field informs the judge, it cannot force a hold --
cases.push({
  name: "a fabricated-visit hold still fires (guard preserved)",
  actual: decideContextFidelityHold({
    enabled: true,
    score: { verdict: "out_of_context", severity: "major", frame: "stale_intent", confidence: 0.9 }
  }).action,
  expected: "hold"
});
cases.push({
  name: "a faithful score still passes",
  actual: decideContextFidelityHold({
    enabled: true,
    score: { verdict: "faithful", severity: "minor", frame: "matches", confidence: 0.95 }
  }).action,
  expected: "pass"
});

let failed = 0;
for (const c of cases) {
  const ok = JSON.stringify(c.actual) === JSON.stringify(c.expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}${ok ? "" : ` — expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`}`);
}
console.log(`\ncontext_fidelity_visit_anchor: ${cases.length - failed}/${cases.length} passed`);
if (failed) process.exit(1);
