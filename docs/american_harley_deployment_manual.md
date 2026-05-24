# American Harley Deployment Manual

This document is the source-controlled reference for the first client deployment. The live, printable version is generated inside Command Dealer Setup from `services/api/src/domain/dealerDeploymentManual.ts`.

When setup steps, provider requirements, runners, compliance gates, or deployment paths change, update the generated manual and this reference in the same change.

## Current Production Shape

| Item | Value |
| --- | --- |
| Dealer | American Harley-Davidson |
| Dealer web UI | `https://americanharley.leadrider.ai` |
| Dealer API | `https://api.americanharley.leadrider.ai` |
| LeadRider Command | `https://www.leadrider.ai/command` |
| API host | Lightsail / PM2 |
| Clean API checkout | `/home/ubuntu/leadrider-api/americanharley` |
| Runtime env | `/home/ubuntu/leadrider-runtime/americanharley/api.env` |
| Runtime data | `/home/ubuntu/leadrider-runtime/americanharley/data` |
| PM2 process | `throttleiq-api` |
| Health check | `https://api.americanharley.leadrider.ai/health` |
| Rollback folders | `/home/ubuntu/throttleiq` and `/home/ubuntu/throttleiq-runtime` remain intentionally present |

## Deployment Rule

Use the split deployment until the API is moved to durable database/storage and background work is separated:

- Vercel serves the web UI.
- Lightsail/PM2 serves the always-on API.
- Dealer runtime data and env stay outside the git checkout.
- API deploys back up the runtime data directory first.
- Old server folders are not archived until the clean path has been stable through a quiet production window.

## Start-To-Finish Operator Flow

1. Create or push the dealer from Sales Funnel into Dealer Setup.
2. Confirm dealer intake fields: website, legal name, DBA, address, primary contact, plan, monthly fee, setup fee, usage, overage terms, and contract term.
3. Prepare the agreement packet and send for review/signature.
4. Add the dealer web hostname to Vercel.
5. Generate DNS records and have the DNS owner add them.
6. Prepare the API deployment profile.
7. Add the remote API env values on the server. Secrets stay only in the server env file.
8. Configure Google mail/calendar, Twilio messaging, SendGrid email, Meta, and any enabled ops stack.
9. Track slow approval items in parallel. DNS, A2P/10DLC, SendGrid sender verification, OAuth login/MFA, Meta app review, and dealer website SMS privacy edits block go-live but should not stop other setup steps.
10. Deploy the API with the generated profile.
11. Run the smoke test.
12. Push to Active Clients only when all go-live blockers are clear.

## American Harley API Deploy Command

```bash
npm run deploy:api -- --profile infra/deploy/americanharley.api.env
```

The profile should point to:

```text
DEPLOY_HOST=ubuntu@api.leadrider.ai
DEPLOY_REPO=/home/ubuntu/leadrider-api/americanharley
DEPLOY_DATA_DIR=/home/ubuntu/leadrider-runtime/americanharley/data
DEPLOY_ENV_FILE=/home/ubuntu/leadrider-runtime/americanharley/api.env
DEPLOY_PM2_PROCESS=throttleiq-api
DEPLOY_HEALTH_URL=https://api.americanharley.leadrider.ai/health
DEPLOY_REPLACE_PM2=1
DEPLOY_ALLOW_DIRTY_REMOTE=0
```

## Required Go-Live Checks

- Public API health is OK.
- Dealer web UI loads.
- Inventory loads.
- One representative conversation opens.
- Twilio inbound webhook points to the dealer API.
- Outbound SMS sends from the dealer number.
- SendGrid inbound route and outbound sender work.
- Google calendar/mail tokens are connected where required.
- Meta app callback and app status are verified if Campaign Studio is enabled.
- MDF/browser runner is registered if the dealer uses portal automation.
- SMS consent/privacy language and public policy links are verified before SMS launch.

## SMS Consent Gate

Dealer lead/contact forms should include consent language before submit:

> By submitting, you agree that the dealership may contact you at the phone number and email provided by call, text, or email about your inquiry. Consent is not a condition of purchase. Message and data rates may apply. Reply STOP to opt out or HELP for help. See our Privacy Policy and Terms of Use.

The website should also clearly link to Privacy Policy and Terms of Use pages. Mobile opt-in data should not be sold or shared for third-party marketing.

## Rollback Rule

If a deploy fails, keep runtime data intact, use the automatic backup created by the deploy script if needed, and keep the old folders available until a stable rollback decision is made. Do not delete old American Harley folders as part of routine cleanup yet.
