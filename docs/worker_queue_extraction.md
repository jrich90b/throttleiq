# Worker + Queue Extraction (Dispatcher Phase)

Status: implemented 2026-06-10 behind `WORKER_DRIVEN_TICKS` (default off — the
API keeps its in-process intervals until enablement). Not yet enabled in
production.
Owner: Joe.

## Goal

Move background scheduling out of the API process so an API restart or crash
never threatens due follow-ups, and scheduled work gets durability + retries
from Postgres (the `leadrider-db` provisioned for the store swap,
`docs/postgres_store_swap.md`).

## Design: Dispatcher, Not Executor

The conversation store is an in-memory Map owned by the API process
(single-writer invariant). A second process must not mutate it. So
`services/worker` is a **dispatcher**:

- pg-boss (Postgres-backed queue, schema `pgboss` in `leadrider`) holds the
  schedules and provides cron firing, retries, and a durable record of runs.
- Each job handler POSTs task names to the API's
  `POST /internal/worker/tick` endpoint (token-auth via `x-worker-token`),
  and the API executes the matching in-process functions exactly as its old
  `setInterval` ticks did — same locks, same single writer.
- If a tick fails (API down mid-restart, task threw), pg-boss retries with
  backoff (`retryLimit` 2, 30 s delay by default), which is precisely the
  durability the `setInterval` model lacked.

Pieces:

| Piece | Where |
| --- | --- |
| Task registry (shared names) | `services/api/src/domain/workerTasks.ts` |
| Dispatch map task → function | `services/api/src/index.ts` (`WORKER_TICK_DISPATCH`) |
| Tick endpoint + token auth | `services/api/src/index.ts` (`/internal/worker/tick`) |
| Schedules (cron + task lists) | `services/worker/src/config.ts` |
| HTTP dispatch + failure propagation | `services/worker/src/tick.ts` |
| pg-boss wiring + shutdown | `services/worker/src/index.ts` |
| Eval (ci:eval, no DB needed) | `scripts/worker_dispatch_eval.ts` |

Schedules in this phase mirror the legacy intervals exactly:

- `tick-followups` every minute: `follow-ups`, `appt-confirm`,
  `staff-appt-notify`, `appt-questions`
- `tick-inventory` every 5 minutes: `inventory-watch`, `inventory-holds`

Still in-process on purpose (later phases): Google keepalive, support/personal
mail polling, Claude agent loop (integration pollers with their own env
gates), and the conversation-store sweep (internal to the store).

## Env

| Var | Where | Meaning |
| --- | --- | --- |
| `WORKER_DRIVEN_TICKS=1` | API | Disable in-process intervals; rely on worker. Default off = today's behavior |
| `WORKER_INTERNAL_TOKEN` | both | Shared token for `/internal/worker/tick` (falls back to `AUTOMATION_RUN_WRITE_TOKEN`) |
| `DATABASE_URL` / `WORKER_DATABASE_URL` | worker | pg-boss storage |
| `WORKER_API_BASE_URL` | worker | Default `http://127.0.0.1:3001` |
| `PG_SSL=1` | worker | TLS without CA verification (same as the store swap) |
| `WORKER_TZ` | worker | Cron timezone, default `America/New_York` |

## Enablement Runbook (per dealer)

Order matters: worker first (redundant ticks are safe — the API keeps its
overlap locks), then flip the API.

1. Deploy the code (normal guarded deploy).
2. Add to the dealer's remote API env file: `WORKER_INTERNAL_TOKEN=<random>`.
   (Do not set `WORKER_DRIVEN_TICKS` yet.)
3. Start the worker under PM2 from the same checkout:

   ```bash
   cd /home/ubuntu/leadrider-api/americanharley
   set -a; . /home/ubuntu/leadrider-runtime/americanharley/api.env; set +a
   pm2 start npm --name leadrider-worker-americanharley \
     --cwd /home/ubuntu/leadrider-api/americanharley \
     -- --workspace @throttleiq/worker run start
   pm2 save
   ```

4. Watch `pm2 logs leadrider-worker-americanharley` for
   `tick-followups ok ...` lines (proves schedule → dispatch → API runs).
5. Flip the API: add `WORKER_DRIVEN_TICKS=1` to the API env, restart the API
   process (`pm2 restart throttleiq-api --update-env` with env sourced).
   Boot log shows `WORKER_DRIVEN_TICKS=1: in-process background ticks
   disabled`.
6. Verify over ~15 minutes: follow-up sends still go out, `pm2 logs` for the
   worker shows ticks succeeding, no `pg-boss error` lines.

**Rollback:** remove `WORKER_DRIVEN_TICKS` from the API env + restart
(intervals resume), `pm2 stop leadrider-worker-americanharley`. Either half
alone is also safe — double ticking is prevented by the API's overlap locks,
and a stopped worker with `WORKER_DRIVEN_TICKS` unset is just today's
behavior.

## Future Phases

- Move integration pollers (mail, keepalive, Claude agent) onto worker
  schedules the same way.
- Per-conversation jobs (send-at-time instead of minute scanning) once the
  store read-flip is done and job payloads can reference Postgres rows.
- Browser automation (TLP/MDF runners) stays on dedicated runner machines.
