# LeadRider Multi-Client Deployment Path

## Current Recommendation

Keep LeadRider in a split deployment while the product is becoming multi-client:

1. Vercel serves the dealer-facing web UI.
2. An always-on API server, currently Lightsail, handles webhooks, background loops, CRM/browser automation, MDF runner tasks, and runtime data.
3. Each dealer starts isolated with its own web hostname, API hostname, runtime data directory, and integration credentials.

This is safer than moving the whole API to Vercel now because the API still depends on long-running processes, local runtime data, uploads, webhooks, and browser automation.

## Target Shape For The Next Few Dealers

Use the same product repo, but keep dealer runtime separated.

| Layer | Early multi-client pattern |
| --- | --- |
| Web UI | Vercel project/domain per dealer, or a shared project only after host-based API routing exists |
| API | PM2 process per dealer or server per dealer |
| Runtime data | one `DATA_DIR` per dealer |
| Secrets | one remote `.env` per dealer API process |
| Webhooks | Twilio/SendGrid/Google/Meta point to that dealer's API hostname |
| Browser/MDF runners | one registered runner computer per dealer where needed |

Example:

```text
americanharley.leadrider.ai       -> Vercel web
api.americanharley.leadrider.ai   -> Lightsail API

nextdealer.leadrider.ai           -> Vercel web
api.nextdealer.leadrider.ai       -> next dealer API process/server
```

## Non-Negotiables

- Do not edit `services/api/dist` directly on production except for a documented emergency hotfix.
- Do not keep runtime JSON or uploaded files in the git checkout.
- Do not deploy over a dirty remote worktree during normal releases.
- Back up the dealer `DATA_DIR` before every API deploy.
- Use `git pull --ff-only`, build, restart PM2, then run a public health check.
- Keep API DNS pointed to the API server. Only the web hostname should point to Vercel.

## Standard Release Flow

1. Make and test code changes locally.
2. Commit and push to `main`.
3. Vercel deploys the web app from `apps/web`.
4. Deploy the API with the guarded script:

```bash
cp infra/deploy/americanharley.api.env.example infra/deploy/americanharley.api.env
scripts/deploy_api_lightsail.sh --profile infra/deploy/americanharley.api.env
```

5. Check:
   - public API health returns OK,
   - web UI loads,
   - Twilio inbound webhook still works,
   - outbound SMS/email still sends,
   - one representative lead/conversation opens.

## First Cleanup Needed On The Existing Server

The current production server has accumulated source and generated-file drift from manual patches. Before the guarded deploy path can be used normally, reconcile that drift once:

1. Inspect `git status --short` on the server.
2. Move runtime/generated files out of the repo into `DATA_DIR` or backups.
3. Commit any real source changes that must survive.
4. Remove or stash temporary production-only patches after they are represented in git.
5. Run `scripts/deploy_api_lightsail.sh --profile ... --dry-run`.
6. Run the real deploy only when the dry run is clean.

The goal is that production is always reproducible from Git plus the dealer `.env` and `DATA_DIR`.

## When To Move More To Vercel

Move more API routes to Vercel only after:

1. Runtime JSON stores are replaced with a database.
2. Uploads move to object storage.
3. Background loops become queue/cron/worker jobs.
4. Browser automation stays on a runner or separate worker host.
5. The web app can route by hostname without one hardcoded `API_BASE_URL` per project.

Until then, Vercel is the right place for the UI and lightweight proxy routes; the API server remains the right place for always-on dealer operations.

## Dealer Setup Profile Template

For each dealer, create a local deploy profile from the example:

```bash
cp infra/deploy/americanharley.api.env.example infra/deploy/<dealer-slug>.api.env
```

Set:

- `DEPLOY_HOST`
- `DEPLOY_REPO`
- `DEPLOY_BRANCH`
- `DEPLOY_DATA_DIR`
- `DEPLOY_ENV_FILE`
- `DEPLOY_PM2_PROCESS`
- `DEPLOY_HEALTH_URL`

Do not store API keys, Twilio tokens, SendGrid keys, or Google secrets in the deploy profile. Those belong in the remote API `.env`.
