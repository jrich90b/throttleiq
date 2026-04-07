import { NextRequest, NextResponse } from "next/server";
import { apiFetch } from "@/lib/apiFetch";

export async function GET(req: NextRequest) {
  const base = process.env.API_BASE_URL;
  if (!base) return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });

  const url = new URL(req.url);
  const source = url.searchParams.get("source") ?? "all";
  const ownerId = url.searchParams.get("ownerId") ?? "all";
  const leadType = url.searchParams.get("leadType") ?? "all";
  const leadScope = url.searchParams.get("leadScope") ?? "online_only";
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";

  const upstream = new URL(`${base}/analytics/kpi`);
  upstream.searchParams.set("source", source);
  upstream.searchParams.set("ownerId", ownerId);
  upstream.searchParams.set("leadType", leadType);
  upstream.searchParams.set("leadScope", leadScope);
  if (from) upstream.searchParams.set("from", from);
  if (to) upstream.searchParams.set("to", to);

  const r = await apiFetch(upstream.toString(), { cache: "no-store" });
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
