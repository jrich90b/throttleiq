export function looksBlocked(html: string, status?: number): boolean {
  const t = (html || "").toLowerCase();
  return (
    status === 403 ||
    t.includes("just a moment") ||
    t.includes("cf-mitigated") ||
    t.includes("challenge-platform")
  );
}

export async function fetchHtmlViaZenRows(targetUrl: string): Promise<string | null> {
  const apikey = process.env.ZENROWS_API_KEY;
  if (!apikey) return null;

  const api = new URL("https://api.zenrows.com/v1/");
  api.searchParams.set("url", targetUrl);
  api.searchParams.set("apikey", apikey);

  if ((process.env.ZENROWS_JS_RENDER ?? "true").toLowerCase() === "true") {
    api.searchParams.set("js_render", "true");
  }
  if ((process.env.ZENROWS_PREMIUM_PROXY ?? "true").toLowerCase() === "true") {
    api.searchParams.set("premium_proxy", "true");
  }
  const wait = (process.env.ZENROWS_WAIT ?? "").trim();
  if (wait) api.searchParams.set("wait", wait);

  const r = await fetch(api.toString(), { headers: { Accept: "text/html,*/*" } });
  if (!r.ok) return null;
  return await r.text();
}

export async function fetchHtmlSmart(url: string, userAgentLabel: string): Promise<string | null> {
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": `ThrottleIQ/1.0 (${userAgentLabel})`,
        Accept: "text/html,*/*",
        "Cache-Control": "no-cache"
      }
    });

    const html = await r.text();
    if (!looksBlocked(html, r.status) && r.ok) return html;

    const zen = await fetchHtmlViaZenRows(url);
    return zen ?? null;
  } catch {
    return await fetchHtmlViaZenRows(url);
  }
}
