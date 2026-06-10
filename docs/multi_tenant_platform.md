# Multi-Tenant Platform Design (Dealer #2 = a Row, Not a Server)

Status: design draft 2026-06-10, for review — no implementation started.
Owner: Joe.
Depends on: `docs/postgres_store_swap.md` (live in dual-write shadow),
`docs/worker_queue_extraction.md` (shadow-running), Dealer Setup workflow
(`dealerSetupStore.ts`, `dealerRuntimePackage.ts`).

## Goal

Onboarding a dealer today means: a Vercel project, DNS records, a dedicated
API process, a hand-built env file, webhook configuration, and a deploy — the
runbook in `docs/multi_client_deployment.md`. The goal is to compress that to:

1. complete Dealer Setup in Command (already built),
2. run one provisioning command,
3. point DNS (one CNAME pair) and configure vendor webhooks.

Everything else — port allocation, nginx route, TLS, PM2 processes (API +
worker), runtime dirs, env scaffolding, cron lines, Postgres scoping — is
derived from the dealer record.

## The Crux: Why Not One Shared Process (Yet)

The API is built on module-level singleton state: the conversation store Map,
`dealerProfile`, `schedulerConfig`, tone rules, inventory snapshot — dozens of
modules cache exactly one dealer's world at import time. A true shared
multi-tenant process means converting every singleton into per-tenant
instances behind an AsyncLocalStorage request context — a months-long refactor
through `index.ts` with regression risk across every guardrail in AGENTS.md.

The process boundary is also our strongest isolation: a bug can't leak dealer
A's customer into dealer B's prompt when they don't share memory.

So the design keeps **one process pair (API + worker) per dealer** and makes
everything *around* the processes shared and automated. The shared-process
refactor is staged last (M3) with explicit entry criteria, not assumed.

```
            *.leadrider.ai DNS ──► Lightsail instance
                                        │
                                  nginx (Host map, TLS)
                                        │
        ┌──────────────┬────────────────┼────────────────┐
   :3001 americanharley  :3011 dealer2   :3021 dealer3 ...
   API + worker pair      API + worker    API + worker
        └──────────────┴───────┬────────┴────────────────┘
                               │
                 leadrider-db (Postgres, dealer_id on every row)
                 pgboss_<slug> schema per dealer worker
```

## What Already Exists (Build On, Don't Rebuild)

- `dealerSetupStore.ts`: `routingMode` (subdomain/path/integration_mapping),
  `localPort`, `proxyPathPrefix`, per-dealer URLs, launch checklist.
- `dealerRuntimePackage.ts`: generates deploy profile, env templates, nginx
  route **preview**, deployment manual, smoke script.
- `scripts/deploy_api_lightsail.sh`: profile-driven deploy with health gates.
- Postgres: `dealer_id` on every conversations/store_documents row (done);
  `DEALER_ID` env already scopes each process.
- Worker dispatcher with token-authed `/internal/worker/tick` (done).
- `dealer:smoke`, `dealer:launch:dry-run`, sandbox seed workflow.

The provisioning command (M2) is mostly *applying* what the runtime package
already generates as review-only artifacts.

## M1 — Shared Ingress (formalize the half-built shape)

One nginx in front of per-dealer local ports on the instance.

- **Port allocation:** `localPort` from the dealer setup record is
  authoritative (allocate 3001, 3011, 3021, … — gap of 10 leaves room for
  per-dealer sidecars). American Harley keeps 3001.
- **nginx:** one `server` block per dealer hostname proxying to
  `127.0.0.1:<localPort>` (the generated `*.nginx.conf.preview` files become
  real config under `/etc/nginx/conf.d/leadrider/<slug>.conf`). Webhooks,
  uploads, and health all pass through unchanged.
- **TLS:** per-hostname certs via certbot HTTP-01 issued during provisioning
  (no DNS-API dependency). Revisit a wildcard cert only if cert count becomes
  a nuisance.
- **Worker pairing:** each dealer gets `leadrider-worker-<slug>` beside
  `leadrider-api-<slug>` with `WORKER_API_BASE_URL=http://127.0.0.1:<localPort>`.

**Required fix before dealer #2 (small, do early):** pg-boss queue names are
global per schema. Two dealers' workers would collide on `tick-followups` in
the shared `pgboss` schema — second worker's `schedule()` overwrites the
first's. Fix: provisioning sets `PGBOSS_SCHEMA=pgboss_<slug>` per dealer
(worker already reads `PGBOSS_SCHEMA`; pg-boss creates the schema on start).
American Harley migrates from `pgboss` → `pgboss_americanharley` at the next
worker restart; abandoned schema is dropped manually.

## M2 — One-Command Provisioning + Shared Web

`npm run dealer:provision -- --slug <slug>` (runs on the instance, or locally
over SSH like `deploy:api`), driven entirely by the dealer setup record:

1. Create `/home/ubuntu/leadrider-runtime/<slug>/{data,reports}` and
   `api.env` from the generated template (secrets left as `FILL_ME`
   placeholders; the command re-runs idempotently after secrets are filled —
   same approval-stop philosophy as the runtime package).
2. Layered env: introduce `/home/ubuntu/leadrider-runtime/platform.env`
   (shared: `DATABASE_URL`, `PG_SSL`, `OPENAI_API_KEY`, LLM flags). Dealer
   `api.env` holds only dealer-scoped values (Twilio, SendGrid, TLP, profile
   path, `DEALER_ID`, `PORT`, `WORKER_INTERNAL_TOKEN`, `PGBOSS_SCHEMA`).
   Process startup sources platform then dealer (dealer wins). Kills the
   secret-duplication problem and makes platform-wide rotations one edit.
