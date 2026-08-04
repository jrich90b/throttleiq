/**
 * merge_freeze — CLI over domain/mergeFreeze.ts. Owns the filesystem and the clock; the decision
 * itself is pure and eval-pinned (`merge_freeze:eval`).
 *
 * Every routine that MERGES calls `check` first. Routines that only build/review/report ignore this
 * entirely and keep working — a freeze pauses LANDING, not thinking.
 *
 *   npx tsx scripts/merge_freeze.ts check                 # exit 0 = free to merge, exit 3 = FROZEN
 *   npx tsx scripts/merge_freeze.ts take --owner <name> --reason "<why>"
 *   npx tsx scripts/merge_freeze.ts release --owner <name>
 *   npx tsx scripts/merge_freeze.ts status               # human-readable, always exit 0
 *
 * Exit codes are the contract (`check`): 0 free, 3 frozen. Anything unexpected also exits 0 — an
 * ambiguous freeze must never be the reason a routine stops landing work.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MERGE_FREEZE_MAX_AGE_MINUTES,
  describeMergeFreeze,
  evaluateMergeFreeze,
  type MergeFreezeRecord
} from "../services/api/src/domain/mergeFreeze.ts";

const FREEZE_DIR = process.env.MERGE_FREEZE_DIR || path.join(os.tmpdir(), "throttleiq-merge-freeze");
const RECORD = path.join(FREEZE_DIR, "freeze.json");
const MAX_AGE = Number(process.env.MERGE_FREEZE_MAX_AGE_MIN ?? DEFAULT_MERGE_FREEZE_MAX_AGE_MINUTES);

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? String(process.argv[i + 1]) : fallback;
}

function readRecord(): unknown {
  if (!fs.existsSync(FREEZE_DIR)) return null;
  try {
    return JSON.parse(fs.readFileSync(RECORD, "utf8"));
  } catch {
    // The directory exists but the record is missing/corrupt. Fail toward ALLOWING merges.
    return { malformed: true };
  }
}

function status() {
  return evaluateMergeFreeze(readRecord(), { nowMs: Date.now(), maxAgeMinutes: MAX_AGE });
}

function main(): void {
  const cmd = String(process.argv[2] ?? "status").trim();

  if (cmd === "check" || cmd === "status") {
    const s = status();
    console.log(describeMergeFreeze(s));
    process.exit(cmd === "check" && s.frozen ? 3 : 0);
  }

  if (cmd === "take") {
    const owner = arg("--owner").trim();
    if (!owner) {
      console.error("merge_freeze take: --owner is required");
      process.exit(2);
    }
    const existing = status();
    if (existing.frozen && existing.owner !== owner) {
      console.error(describeMergeFreeze(existing));
      process.exit(3); // someone else holds it — do not steal
    }
    fs.mkdirSync(FREEZE_DIR, { recursive: true });
    const record: MergeFreezeRecord = {
      owner,
      at: new Date().toISOString(),
      reason: arg("--reason", "release gate in progress")
    };
    fs.writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`merge freeze TAKEN by ${owner} — expires in ${MAX_AGE}m. Release it on every exit path.`);
    process.exit(0);
  }

  if (cmd === "release") {
    const owner = arg("--owner").trim();
    const s = status();
    if (s.frozen && owner && s.owner !== owner) {
      // Releasing someone else's live freeze would silently unblock a gate mid-proof.
      console.error(`merge freeze is held by ${s.owner}, not ${owner} — refusing to release it.`);
      process.exit(3);
    }
    fs.rmSync(FREEZE_DIR, { recursive: true, force: true });
    console.log("merge freeze released — merging is allowed");
    process.exit(0);
  }

  console.error(`merge_freeze: unknown command "${cmd}" (check | take | release | status)`);
  process.exit(2);
}

const isEntry = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) main();
