import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { apiFetch } from "../../../../lib/apiFetch";

function isLocalDevHost(host: string) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isCommandAuthRequest(req: Request, host: string) {
  return host === "leadrider.ai" || host === "www.leadrider.ai" || (isLocalDevHost(host) && req.headers.get("x-leadrider-command") === "1");
}

export async function POST(req: Request) {
  const base = process.env.API_BASE_URL;
  if (!base) return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });

  const host = req.headers.get("host")?.split(":")[0]?.toLowerCase() ?? "";
  const isLeadRiderHost = isCommandAuthRequest(req, host);
  const body = await req.text();
  const requestedEmail = (() => {
    try {
      return String(JSON.parse(body)?.email ?? "").trim().toLowerCase();
    } catch {
      return "";
    }
  })();
  if (isLeadRiderHost && requestedEmail && !requestedEmail.endsWith("@leadrider.ai")) {
    return NextResponse.json({ ok: false, error: "Use a LeadRider email for Command." }, { status: 403 });
  }
  if (!isLeadRiderHost && requestedEmail.endsWith("@leadrider.ai")) {
    return NextResponse.json({ ok: false, error: "Use a dealer account for this dealership workspace." }, { status: 403 });
  }

  const r = await apiFetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  const text = await r.text();
  try {
    const data = JSON.parse(text);
    if (r.ok && data?.token) {
      const store = await cookies();
      store.set("lr_session", data.token, { httpOnly: true, sameSite: "lax", path: "/" });
    }
    return NextResponse.json(data, { status: r.status });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Upstream not JSON", status: r.status, body: text.slice(0, 200) },
      { status: 502 }
    );
  }
}
