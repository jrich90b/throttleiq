import { NextRequest, NextResponse } from "next/server";
import { apiFetch } from "../../../../../../../../lib/apiFetch";

type Ctx = {
  params: Promise<{ id: string; messageId: string; mediaIndex: string }>;
};

export async function GET(req: NextRequest, { params }: Ctx) {
  const base = process.env.API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  }

  const { id, messageId, mediaIndex } = await params;
  const upstream = new URL(
    `${base}/conversations/${encodeURIComponent(decodeURIComponent(id))}/messages/${encodeURIComponent(
      decodeURIComponent(messageId)
    )}/media/${encodeURIComponent(decodeURIComponent(mediaIndex))}`
  );
  if (req.nextUrl.searchParams.get("download") === "1") {
    upstream.searchParams.set("download", "1");
  }

  const r = await apiFetch(upstream.toString(), { cache: "no-store" });
  const headers = new Headers();
  for (const name of ["content-type", "content-length", "content-disposition", "cache-control"]) {
    const value = r.headers.get(name);
    if (value) headers.set(name, value);
  }

  if (!r.ok) {
    const text = await r.text();
    try {
      return NextResponse.json(JSON.parse(text), { status: r.status });
    } catch {
      return NextResponse.json(
        { ok: false, error: "Media upstream failed", status: r.status, body: text.slice(0, 200) },
        { status: r.status }
      );
    }
  }

  return new Response(r.body, { status: r.status, headers });
}
