/**
 * routine_worktree:eval — pins per-routine worktree isolation (docs/routine_worktrees.md).
 *
 * The property that matters is not "does it make a directory". It is that `remove`, which runs
 * `git worktree remove --force`, can NEVER be talked into deleting something outside the managed
 * root — and, symmetrically, that every path this tool mints is one it can still clean up (or the
 * routines silently accumulate orphaned worktrees forever).
 *
 * Behavior-pinned: calls the functions and asserts results. No source-text assertions.
 */
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import {
  MANAGED_DIR_PATTERN,
  MARKER_FILENAME,
  describeMissingPrerequisites,
  formatStamp,
  isManagedWorktreePath,
  sanitizeRoutineName,
  worktreeDirName,
  worktreePathFor
} from "../services/api/src/domain/routineWorktree.ts";

const ROOT = "/Users/someone/throttleiq-worktrees";
const AT = new Date("2026-08-03T10:14:37.000Z");

// 1. Stamp is sortable, filename-safe, and derived from the Date it is given (never `now`).
{
  assert.equal(formatStamp(AT), "20260803T101437Z");
  assert.ok(formatStamp(AT) < formatStamp(new Date("2026-08-03T10:14:38.000Z")), "stamps sort chronologically");
}

// 2. Routine names are untrusted (they come from SKILL.md filenames and prompts). A name that
//    could steer the path out of the managed root must be neutralized at creation — otherwise the
//    removal guard correctly refuses it later and the worktree leaks forever.
{
  assert.equal(sanitizeRoutineName("throttleiq-loop-runner"), "throttleiq-loop-runner");
  assert.equal(sanitizeRoutineName("Leadrider Morning Quality"), "leadrider-morning-quality");
  assert.equal(sanitizeRoutineName("../../etc/passwd"), "etc-passwd", "traversal is flattened, not preserved");
  assert.equal(sanitizeRoutineName("a/b/c"), "a-b-c", "separators cannot survive into the directory name");
  assert.equal(sanitizeRoutineName("--weird--"), "weird");
  assert.throws(() => sanitizeRoutineName(""), /empty/, "an empty name is a hard error, never a bare stamp");
  assert.throws(() => sanitizeRoutineName("///"), /empty/);
  assert.throws(() => sanitizeRoutineName(null), /empty/);
}

// 3. Minted names match the managed shape, and the pid disambiguates two overlapping ticks of the
//    SAME routine in the same second (a long tick overlapping the next one is normal at 2h cadence).
{
  const name = worktreeDirName("throttleiq-loop-runner", AT, 4242);
  assert.equal(name, "throttleiq-loop-runner-20260803T101437Z-4242");
  assert.ok(MANAGED_DIR_PATTERN.test(name));
  assert.notEqual(worktreeDirName("x", AT, 1), worktreeDirName("x", AT, 2), "same routine, same second, different run");
  assert.equal(worktreePathFor(ROOT, "x", AT, 1), path.join(ROOT, "x-20260803T101437Z-1"));
}

