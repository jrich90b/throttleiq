# Console Copilot — Phase 1 spec (Joe approved 2026-08-05)

## What this is

An "Ask AI" panel in the dealer console that answers staff questions about the store's
leads from the data LeadRider already collects — the piece of the Transax Nexus pitch we
don't have yet ("show me hot leads", "how many overdue tasks", "how's this month's
pipeline"). Their 24/7 AI sales agent we already have; this is the manager-facing
insights layer on top.

## Phase 1 scope (this build)

**Read-only. Never touches a customer.** A bug here means a wrong dashboard answer,
never a wrong text to a lead.

1. **Hot leads** — a deterministic, explainable heat score per open lead, computed from
   already-parsed state (no new comprehension):
   - replied within the last 48h (recency, weighted)
   - accepted/asked for a visit but has no booked appointment (the funnel's binding leak)
   - asked about payment/finance recently
   - active watch on a unit (arrival-contingent demand)
   - open staff task on the lead
   Every score comes with its reasons ("replied 3h ago; visit offered, not booked"), so
   staff see *why* a lead is hot, not a black-box number.
2. **Snapshot stats** — overdue/open task counts, open-lead counts by source, booking
   funnel (offered vs booked), reply-recency distribution. All deterministic.
3. **Free-form "Ask AI"** — staff question + the deterministic snapshot go to the LLM;
   the answer must be grounded in the snapshot's numbers (the model explains and
   selects, it does not invent counts). One LLM call per question, with a daily
   per-dealer call cap (lesson from the uncapped-nudge cost incident).

### Explicitly OUT of Phase 1 (Phase 2, approve-first)
- Marketing-list generation/export. When built: opt-out exclusion is a mandatory,
  eval-pinned filter from day one, and the feature *produces lists* — it never sends.
- Saved reports / scheduled digests.
- Any write action from the copilot (booking, task creation, replies).

## Architecture

- **Pure domain module** `services/api/src/domain/copilotInsights.ts`:
  `computeLeadHeat(conv, now)` and `buildCopilotSnapshot(convs, now)`. Pure functions of
  (store record, clock) — no I/O, fully unit-evalable. Deterministic is correct here per
  AGENTS.md: this is structured derivation from already-parsed state, not customer-intent
  comprehension.
- **API** (staff-auth, same guard as existing console endpoints):
  - `GET /copilot/insights` — the deterministic snapshot (hot leads + stats). No LLM.
  - `POST /copilot/ask` — `{question}` → LLM answer grounded on the snapshot, via the
    existing structured-JSON LLM helper. Returns `{answer, leadRefs[]}` so the console
    can link straight to conversations.
- **Console** `apps/web`: a Copilot panel — hot-leads list (score + reasons, click →
  conversation) + Ask box. Icons from the shared `UiIcon` set; contrast per AGENTS.md.

## Safety & cost rails

- Endpoints are read-only against the store; the ask endpoint's LLM sees a compact
  snapshot (aggregates + top-N lead summaries), not raw full transcripts.
- Daily LLM call cap per dealer on `/copilot/ask`; the deterministic `GET` is uncapped.
- Answers carry a "computed from live store at &lt;time&gt;" stamp.

## Eval (wired into ci:eval)

`scripts/console_copilot_insights_eval.ts` — deterministic, pinned clock (the 8/5
midnight-red lesson): fixture conversations covering each heat signal, expected scores
and reasons, snapshot counts, and the visit-accepted-but-unbooked selector. The LLM ask
path is NOT in the deterministic gate; the heat/snapshot math it answers from is.

## Ship path

Supervised-session rules: branch off main (worktree `console-copilot-phase1`), tsc +
ci:eval green, merge-freeze check, then push + deploy (`npm run deploy:api`, web deploy
with the hard-refresh warning). Joe approved the build 2026-08-05 in chat.
