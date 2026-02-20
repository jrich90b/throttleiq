let tlsDisabled = false;

export function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const allowInsecure =
    (process.env.API_INSECURE_TLS ?? "false").toLowerCase() === "true" ||
    url.includes("ngrok-free.dev");

  if (allowInsecure && !tlsDisabled) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    tlsDisabled = true;
  }

  return fetch(url, options);
}
