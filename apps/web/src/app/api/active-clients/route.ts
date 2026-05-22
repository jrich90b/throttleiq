import { NextResponse } from "next/server";
import { activeClientApiFetch, jsonUpstreamResponse } from "./upstream";

export async function GET(req: Request) {
  const base = process.env.API_BASE_URL;
  if (!base) return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });

  const url = new URL(req.url);
  const upstream = new URL(`${base}/active-clients`);
  const limit = url.searchParams.get("limit");
  if (limit) upstream.searchParams.set("limit", limit);

  const { response, text } = await activeClientApiFetch(upstream.origin, `${upstream.pathname}${upstream.search}`, { cache: "no-store" });
  return jsonUpstreamResponse(response, text);
}

export async function POST(req: Request) {
  const base = process.env.API_BASE_URL;
  if (!base) return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });

  const body = await req.text();
  const { response, text } = await activeClientApiFetch(base, "/active-clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  return jsonUpstreamResponse(response, text);
}
