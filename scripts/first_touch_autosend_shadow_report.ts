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
};

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

  const wouldSend = rows.filter(r => r.wouldSend);
  const held = rows.filter(r => !r.wouldSend);
  const reasonCounts = new Map<string, number>();
  for (const r of rows) reasonCounts.set(r.reason, (reasonCounts.get(r.reason) ?? 0) + 1);

  console.log("=== First-touch auto-send SHADOW (nothing was sent) ===");
  console.log(`Source: ${path.join(dir, "first_touch_autosend_shadow.jsonl")}`);
  console.log(`Records: ${rows.length}  |  WOULD auto-send: ${wouldSend.length}  |  held for staff: ${held.length}`);
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
