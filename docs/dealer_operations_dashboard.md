# Dealer Operations Dashboard

Use this as the source of truth for dealer setup, billing, agreement status, integrations, and support. This can start as a Google Sheet, Notion database, or Airtable. Do not build a custom app until the workflow is stable across several dealers.

## Recommended Dashboard Tool

Start with **Notion** or **Google Sheets**.

Recommendation:

- Use **Notion** if you want one clean command center with pages, files, notes, and checklists.
- Use **Google Sheets** if you want fast tables and simple filtering.
- Use **Airtable** later if the setup becomes more process-heavy and you want views, automations, and forms.

Best first setup: **Notion workspace page named `LeadRider Dealer Ops`**.

## Main Dealer Table

| Field | Type | Example |
| --- | --- | --- |
| Dealer | Text | American Harley-Davidson |
| Slug | Text | americanharley |
| Status | Select | Prospect, Setup, Pilot, Active, Paused, Canceled |
| Plan | Select | Starter, Growth, Pro, Enterprise |
| Monthly Fee | Currency | `$995` |
| Setup Fee | Currency | `$1,500` |
| Lead Allowance | Number | `250` |
| Mass SMS Allowance | Number | `1000` |
| Agreement Status | Select | Draft, Sent, Signed, Needs Legal Review |
| Billing Status | Select | Not Started, Pending, Active, Past Due, Suspended |
| Web Domain | URL | `https://americanharley.leadrider.ai` |
| API Domain | URL | `https://api.americanharley.leadrider.ai` |
| CRM | Select | Traffic Log Pro |
| Messaging | Select | Twilio |
| Email | Select | SendGrid |
| Calendar | Select | Google Calendar |
| Meta | Select | Not Connected, Connected, Blocked, Live |
| Primary Contact | Text | `[name]` |
| Billing Contact | Email | `[email]` |
| Signed Agreement | File/URL | `[signed PDF]` |
| Notes | Text | `[operational notes]` |

## American Harley Row

| Field | Value |
| --- | --- |
| Dealer | American Harley-Davidson |
| Slug | americanharley |
| Status | Pilot |
| Plan | Starter |
| Monthly Fee | `$995` |
| Setup Fee | `[choose amount]` |
| Lead Allowance | `250/month` |
| Mass SMS Allowance | `1,000 SMS segments/month` |
| Agreement Status | Draft |
| Billing Status | Not Started |
| Web Domain | `https://americanharley.leadrider.ai` |
| API Domain | `https://api.americanharley.leadrider.ai` |
| CRM | Traffic Log Pro |
| Messaging | Twilio |
| Email | SendGrid |
| Calendar | Google Calendar |
| Meta | Blocked / App not active |

## Per-Dealer Checklist

### Agreement

- Draft agreement created.
- Business terms confirmed.
- Legal review completed, if needed.
- Sent for e-signature.
- Signed PDF saved.
- Dashboard updated.

### Billing

- Stripe customer created.
- Setup fee invoice created.
- Subscription created.
- Payment method added.
- Billing status set to active.

### Hosting

- Vercel project/domain configured.
- API server configured.
- DNS web hostname points to Vercel.
- DNS API hostname points to API server.
- Health checks pass.

### Messaging

- Twilio number configured.
- SMS webhook configured.
- STOP/HELP behavior confirmed.
- SendGrid sender/domain authenticated.
- Test SMS send checked.
- Test email send checked.

### Integrations

- Google Calendar connected.
- CRM credentials configured.
- Inventory feed configured.
- Meta connected, if applicable.
- Sentry/Slack/Linear incident flow configured.

### Product Readiness

- Dealer profile complete.
- Salespeople/users configured.
- Calendar schedules configured.
- Lead source routing checked.
- Report issue checked.
- Feedback loop active.
- OpenAI usage logging active.

## Suggested Views

- `Setup Pipeline`: grouped by Status.
- `Billing`: grouped by Billing Status.
- `Agreements`: grouped by Agreement Status.
- `Integrations`: filtered to dealers with blocked integrations.
- `Renewals`: sorted by agreement date or term end.
- `Support`: active issues and reported bugs.

## When to Build This Into LeadRider

Build a native admin dashboard only after:

- At least 3 dealers are onboarded.
- Agreement and billing fields stop changing.
- Stripe products are final.
- Paywall enforcement exists.
- Dealer setup checklist has been repeated successfully.

