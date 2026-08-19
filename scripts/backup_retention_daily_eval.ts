/**
 * Backup retention: ONE snapshot per calendar day, kept for two years — EXECUTED, not grepped.
 *
 * Joe's ruling 2026-08-19: "2 years" of backup history. The obvious implementation (delete anything
 * older than 2 years) frees ZERO bytes, because nothing on the box is that old. Measured that day:
 * all six americanharley tarballs were from one afternoon, ~1.73 GB each, 9.7 GB total on a 58 GB
 * disk sitting at 94%. The old rule kept the newest 12 REGARDLESS of day, so at 8-17 deploys/day it
 * held under one day of history and threw away every earlier day — both halves backwards.
 *
 * WHY THIS EVAL EXECUTES THE SHELL. `tsc` does not cover `scripts/`, and a source-text assertion
 * cannot prove a bash function still runs (SKILL trap 3 — a change once left a variable referenced
 * but undeclared and every pure assertion stayed green while the script died). This builds a real
 * fixture directory of real files, sources the deploy script's prune function, runs it, and reads
 * which files survive.
 *
 * CLOCK-SAFE. Every fixture filename is derived from the current UTC date at run time, so the
 * "recent" days are recent whenever this runs and the "old" day is always past the horizon. Nothing
 * here is pinned to a wall-clock date that goes red at midnight.
 *
 * FAIL DIRECTION IS KEEP, and it is asserted three ways: an unparseable filename survives, the
 * newest snapshot of each day survives, and a non-backup file in the same directory is untouched.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const script = path.join(repoRoot, "scripts", "deploy_api_lightsail.sh");
const scriptSource = fs.readFileSync(script, "utf8");

// The retention knob is days, not a count — the count rule is what produced six copies of one day.
assert.ok(
  scriptSource.includes("DEPLOY_BACKUP_RETENTION_DAYS"),
  "the deploy script must take a retention in DAYS"
);
assert.ok(
  !scriptSource.includes("DEPLOY_BACKUP_RETENTION_COUNT"),
  "the old keep-newest-N knob must be gone, not left beside the new one"
);
assert.ok(
  scriptSource.includes("prune_backup_root"),
  "the per-root prune function must still exist"
);
assert.ok(
  scriptSource.includes("DEPLOY_BACKUP_EXTRA_ROOTS"),
  "the base lane's backup root must still be reachable — Joe's ruling covers BOTH roots"
);

const dayStamp = (daysAgo: number): string => {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "backup-retention-eval-"));
const extraRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backup-retention-extra-"));
try {
  const today = dayStamp(0);
  const yesterday = dayStamp(1);
  const lastYear = dayStamp(400); // inside a 730-day horizon
  const ancient = dayStamp(900); // outside it

  const write = (dir: string, name: string) => fs.writeFileSync(path.join(dir, name), "x");

  // Six snapshots of ONE day — the exact shape measured on the box.
  for (const t of ["083819", "113624", "123512", "134606", "140046", "165233"]) {
    write(root, `data-${today}T${t}Z.tgz`);
  }
  write(root, `data-${yesterday}T090000Z.tgz`);
  write(root, `data-${yesterday}T170000Z.tgz`);
  write(root, `data-${lastYear}T120000Z.tgz`);
  write(root, `data-${ancient}T120000Z.tgz`);
  // Fail-direction fixtures: neither may be deleted.
  write(root, "data-not-a-timestamp.tgz");
  write(root, "conversations.pre-charles-heal.json");
  // The second root Joe's ruling names.
  write(extraRoot, `data-${today}T010000Z.tgz`);
  write(extraRoot, `data-${today}T020000Z.tgz`);

  // Source the script's prune function without running a deploy: stop the script right after the
  // function is defined. `set -euo pipefail` and the helper both come along.
  const fnStart = scriptSource.indexOf("prune_backup_root() {");
  const fnEnd = scriptSource.indexOf("\n}\n", fnStart) + 3;
  assert.ok(fnStart > 0 && fnEnd > fnStart, "prune_backup_root must be extractable from the script");
  const harness = [
    "set -euo pipefail",
    'DEPLOY_BACKUP_RETENTION_DAYS="${DEPLOY_BACKUP_RETENTION_DAYS:-730}"',
    'backup_path=""',
    scriptSource.slice(fnStart, fnEnd),
    'prune_backup_root "$1"',
    'if [[ -n "${2:-}" ]]; then prune_backup_root "$2"; fi'
  ].join("\n");

  const bash = "bash";
  // The prune must run on bash 3.2 (macOS, where this eval usually runs) AND 5.x (the box). It
  // deliberately uses awk for the per-day grouping and a GNU-or-BSD `date` pair rather than bash-4
  // associative arrays and GNU-only flags — an eval that skips its own execution half on the
  // machine it runs on is exactly the source-pin trap this file exists to close.
  assert.ok(
    !/declare -A|local -A/.test(scriptSource.slice(fnStart, fnEnd)),
    "prune_backup_root must not use bash-4 associative arrays — the eval could not then execute it"
  );
  {
    execFileSync(bash, ["-c", harness, "_", root, extraRoot], { encoding: "utf8" });

    const survivors = fs.readdirSync(root).sort();
    assert.ok(
      survivors.includes(`data-${today}T165233Z.tgz`),
      "the NEWEST snapshot of today must survive — it is the state closest to the deploy that followed"
    );
    for (const t of ["083819", "113624", "123512", "134606", "140046"]) {
      assert.ok(
        !survivors.includes(`data-${today}T${t}Z.tgz`),
        `an earlier same-day duplicate must be pruned: ${t}`
      );
    }
    assert.ok(
      survivors.includes(`data-${yesterday}T170000Z.tgz`) &&
        !survivors.includes(`data-${yesterday}T090000Z.tgz`),
      "yesterday keeps exactly one snapshot, the newest"
    );
    assert.ok(
      survivors.includes(`data-${lastYear}T120000Z.tgz`),
      "a snapshot 400 days old is INSIDE the two-year horizon and must survive — this is the half a keep-newest-N rule threw away"
    );
    assert.ok(
      !survivors.includes(`data-${ancient}T120000Z.tgz`),
      "a snapshot 900 days old is past the horizon and must be pruned"
    );
    assert.ok(
      survivors.includes("data-not-a-timestamp.tgz"),
      "FAIL DIRECTION: a filename we cannot parse is history we cannot reason about — keep it"
    );
    assert.ok(
      survivors.includes("conversations.pre-charles-heal.json"),
      "FAIL DIRECTION: a non-backup file in the same directory must never be touched"
    );
    assert.equal(
      survivors.length,
      5,
      `expected exactly 5 survivors (today, yesterday, 400d, unparseable, non-backup), got ${survivors.join(", ")}`
    );

    const extraSurvivors = fs.readdirSync(extraRoot).sort();
    assert.deepEqual(
      extraSurvivors,
      [`data-${today}T020000Z.tgz`],
      "the second root is pruned by the same rule, not ignored"
    );

    console.log(
      `backup_retention_daily:eval PASS — ${survivors.length} kept in the main root, ${extraSurvivors.length} in the extra root`
    );
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(extraRoot, { recursive: true, force: true });
}
