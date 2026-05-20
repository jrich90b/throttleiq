import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { apiFetch } from "../../../../lib/apiFetch";

export async function GET() {
  const base = process.env.API_BASE_URL;
  if (!base) return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });

  const store = await cookies();
  const token = store.get("lr_session")?.value;
  const r = await apiFetch(`${base}/auth/me`, {
    headers: token ? { "x-auth-token": token } : undefined,
    cache: "no-store"
  });
  const text = await r.text();
  try {
    const data = JSON.parse(text);
    const headerStore = await headers();
    const currentHost = headerStore.get("host")?.split(":")[0]?.toLowerCase() ?? "";
    const isLeadRiderHost = currentHost === "leadrider.ai" || currentHost === "www.leadrider.ai";
    const email = String(data?.user?.email ?? "").trim().toLowerCase();
    if (r.ok && data?.ok && email) {
      if (isLeadRiderHost && !email.endsWith("@leadrider.ai")) {
        store.delete("lr_session");
        return NextResponse.json({ ok: false, error: "Use a LeadRider email for Command." }, { status: 403 });
      }
      if (!isLeadRiderHost && email.endsWith("@leadrider.ai")) {
        store.delete("lr_session");
        return NextResponse.json({ ok: false, error: "Use a dealer account for this dealership workspace." }, { status: 403 });
      }
    }
    return NextResponse.json(data, { status: r.status });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Upstream not JSON", status: r.status, body: text.slice(0, 200) },
      { status: 502 }
    );
  }
}
