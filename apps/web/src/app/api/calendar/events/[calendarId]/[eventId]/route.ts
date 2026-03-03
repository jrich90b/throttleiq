import { NextResponse } from "next/server";
import { apiFetch } from "../../../../../../lib/apiFetch";

export async function PATCH(
  req: Request,
  { params }: { params: { calendarId: string; eventId: string } }
) {
  const base = process.env.API_BASE_URL;
  if (!base) return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });

  const resolved = (await (params as any)) as { calendarId: string; eventId: string };
  const calendarId = resolved.calendarId;
  const eventId = resolved.eventId;
  const body = await req.text();
  const r = await apiFetch(
    `${base}/calendar/events/${encodeURIComponent(calendarId)}/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body
    }
  );
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
