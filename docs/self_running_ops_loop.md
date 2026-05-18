# Self-Running Ops Loop

LeadRider uses a human-reviewed version of the Sentry -> task manager -> coding agent -> PR review loop.

## Current Loop

1. Production signals are collected from conversations, feedback ratings, manual edits, route audit logs, tone quality, and voice/call artifacts.
2. Runtime API incidents can be sent to Sentry, Slack, and Linear when the incident pipeline is configured.
3. Nightly and hourly feedback loops mine product signals into reports and reusable examples.
4. Deterministic tone rules and manual reply examples can be promoted when examples pass safety thresholds.
5. Regression evals run before promoted examples are treated as runtime inputs.
6. The agent manager report ranks the highest-risk signals and turns them into task-ready recommendations.

## Guardrail

The loop does not auto-merge code or push to production. It creates reviewable reports and task candidates so a human can decide which issues should become implementation work.

## Outputs

- `reports/agent_manager/agent_manager_report.json`
- `reports/agent_manager/agent_manager_report.md`

The nightly feedback email includes the agent manager status, top tasks, and report attachments.

See `docs/incident_pipeline.md` for Sentry, Slack, and Linear setup.
