let tlsDisabled = false;

export async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const allowInsecure =
    (process.env.API_INSECURE_TLS ?? "false").toLowerCase() === "true" ||
    url.includes("ngrok-free.dev");

  if (allowInsecure && !tlsDisabled) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    tlsDisabled = true;
  }

  const headers = new Headers(options?.headers ?? {});
  try {
    const { cookies } = await import("next/headers");
    const store = await cookies();
    const token = store.get("lr_session")?.value;
    if (token && !headers.has("x-auth-token")) {
      headers.set("x-auth-token", token);
    }
  } catch {
    // ignore in non-server contexts
  }

  return fetch(url, { ...options, headers });
}
