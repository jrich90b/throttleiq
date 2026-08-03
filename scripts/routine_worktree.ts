/**
 * routine_worktree — give each scheduled routine its OWN git worktree instead of sharing one
 * checkout behind an advisory lock. The pure logic (and the removal safety predicate) lives in
 * services/api/src/domain/routineWorktree.ts; this is the git + filesystem half.
 *
 * Rationale and the migration plan: docs/routine_worktrees.md. In one line: the tree lock is
 * prose, prose gets ignored, and the official guidance is not to share the tree at all
 * (https://code.claude.com/docs/en/worktrees).
 *
 *   create --routine <name> [--branch <b>] [--base origin/main]
 *       Fetch, add a worktree, wire node_modules + .env, verify, print the PATH on the last
 *       line (so a caller can `WT=$(... | tail -1)`). Omit --branch for a detached worktree.
 *   remove --path <p>
 *       Remove ONLY a worktree this tool created. Refuses anything else, loudly.
 *   list
 *       Managed worktrees with their age — for spotting ones a killed run left behind.
 *
 * Run from anywhere: the base checkout is derived from `git rev-parse --git-common-dir`, which
 * every worktree of a repo shares, so this works whether you invoke it from the base tree or
 * from inside another worktree.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  MARKER_FILENAME,
  describeMissingPrerequisites,
  isManagedWorktreePath,
  worktreePathFor
} from "../services/api/src/domain/routineWorktree.ts";

const argv = process.argv.slice(2);
const sub = argv[0];
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const die = (msg: string, code = 2): never => {
  console.error(msg);
  process.exit(code);
};

const git = (args: string[], cwd?: string): string =>
  execFileSync("git", args, { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * The BASE checkout — the one with the real `node_modules` and the gitignored `.env`.
 * `--git-common-dir` resolves to the shared `.git` for every worktree, so its parent is the
 * base tree no matter where we were invoked from.
 */
function baseRepo(): string {
  const override = process.env.THROTTLEIQ_BASE_REPO;
  if (override) return path.resolve(override);
  try {
    const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return path.dirname(common);
  } catch {
    return die("not inside a git repository, and THROTTLEIQ_BASE_REPO is not set");
  }
}

/** Managed root. Deliberately OUTSIDE the repo: no untracked-file noise, no ignore rules to get right. */
function worktreeRoot(): string {
  return path.resolve(process.env.THROTTLEIQ_WORKTREE_ROOT || path.join(os.homedir(), "throttleiq-worktrees"));
}

/** Secrets are SYMLINKED, never copied — one source of truth, and no stale key left behind on cleanup. */
const ENV_FILES = [".env", "services/api/.env"];
const NODE_MODULES = ["node_modules", "services/api/node_modules"];

function linkInto(worktree: string, repo: string, rel: string): boolean {
  const target = path.join(repo, rel);
  if (!fs.existsSync(target)) return false;
  const link = path.join(worktree, rel);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.rmSync(link, { force: true, recursive: false });
  fs.symlinkSync(target, link);
  return true;
}

