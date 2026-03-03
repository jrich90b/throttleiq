import { NextRequest, NextResponse } from "next/server";
import { apiFetch } from "../../../../lib/apiFetch";

type Ctx = {
  params: Promise<{ id: string }>;
};

export async function GET(
  _req: NextRequest,
  { params }: Ctx
) {
  const base = process.env.API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  }

  const { id } = await params;

  const r = await apiFetch(`${base}/conversations/${decodeURIComponent(id)}`, {
    cache: "no-store"
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

export async function DELETE(
  _req: NextRequest,
  { params }: Ctx
) {
  const base = process.env.API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  }

  const { id } = await params;
  const r = await apiFetch(`${base}/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE"
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
