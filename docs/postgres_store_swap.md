# Postgres Store Swap (Durable Document Store Behind the In-Memory Map)

Status: implemented behind `DATA_BACKEND` (default `file`); not yet enabled in
production — next step is provisioning managed Postgres and running the
rollout below. The `postgres` and `dual_write` paths are validated by
`npm run store_persistence:eval` against a real PostgreSQL instance when
`DATABASE_URL_TEST` is set (file mode runs in `ci:eval` unconditionally).
Owner: Joe. Drafted 2026-06-09; implemented 2026-06-10.

## Goal

Replace the conversation store's whole-file JSON persistence with Postgres as a
durable document store, **without changing the programming model**. Call sites
keep mutating in-memory `Conversation` objects exactly as today; only the
load/save layer inside `services/api/src/domain/conversationStore.ts` changes.

What this buys:

- No more whole-file rewrite on every save (one corrupted write today can lose
  the entire conversation history; the malformed-row scrubbing in
  `loadFromDisk()` exists because this has already bitten).
- Managed point-in-time backups replace "back up `DATA_DIR` before deploy."
- Data durability decoupled from the single Lightsail box.
- `dealer_id` on every row from day one — the keystone for the future shared
  multi-tenant API, even while we still run process-per-dealer.

## Non-Goals (Explicitly Out of Scope)

- No relational normalization. Payloads stay JSONB documents.
- No repository/async rewrite of call sites. The in-memory `Map` and
  mutate-in-place semantics stay.
- No change to evals or local dev: file mode remains the default backend.
- Other store files (contacts, campaigns, users, settings, ...) migrate later
  (Phase 2) via the same generic table; this phase covers only the
  conversation store file (`conversations` + `todos` + `questions`).
- Uploads stay on disk (object storage is a separate workstream).
- No multi-process writers. Still exactly one API process per dealer.

## Current State (for reference)

`conversationStore.ts` loads `conversations.json` into a `Map` at module
import, indexes by `leadKey`, and persists with a 250 ms debounced
`saveToDisk()` that serializes **everything** (conversations array + `todos` +
`questions`) and atomically renames a temp file. `flushConversationStore()`
forces a save before early returns. `deleteConversation()` hard-deletes from
the Map. Dealer identity per process already exists as `DEALER_ID` /
`DEALER_SLUG` env (see `openaiUsageLogger.ts`), defaulting to the single
dealer.

## Schema

```sql
-- One row per conversation. payload is the exact JSON object stored today.
CREATE TABLE IF NOT EXISTS conversations (
  dealer_id  text        NOT NULL,
  id         text        NOT NULL,
  lead_key   text        NOT NULL DEFAULT '',
  payload    jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dealer_id, id)
);
CREATE INDEX IF NOT EXISTS conversations_lead_key_idx
  ON conversations (dealer_id, lead_key);

-- Generic single-document store for small collections.
-- Phase 1 uses exactly two rows per dealer: ('todos','all') and
-- ('questions','all'), each payload holding the whole array — identical
-- durability semantics to today's file, no per-row id assumptions.
CREATE TABLE IF NOT EXISTS store_documents (
  dealer_id  text        NOT NULL,
  store      text        NOT NULL,
  id         text        NOT NULL,
  payload    jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dealer_id, store, id)
);
```

`lead_key` is maintained by the write path (copied from `conv.leadKey`) so the
future shared API can look up by lead without parsing JSONB. Hot fields can be
promoted to indexed columns later as separate, eval-gated changes.

## Backend Selection

