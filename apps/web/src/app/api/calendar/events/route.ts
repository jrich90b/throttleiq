import { NextResponse } from "next/server";
import { apiFetch } from "../../../../lib/apiFetch";

export async function GET(req: Request) {
  const base = process.env.API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  }

  const url = new URL(req.url);
  const start = url.searchParams.get("start") ?? "";
  const end = url.searchParams.get("end") ?? "";
  const salespeople = url.searchParams.get("salespeople") ?? "";

  const apiUrl = new URL(`${base}/calendar/events`);
  apiUrl.searchParams.set("start", start);
  apiUrl.searchParams.set("end", end);
  if (salespeople) apiUrl.searchParams.set("salespeople", salespeople);

  const r = await apiFetch(apiUrl.toString(), { cache: "no-store" });
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

export async function POST(req: Request) {
  const base = process.env.API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  }
  const body = await req.text();
  const r = await apiFetch(`${base}/calendar/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
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
