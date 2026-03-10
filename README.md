# ThrottleIQ

## Google Calendar OAuth (Local + Production)
To support both local dev and the Lightsail instance:

1) In Google Cloud Console → OAuth client, add both redirect URIs:
   - `http://127.0.0.1:3001/integrations/google/callback`
   - `https://api.leadrider.ai/integrations/google/callback`

2) Set `GOOGLE_REDIRECT_URI` per environment:
   - Local: `GOOGLE_REDIRECT_URI=http://127.0.0.1:3001/integrations/google/callback`
   - Instance: `GOOGLE_REDIRECT_URI=https://api.leadrider.ai/integrations/google/callback`

This allows one OAuth client to work in both environments.

## Lead Source Catalogs (HDMC + CRM Overlays)
Lead source routing supports a base HDMC catalog plus optional CRM-specific overlays.

Files:
- `services/api/data/lead_sources/hdmc.json` (global HDMC list)
- `services/api/data/lead_sources/<crm>.json` (optional CRM overlay, e.g. `tlp.json`)

Selection:
- API uses `CRM_PROVIDER` if set.
- If not set, it will look at `dealer_profile.json` -> `crmProvider` (set in the Dealer Profile UI).

Matching:
- Exact rule matches in `leadSourceRules.ts` still win.
- Catalog match by `sourceId` or `source` name is used as a fallback.

To add a new CRM:
1) Create `services/api/data/lead_sources/<crm>.json`
2) Add any CRM-specific lead sources to that file
3) Set `crmProvider` in Dealer Profile (or `CRM_PROVIDER` env)
