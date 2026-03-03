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