3. Write nginx conf from the preview + `certbot --nginx -d api.<slug>...`
   + reload (each step gated behind an explicit `--apply` flag; default is
   dry-run printing the diff, consistent with launch-gate culture).
4. Checkout: clone/pull `/home/ubuntu/leadrider-api/<slug>`, build, PM2 start
   API + worker pair, `pm2 save`.
5. Generate the dealer's cron lines (nightly/hourly loops with the dealer's
   `DATA_DIR`/`REPORT_ROOT`/`FEEDBACK_LOOP_ENV_PATH`) — printed for review,
   applied with `--apply-cron`.
6. Run `dealer:smoke` and print the remaining manual checklist (DNS records,
   Twilio/SendGrid webhook URLs, vendor logins) — the same blocked-items
   model Dealer Setup already tracks.

**Shared web app:** collapse per-dealer Vercel projects into one. The web app
derives the API base from its own hostname
(`<slug>.leadrider.ai` → `https://api.<slug>.leadrider.ai`) instead of a
build-time `API_BASE_URL`; dealer branding/config comes from the API
(`/public/...` bootstrap endpoint keyed by host). New dealer = add domain to
the single Vercel project. (This is the "shared project only after host-based
API routing exists" line in `multi_client_deployment.md` — M1 provides that
routing.)

**Capacity note:** instance memory is the binding constraint (~150–300 MB per
API process at steady state, worker ~60 MB). Expect roughly 6–10 dealers per
4 GB box. Scaling = bigger instance or a second instance with its own nginx —
`DEPLOY_HOST` per dealer already supports multi-box; the provisioning command
takes `--host`. Postgres is shared across boxes either way.

## M3 — Shared-Process Tenancy (Criteria-Gated, Not Scheduled)

Enter only when at least one is true: >~10 dealers per box makes process
overhead dominate; ops burden of N PM2 pairs measurably hurts; or a platform
feature genuinely needs cross-dealer request handling.

Shape when it happens: AsyncLocalStorage `tenantContext` set from the Host
header; store modules convert one at a time from module singletons to
dealer-keyed instances (`getStore(dealerId)`) — the Postgres layer already
keys everything by `dealer_id`, so this is an in-memory refactor, not a data
migration. The per-dealer-process model keeps working throughout; dealers
migrate to the shared process individually behind a flag, eval-gated, same
playbook as the store swap. Promoted learning artifacts (tone rules, few-shot
examples) must become dealer-scoped rows *before* any shared process serves
two dealers — that work rides with the feedback-loop tenant-awareness item.

## Isolation & Security Model

- Process boundary per dealer (memory isolation) + per-dealer env (credential
  isolation) — unchanged from today.
- Shared Postgres scoped by `DEALER_ID` per process. Optional hardening
  later: one Postgres role per dealer with row-level security on `dealer_id`
  (deferred — single-account risk today is the app itself, which is already
  the trust boundary).
- `WORKER_INTERNAL_TOKEN` is per dealer (different token per env file).
- nginx adds the only new shared surface; configs are generated + reviewed,
  and `proxyPathPrefix`/`integration_mapping` modes remain available for
  dealers who can't take subdomains.

## American Harley Migration

Already M1-shaped: port 3001, clean checkout, neutral runtime paths, worker
pair running. Remaining deltas, each independently safe:

1. `PGBOSS_SCHEMA=pgboss_americanharley` + worker restart (the queue-collision fix).
2. Rename PM2 `throttleiq-api` → `leadrider-api-americanharley` during a
   normal deploy window (`DEPLOY_PM2_PROCESS` + `DEPLOY_REPLACE_PM2=1` —
   documented migration exception already exists).
3. Split `platform.env` out of its `api.env` when M2 lands.
4. Confirm/formalize the nginx server block matches the generated preview.

## Implementation Order & Sizing

| Step | Size | Risk | Unblocks |
| --- | --- | --- | --- |
| pg-boss schema-per-dealer | hours | low | dealer #2 worker |
| nginx conf formalization + AH PM2 rename | hours | low (deploy window) | shared ingress |
| `dealer:provision` (dry-run first) | days | low — generates, gated applies | dealer #2 in minutes |
| platform/dealer env layering | hours | low | secret rotation, M2 |
| shared web app (host-derived API base) | days | medium — touches `page.tsx` | one Vercel project |
| per-dealer cron generation | hours | low | feedback loops at N dealers |
| tenant-scoped learning artifacts | days | medium | M3 prerequisite |
| M3 shared process | months | high | only if criteria met |

Suggested first PR: schema-per-dealer fix + `dealer:provision` dry-run mode —
zero production impact, and the dry-run output doubles as the review artifact
for everything else.

## Open Questions (for Joe)

1. Subdomain-per-dealer confirmed as the default (`routingMode: subdomain`)?
   The path/integration modes stay supported but unautomated initially.
2. Are any near-term dealers non-Harley OEMs? (Affects how fast the
   model-catalog/config-vs-code work from the architecture review needs to
   move — orthogonal to this doc but same timeline.)
3. Second instance appetite: scale the single box up, or prove two-box
   provisioning early with dealer #2 on its own instance?