// 4. THE SAFETY PREDICATE — removal must never escape the managed root.
{
  const managed = worktreePathFor(ROOT, "throttleiq-loop-runner", AT, 4242);
  assert.equal(isManagedWorktreePath(managed, ROOT), true, "a path we minted is removable");

  // Everything a cleanup step could plausibly be handed by accident:
  assert.equal(isManagedWorktreePath(ROOT, ROOT), false, "the root itself is never removable");
  assert.equal(isManagedWorktreePath("/", ROOT), false);
  assert.equal(isManagedWorktreePath(os.homedir(), ROOT), false, "$HOME is never removable");
  assert.equal(isManagedWorktreePath("/Users/someone/throttleiq-agents", ROOT), false, "the base checkout is not managed");
  assert.equal(
    isManagedWorktreePath("/Users/someone/throttleiq-anomaly-review", ROOT),
    false,
    "a sibling routine's clone is not managed"
  );

  // Traversal: `path.resolve` normalizes before the parent check, so these land outside the root.
  assert.equal(isManagedWorktreePath(`${ROOT}/../../../etc`, ROOT), false, "traversal out of the root is refused");
  assert.equal(
    isManagedWorktreePath(`${ROOT}/x-20260803T101437Z-1/../../elsewhere`, ROOT),
    false,
    "traversal that ends outside is refused even when it starts managed"
  );

  // Shape: only a DIRECT child whose name we mint.
  assert.equal(isManagedWorktreePath(`${ROOT}/some-scratch-dir`, ROOT), false, "an unmanaged name is refused");
  assert.equal(isManagedWorktreePath(`${ROOT}/x-20260803T101437Z-1/services`, ROOT), false, "a grandchild is refused");
  assert.equal(isManagedWorktreePath("relative/path", ROOT), false, "a relative path is refused, never cwd-resolved");
  assert.equal(isManagedWorktreePath(managed, "relative-root"), false, "a relative root is refused");
  assert.equal(isManagedWorktreePath("", ROOT), false);
  assert.equal(isManagedWorktreePath(managed, ""), false);
  assert.equal(isManagedWorktreePath(null, ROOT), false);

  // A root that merely shares a PREFIX must not be treated as the parent.
  assert.equal(isManagedWorktreePath(`${ROOT}-other/x-20260803T101437Z-1`, ROOT), false, "prefix ≠ parent");
}

// 5. ROUND TRIP — anything we can mint, we can clean up. This is what stops orphan accumulation:
//    a name that sanitizes into an unmanageable shape would leak a worktree on every tick.
{
  for (const raw of [
    "throttleiq-loop-runner",
    "leadrider-issue-report-burndown",
    "A",
    "9lives",
    "../../etc/passwd",
    "Weird   Name!!",
    "x".repeat(200)
  ]) {
    const p = worktreePathFor(ROOT, raw, AT, 7);
    assert.equal(isManagedWorktreePath(p, ROOT), true, `minted path must be removable: ${raw} -> ${p}`);
    assert.equal(path.dirname(p), ROOT, `minted path must sit directly under the root: ${raw}`);
  }
}

// 6. PREREQUISITES FAIL LOUD. Both real failures here are silent-green, the worst kind: a missing
//    node_modules lets the early `npx tsx` steps of ci:eval pass before the chain dies, and a
//    missing .env costs the cross-model reviewer its key so every ship ESCALATES as "no review
//    available" — which reads like a code objection and is not one (PR #343, 2026-07-30).
{
  const ready = {
    rootNodeModules: true,
    apiNodeModules: true,
    envFiles: [
      { path: ".env", present: true },
      { path: "services/api/.env", present: true }
    ]
  };
  assert.deepEqual(describeMissingPrerequisites(ready), [], "a fully wired worktree reports nothing missing");

  const noApiModules = describeMissingPrerequisites({ ...ready, apiNodeModules: false });
  assert.equal(noApiModules.length, 1);
  assert.match(noApiModules[0], /services\/api\/node_modules/, "the api install is reported separately from the root");

  const noEnv = describeMissingPrerequisites({
    ...ready,
    envFiles: [
      { path: ".env", present: false },
      { path: "services/api/.env", present: true }
    ]
  });
  assert.equal(noEnv.length, 1);
  assert.match(noEnv[0], /\.env/);

  const nothing = describeMissingPrerequisites({
    rootNodeModules: false,
    apiNodeModules: false,
    envFiles: [
      { path: ".env", present: false },
      { path: "services/api/.env", present: false }
    ]
  });
  assert.equal(nothing.length, 4, "every missing prerequisite is named, not just the first");
}

// 7. The marker filename is part of the removal contract (`remove` refuses a directory without it),
//    so it must stay gitignored-looking and stable.
{
  assert.ok(MARKER_FILENAME.startsWith("."), "the marker is a dotfile");
  assert.ok(!MARKER_FILENAME.includes("/"), "the marker is a filename, not a path");
}

console.log(
  "PASS routine worktree eval (stamp / untrusted-name sanitizing / minted shape + pid / removal never escapes the root: root, $HOME, base checkout, sibling clone, traversal, grandchild, relative, prefix / mint-remove round trip / prerequisites fail loud / marker contract)"
);
