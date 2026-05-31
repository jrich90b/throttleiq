import { NextRequest, NextResponse } from "next/server";
import { apiFetch } from "../../../../../lib/apiFetch";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const base = process.env.API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  }
  const body = await req.text();
  return jsonFromUpstream(
    await apiFetch(`${base}/warranty-rma/vector/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    })
  );
}

async function jsonFromUpstream(r: Response) {
  const text = await r.text();
  try {
    const data = JSON.parse(text);
    return NextResponse.json(data, { status: r.status });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Upstream not JSON", status: r.status, body: text.slice(0, 200) },
      { status: 502 }
    );
  }
}
