# Langfuse Observability

The API can export orchestrator traces to Langfuse when credentials are present.
Tracing is optional and off unless the runtime has Langfuse keys.

## Required Runtime Env

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
LANGFUSE_ENABLED=1
```

For self-hosted Langfuse, set `LANGFUSE_BASE_URL` to the self-hosted origin.

By default, traces do not include raw customer/staff message text. They include
metadata such as provider, channel, body length, media count, routing hints,
intent/stage, draft length, and hashed phone/message identifiers.

To include raw inbound/outbound text for deeper review:

```bash
LANGFUSE_INCLUDE_MESSAGE_TEXT=1
```

Only enable raw text if the Langfuse project is approved for customer data.

## What Is Traced

The API wraps `safeOrchestrateInbound(...)` and emits one Langfuse observation
per orchestrator run:

- live Twilio inbound
- regenerate
- debug inbound

Each trace includes:

- input metadata: provider/channel, hashed sender/recipient, message length,
  media count, history count, classification hints, workflow state flags
- output metadata: intent, stage, whether the agent should respond, draft
  length, handoff/autoclose flags, suggested slot count, debug flow
- tags: `orchestrator`, provider, channel

## Cloud Setup

1. Create a Langfuse project.
2. Copy the project public and secret keys.
3. Add the env vars above to the API runtime.
4. Restart the API process.

## Server Deploy Notes

The Langfuse JS SDK requires Node.js 20 or newer. If the API is running on an
older Node runtime, tracing will stay disabled and log a startup warning.

On the current PM2 deployment, add the env vars to the API environment file or
shell profile used by PM2, then restart:

```bash
cd ~/throttleiq
git pull

cd services/api
npm ci
npm run build
pm2 restart throttleiq-api --update-env
```

## Self-Hosted Option

Langfuse self-hosting requires the Langfuse web/worker services plus supporting
datastores. Use the official Langfuse self-hosted Docker Compose from Langfuse
for production so service versions and migrations stay aligned. After the
Langfuse UI is reachable, create a project and use its keys in the env vars
above.