if (sub === "create") {
  const routine = flag("routine") ?? die("--routine <name> is required");
  const base = flag("base") || "origin/main";
  const branch = flag("branch");
  const repo = baseRepo();
  const root = worktreeRoot();
  fs.mkdirSync(root, { recursive: true });

  const dest = worktreePathFor(root, routine, new Date(), process.pid);

  // Always cut from the REMOTE ref. A routine that branched from a stale local `main` reviews
  // and gates the wrong tree — the #336 trap, where a review spent its budget on someone else's
  // already-merged commits.
  try {
    git(["-C", repo, "fetch", "-q", "origin", "main"]);
  } catch {
    console.error("warning: `git fetch origin main` failed — cutting from the cached ref");
  }

  const addArgs = ["-C", repo, "worktree", "add", "-f"];
  if (branch) addArgs.push("-b", branch);
  else addArgs.push("--detach");
  addArgs.push(dest, base);
  try {
    git(addArgs);
  } catch (err: any) {
    die(`git worktree add failed: ${err?.stderr || err?.message || err}`);
  }

  const state = {
    rootNodeModules: false,
    apiNodeModules: false,
    envFiles: [] as { path: string; present: boolean }[]
  };
  for (const rel of NODE_MODULES) {
    const ok = linkInto(dest, repo, rel);
    if (rel === "node_modules") state.rootNodeModules = ok;
    else state.apiNodeModules = ok;
  }
  for (const rel of ENV_FILES) state.envFiles.push({ path: rel, present: linkInto(dest, repo, rel) });

  const missing = describeMissingPrerequisites(state);
  if (missing.length) {
    // Roll back rather than hand back a worktree whose gates would fail SILENTLY GREEN.
    try {
      git(["-C", repo, "worktree", "remove", "--force", dest]);
    } catch {
      /* leave it for `list` to surface */
    }
    die(`worktree not usable, rolled back. Missing in ${repo}:\n  - ${missing.join("\n  - ")}`);
  }

  fs.writeFileSync(
    path.join(dest, MARKER_FILENAME),
    `${JSON.stringify({ routine, createdAt: new Date().toISOString(), base, branch: branch ?? null, repo, pid: process.pid }, null, 2)}\n`
  );

  console.error(`worktree ready for ${routine} (${branch ? `branch ${branch}` : "detached"} @ ${base})`);
  console.log(dest); // LAST line, and the only stdout — callers capture it
  process.exit(0);
}

if (sub === "remove") {
  const raw = flag("path") ?? die("--path <p> is required");
  const root = worktreeRoot();
  if (!fs.existsSync(raw)) {
    console.error(`nothing to remove at ${raw}`);
    process.exit(0);
  }
  // Resolve symlinks BEFORE validating: the predicate is string logic and cannot see through
  // a symlinked child that points outside the managed root.
  const real = fs.realpathSync(raw);
  const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
  if (!isManagedWorktreePath(real, realRoot)) {
    die(`REFUSING to remove ${real}: not a managed worktree under ${realRoot}`);
  }
  if (!fs.existsSync(path.join(real, MARKER_FILENAME))) {
    die(`REFUSING to remove ${real}: no ${MARKER_FILENAME} marker — this tool did not create it`);
  }
  const repo = baseRepo();
  try {
    git(["-C", repo, "worktree", "remove", "--force", real]);
  } catch {
    fs.rmSync(real, { recursive: true, force: true });
  }
  try {
    git(["-C", repo, "worktree", "prune"]);
  } catch {
    /* best effort */
  }
  console.error(`removed ${real}`);
  process.exit(0);
}

if (sub === "list") {
  const root = worktreeRoot();
  if (!fs.existsSync(root)) {
    console.log(`no managed worktrees (${root} does not exist)`);
    process.exit(0);
  }
  const now = Date.now();
  const rows = fs
    .readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((p) => isManagedWorktreePath(p, root))
    .map((p) => {
      let marker: any = {};
      try {
        marker = JSON.parse(fs.readFileSync(path.join(p, MARKER_FILENAME), "utf8"));
      } catch {
        /* an unreadable marker still lists — that is exactly the leftover worth seeing */
      }
      const ageH = marker.createdAt ? (now - Date.parse(marker.createdAt)) / 3_600_000 : NaN;
      return `${Number.isFinite(ageH) ? `${ageH.toFixed(1)}h` : "  ?  "}  ${marker.routine ?? "?"}  ${p}`;
    });
  console.log(rows.length ? rows.join("\n") : `no managed worktrees under ${root}`);
  process.exit(0);
}

console.error(
  "usage: npx tsx scripts/routine_worktree.ts <create --routine <name> [--branch b] [--base origin/main] | remove --path <p> | list>"
);
process.exit(2);
