import { NextResponse } from "next/server";

export async function GET() {
  const base = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  }
  return NextResponse.redirect(`${base}/integrations/google/start`, { status: 307 });
}
