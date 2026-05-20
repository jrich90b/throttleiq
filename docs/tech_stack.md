# LeadRider Tech Stack

## Identity

- Domain: `leadrider.ai`
- Registrar: Namecheap
- DNS: AWS Lightsail Domains & DNS
- Business email: Google Workspace, primary inbox `support@leadrider.ai`
- Integrations email: `integrations@leadrider.ai`
- Personal email: `joe.hartrich@leadrider.ai`
- Backup/recovery email: `leadriderai@gmail.com`

Email DNS currently includes Google MX, SPF, DKIM, and DMARC records.

## Hosting

- API: current Node/Express service in `services/api`
- Web app: Next.js app in `apps/web`
- Web hosting: Vercel project `leadrider-web`
- LeadRider Command domain: `https://www.leadrider.ai/command`
- LeadRider Command API domain: `https://api.leadrider.ai`
- First client web domain: `https://americanharley.leadrider.ai`
- First client API domain: `https://api.americanharley.leadrider.ai`
- DNS: `americanharley.leadrider.ai` points to Vercel; `api.americanharley.leadrider.ai` and `api.leadrider.ai` point to the Lightsail API server
- Runtime data: `DATA_DIR`

## Observability and Ops

- Error tracking: Sentry
- Incident channel: Slack
- Issue tracking: Linear
- Internal quality loop: feedback loop scripts and agent manager reports

## Integrations

- Messaging: Twilio
- Email delivery: SendGrid
- Calendar: Google Calendar authorized through `integrations@leadrider.ai`
- LeadRider Command integrations: use LeadRider-owned callbacks such as `https://api.leadrider.ai/integrations/zoom/callback`
- Campaign image generation: Google Vertex/Gemini image model, managed through `integrations@leadrider.ai`; runtime uses the `vertex-search-runner` service account
- Meta: Facebook/Instagram app integration for Campaign Studio
- Inventory and CRM inputs: ADF, Room58, Traffic Log Pro

## Key Repo Docs

- Incident setup: `docs/incident_pipeline.md`
- Closed-loop ops and dealer tone: `docs/closed_loop_ops.md`
- Self-running ops loop: `docs/self_running_ops_loop.md`
- Web text widget: `docs/web_text_widget_embed.md`
- Environment variables: `docs/env_vars.md`
- Vendor accounts: `docs/vendors.md`