New env vars (all optional; defaults preserve today's behavior exactly):

| Var | Values | Default | Meaning |
| --- | --- | --- | --- |
| `DATA_BACKEND` | `file` \| `dual_write` \| `postgres` | `file` | Where the conversation store reads/writes |
| `DATABASE_URL` | Postgres URL | — | Required for `dual_write`/`postgres` |
| `DEALER_ID` | slug | `americanharley` | Row scope for every read/write |

- `file` — today's behavior, byte-for-byte. Evals, local dev, and CI never set
  `DATA_BACKEND`, so nothing changes for them.
- `dual_write` — reads from file at startup; every save writes the JSON file
  **and** upserts Postgres. File remains source of truth.
- `postgres` — reads from Postgres at startup; saves upsert Postgres. A JSON
  snapshot can still be written on each flush with `FILE_SNAPSHOT=1` as an
  escape hatch during the first weeks.

## Write Path

Keep `scheduleSave()` and the 250 ms debounce. Changes inside the store only:

1. **Dirty tracking.** Every mutation that currently calls `scheduleSave()`
   either already passes through `saveConversation(conv)` (add `conv.id` to a
   `dirtyConversationIds` set there) or touches `todos`/`questions` (set a
   `todosDirty`/`questionsDirty` flag at those call sites inside the store).
   `deleteConversation()` adds the id to a `removedConversationIds` set.
2. **Flush.** The debounced flush:
   - `file` mode: unchanged `saveToDisk()`.
   - `dual_write`: `saveToDisk()` first (source of truth), then best-effort
     Postgres upserts of dirty rows + deletes of removed ids + the two
     collection documents, in one transaction.
   - `postgres`: Postgres transaction first; `saveToDisk()` only if
     `FILE_SNAPSHOT=1`.
3. **Safety sweep.** Every `STORE_FULL_SWEEP_MINUTES` (default 30) — and
   whenever a mutation came from an untracked `scheduleSave()` call site —
   the next flush upserts **all** rows regardless of dirty flags. Correctness
   never depends on a call site having been tagged; tagging is purely a
   write-volume optimization on the hot paths.
4. **Failure semantics.** Postgres errors never block webhook handling:
   - `dual_write`: log + Sentry breadcrumb; file already saved; dirty set is
     retained so the next flush retries.
   - `postgres`: retry with backoff while keeping the dirty set; if Postgres
     is unreachable past `PG_DEGRADED_AFTER_MS`, force `FILE_SNAPSHOT`
     behavior on and raise an ops anomaly (`opsAnomalyStore`).
   Crash exposure stays what it is today: at most the debounce window plus
   any unflushed retries.

## Read Path / Startup

`loadFromPostgres()` runs `SELECT payload FROM conversations WHERE dealer_id =
$1` plus the two collection documents, then feeds rows through the **same
normalization currently in `loadFromDisk()`** (malformed-row coercion, legacy
todo class inference, lead-key indexing) — that logic gets extracted into a
shared `hydrateStore(parsed)` so file and Postgres loads cannot drift. Module
import keeps the same `void load…()` pattern; no call-site changes.

## Rollout Plan

Prereqs: instance clean-checkout migration (see
`docs/multi_client_deployment.md`) done first, so production is reproducible
before persistence semantics change.

1. **Provision** managed Postgres with PITR. Recommended: Lightsail managed
   PostgreSQL in the same region (private networking to the API instance).
   Neon or RDS are fine alternatives. Database `leadrider`, one user per
   environment, TLS required.
2. **Land code** behind `DATA_BACKEND` (default `file`) + `npm run pg:import`
   + `npm run pg:parity`. CI/evals run exactly as before.
3. **Seed**: on the instance, run `pg:import` (reads the live
   `conversations.json`, upserts everything; idempotent, re-runnable).
4. **Shadow week**: set `DATA_BACKEND=dual_write` in the PM2 env, restart API.
   Run `pg:parity` daily (add to the nightly feedback loop): it diffs file vs
   Postgres (row counts, per-conversation `updatedAt`, payload hash) and
   writes a JSON report; any mismatch is a stop-the-line signal.
5. **Flip reads**: `DATA_BACKEND=postgres FILE_SNAPSHOT=1`, restart, smoke
   test (`dealer:smoke` + open a real conversation + send one test turn).
6. **Steady state** (after ~2 more clean weeks): drop `FILE_SNAPSHOT`. The
   JSON file stops being written; `pg:import` in reverse (`pg:export`) exists
   for manual snapshots.

**Rollback at any step:** set `DATA_BACKEND=file` (or re-add
`FILE_SNAPSHOT=1`) and restart — the file stayed current through dual writes,
so rollback is an env flip, not a data migration. After step 6, rollback is
`pg:export` then `DATA_BACKEND=file`.

## New Files / Scripts

- `services/api/src/domain/storePersistence.ts` — backend selection, pg pool
  (`pg` dependency), upsert/delete/load functions, degraded-mode handling.
  `conversationStore.ts` calls into it; nothing else imports it in Phase 1.
- `scripts/pg_runtime_import.ts` (`npm run pg:import`) — file → Postgres seed.
- `scripts/pg_runtime_export.ts` (`npm run pg:export`) — Postgres → file.
- `scripts/pg_parity_check.ts` (`npm run pg:parity`) — diff report.
- `scripts/store_persistence_eval.ts` (`npm run store_persistence:eval`) —
  runs the store against a temp dir in `file` and (when `DATABASE_URL_TEST`
  is set) `postgres` modes: write/load round-trip, dirty-tracking coverage,
  delete propagation, malformed-row hydration parity. Wired into `ci:eval`
  in file mode so the suite never requires a database.

## Phase 2 (Later, Same Pattern)

Migrate remaining `dataPath()` stores one at a time into `store_documents`
(contacts, contact lists, campaigns, users, sessions, settings, suppressions,
agent tasks, dealer setups, active clients, MDF claims). Caches and
script-promoted artifacts (`inventory_snapshot.json`, tone rules, manual reply
examples) stay as files until the feedback-loop scripts are made
tenant-aware. `dealer_profile.json` migrates only alongside the multi-tenant
config work.

## Concurrency Note

Phase 1 touches `conversationStore.ts` plus new files only — minimal collision
surface with parallel agent work in `index.ts`/`sendgridInbound.ts`. Anyone
working in this repo: run `git fetch` and check ahead/behind before building
on `main`; multiple agents push to this repo.
