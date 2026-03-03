import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { apiFetch } from "../../../../lib/apiFetch";

export async function POST() {
  const base = process.env.API_BASE_URL;
  if (!base) return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });

  const store = await cookies();
  const token = store.get("lr_session")?.value;
  const r = await apiFetch(`${base}/auth/logout`, {
    method: "POST",
    headers: token ? { "x-auth-token": token } : undefined
  });
  const text = await r.text();
  try {
    const data = JSON.parse(text);
    store.delete("lr_session");
    return NextResponse.json(data, { status: r.status });
  } catch {
    store.delete("lr_session");
    return NextResponse.json(
      { ok: false, error: "Upstream not JSON", status: r.status, body: text.slice(0, 200) },
      { status: 502 }
    );
  }
}
