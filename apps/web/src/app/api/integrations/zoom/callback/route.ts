import { NextResponse } from "next/server";
import { apiFetch } from "../../../../../lib/apiFetch";

export async function GET(req: Request) {
  const base = process.env.API_BASE_URL;
  if (!base) return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });

  const url = new URL(req.url);
  const upstream = new URL(`${base}/integrations/zoom/callback`);
  for (const [key, value] of url.searchParams.entries()) upstream.searchParams.set(key, value);
  const r = await apiFetch(upstream.toString(), { cache: "no-store" });
  const text = await r.text();
  return new NextResponse(text, {
    status: r.status,
    headers: { "Content-Type": r.headers.get("content-type") || "text/html; charset=utf-8" }
  });
}
