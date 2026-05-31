import { NextResponse } from "next/server";
import { apiFetch } from "../../../../lib/apiFetch";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  const base = process.env.API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  }
  return jsonFromUpstream(await apiFetch(`${base}/warranty-rma/capabilities`, { cache: "no-store" }));
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
