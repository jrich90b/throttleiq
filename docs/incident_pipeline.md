# Incident Pipeline

LeadRider can send production incidents through Sentry, Slack, and Linear.

Current account setup:

- Sentry: org `leadrider`, Express/API project.
- Slack: workspace `Leadrider`, app `LeadRider Incidents`, channel `#incidents`.
- Linear: workspace `LeadRider`, team key `LEA`, team ID `a7f65092-379e-47fc-bdda-561c74d98ac6`.

## Flow

1. API errors are captured by Sentry when `SENTRY_DSN` is configured.
2. A deduped Slack alert is sent when `SLACK_INCIDENT_WEBHOOK_URL` is configured.
3. A Linear issue is created when `LINEAR_API_KEY`, `LINEAR_TEAM_ID`, and `LINEAR_CREATE_ISSUES=1` are configured.
4. PR creation and deployment remain human-reviewed.

## Environment

```bash
SENTRY_DSN=
SENTRY_ENVIRONMENT=production
SENTRY_RELEASE=
SENTRY_TRACES_SAMPLE_RATE=0
SENTRY_SEND_DEFAULT_PII=0

INCIDENT_ALERTS_ENABLED=1
INCIDENT_DEDUPE_MINUTES=30
INCIDENT_TEST_TOKEN=

SLACK_INCIDENT_WEBHOOK_URL=

LINEAR_API_KEY=
LINEAR_TEAM_ID=a7f65092-379e-47fc-bdda-561c74d98ac6
LINEAR_CREATE_ISSUES=1
LINEAR_PROJECT_ID=
LINEAR_ASSIGNEE_ID=
LINEAR_LABEL_IDS=
LINEAR_ISSUE_PRIORITY=2
```

`LINEAR_LABEL_IDS` is a comma-separated list. Use labels such as `api`, `web`, `campaign-studio`, `meta-integration`, `sms`, `adf-parser`, `booking`, and `tone` in Linear so issues route cleanly.

## Test

In production, set `INCIDENT_TEST_TOKEN` and call:

```bash
curl -X POST "https://api.example.com/debug/incidents/test?token=$INCIDENT_TEST_TOKEN"
```

The response includes whether Sentry, Slack, and Linear were triggered. Repeated test calls may be deduped for `INCIDENT_DEDUPE_MINUTES`.

Setup checks completed May 18, 2026:

- Slack webhook sent a test message to `#incidents`; the initially exposed webhook was revoked and replaced with a fresh webhook.
- Linear API created test issue `LEA-5`.
- Production API incident test returned Sentry + Slack + Linear success; latest verification created Linear issue `LEA-9`.
