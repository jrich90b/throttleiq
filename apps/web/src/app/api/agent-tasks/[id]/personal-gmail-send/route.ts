import { NextResponse } from "next/server";
import { apiFetch } from "../../../../../lib/apiFetch";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const base = process.env.API_BASE_URL;
  if (!base) return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });

  const { id } = await context.params;
  const body = await req.text();
  const r = await apiFetch(`${base}/agent-tasks/${encodeURIComponent(id)}/personal-gmail-send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  const text = await r.text();
  try {
    return NextResponse.json(JSON.parse(text), { status: r.status });
  } catch {
    const contentType = r.headers.get("content-type") ?? "";
    const body = text.replace(/\s+/g, " ").trim().slice(0, 500);
    const detail = body ? `Upstream returned ${r.status} ${contentType}: ${body}` : `Upstream returned ${r.status} ${contentType || "with an empty body"}`;
    return NextResponse.json(
      { ok: false, error: detail, status: r.status, body },
      { status: 502 }
    );
  }
}
