import { NextResponse } from "next/server";
import { apiFetch } from "../../../../lib/apiFetch";

export async function GET(req: Request) {
  const base = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  }

  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const type = url.searchParams.get("type") ?? "";
  const daysAhead = url.searchParams.get("daysAhead") ?? "";
  const limit = url.searchParams.get("limit") ?? "";
  const perSalesperson = url.searchParams.get("perSalesperson") ?? "";

  const qs = new URLSearchParams();
  if (token) qs.set("token", token);
  if (type) qs.set("type", type);
  if (daysAhead) qs.set("daysAhead", daysAhead);
  if (limit) qs.set("limit", limit);
  if (perSalesperson) qs.set("perSalesperson", perSalesperson);

  const r = await apiFetch(`${base}/public/booking/availability?${qs.toString()}`, {
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

