# Vendor Accounts

Use `support@leadrider.ai` as the primary customer/support identity. Use `integrations@leadrider.ai` for vendor accounts, OAuth grants, app ownership, and automation/service notifications.

## Identity and Domain

- Registrar: Namecheap
- DNS management UI: AWS Lightsail Domains & DNS
- DNS host: AWS Lightsail Domains & DNS
- Email host: Google Workspace
- Primary mailbox: `support@leadrider.ai`
- Integrations mailbox: `integrations@leadrider.ai`
- Personal mailbox: `joe.hartrich@leadrider.ai`
- Backup/recovery mailbox: `leadriderai@gmail.com`

## Production and Delivery

- Hosting: current API host, planned Vercel for web/landing
- Vercel: `LeadRider` team created under `integrations@leadrider.ai` on Pro Trial May 18, 2026; payment method not yet added
- Error tracking: Sentry org `leadrider` under `integrations@leadrider.ai`; Express/API project created May 18, 2026
- Incident alerts: Slack workspace `Leadrider` (`leadrider.slack.com`) created under `integrations@leadrider.ai` on Free plan May 18, 2026; `#incidents` channel and `LeadRider Incidents` Slack app/webhook created May 18, 2026; webhook rotated after setup and production test passed
- Issue tracker: Linear workspace `LeadRider` (`linear.app/leadrider`), team key `LEA`, team ID `a7f65092-379e-47fc-bdda-561c74d98ac6`, owner `integrations@leadrider.ai`; incident pipeline API key created May 18, 2026
- OpenAI Platform organization: `LeadRider`; `integrations@leadrider.ai` Owner invite accepted May 18, 2026
- Messaging: Twilio
- Twilio admin invite: `integrations@leadrider.ai` invited as Admin on May 18, 2026; accepted by user, pending console re-check
- Email delivery: SendGrid
- SendGrid teammate/admin invite: `integrations@leadrider.ai` accepted by user on May 18, 2026; pending console re-check
- Calendar/OAuth: Google Cloud / Google Workspace (`integrations@leadrider.ai`)
- Google Cloud project owner for Vertex/Nano Banana: `integrations@leadrider.ai`
- Vertex runtime service account: `vertex-search-runner@american-harley-davidson-3436.iam.gserviceaccount.com`
- Social publishing: Meta Developers

## Planned Account Setup Order

1. Google Workspace for `leadrider.ai` - domain verified, Gmail MX active
2. Sentry organization/project
3. Slack incident channel and incoming webhook - done May 18, 2026
4. Linear workspace/team and API key - done May 18, 2026
5. Vercel team/project for web and landing
6. Production environment variables and incident test
