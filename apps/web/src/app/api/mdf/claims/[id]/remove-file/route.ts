import { NextResponse } from "next/server";
import { apiFetch } from "../../../../../../lib/apiFetch";

type Ctx = {
  params: Promise<{ id: string }>;
};

// Take one uploaded document back off a claim (a mis-upload). The API also stops any invoice row
// referencing that file and reports rows left with no evidence, which the console warns on.
export async function POST(req: Request, { params }: Ctx) {
  const base = process.env.API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  }
  const { id } = await params;
  const body = await req.text();
  const r = await apiFetch(`${base}/mdf/claims/${encodeURIComponent(id)}/remove-file`, {
    method: "POST",
    headers: { "content-type": "application/json" },
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
