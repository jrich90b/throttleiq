# Dealer Pricing Cost Model

Last updated: 2026-05-19

This model is for pricing LeadRider as an all-in dealer subscription where routine vendor usage is included in the monthly platform fee.

## Recommendation

Use bundled pricing with fair-use limits instead of passing through every small vendor charge.

Recommended structure:

- One-time onboarding/setup fee.
- Monthly platform fee based on lead volume.
- Included usage allowance for SMS, email, AI drafting, hosting, monitoring, and normal support.
- Overage only when usage is materially above the plan.
- Pass-through only for unusual costs, such as high-volume marketing blasts, heavy image/video generation, custom website work, paid ad spend, or extra phone numbers.

## Current American Harley Baseline

Production aggregate counts from `/home/ubuntu/throttleiq-runtime/data/conversations.json` on 2026-05-19:

| Window | Leads / ADF | Active conversations | SMS inbound | SMS outbound segments | MMS outbound | Email outbound | AI draft outbound |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 30 days | 244 | 260 | 469 | 1,169 | 63 | 85 | 322 |
| 60 days | 407 | 365 | 679 | 1,733 | 82 | 136 | 702 |
| 90 days | 450 | 377 | 693 | 1,858 | 82 | 145 | 736 |

Current production model setting:

```text
OPENAI_MODEL=gpt-5-mini
```

The app does not yet persist exact OpenAI token usage per request, so OpenAI cost below is estimated from production lead volume and typical prompt sizes. Add usage logging before making exact margin decisions.

## Vendor Cost Notes

### OpenAI

OpenAI bills by input and output tokens. The current public pricing page lists current GPT-5.4 mini at:

- Input: `$0.75 / 1M tokens`
- Cached input: `$0.075 / 1M tokens`
- Output: `$4.50 / 1M tokens`

Older `gpt-5-mini` pricing has historically been lower, but use the current mini pricing above as a conservative planning number unless the OpenAI billing dashboard confirms otherwise.

Estimated monthly OpenAI cost at normal CRM/SMS draft usage:

| Monthly leads | Low estimate | Middle estimate | Conservative high |
| ---: | ---: | ---: | ---: |
| 250 | ~$1 | ~$2 | ~$9 |
| 500 | ~$2 | ~$3 | ~$17 |
| 1,000 | ~$3 | ~$6 | ~$34 |
| 1,500 | ~$5 | ~$9 | ~$51 |

OpenAI is not the main cost driver for normal lead handling. It becomes material if Campaign Studio image/video generation, long-form email generation, or agentic research/tools become high volume.

### Twilio

Twilio SMS/MMS is the main variable vendor cost.

Planning assumptions:

- SMS platform price: about `$0.0083` per inbound or outbound segment.
- Carrier fees vary by carrier; plan around another `$0.003-$0.005` per SMS segment.
- MMS costs more; plan around `$0.03-$0.04` per outbound MMS.
- Phone number: about `$1-$3` per month depending on number type.

American Harley 30-day estimate:

- SMS: `(469 inbound + 1,169 outbound segments) * ~$0.0123 = ~$20`
- MMS: `63 outbound + 20 inbound = ~$3`
- Phone number: `~$1-$3`
- Total estimated Twilio: `~$24-$30/month`

Twilio scales roughly linearly with lead volume and salesperson follow-up activity.

### SendGrid

SendGrid outbound email volume is small for current American Harley usage. The practical decision is whether each dealer gets a dedicated paid SendGrid plan or whether low-volume dealers share an account with isolated sender/domain setup.

Planning assumption:

- Budget `$20/month/dealer` for a basic paid Email API plan once a dealer is live.
- High-volume marketing email should be separately metered or moved to a higher plan.

### Hosting

Current recommended first-client pattern:

- Web UI: Vercel Pro.
- API: Lightsail.

American Harley API server shape:

- Lightsail instance appears to match the `2 GB memory / 2 vCPU / 60 GB SSD` Linux bundle.
- Budget: `$12/month` with public IPv4 based on current Lightsail pricing.

Vercel:

- Pro starts at `$20/month` plus usage.
- For now, budget at least `$20/month` platform overhead and allocate it across dealers once there are multiple clients.

### Google Workspace

Google Workspace is mostly company overhead, not dealer-specific usage.

Current LeadRider mailboxes:

- `support@leadrider.ai`
- `integrations@leadrider.ai`
- `joe.hartrich@leadrider.ai`

If using Business Starter, budget roughly `$7/user/month`, or about `$21/month` for three users. Do not allocate the full cost to one dealer once there are multiple dealers.

### Sentry, Slack, Linear

These are operating overhead unless a dealer requires dedicated workspaces or advanced support/SLA.

For early pricing, treat them as included internal overhead, not per-dealer pass-through.

## Estimated Monthly Vendor Cost by Lead Volume

This table assumes:

- Normal two-way SMS cadence similar to American Harley.
- SendGrid budgeted at `$20/month`.
- Lightsail API budgeted at `$12/month`.
- Vercel Pro budgeted at `$20/month`.
- OpenAI middle estimate using normal drafting volume.
- Google Workspace excluded as shared company overhead.

| Monthly leads | Estimated vendor cost | With Workspace overhead |
| ---: | ---: | ---: |
| 250 | ~$78 | ~$99 |
| 500 | ~$103 | ~$124 |
| 1,000 | ~$152 | ~$173 |
| 1,500 | ~$202 | ~$223 |

Add a 2x-3x buffer internally for billing surprises, support tooling, retries, and growth. Even with that buffer, vendor cost is much lower than the value/support cost of the product.

## Suggested Dealer Pricing

Use simple plan names and fair-use limits:

| Plan | Lead volume | Suggested monthly | Included usage |
| --- | ---: | ---: | --- |
| Starter | up to 250 leads/month | `$799-$995` | core lead inbox, SMS/email draft workflow, cadence, basic reporting |
| Growth | up to 750 leads/month | `$1,295-$1,695` | higher SMS usage, appointments/outcomes, feedback loop, integrations |
| Pro | up to 1,500 leads/month | `$1,995-$2,495` | heavier usage, Campaign Studio, priority support, more users/calendars |
| Enterprise | 1,500+ leads/month or multi-store | custom | custom integrations, SLA, dedicated setup, volume pricing |

Suggested setup/onboarding:

- Standard dealer setup: `$1,500-$3,000`.
- Heavy CRM/website/custom data work: quote separately.

## Contract Language Guidance

Recommended billing clause:

> Monthly subscription includes ordinary platform hosting, AI drafting, operational monitoring, email delivery, and two-way SMS usage up to the plan allowance. LeadRider may charge overages or require a plan upgrade for materially higher usage, unusually large SMS/email campaigns, high-volume media generation, additional phone numbers, custom integrations, or third-party vendor fees outside normal lead follow-up.

Recommended usage clause:

> Included usage is intended for normal dealership lead follow-up and customer conversation workflows. Marketing blasts, bulk campaigns, paid advertising spend, website provider charges, and dealer-requested custom development are not included unless listed in the order form.

## Gaps to Close

1. Add OpenAI token usage logging per request.
2. Add monthly vendor-cost report per dealer.
3. Add Stripe products and plan metadata.
4. Add dealer `billingStatus`, `plan`, `leadAllowance`, and `usageMonth` fields.
5. Add a paywall that blocks app access only after billing status is intentionally enforced.

