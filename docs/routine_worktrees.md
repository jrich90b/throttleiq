# Per-routine worktrees — stop sharing the tree

**Status:** tooling landed; rollout is one routine at a time (see [Rollout](#rollout)).

## The problem, measured

Six scheduled routines share two checkouts (`throttleiq-agents`, `throttleiq-anomaly-review`) and
take turns through a `mkdir` lock in `/tmp`. The lock is **advisory prose** in each `SKILL.md`, and
it fails the way advisory rules fail:

- **2026-08-03** — the lock was found held, **empty** (no `owner` file) and orphaned for **4+ hours**
  after a killed run. It cost the un-stack loop its own 04:15 tick and the burndown loop its build
  lane. An empty lock is undiagnosable, so the `>6h` staleness rule is the only way out, and it is
  deliberately slow.
- **2026-07-07** — two sessions ran concurrently anyway and cross-talked: one session's uncommitted
  edits kept surfacing in the other's working files, and a commit meant for
  `loop/auto-era-lowrider-*` landed on `review/auto-watchtrim-*`, because creating a branch does not
  move `HEAD` — whatever branch is checked out when you commit gets the commit.
- A sibling has ignored the lock outright, and a *held* lock silently downgrades a routine to
  read-only triage it never planned for.

Every one of these is the same root cause: **shared mutable working files.**

## The fix

Don't share the tree. Each routine gets its own [git worktree](https://code.claude.com/docs/en/worktrees)
cut from `origin/main`, so parallel edits cannot collide and there is nothing to take turns over.

The distinction that makes this safe to adopt incrementally:

> Creating a worktree writes to the base repo's `.git` directory. It **never** touches the base
> repo's working files, index, or `HEAD`.

So a routine can create its worktree **while another session holds the working-tree lock** without
violating the lock's intent. The lock protects working files; worktree creation doesn't touch them.
That is what lets us migrate one routine at a time instead of flag-day-ing all six.

## Using it

```bash
WT=$(npx tsx scripts/routine_worktree.ts create --routine throttleiq-loop-runner --branch loop/auto-my-fix)
cd "$WT"
# ... gates and work happen here, fully isolated ...
npx tsx scripts/routine_worktree.ts remove --path "$WT"
```

`create` prints the path as the **only line on stdout** (progress goes to stderr), so `$( )` captures
it cleanly. Omit `--branch` for a detached worktree when you only need to read or gate.

Worktrees live under `~/throttleiq-worktrees/<routine>-<stamp>-<pid>` — deliberately **outside** the
repo, so they generate no untracked-file noise and no ignore rules to get right. Override with
`THROTTLEIQ_WORKTREE_ROOT`. `list` shows what exists and how old it is, which is how you spot one a
killed run left behind.

### What `create` wires up, and why it fails loudly

A worktree is a fresh checkout: no `node_modules`, no `.env`. Both gaps fail **silently green**,
which is why `create` verifies and **rolls the worktree back** rather than handing you a broken one:

- **`node_modules`** (root *and* `services/api` — two separate real installs). Without them the early
  `npx tsx` steps of `ci:eval` still pass before the chain dies on `Cannot find module .../.bin/tsx`.
- **`.env`, `services/api/.env`**. Without them the cross-model pre-ship reviewer has no API key and
  every ship **escalates as "no review available"** — which reads like a code objection and isn't one
  (PR #343, 2026-07-30).

All four are **symlinked, not copied**: one source of truth, a rotated key takes effect everywhere at
once, and cleanup can't leave a stale secret on disk.

`.gitignore` matches `node_modules` **without a trailing slash** on purpose — the slash form matches
only real directories, so a symlink showed up as untracked `?? services/api/node_modules` and tripped
the deploy script's clean-tree guard.

### Removal is the dangerous half

`remove` runs `git worktree remove --force`. Two independent guards stand in front of it, both
pinned by `routine_worktree:eval`:

1. **Path** — `isManagedWorktreePath` accepts only a *direct child* of the managed root whose name
   this tool minted. That single `dirname === root` check refuses the base checkout, `$HOME`, `/`, a
   sibling routine's clone, `..` traversal, and a root that merely shares a prefix. Symlinks are
   resolved (`realpath`) *before* the check, since the predicate is string logic.
2. **Marker** — the directory must contain `.throttleiq-routine-worktree`, written at creation.

Routine names are sanitized at creation for the same reason: a name containing `/` or `..` would mint
a path the guard then refuses to clean up, leaking a worktree on every tick. The eval pins the round
trip — *anything we can mint, we can remove*.

## What this does and doesn't replace

- **Replaces:** the `/tmp/throttleiq-*-tree.lock` dance, for any routine that has migrated.
- **Does not replace:** cross-routine *work* coordination — the disposition ledger, finding-key PR
  dedup, and the claims directory in `ROUTINE_CONTRACT.md`. Worktrees stop two routines corrupting
  each other's *files*; they do nothing to stop two routines fixing the same *bug*.
- **Deploys** still run from a tree pinned exactly at the merged commit, because `npm run deploy:api`
  ships the local build and aborts unless local `HEAD == origin/main` and `services/api`/`packages`
  are clean. A worktree at the merge SHA satisfies both.

Anthropic's own guidance is worth reading alongside this: multi-agent setups are weakest on
"tasks requiring shared context or heavy interdependencies (e.g., most coding tasks)". Our routines
edit the same few files, so the burden is on us to keep them genuinely separable. That argues for
worktrees, and against adding more routines.

## Rollout

One routine at a time, newest failure first. A migrated routine replaces its STEP-0 lock block with
the `create`/`remove` pair above and keeps everything else — gates, tiers, dedup — unchanged.

- [x] Tooling + eval + docs (this change)
- [ ] `throttleiq-loop-runner` (pilot — it already builds in a worktree by hand)
- [ ] `leadrider-issue-report-burndown`
- [ ] `throttleiq-unstack-loop`
- [ ] `leadrider-daily-anomaly-pr-review`
- [ ] `agent-watch-held-draft-sweep`
- [ ] `leadrider-morning-quality-routine`

Until a routine is ticked, it keeps using its lock — and that is fine: a migrated routine not taking
the lock cannot corrupt an unmigrated one that does, because it never writes to the shared tree.

## Related

- `ROUTINE_CONTRACT.md` — division of labor, dedup-first, staleness discipline
- `docs/autonomous_coding_loop.md` — the 5-block spec and hard stops
- Claude Code docs: [worktrees](https://code.claude.com/docs/en/worktrees),
  [best practices](https://code.claude.com/docs/en/best-practices),
  [agent teams](https://code.claude.com/docs/en/agent-teams) (evaluated, not adopted: a team is
  scoped to one session and cannot span scheduled runs)
