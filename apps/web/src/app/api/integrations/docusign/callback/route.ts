import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const base = process.env.API_BASE_URL;
  if (!base) return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  const url = new URL(req.url);
  const upstream = new URL(`${base}/integrations/docusign/callback`);
  for (const key of ["code", "state", "error", "error_description"]) {
    const value = url.searchParams.get(key);
    if (value) upstream.searchParams.set(key, value);
  }
  const r = await fetch(upstream.toString(), { cache: "no-store" });
  const text = await r.text();
  return new Response(text, {
    status: r.status,
    headers: {
      "content-type": r.headers.get("content-type") || "text/html; charset=utf-8"
    }
  });
}
