import { NextResponse } from "next/server";
import { apiFetch } from "../../../lib/apiFetch";

export async function GET(req: Request) {
  const base = process.env.API_BASE_URL;
  if (!base) return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });

  const url = new URL(req.url);
  const upstream = new URL(`${base}/active-clients`);
  const limit = url.searchParams.get("limit");
  if (limit) upstream.searchParams.set("limit", limit);

  const r = await apiFetch(upstream.toString(), { cache: "no-store" });
  const text = await r.text();
  try {
    return NextResponse.json(JSON.parse(text), { status: r.status });
  } catch {
    return NextResponse.json({ ok: false, error: "Upstream not JSON", status: r.status, body: text.slice(0, 200) }, { status: 502 });
  }
}

export async function POST(req: Request) {
  const base = process.env.API_BASE_URL;
  if (!base) return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });

  const body = await req.text();
  const r = await apiFetch(`${base}/active-clients`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  const text = await r.text();
  try {
    return NextResponse.json(JSON.parse(text), { status: r.status });
  } catch {
    return NextResponse.json({ ok: false, error: "Upstream not JSON", status: r.status, body: text.slice(0, 200) }, { status: 502 });
  }
}
