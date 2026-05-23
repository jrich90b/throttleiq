import { NextResponse } from "next/server";
import { apiFetch } from "../../../../../../lib/apiFetch";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const base = process.env.API_BASE_URL;
  if (!base) return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });

  const { id } = await ctx.params;
  const r = await apiFetch(`${base}/dealer-setups/${encodeURIComponent(id)}/api/deploy-profile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  const text = await r.text();
  try {
    return NextResponse.json(JSON.parse(text), { status: r.status });
  } catch {
    return NextResponse.json({ ok: false, error: "Upstream not JSON", status: r.status, body: text.slice(0, 200) }, { status: 502 });
  }
}
