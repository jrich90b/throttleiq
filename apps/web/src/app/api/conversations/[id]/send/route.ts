import { NextRequest, NextResponse } from "next/server";
import { apiFetch } from "../../../../../lib/apiFetch";

type Ctx = {
  params: Promise<{ id: string }>;
};

export async function POST(
  req: NextRequest,
  { params }: Ctx
) {
  const base = process.env.API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  }

  const { id } = await params;
  const body = await req.text();
  const controller = new AbortController();
  const timeoutMs = Number(process.env.WEB_SEND_PROXY_TIMEOUT_MS ?? 25000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let r: Response;
  try {
    r = await apiFetch(`${base}/conversations/${decodeURIComponent(id)}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal
    });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return NextResponse.json(
        { ok: false, error: `send timed out after ${timeoutMs}ms` },
        { status: 504 }
      );
    }
    return NextResponse.json(
      { ok: false, error: err?.message ?? "send request failed" },
      { status: 502 }
    );
  } finally {
    clearTimeout(timer);
  }

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
