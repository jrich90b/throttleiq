/**
 * first_touch_autosend_shadow:report — read the SHADOW log of what the
 * first-touch auto-ack WOULD have sent (nothing was sent) so Joe can judge from
 * real messages whether it could ever be trusted to auto-send.
 *
 * Enable capture on the box: FIRST_TOUCH_ACK_AUTOSEND_DEBUG=1 in api.env + restart
 * (the LIVE-send flag FIRST_TOUCH_ACK_AUTOSEND stays OFF — debug is log-only).
 * Records land in reports/first_touch_autosend/first_touch_autosend_shadow.jsonl.
 *
 * Run: npm run first_touch_autosend_shadow:report [-- --dir <path>] [--limit N] [--all]
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Row = {
  at: string;
  convId: string | null;
  leadKey: string | null;
  leadName: string | null;
  model: string | null;
  leadSource: string | null;
  inbound: string | null;
  wouldSend: boolean;
  reason: string;
  ack: string;
  /** Absent on every row written before 2026-08-10 — those are UNKNOWN, never assumed live. */
  origin?: "live" | "replay";
};

/**
 * Which rows may be graded against the flip bar.
 *
 * `corpus_replay_nightly` shells out to `inbound_shadow_replay`, which runs each case against a
 * SANDBOX store but inherits the live REPORT_ROOT — so rehearsals of historical turns land in this
 * same file. Measured 2026-08-10: 722 would-send rows over 11 days against 46 real new leads (~15x),
 * with one lead (+15126299400, really texted once on 07-19) appearing as a would-send on ELEVEN
 * consecutive days. Graded naively that reads as a duplicate-send bug; it is a rehearsal counted as
 * a performance.
 *
 * Rows written before the origin stamp existed cannot be classified after the fact — timestamps
 * cannot do it, because the replay jobs run at several different hours and outnumber the ~4 real
 * leads/day. So they are UNKNOWN and excluded, which keeps the bar conservative: the flip waits for
 * clean evidence rather than being approved on contaminated evidence.
 */
export function gradableRows(rows: Row[]): { live: Row[]; replay: Row[]; unknown: Row[] } {
  const live: Row[] = [];
  const replay: Row[] = [];
  const unknown: Row[] = [];
  for (const r of rows) {
    if (r.origin === "live") live.push(r);
    else if (r.origin === "replay") replay.push(r);
    else unknown.push(r);
  }
  return { live, replay, unknown };
}

function parseArgs(argv: string[]): { dir: string; limit: number; all: boolean } {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const value = argv[i + 1];
    if (value && !value.startsWith("--")) {
      args.set(key, value);
      i += 1;
    } else {
      args.set(key, "true");
    }
  }
  const dir =
    args.get("--dir") ||
    process.env.FIRST_TOUCH_AUTOSEND_SHADOW_DIR ||
    path.resolve(process.cwd(), "reports", "first_touch_autosend");
  const limitRaw = Number(args.get("--limit") ?? "40");
  return {
    dir,
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 40,
    all: args.get("--all") === "true"
  };
}

function readRows(dir: string): Row[] {
  const file = path.join(dir, "first_touch_autosend_shadow.jsonl");
  if (!fs.existsSync(file)) return [];
  const rows: Row[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as Row);
    } catch {
      // skip malformed lines
    }
  }
  return rows;
}

function main(): void {
  const { dir, limit, all } = parseArgs(process.argv.slice(2));
  const rows = readRows(dir);
  if (!rows.length) {
    console.log(`No shadow records yet in ${dir}.`);
    console.log(
      "Turn capture on with FIRST_TOUCH_ACK_AUTOSEND_DEBUG=1 (api.env) + restart; the live send flag stays OFF."
    );
    return;
  }

  const split = gradableRows(rows);
  // Only LIVE rows describe what would really have gone to a customer.
  const gradable = split.live;
  const wouldSend = gradable.filter(r => r.wouldSend);
  const held = gradable.filter(r => !r.wouldSend);
  const reasonCounts = new Map<string, number>();
  for (const r of gradable) reasonCounts.set(r.reason, (reasonCounts.get(r.reason) ?? 0) + 1);

  console.log("=== First-touch auto-send SHADOW (nothing was sent) ===");
  console.log(`Source: ${path.join(dir, "first_touch_autosend_shadow.jsonl")}`);
  console.log(
    `Records: ${rows.length}  |  live: ${split.live.length}  |  replay (excluded): ${split.replay.length}` +
      `  |  unstamped/UNKNOWN (excluded): ${split.unknown.length}`
  );
  console.log(`LIVE rows — WOULD auto-send: ${wouldSend.length}  |  held for staff: ${held.length}`);
  if (split.unknown.length) {
    console.log(
      `NOTE: ${split.unknown.length} row(s) predate the origin stamp (2026-08-10) and cannot be told ` +
        `apart from replays. They are excluded from every count above — the flip bar must be graded ` +
        `on rows written after the stamp landed.`
    );
  }
  // Duplicate check, on LIVE rows only — the criterion that was being graded on replay traffic.
  const seen = new Map<string, number>();
  for (const r of wouldSend) {
    const key = String(r.convId ?? r.leadKey ?? "");
    if (key) seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1);
  console.log(`LIVE duplicate would-send leads: ${dupes.length}${dupes.length ? " -> " + dupes.map(([k, n]) => `${k} x${n}`).join(", ") : " (bar criterion 3: PASS so far)"}`);
  console.log("Reasons: " + [...reasonCounts.entries()].map(([r, c]) => `${r}=${c}`).join(", "));

  const show = all ? wouldSend : wouldSend.slice(-limit);
  console.log(`\n--- Messages it WOULD have auto-sent (${show.length}${all ? "" : ` of ${wouldSend.length}, newest`}) ---`);
  for (const r of show) {
    console.log(`\n[${r.at}] ${r.leadName ?? r.leadKey ?? r.convId ?? "?"}${r.model ? ` — ${r.model}` : ""}${r.leadSource ? ` (${r.leadSource})` : ""}`);
    if (r.inbound) console.log(`  customer: ${r.inbound}`);
    console.log(`  WOULD SEND: ${r.ack}`);
  }

  if (held.length) {
    const heldReasons = new Map<string, number>();
    for (const r of held) heldReasons.set(r.reason, (heldReasons.get(r.reason) ?? 0) + 1);
    console.log(`\n--- Held for staff (not auto-sent): ${held.length} ---`);
    console.log("  " + [...heldReasons.entries()].map(([r, c]) => `${r}=${c}`).join(", "));
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main();
