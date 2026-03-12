import { NextRequest, NextResponse } from "next/server";
import { apiFetch } from "@/lib/apiFetch";

export async function GET() {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? process.env.API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "Missing API base URL" }, { status: 500 });
  }
  const r = await apiFetch(`${base}/inventory`, { cache: "no-store" });
  const text = await r.text();
  try {
    const json = JSON.parse(text);
    return NextResponse.json(json, { status: r.status });
  } catch {
    return NextResponse.json({ ok: false, error: text || "Invalid response" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? process.env.API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "Missing API base URL" }, { status: 500 });
  }
  const body = await req.text();
  const r = await apiFetch(`${base}/inventory`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body
  });
  const text = await r.text();
  try {
    const json = JSON.parse(text);
    return NextResponse.json(json, { status: r.status });
  } catch {
    return NextResponse.json({ ok: false, error: text || "Invalid response" }, { status: 500 });
  }
}
