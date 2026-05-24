import { NextResponse } from "next/server";
import { apiFetch } from "../../../../../lib/apiFetch";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const base = process.env.API_BASE_URL;
  if (!base) return NextResponse.json({ ok: false, error: "Command server is not connected yet." }, { status: 500 });

  const { id } = await ctx.params;
  const url = new URL(req.url);
  const upstream = new URL(`${base}/dealer-setups/${encodeURIComponent(id)}/manual`);
  for (const key of ["format", "download"]) {
    const value = url.searchParams.get(key);
    if (value) upstream.searchParams.set(key, value);
  }
  const r = await apiFetch(upstream.toString(), { cache: "no-store" });
  const body = await r.text();
  const headers = new Headers();
  const contentType = r.headers.get("content-type");
  const disposition = r.headers.get("content-disposition");
  if (contentType) headers.set("content-type", contentType);
  if (disposition) headers.set("content-disposition", disposition);
  headers.set("cache-control", "no-store");
  return new Response(body, { status: r.status, headers });
}
