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
| Runtime data | one `DATA_DIR` per dealer, for example `/home/ubuntu/leadrider-runtime/<dealer>/data` |
| Secrets | one remote `.env` per dealer API process |
| Webhooks | Twilio, SendGrid, and Google callbacks point to that dealer's API hostname |
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
5. Move the dealer `DATA_DIR` to a neutral runtime path such as `/home/ubuntu/leadrider-runtime/americanharley/data`.
6. Verify health, webhook delivery, and one representative conversation.
7. After production is stable, leave the old dirty repo and data folders untouched until all runtime/state dependencies have been audited.

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

For each dealer, the Command Dealer Setup flow can generate the clean API deployment shape from the dealer slug:

- checkout: `/home/ubuntu/leadrider-api/<dealer-slug>`
- runtime data: `/home/ubuntu/leadrider-runtime/<dealer-slug>/data`
- runtime env: `/home/ubuntu/leadrider-runtime/<dealer-slug>/api.env`
- PM2 process: `leadrider-api-<dealer-slug>`
- health check: `https://api.<dealer-slug>.leadrider.ai/health`

American Harley is the first client and currently keeps the PM2 process name `throttleiq-api` while running from the clean checkout `/home/ubuntu/leadrider-api/americanharley`. New dealers should use the `leadrider-api-<dealer-slug>` process name unless there is a documented migration reason not to.

Use the **API deploy profile** button in Dealer Setup to copy the generated profile text, then save it locally as:

```text
infra/deploy/<dealer-slug>.api.env
```

If you are creating it manually, start from the American Harley example:

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

You can also generate a complete local runtime handoff package from Dealer Setup:

```bash
npm run dealer:config:export -- --slug <dealer-slug>
npm run dealer:config:verify -- --slug <dealer-slug>
```

The default package path is `reports/dealer-setup/<dealer-slug>/runtime-config-package`. It includes the normalized dealer config, `dealer_profile.json`, Lightsail deploy profile, remote API env template, Vercel env template, deployment manual, smoke script, manifest, checksums, and explicit human approval stops. It is an offline package only; it does not deploy, change DNS, submit vendor forms, create credentials, or send customer-facing messages.

Command Dealer Setup also exposes the same package from **Technical details** as **Runtime package**. Use that browser action for preview/download during onboarding; use the CLI commands when you need the files written under `reports/`.

Before requesting any deployment approval, run the launch dry-run:

```bash
npm run dealer:launch:dry-run -- --slug <dealer-slug>
```

The dry-run aggregates the runtime package verification, deploy profile, DNS records, remote API env checklist, tenant-isolated runtime paths, launch checklist, smoke-test state, and vendor/compliance setup steps. It is read-only: no SSH, deploy, Vercel, DNS, Twilio, SendGrid, Google, CRM, or customer-message action is performed.

After the profile is created, deploy with:

```bash
npm run deploy:api -- --profile infra/deploy/<dealer-slug>.api.env
```

## Dealer Launch Checklist

The Command Dealer Setup page now follows one repeatable workflow from closed-won prospect to launch:

- dealer intake
- domains and subdomains
- SendGrid sender/domain
- Twilio SMS and compliance
- Google Calendar and users
- inventory/export URL
- CRM/ADF/Twilio routing
- dealer profile, tone, rules, and feature flags
- remote API env
- API tenant/runtime setup
- Vercel frontend setup
- deployment manual
- smoke tests
- launch gate
- production launch and post-launch monitoring

The API deploy profile only defines where the app should run. The remote API `.env` still has to exist on the server and contain the dealer's real secrets. Use the **Remote API env** section in Dealer Setup to copy a safe template, fill secret values directly on the server, then mark **Remote API env confirmed**.

Blocked third-party items such as DNS propagation, Twilio A2P/10DLC approval, SMS consent/legal review, SendGrid domain verification, vendor logins, OAuth, credentials, or MFA should be marked blocked or waiting on dealer without stopping unrelated setup steps.

Run a public per-dealer smoke test without deploying:

```bash
npm run dealer:smoke -- --dealer americanharley
npm run dealer:smoke -- --dealer <dealer-slug>
```

You can override generated URLs when testing a custom host:

```bash
npm run dealer:smoke -- --app https://<dealer>.leadrider.ai --api https://api.<dealer>.leadrider.ai
```

## American Harley Sandbox Setup

American Harley is the live first client and should be used as the read-only canary. To test the repeatable Dealer Setup workflow without touching production vendor settings, seed a sandbox setup record:

```bash
npm run dealer:seed:american-harley-sandbox
```

The default slug is `americanharley-sandbox`, which generates sandbox web/API/runtime paths such as:

- `https://americanharley-sandbox.leadrider.ai`
- `https://api.americanharley-sandbox.leadrider.ai`
- `/home/ubuntu/leadrider-runtime/americanharley-sandbox/data`

This seed record is for setup workflow, config, manual, launch-gate, and task testing only. Do not deploy it, change live DNS, submit Twilio/SendGrid/Google/vendor changes, or reuse live credentials without explicit approval.

Preview the seed payload without writing:

```bash
npm run dealer:seed:american-harley-sandbox -- --dry-run
```

Generate and verify the sandbox runtime package:

```bash
npm run dealer:workflow:american-harley-sandbox
npm run dealer:config:export -- --slug americanharley-sandbox
npm run dealer:config:verify -- --slug americanharley-sandbox
npm run dealer:launch:dry-run -- --slug americanharley-sandbox
npm run dealer:runtime-isolation:eval -- --sandbox americanharley-sandbox
```

The sandbox package should remain review-only until there is explicit approval to create DNS/provider/runtime changes.
