import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { apiFetch } from "../../../../lib/apiFetch";

export async function POST(req: Request) {
  const base = process.env.API_BASE_URL;
  if (!base) return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });

  const body = await req.text();
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
