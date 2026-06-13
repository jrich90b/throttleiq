# Dealer-Ready Checklist (June 30 showcase target)

Status of every day-1 capability at American Harley, with last verified
production evidence. Maintained by the agent-quality workstream; update the
evidence date whenever a capability is re-verified.

| Capability | Status | Last production evidence | Notes |
| --- | --- | --- | --- |
| ADF lead ingestion (Room58, Trade Accelerator, Meta, HD.com, TLP) | WORKING | 2026-06-11 (Meta lead 05:01Z, auto-replied in 7s) | |
| AI SMS drafts + auto-replies | WORKING | 2026-06-11 | Voice charter + template rewrite live 6/11 |
| Email outbound + cadence | WORKING | 2026-06-11 11:20Z | |
| Calendar slot offers | WORKING | 2026-06-10 19:43Z (+15856273860) | |
| Appointment booking/confirmation | WORKING | 2026-06-10 21:39Z confirmed (+17169085647) | |
| Voice call capture (transcripts) | WORKING | 2026-06-10 22:04Z | |
| Voice call summaries | WORKING | 2026-06-13 (report-join bug fixed: withVoiceSummary 0→423 on live data; voice_feedback_join:eval now gates ci:eval) | |
| Traffic Log Pro walk-in ingest | WORKING | 2026-06-09 22:05Z (Perez walk-in) | |
| Inventory watches | WORKING | 53 conversations carry watch state | |
| Deposit / payment requests (Stripe) | WORKING | 2026-06-04 (dealer_payment_requests.json + customer flow) | Re-verify before June 30 |
| DocuSign | UNVERIFIED | last customer mention 2026-04-01; tokens file 2026-05-19 | Probe token validity + a sandbox envelope (open) |
| Postgres dual-write | WORKING | parity clean expected from 6/12 (shadow-leak fix) | Read-flip June 17 |
| Worker dispatcher | SHADOW | running since 6/10 | Tick flip June 17 |

## Open verification items
1. DocuSign: validate token refresh and send a test envelope before declaring day-1 ready.
2. Stripe deposit flow: one end-to-end re-verification closer to June 30.

## Resolved
- Voice summary report join (2026-06-13): `voice_feedback_mine` searched forward-only for each transcript's summary, but the runtime writes the summary before the transcript, so withVoiceSummary read 0 despite 423 summaries. Now keyed on the shared call SID (id-keyed bidirectional); recovers 0→423 on live data. Guarded by `voice_feedback_join:eval` in ci:eval (voice-feedback previously had no eval).

## Sizing note for dealer #2
A 2GB Lightsail instance runs the full stack but can never build it — deploys
are artifact-based (`DEPLOY_BUILD_MODE=local`, the default). See AGENTS.md
"Deploys Build Locally Now".
