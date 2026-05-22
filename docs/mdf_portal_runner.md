# MDF Portal Runner

The MDF Assistant can create an approval-gated `mdf_portal` Codex task. The local runner turns that task into a browser workflow for the Harley-Davidson MDF portal.

## What It Does

- Reads the saved MDF claim packet and uploaded file links.
- Builds a clear portal-fill prompt and a local checklist page.
- Uses Browser Use when it is installed.
- Falls back to a guided browser packet when Browser Use is not available.
- Never final-submits a claim. It stops at draft/review and leaves the task in `needs_approval` or `blocked`.

## Commands

```bash
npm run mdf:portal -- --list
```

```bash
npm run mdf:portal -- --dry-run --task-id <agent_task_id>
```

```bash
MDF_PORTAL_URL="https://portal-url.example" npm run mdf:portal -- --run --task-id <agent_task_id>
```

For the live API, point the runner at the API bridge:

```bash
MDF_PORTAL_API_BASE_URL="https://api.americanharley.leadrider.ai" \
MDF_PORTAL_RUNNER_TOKEN="..." \
MDF_PORTAL_URL="https://portal-url.example" \
npm run mdf:portal -- --run --task-id <agent_task_id>
```

## Logged-In Chrome

For the automatic path, use a Chrome session that is already logged into the MDF portal and expose it through Chrome DevTools Protocol:

```bash
MDF_PORTAL_CDP_URL="http://127.0.0.1:9222"
```

The runner checks that URL before connecting. If it cannot connect, it opens the guided fallback in the normal desktop browser.

## Browser Use

Install Browser Use in the Python environment used by `MDF_BROWSER_USE_PYTHON`. If Browser Use is not installed, the runner still opens the portal and packet checklist but does not fill fields automatically.

Useful environment variables:

- `MDF_PORTAL_API_BASE_URL`
- `MDF_PORTAL_RUNNER_TOKEN`
- `MDF_BROWSER_USE_PYTHON`
- `MDF_BROWSER_USE_MODEL`
- `MDF_BROWSER_USE_MAX_STEPS`
- `OPENAI_API_KEY`

## Status Handling

- `running`: the runner has started.
- `needs_approval`: draft/review work is ready for a human to inspect.
- `blocked`: login, MFA, missing data, missing Browser Use, or portal issues stopped the run.
