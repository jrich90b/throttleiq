import { NextResponse } from "next/server";
import { apiFetch } from "../../../../lib/apiFetch";

export async function POST(req: Request) {
  const base = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  }

  const body = await req.text();
  const r = await apiFetch(`${base}/public/command-booking/book`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  const text = await r.text();
  try {
    const data = JSON.parse(text);
    return NextResponse.json(data, { status: r.status });
  } catch {
    const contentType = r.headers.get("content-type") ?? "";
    const body = text.replace(/\s+/g, " ").trim().slice(0, 500);
    return NextResponse.json(
      {
        ok: false,
        error: body ? `Booking service returned ${r.status} ${contentType}: ${body}` : "Booking service returned an empty response.",
        status: r.status,
        body
      },
      { status: 502 }
    );
  }
}
