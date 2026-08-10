/**
 * first_touch_shadow_origin:eval — a shadow row must say whether it was real (2026-08-10).
 *
 * WHY. The flip bar for FIRST_TOUCH_ACK_AUTOSEND is graded off the first-touch shadow JSONL, and one
 * criterion is "zero duplicates" — the same lead must never be acked twice. That file is written by
 * BOTH the live inbound path and `corpus_replay_nightly`, which shells out to `inbound_shadow_replay`
 * and runs each case against a SANDBOX store while inheriting the live REPORT_ROOT.
 *
 * A replay is a thread rewound to before we answered, so it always says "would send", and it says it
 * again the next night. Measured on the live corpus 2026-08-10:
 *
 *     722 would-send rows over 11 days   vs   46 real new leads in the same window (~15x)
 *     +15126299400 (really texted ONCE, 2026-07-19) appears as would-send on 11 consecutive days
 *
 * Graded naively that reads as a duplicate-send bug in the auto-send guard. It is not — it is a
 * rehearsal counted as a performance. I reported it as a live defect before checking what wrote the
 * rows; this eval exists so the next reader cannot repeat that.
 *
 * Timestamps cannot separate them after the fact (the replay jobs run at several hours and outnumber
 * the ~4 real leads/day), so the row must carry its own origin, and rows written before the stamp
 * are UNKNOWN — never assumed live.
 */
import assert from "node:assert/strict";
import {
  buildFirstTouchShadowRecord,
  firstTouchShadowOrigin,
  type FirstTouchShadowOrigin
} from "../services/api/src/domain/firstTouchAutoSend.ts";
import { gradableRows } from "./first_touch_autosend_shadow_report.ts";

// ── 1. The signal: what the replay harness actually sets ───────────────────────────────
{
  // buildShadowApiEnv (scripts/inbound_shadow_replay.ts) pins NODE_ENV=shadow for every replayed
  // case. That is the value this classification rides on.
  assert.equal(firstTouchShadowOrigin({ NODE_ENV: "shadow" } as any), "replay", "a replayed case is a replay");
  assert.equal(firstTouchShadowOrigin({ NODE_ENV: "test" } as any), "replay", "a test run is not a customer");
  assert.equal(firstTouchShadowOrigin({ NODE_ENV: "production" } as any), "live", "production is live");
  assert.equal(firstTouchShadowOrigin({} as any), "live", "a normally-booted API is live");
  // The escape hatch for a future harness that cannot set NODE_ENV.
  assert.equal(
    firstTouchShadowOrigin({ NODE_ENV: "production", FIRST_TOUCH_SHADOW_ORIGIN: "replay" } as any),
    "replay",
    "an explicit override can force replay"
  );
  // …but it must not be able to force the UNSAFE direction.
  assert.equal(
    firstTouchShadowOrigin({ NODE_ENV: "shadow", FIRST_TOUCH_SHADOW_ORIGIN: "live" } as any),
    "replay",
    "nothing may relabel a replay as live — that is how the corpus got contaminated"
  );
}

// ── 2. Every record carries the stamp ──────────────────────────────────────────────────
{
  const base = {
    at: "2026-08-10T05:21:15.929Z",
    convId: "+15126299400",
    leadKey: "+15126299400",
    ackText: "Hey Layla, it's Alexandra over at American Harley-Davidson.",
    decision: { send: true, reason: "first_touch_deterministic_ack" }
  };
  assert.equal(buildFirstTouchShadowRecord({ ...base, origin: "replay" }).origin, "replay");
  assert.equal(buildFirstTouchShadowRecord({ ...base, origin: "live" }).origin, "live");
  const stamped = buildFirstTouchShadowRecord(base as any);
  assert.ok(
    stamped.origin === "live" || stamped.origin === "replay",
    "a record is never written without an origin"
  );
}

// ── 3. Grading excludes replays AND unstamped history ──────────────────────────────────
{
  const row = (origin: FirstTouchShadowOrigin | undefined, convId: string, wouldSend = true) =>
    ({ at: "2026-08-10T05:21:15.929Z", convId, leadKey: convId, leadName: null, model: null,
       leadSource: null, inbound: null, wouldSend, reason: "first_touch_deterministic_ack",
       ack: "x", ...(origin ? { origin } : {}) }) as any;

  const split = gradableRows([
    row("live", "+1111"),
    row("replay", "+2222"),
    row(undefined, "+3333") // written before the stamp existed
  ]);
  assert.equal(split.live.length, 1, "only the live row is gradable");
  assert.equal(split.replay.length, 1, "the replay is set aside, not counted");
  assert.equal(split.unknown.length, 1, "an unstamped row is UNKNOWN");
  assert.equal(split.live[0].convId, "+1111");
  // The fail direction that matters: an unstamped row must NEVER be graded as live.
  assert.ok(
    !split.live.some(r => r.convId === "+3333"),
    "unstamped history must not be graded as live — assuming otherwise re-contaminates the bar"
  );
}

// ── 4. Layla's real shape: eleven rehearsals must not read as eleven duplicates ─────────
{
  // Her thread carries exactly one real send (2026-07-19, provider twilio). The nightly replay
  // rewinds past it, so the same would-send row appears every night.
  const rehearsals = Array.from({ length: 11 }, (_, i) =>
    ({ at: `2026-08-${String(i + 1).padStart(2, "0")}T05:21:15.929Z`, convId: "+15126299400",
       leadKey: "+15126299400", leadName: "Layla", model: null, leadSource: "Ride Challenge",
       inbound: null, wouldSend: true, reason: "first_touch_deterministic_ack", ack: "Hey Layla…",
       origin: "replay" }) as any
  );
  const split = gradableRows(rehearsals);
  assert.equal(split.live.length, 0, "eleven rehearsals of one turn contribute ZERO live rows");
  assert.equal(split.replay.length, 11);

  // And the same eleven rows, if they HAD been live, must still be visible as duplicates — the
  // filter must not be so blunt that it hides a genuine repeat.
  const asLive = rehearsals.map(r => ({ ...r, origin: "live" }));
  const liveSplit = gradableRows(asLive);
  const counts = new Map<string, number>();
  for (const r of liveSplit.live.filter(r => r.wouldSend)) {
    counts.set(String(r.convId), (counts.get(String(r.convId)) ?? 0) + 1);
  }
  assert.equal(counts.get("+15126299400"), 11, "a genuine live repeat is still counted as a duplicate");
}

console.log("first_touch_shadow_origin:eval PASS");
