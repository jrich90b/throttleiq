import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { apiFetch } from "../../../../lib/apiFetch";

type Ctx = {
  params: Promise<{ id: string }>;
};

type ApiUser = {
  id?: unknown;
  email?: unknown;
};

async function hostScope() {
  const host = (await headers()).get("host")?.split(":")[0]?.toLowerCase() ?? "";
  return {
    isLeadRiderHost: host === "leadrider.ai" || host === "www.leadrider.ai"
  };
}

function forceCommandScope(req: Request) {
  return new URL(req.url).searchParams.get("scope") === "command";
}

async function loadUserForScope(base: string, id: string) {
  const r = await apiFetch(`${base}/users`, { cache: "no-store" });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data?.ok || !Array.isArray(data.users)) return null;
  return data.users.find((user: ApiUser) => String(user?.id ?? "") === id) ?? null;
}

function emailAllowedForScope(email: string, isLeadRiderHost: boolean) {
  const normalized = String(email ?? "").trim().toLowerCase();
  return isLeadRiderHost ? normalized.endsWith("@leadrider.ai") : !normalized.endsWith("@leadrider.ai");
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const base = process.env.API_BASE_URL;
  if (!base) return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });

  const scope = await hostScope();
  const isCommandScope = scope.isLeadRiderHost || forceCommandScope(req);
  const existing = await loadUserForScope(base, id);
  if (!existing || !emailAllowedForScope(existing.email, isCommandScope)) {
    return NextResponse.json({ ok: false, error: "User is outside this workspace." }, { status: 403 });
  }
  const body = await req.text();
  const requestedEmail = (() => {
    try {
      return String(JSON.parse(body)?.email ?? existing.email ?? "").trim().toLowerCase();
    } catch {
      return String(existing.email ?? "").trim().toLowerCase();
    }
  })();
  if (!emailAllowedForScope(requestedEmail, isCommandScope)) {
    return NextResponse.json({ ok: false, error: "User email is outside this workspace." }, { status: 403 });
  }

  const r = await apiFetch(`${base}/users/${encodeURIComponent(id)}`, {
    method: "PUT",
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

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const base = process.env.API_BASE_URL;
  if (!base) return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });

  const scope = await hostScope();
  const isCommandScope = scope.isLeadRiderHost || forceCommandScope(req);
  const existing = await loadUserForScope(base, id);
  if (!existing || !emailAllowedForScope(existing.email, isCommandScope)) {
    return NextResponse.json({ ok: false, error: "User is outside this workspace." }, { status: 403 });
  }

  const r = await apiFetch(`${base}/users/${encodeURIComponent(id)}`, { method: "DELETE" });
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
