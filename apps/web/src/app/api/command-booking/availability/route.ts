import { NextResponse } from "next/server";
import { apiFetch } from "../../../../lib/apiFetch";

export async function GET(req: Request) {
  const base = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!base) return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });

  const url = new URL(req.url);
  const qs = new URLSearchParams();
  for (const key of ["user", "type", "daysAhead", "limit", "perDay"]) {
    const value = url.searchParams.get(key);
    if (value) qs.set(key, value);
  }
  const r = await apiFetch(`${base}/public/command-booking/availability?${qs.toString()}`, {
    cache: "no-store"
  });
  const text = await r.text();
  try {
    return NextResponse.json(JSON.parse(text), { status: r.status });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Upstream not JSON", status: r.status, body: text.slice(0, 200) },
      { status: 502 }
    );
  }
}
