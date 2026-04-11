import { NextResponse } from "next/server";
import { apiFetch } from "../../../../lib/apiFetch";

export async function POST(req: Request) {
  const base = process.env.API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  }

  const body = await req.json();
  const convId = String(body?.convId ?? "").trim();
  const summary = String(body?.summary ?? "").trim();
  const reason = String(body?.reason ?? "other").trim();
  const taskClass = String(body?.taskClass ?? "").trim().toLowerCase();
  const ownerId = String(body?.ownerId ?? "").trim();
  const ownerName = String(body?.ownerName ?? "").trim();
  if (!convId || !summary) {
    return NextResponse.json({ ok: false, error: "Missing convId/summary" }, { status: 400 });
  }

  const r = await apiFetch(`${base}/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      convId,
      summary,
      reason,
      taskClass: taskClass || undefined,
      ownerId: ownerId || undefined,
      ownerName: ownerName || undefined
    })
  });
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
