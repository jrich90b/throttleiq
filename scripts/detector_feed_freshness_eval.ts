/**
 * Detector-feed freshness eval — pins that a work order built on DEAD detector feeds says so.
 *
 * THE MISS THIS GUARDS (measured 2026-08-18). `anomaly_loop_detect` merges nine feeds and stamps the
 * result `generatedAt: now`. Four of them — including the primary `outcome_audit` — had last written
 * 29 hours earlier (the 08:50-08:54 UTC crons died inside a deploy's `npm install`), and one had not
 * written in five days. `act_runner list` printed a normal queue and, on an empty one, would have
 * printed "the loop is healthy". Two loop ticks triaged a day-old world believing it was current.
 *
 * This eval EXECUTES both scripts against a synthetic report root (SKILL trap 3: a source-text
 * assertion cannot prove a script still runs — the watchdog that died with a ReferenceError kept
 * every pure assertion green). Clock-safe: every fixture timestamp is built relative to `now`, so it
 * cannot go red at midnight.
 *
 * Run: npx tsx scripts/detector_feed_freshness_eval.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DETECTOR_FEED_CYCLE_SPREAD_HOURS_DEFAULT,
  DETECTOR_FEED_STALE_HOURS_DEFAULT,
  describeDetectorFeed,
  formatStaleDetectorFeedBanner,
  resolveCycleSpreadHours,
  resolveStaleHours,
  summarizeDetectorFeeds
} from "./detectorFeedFreshness.ts";

const NOW_MS = Date.parse("2026-08-18T13:40:00.000Z");
const hoursAgo = (h: number) => NOW_MS - h * 60 * 60 * 1000;
const isoHoursAgo = (h: number) => new Date(hoursAgo(h)).toISOString();

// ---------------------------------------------------------------------------
// 1. The pure math — the real box readings from 2026-08-18, as measured.
// ---------------------------------------------------------------------------
const boxFeeds = [
  { name: "outcome-audit (primary)", file: "/r/outcome_audit/latest.json", present: true, generatedAt: isoHoursAgo(28.8), findings: 40 },
  { name: "open-critic (discovery)", file: "/r/open_critic/latest.json", present: true, generatedAt: isoHoursAgo(28.8), findings: 3 },
  { name: "watch-fire-miss", file: "/r/watch_fire_miss/latest.json", present: true, generatedAt: isoHoursAgo(28.8), findings: 2 },
  { name: "operator-reported (ops anomaly)", file: "/r/ops_anomaly/latest.json", present: true, generatedAt: isoHoursAgo(28.8), findings: 92 },
  { name: "intent-handled (comprehension)", file: "/r/intent_handled/anomalies.json", present: true, generatedAt: isoHoursAgo(121), findings: 0 },
  { name: "thumbs-down staff action", file: "/r/thumbs_down_action/latest.json", present: true, generatedAt: isoHoursAgo(5.0), findings: 1 },
  { name: "mdf-portal-health", file: "/r/mdf_health/latest.json", present: true, generatedAt: isoHoursAgo(4.7), findings: 1 },
  { name: "fabricated-frame (comprehension)", file: "/r/fabricated_frame/latest.json", present: true, generatedAt: isoHoursAgo(5.3), findings: 0 },
  { name: "corpus-replay (offline flywheel)", file: "/r/corpus_replay/latest.json", present: true, generatedAt: isoHoursAgo(3.7), findings: 36 }
];
const boxSummary = summarizeDetectorFeeds(boxFeeds, { nowMs: NOW_MS });
assert.equal(
  boxSummary.staleSources.length,
  5,
  "the 2026-08-18 box reading: four day-old feeds plus the five-day-old intent-handled feed are stale"
);
assert.deepEqual(
  boxSummary.staleSources.map(s => s.name).sort(),
  [
    "intent-handled (comprehension)",
    "open-critic (discovery)",
    "operator-reported (ops anomaly)",
    "outcome-audit (primary)",
    "watch-fire-miss"
  ],
  "exactly the feeds whose crons died — the four healthy same-morning feeds must NOT alarm"
);
assert.equal(boxSummary.oldestAgeHours, 121, "the work order's honest age is its OLDEST input, not its own stamp");

// A healthy morning: every feed inside the daily bound ⇒ silence. A false alarm every day would
// train the reader to skip the banner, which is the same failure as not having one.
const healthy = summarizeDetectorFeeds(
  boxFeeds.map(f => ({ ...f, generatedAt: isoHoursAgo(5) })),
  { nowMs: NOW_MS }
);
assert.equal(healthy.staleSources.length, 0, "a morning where every cron ran must produce zero stale feeds");
assert.equal(formatStaleDetectorFeedBanner(healthy), null, "a healthy run prints nothing at all");

// ---------------------------------------------------------------------------
// 2. Fail direction — an INSTRUMENT fails toward warning, not toward silence.
// ---------------------------------------------------------------------------
const undatable = describeDetectorFeed(
  { name: "no-stamp", file: "/r/x/latest.json", present: true, generatedAt: null, mtimeMs: null },
  { nowMs: NOW_MS }
);
assert.equal(undatable.stale, true, "a PRESENT feed whose age cannot be established reads STALE, never fresh");
assert.match(String(undatable.staleReason), /undatable/i, "and it says why in plain words");

const absent = describeDetectorFeed({ name: "optional", file: "/r/none/latest.json", present: false }, { nowMs: NOW_MS });
assert.equal(absent.stale, false, "an ABSENT optional feed contributed nothing and claims nothing — never an alarm");

const mtimeOnly = describeDetectorFeed(
  { name: "mtime-only", file: "/r/x/latest.json", present: true, generatedAt: null, mtimeMs: hoursAgo(30) },
  { nowMs: NOW_MS }
);
assert.equal(mtimeOnly.stampSource, "mtime", "a feed carrying no generatedAt is still datable by file mtime");
assert.equal(mtimeOnly.stale, true, "…and a 30h-old mtime is stale");

const future = describeDetectorFeed(
  { name: "clock-skew", file: "/r/x/latest.json", present: true, generatedAt: isoHoursAgo(-6) },
  { nowMs: NOW_MS }
);
assert.equal(future.ageHours, 0, "a future stamp is a broken clock, clamped to 0 — never a negative age");
assert.equal(future.stale, false, "…and clamping must not manufacture an alarm");

// The boundary is the DAILY bound, and it is exclusive: exactly at the bound is not yet a miss.
assert.equal(
  describeDetectorFeed({ name: "b", file: "f", present: true, generatedAt: isoHoursAgo(DETECTOR_FEED_STALE_HOURS_DEFAULT) }, { nowMs: NOW_MS }).stale,
  false,
  "a feed exactly at the bound is not yet stale"
);
assert.equal(
  describeDetectorFeed({ name: "b", file: "f", present: true, generatedAt: isoHoursAgo(DETECTOR_FEED_STALE_HOURS_DEFAULT + 0.5) }, { nowMs: NOW_MS }).stale,
  true,
  "half an hour past the bound is"
);

// The env override widens for a slower dealer cron; junk must never DISABLE the check.
assert.equal(resolveStaleHours({ DETECTOR_FEED_STALE_HOURS: "48" }), 48, "a valid override is honoured");
assert.equal(resolveStaleHours({ DETECTOR_FEED_STALE_HOURS: "nonsense" }), DETECTOR_FEED_STALE_HOURS_DEFAULT, "junk falls back to the default");
assert.equal(resolveStaleHours({ DETECTOR_FEED_STALE_HOURS: "0" }), DETECTOR_FEED_STALE_HOURS_DEFAULT, "0 would alarm on everything — refused");
assert.equal(resolveStaleHours({}), DETECTOR_FEED_STALE_HOURS_DEFAULT, "unset falls back to the default");

// ---------------------------------------------------------------------------
// 2b. THE HOLE IN THE ABSOLUTE BOUND — the real 2026-08-22 reading.
//
// The same cron-vs-deploy failure recurred: a deploy at 08:45 UTC blew away node_modules and the
// 08:50/08:52/08:53/08:54 sweeps died with ERR_MODULE_NOT_FOUND. But this time the work order was
// built at 08:55 and read at 09:02, so the dead feeds measured 24.1-24.2h — UNDER the 26h bound.
// `staleFeedCount` read 0 and forty hours of operator reports and draft-review rewrites were
// invisible. These are the measured ages, to the tenth of an hour, off the box.
// ---------------------------------------------------------------------------
const AUG22_NOW_MS = Date.parse("2026-08-22T09:02:00.000Z");
const aug22HoursAgo = (h: number) => new Date(AUG22_NOW_MS - h * 60 * 60 * 1000).toISOString();
const aug22Feeds = [
  { name: "outcome-audit (primary)", file: "/r/outcome_audit/latest.json", present: true, generatedAt: aug22HoursAgo(24.2), findings: 38 },
  { name: "open-critic (discovery)", file: "/r/open_critic/latest.json", present: true, generatedAt: aug22HoursAgo(24.1), findings: 0 },
  { name: "watch-fire-miss", file: "/r/watch_fire_miss/latest.json", present: true, generatedAt: aug22HoursAgo(24.1), findings: 4 },
  { name: "operator-reported (ops anomaly)", file: "/r/ops_anomaly/latest.json", present: true, generatedAt: aug22HoursAgo(24.1), findings: 133 },
  { name: "corpus-replay (offline flywheel)", file: "/r/corpus_replay/latest.json", present: true, generatedAt: aug22HoursAgo(23.3), findings: 31 },
  { name: "intent-handled (comprehension)", file: "/r/intent_handled/anomalies.json", present: true, generatedAt: aug22HoursAgo(0.2), findings: 0 },
  { name: "thumbs-down staff action", file: "/r/thumbs_down_action/latest.json", present: true, generatedAt: aug22HoursAgo(0.3), findings: 2 },
  { name: "mdf-portal-health", file: "/r/mdf_health/latest.json", present: true, generatedAt: aug22HoursAgo(0.0), findings: 0 },
  { name: "fabricated-frame (comprehension)", file: "/r/fabricated_frame/latest.json", present: true, generatedAt: aug22HoursAgo(0.6), findings: 0 }
];

// FIRST, pin the hole itself — so nobody ever "simplifies" this back to one rule. Every dead feed
// passes the absolute bound cleanly; it is not a matter of a slightly-too-generous number.
for (const f of aug22Feeds.slice(0, 5)) {
  assert.equal(
    describeDetectorFeed(f, { nowMs: AUG22_NOW_MS }).stale,
    false,
    `the ${f.name} feed is under the ${DETECTOR_FEED_STALE_HOURS_DEFAULT}h absolute bound — a daily feed read just after its window is ~24h old whether it ran or not`
  );
}

const aug22 = summarizeDetectorFeeds(aug22Feeds, { nowMs: AUG22_NOW_MS });
assert.deepEqual(
  aug22.staleSources.map(s => s.name).sort(),
  [
    "corpus-replay (offline flywheel)",
    "open-critic (discovery)",
    "operator-reported (ops anomaly)",
    "outcome-audit (primary)",
    "watch-fire-miss"
  ],
  "the four feeds whose crons died are named, plus corpus-replay, whose 05:00 run had not yet written at 09:02"
);
for (const s of aug22.staleSources) {
  assert.match(String(s.staleReason), /missed a detector cycle/i, "each says WHICH rule fired, in plain words");
}
assert.equal(
  aug22.sources.filter(s => !s.stale).length,
  4,
  "the four feeds that ran this morning must NOT alarm — a banner that fires on healthy feeds trains the reader to skip it"
);

// NOW-INDEPENDENCE is the property that makes this rule work where the absolute one cannot: the
// relative rule compares feeds to EACH OTHER, so the verdict at 08:55 (when anomaly_loop_detect
// bakes it into next.json) is identical to the verdict at 09:02 (when act_runner re-derives it),
// and identical again at 16:00.
for (const readAt of ["2026-08-22T08:55:00.000Z", "2026-08-22T16:00:00.000Z"]) {
  const later = summarizeDetectorFeeds(aug22Feeds, { nowMs: Date.parse(readAt) });
  assert.deepEqual(
    later.staleSources.map(s => s.name).sort(),
    aug22.staleSources.map(s => s.name).sort(),
    `the same feeds read at ${readAt} must produce the same verdict — the rule cannot depend on when it is run`
  );
}

// HONEST LIMIT, stated so nobody mistakes it for coverage: when the WHOLE chain dies on the same
// day there is no fresh sibling to measure against, and the relative rule says nothing. That case
// belongs to the absolute bound and to the work order's own generatedAt, not to this rule.
const allDead = summarizeDetectorFeeds(
  aug22Feeds.map(f => ({ ...f, generatedAt: aug22HoursAgo(24.1) })),
  { nowMs: AUG22_NOW_MS }
);
assert.equal(allDead.staleSources.length, 0, "a uniformly dead chain has no spread to detect — documented limit, not a bug");

// A single feed cannot be compared to anything, so it never alarms on the relative rule alone.
const lonely = summarizeDetectorFeeds([aug22Feeds[0]], { nowMs: AUG22_NOW_MS });
assert.equal(lonely.staleSources.length, 0, "one feed has no siblings — the relative rule needs at least two");

// The same-cycle bound is exclusive at the boundary, and its env override behaves like the other.
const spreadProbe = (behindHours: number, cycleSpreadHours?: number) =>
  summarizeDetectorFeeds(
    [
      { name: "fresh", file: "f", present: true, generatedAt: aug22HoursAgo(0) },
      { name: "behind", file: "b", present: true, generatedAt: aug22HoursAgo(behindHours) }
    ],
    { nowMs: AUG22_NOW_MS, cycleSpreadHours }
  ).staleSources.map(s => s.name);
assert.deepEqual(spreadProbe(DETECTOR_FEED_CYCLE_SPREAD_HOURS_DEFAULT), [], "exactly at the same-cycle bound is not yet a miss");
assert.deepEqual(spreadProbe(DETECTOR_FEED_CYCLE_SPREAD_HOURS_DEFAULT + 0.5), ["behind"], "half an hour past it is");
assert.deepEqual(spreadProbe(12, 24), [], "a dealer with a wider detector block widens the bound");
assert.equal(resolveCycleSpreadHours({ DETECTOR_FEED_CYCLE_SPREAD_HOURS: "12" }), 12, "a valid override is honoured");
assert.equal(resolveCycleSpreadHours({ DETECTOR_FEED_CYCLE_SPREAD_HOURS: "nonsense" }), DETECTOR_FEED_CYCLE_SPREAD_HOURS_DEFAULT, "junk falls back to the default");
assert.equal(resolveCycleSpreadHours({ DETECTOR_FEED_CYCLE_SPREAD_HOURS: "0" }), DETECTOR_FEED_CYCLE_SPREAD_HOURS_DEFAULT, "0 would alarm on everything — refused");
assert.equal(resolveCycleSpreadHours({}), DETECTOR_FEED_CYCLE_SPREAD_HOURS_DEFAULT, "unset falls back to the default");

// A feed already stale by the absolute bound keeps ITS reason — the new rule only ever adds.
const mixed = summarizeDetectorFeeds(
  [
    { name: "fresh", file: "f", present: true, generatedAt: aug22HoursAgo(0) },
    { name: "ancient", file: "a", present: true, generatedAt: aug22HoursAgo(121) }
  ],
  { nowMs: AUG22_NOW_MS }
);
assert.match(
  String(mixed.staleSources.find(s => s.name === "ancient")?.staleReason),
  /over the 26h daily bound/,
  "the absolute rule still owns the feeds it already caught"
);

// ---------------------------------------------------------------------------
// 3. EXECUTION — run both scripts end to end against a synthetic report root.
// ---------------------------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), "detector-feed-freshness-"));
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
function writeFeed(dir: string, file: string, generatedAt: string, anomalies: any[]): void {
  const d = path.join(root, dir);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, file), JSON.stringify({ generatedAt, anomalies }, null, 2));
  // The mtime is NOW either way; the stale reading must come from the feed's own stamp.
}
const anomaly = (convId: string, dimension: string) => ({
  convId,
  leadKey: convId,
  dimension,
  category: "comprehension",
  severity: "P2",
  healed: false,
  detail: `synthetic ${dimension}`,
  occurredAt: isoHoursAgo(2)
});

// The primary feed is a DAY old (the real 2026-08-18 shape); one sibling ran this morning.
writeFeed("outcome_audit", "latest.json", new Date(Date.now() - 29 * 3600 * 1000).toISOString(), [anomaly("+15550000001", "intent_unaddressed")]);
writeFeed("ops_anomaly", "latest.json", new Date(Date.now() - 29 * 3600 * 1000).toISOString(), [anomaly("+15550000002", "reported_issue")]);
writeFeed("corpus_replay", "latest.json", new Date(Date.now() - 3 * 3600 * 1000).toISOString(), []);

// spawnSync, not execFileSync: execFileSync only hands back stderr on FAILURE, and every assertion
// below is about what a SUCCESSFUL run prints on stderr. Captured status, never a pipe (SKILL trap 1).
function run(script: string, args: string[] = []): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("npx", ["tsx", path.join(repoRoot, "scripts", script), ...args], {
    encoding: "utf8",
    cwd: repoRoot,
    env: { ...process.env, REPORT_ROOT: root }
  });
  return { stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? ""), status: Number(r.status ?? 1) };
}

const detect = run("anomaly_loop_detect.ts");
assert.equal(detect.status, 0, `anomaly_loop_detect must RUN, not just typecheck — exit ${detect.status}\n${detect.stderr}`);
const nextPath = path.join(root, "anomaly_loop", "next.json");
assert.ok(fs.existsSync(nextPath), "it writes the work order");
const payload = JSON.parse(fs.readFileSync(nextPath, "utf8"));

assert.ok(Array.isArray(payload.feedSources), "next.json records provenance for every input feed");
const byName = new Map<string, any>(payload.feedSources.map((s: any) => [s.name, s]));
assert.equal(byName.get("outcome-audit (primary)")?.stale, true, "the day-old PRIMARY feed is recorded stale");
assert.equal(byName.get("operator-reported (ops anomaly)")?.stale, true, "the day-old ops feed is recorded stale");
assert.equal(byName.get("corpus-replay (offline flywheel)")?.stale, false, "the feed that ran this morning is not");
assert.equal(byName.get("fabricated-frame (comprehension)")?.present, false, "a feed absent from this root is recorded absent");
assert.equal(byName.get("fabricated-frame (comprehension)")?.stale, false, "…and absent is never an alarm");
assert.equal(payload.staleFeedCount, 2, "the stale count is the two dead feeds, not the absent ones");
assert.ok(Number(payload.oldestFeedAgeHours) >= 28, "oldestFeedAgeHours reports the honest age of the work order");
assert.ok(
  detect.stderr.includes("DETECTOR FEEDS ARE STALE"),
  "the detect run itself warns loudly on stderr"
);

// `act_runner list` is what the loop actually reads (its SKILL forbids cat-ing next.json).
const list = run("act_runner.ts", ["list"]);
assert.ok(
  list.stderr.includes("DETECTOR FEEDS ARE STALE"),
  `act_runner list must carry the banner — the loop never reads next.json directly\n${list.stdout}\n${list.stderr}`
);
assert.ok(list.stderr.includes("outcome-audit (primary)"), "the banner NAMES the dead feeds");
assert.ok(
  /INVISIBLE|not evidence of a\s*\n?\s*quiet store/.test(list.stderr),
  "…and says what it means: an empty queue is not evidence of a quiet store"
);

// THE CASE IT EXISTS FOR: an EMPTY queue on dead feeds must warn BEFORE the "loop is healthy" exit.
// (Before this change that early return fired first and the banner never printed.)
fs.writeFileSync(nextPath, JSON.stringify({ ...payload, workOrders: [] }, null, 2));
const emptyList = run("act_runner.ts", ["list"]);
assert.ok(
  emptyList.stdout.includes("No work orders"),
  "an empty queue still reports empty"
);
assert.ok(
  emptyList.stderr.includes("DETECTOR FEEDS ARE STALE"),
  "…but the stale-feed banner prints FIRST — a dead detector chain must never read as a quiet store"
);

// THE 2026-08-22 SHAPE, END TO END: a work order that BAKED IN `stale: false` for a feed that had
// missed a cycle. `act_runner list` must re-derive from each feed's stored `stampedAt` and warn
// anyway — trusting the baked flag is what carried a dead ops-anomaly feed all day.
const bakedFreshPath = path.join(root, "anomaly_loop", "next.json");
fs.writeFileSync(
  bakedFreshPath,
  JSON.stringify(
    {
      ...payload,
      workOrders: [],
      staleFeedCount: 0,
      staleFeeds: [],
      feedSources: [
        {
          name: "operator-reported (ops anomaly)",
          file: "/r/ops_anomaly/latest.json",
          present: true,
          stampedAt: new Date(Date.now() - 24.1 * 3600 * 1000).toISOString(),
          stampSource: "generatedAt",
          findings: 133,
          ageHours: 24.1,
          stale: false
        },
        {
          name: "mdf-portal-health",
          file: "/r/mdf_health/latest.json",
          present: true,
          stampedAt: new Date(Date.now() - 0.2 * 3600 * 1000).toISOString(),
          stampSource: "generatedAt",
          findings: 0,
          ageHours: 0.2,
          stale: false
        }
      ]
    },
    null,
    2
  )
);
const bakedList = run("act_runner.ts", ["list"]);
assert.ok(
  bakedList.stderr.includes("DETECTOR FEEDS ARE STALE"),
  `act_runner must RE-DERIVE freshness at read time, not trust the flag the work order baked in\n${bakedList.stderr}`
);
assert.ok(
  bakedList.stderr.includes("operator-reported (ops anomaly)"),
  "…and name the feed that actually missed the cycle"
);
assert.ok(
  bakedList.stderr.includes("1 of 2 input feed(s) did not run"),
  "…without dragging in the sibling that ran on time (it appears only as the feed being compared AGAINST)"
);

// A work order written before this provenance existed must not crash or invent an alarm.
fs.writeFileSync(nextPath, JSON.stringify({ ...payload, feedSources: undefined, staleFeedCount: undefined, workOrders: [] }, null, 2));
const legacyList = run("act_runner.ts", ["list"]);
assert.equal(legacyList.status, 0, "a pre-provenance work order still lists cleanly");
assert.ok(!legacyList.stderr.includes("DETECTOR FEEDS ARE STALE"), "…and claims nothing it cannot know");

fs.rmSync(root, { recursive: true, force: true });

console.log("detector_feed_freshness_eval: PASS — provenance recorded, stale feeds named, empty queue warns first");
