import { NextRequest, NextResponse } from "next/server";
import { apiFetch } from "@/lib/apiFetch";

/**
 * Proxy for the Appointments report ("who set it, did they show?").
 *
 * Mirrors the KPI proxy beside it, with one addition: `format=csv` streams the upstream body
 * through UNPARSED as a download. The CSV is built once, in the API's domain module, so the file
 * Joe downloads from the console and the file any script produces are byte-identical — a
 * commission sheet assembled twice is a commission sheet that can disagree with itself.
 */
export async function GET(req: NextRequest) {
  const base = process.env.API_BASE_URL;
  if (!base) return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });

  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const format = (url.searchParams.get("format") ?? "json").toLowerCase();

  const upstream = new URL(`${base}/analytics/appointments`);
  if (from) upstream.searchParams.set("from", from);
  if (to) upstream.searchParams.set("to", to);
  if (format === "csv") upstream.searchParams.set("format", "csv");

  const r = await apiFetch(upstream.toString(), { cache: "no-store" });

  if (format === "csv") {
    const body = await r.text();
    if (!r.ok) {
      return NextResponse.json({ ok: false, error: "Export failed", status: r.status }, { status: r.status });
    }
    const stamp = `${(from || "start").slice(0, 10)}_${(to || "end").slice(0, 10)}`;
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="appointments_${stamp}.csv"`
      }
    });
  }

  const text = await r.text();
  try {
    return NextResponse.json(JSON.parse(text), { status: r.status });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Upstream not JSON", status: r.status, body: text.slice(0, 200) },
      { status: 502 }
    );
  }
}
