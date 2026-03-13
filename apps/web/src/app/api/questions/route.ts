import { NextResponse } from "next/server";
import { apiFetch } from "../../../lib/apiFetch";

export async function GET() {
  const base = process.env.API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  }

  const r = await apiFetch(`${base}/questions`, { cache: "no-store" });
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
  const questionId = String(body?.questionId ?? "").trim();
  const text = String(body?.text ?? "").trim();

  if (convId && questionId) {
    const outcome = String(body?.outcome ?? "").trim();
    const followUpAction = String(body?.followUpAction ?? "").trim();
    const r = await apiFetch(
      `${base}/questions/${encodeURIComponent(convId)}/${encodeURIComponent(questionId)}/done`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome: outcome || undefined,
          followUpAction: followUpAction || undefined
        })
      }
    );
    const txt = await r.text();
    try {
      const data = JSON.parse(txt);
      return NextResponse.json(data, { status: r.status });
    } catch {
      return NextResponse.json(
        { ok: false, error: "Upstream not JSON", status: r.status, body: txt.slice(0, 200) },
        { status: 502 }
      );
    }
  }

  if (!convId || !text) {
    return NextResponse.json({ ok: false, error: "Missing convId/text" }, { status: 400 });
  }

  const r = await apiFetch(`${base}/questions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ convId, text })
  });
  const txt = await r.text();
  try {
    const data = JSON.parse(txt);
    return NextResponse.json(data, { status: r.status });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Upstream not JSON", status: r.status, body: txt.slice(0, 200) },
      { status: 502 }
    );
  }
}
