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

## The number: 29.1%

Measured 2026-08-04T19:10Z on the 117-item eval hold-out — **29.1% (34 of 117)**.

On 117 held-out real customer turns, the agent's reply accomplished what the salesperson's reply
accomplished 34 times.

### The first reading said 45%, and that was the sample talking

An earlier run on a 20-item hold-out scored 45% (9/20). Both readings are real; they are also
statistically **consistent** — 29.1% sits inside the first run's 26%–66% interval. The 45% was the
lucky end of a thin sample, which is exactly why a floor was never set on it.

| run | hold-out | score | 95% interval |
|---|---|---|---|
| 2026-08-04 17:30 | 20 | 45.0% | 26% – 66% (40 pts) |
| 2026-08-04 19:10 | 117 | 29.1% | 22% – 38% (16 pts) |

### It is a real reading, not a harness artifact

Both runs carry the same health checks:

- **0** items where the agent produced no reply, so thread history really was reconstructed
  (message bodies live in `m.body`, not `m.text` — a scorer reading the wrong field would compose
  blind and tank the number for no reason)
- **100 of 117** judge verdicts unanimous across 3 votes (74 unanimous-wrong, 26 unanimous-right).
  Only 17 were split.

### One honest caveat on what it measures

The corpus is built from replies a named staff member sent **without editing** — confirmed-good
human answers, not the agent's known failures. That is the right benchmark.

But these are turns a human chose to handle personally, which skews toward *harder* conversations
than the ones the agent handles unattended. So 29% is probably a slightly pessimistic read of
overall performance. It is not "the agent gets 71% of all conversations wrong."

## The floor: 20%

`GOLD_SCORE_FLOOR=20`.

The floor is a **smoke alarm, not a target**. It catches the day the agent falls over — a prompt
regression, a broken composer, replies coming out empty. It does not make the agent better.

At n=117 the trade-off is finally a good one:

| floor | blocks a healthy (29%) agent | misses an agent that HALVED to 15% |
|---|---|---|
| 15% | 0.02% of runs | 49% |
| **20%** | **1.4% of runs** | **7%** |
| 25% | 18% of runs | 0.2% |
| 30% | blocks *everything* | — |

20% almost never fires by accident and catches a halving better than nine times in ten. That
combination was impossible at n=20, where every setting either cried wolf or missed things — which
was the whole argument for growing the corpus.

**Do not set the floor to the current score.** A floor at 29% would block roughly a third of
deploys on an agent that is working fine.

### Raising it

Raise the floor when the score genuinely moves, not when a single run looks good. With a 16-point
interval, a run has to clear the *previous interval* before it means anything — so a reading of 40%
is real progress, a reading of 33% is probably noise.

The 74 unanimous-wrong items in the report are the improvement backlog: those are turns where all
three judges agreed the agent missed what the salesperson did.

## What each routine has to do

Every routine that **merges** checks the freeze first:

```bash
npx tsx scripts/merge_freeze.ts check    # exit 0 = merge away, exit 3 = FROZEN
```

Exit 3 ⇒ do not merge. Finish the build/triage work, note it in one line, land it next tick. A
freeze pauses *landing*, not thinking — building PRs, triaging, sweeping and reporting all carry on.
