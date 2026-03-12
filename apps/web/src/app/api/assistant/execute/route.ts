import { NextRequest, NextResponse } from "next/server";
import { apiFetch } from "@/lib/apiFetch";

export async function POST(req: NextRequest) {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? process.env.API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API base URL not configured" }, { status: 500 });
  }
  const body = await req.text();
  const r = await apiFetch(`${base}/assistant/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { ok: r.ok, raw: text };
  }
  return NextResponse.json(json, { status: r.status });
}
