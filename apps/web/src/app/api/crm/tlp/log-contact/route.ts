import { NextRequest, NextResponse } from "next/server";
import { apiFetch } from "../../../../../lib/apiFetch";

export async function POST(req: NextRequest) {
  const base = process.env.API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  }
  const body = await req.text();
  const r = await apiFetch(`${base}/crm/tlp/log-contact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  const data = await r.json().catch(() => ({}));
  return NextResponse.json(data, { status: r.status });
}
