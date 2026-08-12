/**
 * Ladder-health sweep — "is each lead lane still ADVANCING leads?" (Joe, 2026-08-11).
 *
 * Read-only. Counts, per lead source, how many first touches ASKED the customer anything, and
 * compares the recent window against the lane's own history. A lane that drops from 90% asking to 5%
 * is a broken ladder, and no existing net sees it: they all ask "was this reply wrong?", and a reply
 * that simply never advances the lead looks perfectly fine on its own.
 *
 * Run (local):  npx tsx scripts/ladder_health_sweep.ts
 * Run (box):
 *   CONVERSATIONS_DB_PATH=/home/ubuntu/leadrider-runtime/americanharley/data/conversations.json \
 *   REPORT_ROOT=/home/ubuntu/leadrider-runtime/americanharley/reports \
 *   npx tsx scripts/ladder_health_sweep.ts
 *
 * Never mutates the store. Writes reports/ladder_health/latest.json.
 * EXIT CODE IS ALWAYS 0 — this reports, it never gates. See the module header for the fail direction.
 */
import fs from "node:fs";
import path from "node:path";

const dbPath = path.resolve(process.env.CONVERSATIONS_DB_PATH || "data/conversations.json");
const raw = JSON.parse(fs.readFileSync(dbPath, "utf8"));
const conversations: any[] = Array.isArray(raw?.conversations) ? raw.conversations : Array.isArray(raw) ? raw : [];

const { assessLadderHealth } = await import("../services/api/src/domain/ladderHealth.ts");
const report = assessLadderHealth({ conversations, now: new Date() });

const reportRoot = process.env.REPORT_ROOT || path.resolve("reports");
const outDir = path.join(reportRoot, "ladder_health");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "latest.json");
fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), source: dbPath, ...report }, null, 2));

const pct = (v: number | null) => (v == null ? "  — " : `${String(Math.round(v * 100)).padStart(3)}%`);
console.log(
  `Ladder health — last ${report.windowDays}d vs the ${report.baselineDays}d before it. ` +
    `${report.summary.lanesScanned} lanes, ${report.summary.leadsRecent} leads, ` +
    `${report.summary.askedRecent} of ${report.summary.agentFirstTouchesRecent} agent-owned first touches asked something, ` +
    `${report.summary.bookedRecent} booked.`
);
console.log(
  `  (${report.summary.staffFirstTouchesRecent} first touches were typed by staff and ` +
    `${report.summary.neverTextedRecent} leads were never texted — counted, never graded.)`
);
// The columns ARE the diagnosis, and each sends you to a different building:
//   reach 0             → a broken lead feed: nobody to send to
//   staff > ours        → a lane a salesperson opens; our copy is not what it reads
//   ours healthy, 0%    → a missing ladder, and the fix is the copy
console.log("\n  recent  reach   ours  staff  none  asked  replied  booked | was  | source");
for (const lane of report.lanes) {
  if (lane.recent.leads === 0) continue;
  console.log(
    `  ${String(lane.recent.leads).padStart(6)}  ${String(lane.recent.contactable).padStart(5)}  ` +
      `${String(lane.recent.agentFirstTouches).padStart(5)}  ${String(lane.recent.staffFirstTouches).padStart(5)}  ` +
      `${String(lane.recent.neverTexted).padStart(4)}  ${pct(lane.askRateRecent)}  ` +
      `${String(lane.recent.replied).padStart(7)}  ${String(lane.recent.booked).padStart(6)} | ${pct(lane.askRateBaseline)} | ` +
      `${lane.alarm ? "⚠ " : "  "}${lane.source}`
  );
}
if (report.alarms.length) {
  console.log(`\n${report.alarms.length} LANE(S) NEED A LOOK:`);
  for (const a of report.alarms) console.log(`  - [${a.alarm}] ${a.source}: ${a.why}`);
} else {
  console.log("\nNo lane alarms.");
}
console.log(`\nReport written: ${outPath}`);
