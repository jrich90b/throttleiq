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
| Voice call summaries | WORKING* | 2026-06-10 22:04Z | *voice_feedback report showed withVoiceSummary=0 at 23:00 while summary messages exist — report join bug, investigate (open) |
| Traffic Log Pro walk-in ingest | WORKING | 2026-06-09 22:05Z (Perez walk-in) | |
| Inventory watches | WORKING | 53 conversations carry watch state | |
| Deposit / payment requests (Stripe) | WORKING | 2026-06-04 (dealer_payment_requests.json + customer flow) | Re-verify before June 30 |
| DocuSign | UNVERIFIED | last customer mention 2026-04-01; tokens file 2026-05-19 | Probe token validity + a sandbox envelope (open) |
| Postgres dual-write | WORKING | parity clean expected from 6/12 (shadow-leak fix) | Read-flip June 17 |
| Worker dispatcher | SHADOW | running since 6/10 | Tick flip June 17 |

## Open verification items
1. Voice summary report join: summaries exist as messages but voice_feedback_summary counted 0 — fix the join or the report misleads the gate.
2. DocuSign: validate token refresh and send a test envelope before declaring day-1 ready.
3. Stripe deposit flow: one end-to-end re-verification closer to June 30.

## Sizing note for dealer #2
A 2GB Lightsail instance runs the full stack but can never build it — deploys
are artifact-based (`DEPLOY_BUILD_MODE=local`, the default). See AGENTS.md
"Deploys Build Locally Now".
