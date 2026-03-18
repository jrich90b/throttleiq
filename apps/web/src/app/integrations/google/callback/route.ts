import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const base = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  }
  const url = new URL(req.url);
  const qs = url.searchParams.toString();
  const target = `${base}/integrations/google/callback${qs ? `?${qs}` : ""}`;
  return NextResponse.redirect(target, { status: 307 });
}
