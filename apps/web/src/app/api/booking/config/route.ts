import { NextResponse } from "next/server";
import { apiFetch } from "../../../../lib/apiFetch";

export async function GET(req: Request) {
  const base = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  }

  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const r = await apiFetch(`${base}/public/booking/config?token=${encodeURIComponent(token)}`, {
    cache: "no-store"
  });
  const text = await r.text();
  try {
    const data = JSON.parse(text);
    return NextResponse.json(data, { status: r.status });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Upstream not JSON", status: r.status, body: text.slice(0, 200) },
      { status: 502 }
    );
  }
}

