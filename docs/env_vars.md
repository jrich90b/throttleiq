# Environment Variables

Keep production secrets in the deployment host, not in git.

## Core Runtime

- `NODE_ENV=production`
- `DATA_DIR`
- `PUBLIC_BASE_URL`
- `APP_BASE_URL`
- `API_BASE_URL`
- `AUTH_DISABLED=false`

## Email and Messaging

- `SENDGRID_API_KEY`
- `SENDGRID_FROM_EMAIL`
- `SUPPORT_TICKET_EMAILS_ENABLED`
  - Defaults on. Set to `0` to disable support ticket confirmation/completion emails.
- `SUPPORT_TICKET_EMAIL_FROM`
  - Optional. Defaults to `SENDGRID_FROM_EMAIL`, then `support@leadrider.ai`.
- `SUPPORT_TICKET_REPLY_TO`
  - Optional. Defaults to `support@leadrider.ai`.
- `SUPPORT_AGENT_POLL_TOKEN`
  - Optional token for the support Gmail poll endpoint.
  - Falls back to `AUTOMATION_RUN_WRITE_TOKEN` when unset.
  - Used by `npm run support_mail:poll` to create Support Agent tasks for new support emails.
- `SUPPORT_MAIL_AUTO_POLL_ENABLED`
  - Optional. Defaults on. Set to `0` or `false` to disable API-side support Gmail polling.
- `SUPPORT_MAIL_AUTO_POLL_MINUTES`
  - Optional. Defaults to `5`.
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`

## Google

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `GOOGLE_SUPPORT_MAIL_TOKEN_PATH`
  - Optional explicit token file for `support@leadrider.ai` Gmail access.
  - Defaults to `DATA_DIR/google_support_mail_tokens.json`.

## Meta

- `META_APP_ID`
- `META_APP_SECRET`
- `META_REDIRECT_URI`

Current Meta callback:

```text
https://api.americanharley.leadrider.ai/integrations/meta/callback
```

## OpenAI Usage Logging

- `OPENAI_USAGE_LOGGING_ENABLED`
  - Defaults on. Set to `0` to disable local usage logging.
- `OPENAI_USAGE_LOG_PATH`
  - Optional explicit JSONL file path.
  - Defaults to `DATA_DIR/openai_usage/YYYY-MM.jsonl`.
- `OPENAI_USAGE_PRICING_JSON`
  - Optional pricing override as JSON.
  - Example:

```json
{
  "gpt-5-mini": {
    "inputPerMillion": 0.75,
    "cachedInputPerMillion": 0.075,
    "outputPerMillion": 4.5
  }
}
```

## Incidents

- `SENTRY_DSN`
  - Current Sentry Express/API DSN: `https://7e0e94b6c64c2018f0328ae7748d53f5@o4511411556319232.ingest.us.sentry.io/4511411559792640`
- `SENTRY_ENVIRONMENT=production`
- `SENTRY_RELEASE`
- `SENTRY_TRACES_SAMPLE_RATE=0`
- `SENTRY_SEND_DEFAULT_PII=0`
- `INCIDENT_ALERTS_ENABLED=1`
- `INCIDENT_DEDUPE_MINUTES=30`
- `INCIDENT_TEST_TOKEN`

## Claude Agent

- `ANTHROPIC_API_KEY`
  - Required for Claude Support Agent execution.
- `ANTHROPIC_MODEL`
  - Optional. Defaults to `claude-sonnet-4-5-20250929`.
- `ANTHROPIC_AGENT_MAX_TOKENS`
  - Optional. Defaults to `1200`.
- `CLAUDE_AGENT_ENABLED`
  - Optional. Defaults on. Set to `0` or `false` to disable background Claude task execution.
- `CLAUDE_AGENT_POLL_MINUTES`
  - Optional. Defaults to `2`.
- `SLACK_INCIDENT_WEBHOOK_URL`
- `LINEAR_API_KEY`
- `LINEAR_TEAM_ID=a7f65092-379e-47fc-bdda-561c74d98ac6`
- `LINEAR_CREATE_ISSUES=1`
- `LINEAR_PROJECT_ID`
- `LINEAR_ASSIGNEE_ID`
- `LINEAR_LABEL_IDS`
- `LINEAR_ISSUE_PRIORITY=2`

## Feedback Loop

- `REPORT_ROOT`
- `CONVERSATIONS_DB_PATH`
- `FEEDBACK_LOOP_ENV_PATH`
- `FEEDBACK_REPORT_EMAIL_TO`
- `FEEDBACK_REPORT_EMAIL_FROM`
- `AGENT_MANAGER_OUT_DIR`
- `AUTOMATION_RUNS_PATH`
  - Optional explicit JSON file path for CEO dashboard closed-loop run history.
  - Defaults to `DATA_DIR/automation_runs.json`.
- `AUTOMATION_RUN_WRITE_TOKEN`
  - Optional token for external automation jobs to post to `/automation-runs/ingest`.
