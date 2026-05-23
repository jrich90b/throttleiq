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

The current production server has accumulated source and generated-file drift from manual patches. Do not clean it up by resetting the folder in place. The safer first step is to move PM2 to a clean release checkout and leave the old folder intact as a rollback/source backup:

1. Keep the existing `/home/ubuntu/throttleiq` folder untouched.
2. Deploy a clean checkout to a dealer-specific path such as `/home/ubuntu/leadrider-api/americanharley`.
3. Point PM2 at the clean checkout with `DEPLOY_REPLACE_PM2=1`.
4. Move the dealer `.env` to a neutral runtime path such as `/home/ubuntu/leadrider-runtime/americanharley/api.env`.
5. Verify health, webhook delivery, and one representative conversation.
6. After production is stable, leave the old dirty repo folder untouched until all runtime/state dependencies have been audited.

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
