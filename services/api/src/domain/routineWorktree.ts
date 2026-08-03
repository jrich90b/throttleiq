/**
 * routineWorktree — the PURE half of per-routine git worktree isolation.
 *
 * WHY THIS EXISTS. Six scheduled routines share two checkouts and take turns through a
 * `mkdir` lock (`/tmp/throttleiq-agents-tree.lock`, `/tmp/throttleiq-anomaly-tree.lock`).
 * The lock is advisory prose in each SKILL.md, so it fails the way advisory rules fail:
 * on 2026-08-03 it was found held, EMPTY and orphaned for 4+ hours (costing two routines
 * their whole tick), and a sibling has ignored it outright. A held lock also silently
 * downgrades a routine to read-only work it never planned for.
 *
 * The fix is not a better lock. It is not sharing the tree: every routine gets its own
 * git worktree off `origin/main`, so parallel edits cannot collide and there is nothing
 * to take turns over. Creating a worktree touches the base repo's `.git` directory but
 * NEVER its working files, index, or HEAD — so it is safe to do while another session
 * holds the working-tree lock. That distinction is the whole point; see
 * `docs/routine_worktrees.md`.
 *
 * The IO half (git, symlinks, fs) lives in `scripts/routine_worktree.ts`. Everything here
 * is pure so `routine_worktree:eval` can pin the one property that actually matters:
 * REMOVAL NEVER ESCAPES THE MANAGED ROOT.
 */
import path from "node:path";

/** Written inside every managed worktree; `remove` refuses a directory without it. */
export const MARKER_FILENAME = ".throttleiq-routine-worktree";

/**
 * Directory name shape: `<routine>-<stamp>-<pid>`.
 *
 * The pid is not decoration — two ticks of the SAME routine can overlap when one runs long,
 * and a same-second collision would otherwise make `git worktree add` fail (or worse, reuse).
 */
export const MANAGED_DIR_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-\d{8}T\d{6}Z-\d+$/;

/**
 * Routine names come from SKILL.md filenames and prompts, so they are untrusted enough to
 * matter: a name containing `/` or `..` would otherwise steer the created path out of the
 * managed root, and `isManagedWorktreePath` would then correctly refuse to clean it up —
 * leaving orphaned worktrees forever. Reject at creation instead.
 */
export function sanitizeRoutineName(raw: string | null | undefined): string {
  const cleaned = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  if (!cleaned) throw new Error(`routine name is empty after sanitizing: ${JSON.stringify(raw)}`);
  return cleaned;
}

/** `20260803T101437Z` — sortable, filename-safe, and passed a Date so the eval can pin it. */
export function formatStamp(at: Date): string {
  const iso = at.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

export function worktreeDirName(routine: string, at: Date, pid: number): string {
  const name = `${sanitizeRoutineName(routine)}-${formatStamp(at)}-${Math.trunc(pid)}`;
  if (!MANAGED_DIR_PATTERN.test(name)) {
    // Unreachable via sanitizeRoutineName, but a future edit to either half must not be able
    // to mint a name that `remove` will then refuse to clean up.
    throw new Error(`refusing to mint an unmanageable worktree name: ${name}`);
  }
  return name;
}

export function worktreePathFor(root: string, routine: string, at: Date, pid: number): string {
  return path.join(path.resolve(root), worktreeDirName(routine, at, pid));
}

/**
 * THE SAFETY PREDICATE. `remove` deletes a directory with `--force`, so this is the guard
 * standing between a routine's cleanup step and someone's working tree.
 *
 * True ONLY for a DIRECT child of the managed root whose name we minted. That single
 * `dirname === root` check is what refuses the base checkout, `$HOME`, `/`, a sibling
 * routine's clone, and `..` traversal (which `path.resolve` normalizes before the compare).
 * Relative paths are refused outright rather than resolved against an ambient cwd.
 *
 * Callers must pass REAL paths (`fs.realpathSync`) — this is string logic and cannot see
 * through a symlinked child. The CLI does that before calling.
 */
export function isManagedWorktreePath(candidate: string | null | undefined, root: string | null | undefined): boolean {
  const c = String(candidate ?? "");
  const r = String(root ?? "");
  if (!c || !r) return false;
  if (!path.isAbsolute(c) || !path.isAbsolute(r)) return false;
  const resolvedRoot = path.resolve(r);
  const resolved = path.resolve(c);
  if (resolved === resolvedRoot) return false;
  if (path.dirname(resolved) !== resolvedRoot) return false;
  return MANAGED_DIR_PATTERN.test(path.basename(resolved));
}

export type WorktreePrereqState = {
  /** Root `node_modules` reachable from inside the worktree. */
  rootNodeModules: boolean;
  /** `services/api/node_modules` — a separate real install; ci:eval crashes mid-chain without it. */
  apiNodeModules: boolean;
  /** Env files that must resolve, in the order the gates need them. */
  envFiles: { path: string; present: boolean }[];
};

/**
 * What is missing before this worktree can run the gates. Empty ⇒ ready.
 *
 * Fail-direction: LOUD. Both known failures here are silent-green, which is the worst kind.
 * Missing `node_modules` lets the early `npx tsx` steps of `ci:eval` pass before the chain
 * dies on `Cannot find module .../node_modules/.bin/tsx`. A missing `.env` costs the
 * cross-model pre-ship review its API key, and every ship then ESCALATES as "no review
 * available" — which reads like a code objection and is not one (PR #343, 2026-07-30).
 */
export function describeMissingPrerequisites(state: WorktreePrereqState): string[] {
  const missing: string[] = [];
  if (!state.rootNodeModules) missing.push("node_modules (root) — ci:eval dies mid-chain without it");
  if (!state.apiNodeModules) missing.push("services/api/node_modules — the api install is separate");
  for (const env of state.envFiles) {
    if (!env.present) missing.push(`${env.path} — gates and the cross-model review need its keys`);
  }
  return missing;
}
