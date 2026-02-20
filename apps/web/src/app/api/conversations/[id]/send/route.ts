import { NextResponse } from "next/server";
import { apiFetch } from "../../../../../lib/apiFetch";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const base = process.env.API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  }

  const { id } = await context.params;
  const body = await req.text();

  const r = await apiFetch(`${base}/conversations/${decodeURIComponent(id)}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });

  const data = await r.json();
  return NextResponse.json(data, { status: r.status });
}
