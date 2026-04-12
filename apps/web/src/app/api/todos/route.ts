import { NextResponse } from "next/server";
import { apiFetch } from "../../../lib/apiFetch";

export async function GET() {
  const base = process.env.API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  }

  const r = await apiFetch(`${base}/todos`, { cache: "no-store" });
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

export async function POST(req: Request) {
  const base = process.env.API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  }

  const body = await req.json();
  const convId = String(body?.convId ?? "").trim();
  const todoId = String(body?.todoId ?? "").trim();
  const resolution = String(body?.resolution ?? "").trim();
  const appointmentOutcome = String(body?.appointmentOutcome ?? "").trim();
  const appointmentOutcomeNote = String(body?.appointmentOutcomeNote ?? "").trim();
  if (!convId || !todoId) {
    return NextResponse.json({ ok: false, error: "Missing convId/todoId" }, { status: 400 });
  }

  const r = await apiFetch(`${base}/todos/${encodeURIComponent(convId)}/${encodeURIComponent(todoId)}/done`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      resolution,
      appointmentOutcome: appointmentOutcome || undefined,
      appointmentOutcomeNote: appointmentOutcomeNote || undefined
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
