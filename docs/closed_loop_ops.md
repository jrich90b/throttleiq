# Closed Loop Ops

LeadRider uses three feedback sources for continuous improvement:

1. Message feedback: thumbs up, thumbs down, draft edits, and manual replies.
2. Operational anomalies: staff-reported routing, Task Inbox, cadence, inventory, integration, UI, or tone issues.
3. Runtime incidents: Sentry errors, Slack alerts, and Linear tickets.

## Staff-Reported Anomalies

Task Inbox rows include `Report issue`. Staff should use it when something is wrong but not tied to a draft, for example:

- A lead routed to the wrong department.
- A task appeared that should not exist.
- A task owner is wrong.
- Follow-up cadence is wrong.
- Inventory/model normalization is wrong.
- Meta, Google, Twilio, SendGrid, or TLP behavior is broken.
- The UI shows inconsistent state.

Reports are saved to `OPS_ANOMALIES_PATH` or `DATA_DIR/ops_anomalies.json`, then included in the daily agent manager report. When ticket creation is enabled, the report also creates a Slack/Linear incident so the issue is visible immediately.

## Dealer-Specific Tone

Dealer tone should stay data-driven, not repo-driven.

- Shared safety/compliance rules live in code.
- Dealer-specific style lives in dealer profile/runtime data.
- Feedback examples should be tagged by dealer context.
- Promotion logic should only move a tone pattern into global rules when it is clearly universal.
- If a dealer prefers different cadence language, signoffs, emoji use, finance wording, or appointment phrasing, store it as dealer configuration or dealer-scoped examples.

This keeps one shared product repo while allowing each dealer to sound different.
