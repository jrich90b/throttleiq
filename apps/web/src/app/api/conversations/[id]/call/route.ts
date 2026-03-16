import { NextRequest, NextResponse } from "next/server";
import { apiFetch } from "../../../../../lib/apiFetch";

type Ctx = {
  params: Promise<{ id: string }>;
};

export async function POST(
  req: NextRequest,
  { params }: Ctx
) {
  const base = process.env.API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  }

  const { id } = await params;
  const body = await req.text();

  const r = await apiFetch(`${base}/conversations/${decodeURIComponent(id)}/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });

  const data = await r.json().catch(() => null);
  return NextResponse.json(data ?? { ok: false }, { status: r.status });
}
