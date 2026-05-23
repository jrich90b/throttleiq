import { NextResponse } from "next/server";
import { apiFetch } from "../../../../../lib/apiFetch";

export async function GET() {
  const base = process.env.API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  }
  const r = await apiFetch(`${base}/mdf/portal-runner/install.sh`, { cache: "no-store" });
  const body = await r.text();
  if (!r.ok) {
    return NextResponse.json(
      { ok: false, error: body.slice(0, 500) || "Installer could not be generated." },
      { status: r.status }
    );
  }
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "Content-Disposition": 'attachment; filename="leadrider-mdf-runner-install.sh"'
    }
  });
}
