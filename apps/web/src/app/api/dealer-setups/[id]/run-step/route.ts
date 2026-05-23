import { NextResponse } from "next/server";
import { apiFetch } from "../../../../../lib/apiFetch";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const base = process.env.API_BASE_URL;
  if (!base) return NextResponse.json({ ok: false, error: "Command server is not connected yet." }, { status: 500 });

  const { id } = await ctx.params;
  const body = await req.text();
  const r = await apiFetch(`${base}/dealer-setups/${encodeURIComponent(id)}/run-step`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  const text = await r.text();
  try {
    return NextResponse.json(JSON.parse(text), { status: r.status });
  } catch {
    return NextResponse.json({ ok: false, error: "Command server returned an unexpected response." }, { status: 502 });
  }
}
