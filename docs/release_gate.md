# The full release gate (and the golden-corpus number)

Joe, 2026-08-04: *"let's set up the full suite with the golden corpus."*

## The problem this solves

`ci:eval` takes about **45 minutes**. `throttleiq-unstack-loop` merges about every **20**. On 8/4 a
single deploy attempt watched main move four times underneath it (#519, #523, #524, #526) — so the
tree that was proven green was never the tree that shipped, and the release went out on targeted
evals plus a judgement call.

That arithmetic never comes out: you cannot finish a 45-minute proof about a branch that changes
every 20 minutes. The choice was deploy-something-unproven or never-deploy. This is the third
option — **hold merges still for one window, prove the exact tree, ship it, let go.**

## Running it

```bash
npm run gate:release              # gate, then deploy the API
npm run gate:release -- --with-web    # also deploy the console
npm run gate:release -- --gate-only   # prove it, deploy nothing
```

In order, stopping at the first failure:

1. **Take the merge freeze** so main cannot move under the proof
2. **Sync** to `origin/main`, refusing a dirty tree
3. **tsc --noEmit**
4. **The full `ci:eval` suite** — capturing its own exit code, because a wrapper in the chain can
   mask a downstream failure
5. **The golden corpus** — a *fresh* score at or above the floor
6. **Deploy**

The freeze is released on every exit path, including failure and Ctrl-C.

## The two gates are not the same question

| | asks | when |
|---|---|---|
| `ci:eval` | "have these specific things regressed?" | every build |
| golden corpus | "is the agent actually any good?" | release gate |

The suite can be entirely green while the agent is mediocre — it only knows about the cases someone
already thought to pin. The golden corpus replays **real customer turns** and asks a judge whether
the agent's reply accomplished what the salesperson's reply accomplished. That is the number that
can go *up*.

### Freshness lives at the gate, not in the suite

`gold_corpus_score:eval` (inside `ci:eval`) is the cheap ratchet: no network, runs everywhere, inert
until a floor is set. It deliberately does **not** check staleness — failing every developer's build
over a report only the box produces would be miserable.

`scripts/gold_score_gate.ts` adds that check at deploy time, where the answer is actionable: re-run
the scorer on the box. Default window 48h.

### Fail directions point opposite ways, deliberately

- **The freeze fails OPEN.** Absent, malformed, or older than 90 minutes all read as *not frozen*. A
  stuck freeze would silently stop every routine landing work — far worse than one deploy shipping
  on a main that moved a little. A crashed gate costs one cycle, not an afternoon.
- **The gold gate fails CLOSED.** Missing, unreadable, thin, stale, or under the floor all stop the
  release. Refusing to ship costs a delay; shipping an unmeasured agent costs customers.

Both are pinned by `merge_freeze:eval`.

## The first number: 45%

First real run, 2026-08-04T17:30Z — **45% (9 of 20)**.

On 20 held-out real customer turns, the agent's reply accomplished what the salesperson's reply
accomplished 9 times.

It is a genuine reading, not a harness artifact:

- **0** items where the agent produced no reply, so thread history really was reconstructed
- **18 of 20** judge verdicts unanimous across 3 votes (10 unanimous-wrong, 8 unanimous-right)

But **do not treat 45% as the agent's grade.** The corpus holds 81 harvested examples, of which 20
are in the eval hold-out. At n=20 the 95% confidence interval is roughly **23%–68%** — wide enough
that a 10-point move next week would mean nothing.

### So the floor starts as a catastrophe floor

`GOLD_SCORE_FLOOR=30` catches a collapse (the agent falling over, a prompt regression gutting
replies) without blocking on sampling noise. It is **not** a quality target.

The real work is **growing the corpus**. Get the eval hold-out to ~100 and the interval tightens to
about ±10, at which point the floor can become a genuine ratchet that only moves up. Until then the
gate is honest about what it proved: regressions, plus a floor against collapse.

## What each routine has to do

Every routine that **merges** checks the freeze first:

```bash
npx tsx scripts/merge_freeze.ts check    # exit 0 = merge away, exit 3 = FROZEN
```

Exit 3 ⇒ do not merge. Finish the build/triage work, note it in one line, land it next tick. A
freeze pauses *landing*, not thinking — building PRs, triaging, sweeping and reporting all carry on.
