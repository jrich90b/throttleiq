import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { apiFetch } from "../../../lib/apiFetch";

async function hostScope() {
  const host = (await headers()).get("host")?.split(":")[0]?.toLowerCase() ?? "";
  return {
    isLeadRiderHost: host === "leadrider.ai" || host === "www.leadrider.ai"
  };
}

export async function GET() {
  const base = process.env.API_BASE_URL;
  if (!base) return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });

  const scope = await hostScope();
  const r = await apiFetch(`${base}/users`, { cache: "no-store" });
  const text = await r.text();
  try {
    const data = JSON.parse(text);
    if (r.ok && data?.ok && Array.isArray(data.users)) {
      data.users = data.users.filter((user: any) => {
        const email = String(user?.email ?? "").trim().toLowerCase();
        return scope.isLeadRiderHost ? email.endsWith("@leadrider.ai") : !email.endsWith("@leadrider.ai");
      });
    }
    return NextResponse.json(data, { status: r.status });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Upstream not JSON", status: r.status, body: text.slice(0, 200) },
      { status: 502 }
    );
  }
}

export async function POST(req: Request) {
  const base = process.env.API_BASE_URL;
  if (!base) return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });

  const scope = await hostScope();
  const body = await req.text();
  const requestedEmail = (() => {
    try {
      return String(JSON.parse(body)?.email ?? "").trim().toLowerCase();
    } catch {
      return "";
    }
  })();
  if (scope.isLeadRiderHost && !requestedEmail.endsWith("@leadrider.ai")) {
    return NextResponse.json({ ok: false, error: "Command users must use @leadrider.ai email." }, { status: 403 });
  }
  if (!scope.isLeadRiderHost && requestedEmail.endsWith("@leadrider.ai")) {
    return NextResponse.json({ ok: false, error: "LeadRider internal users cannot be created in a dealer workspace." }, { status: 403 });
  }

  const r = await apiFetch(`${base}/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
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
