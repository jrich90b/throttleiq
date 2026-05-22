import { NextResponse } from "next/server";
import { apiFetch } from "../../../../lib/apiFetch";

export async function POST(req: Request) {
  const base = process.env.API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const payload = await req.json();
    const r = await apiFetch(`${base}/mdf/extract-json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return jsonFromUpstream(r);
  }

  const body = await req.formData();
  const forwarded = new FormData();
  for (const [key, value] of body.entries()) {
    if (value instanceof File) {
      forwarded.append(key, value, safeMdfUploadName(value.name, value.type));
    } else {
      forwarded.append(key, value);
    }
  }
  const r = await apiFetch(`${base}/mdf/extract`, {
    method: "POST",
    body: forwarded
  });
  return jsonFromUpstream(r);
}

async function jsonFromUpstream(r: Response) {
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

function safeMdfUploadName(name: string, mimeType: string) {
  const fallbackExt =
    mimeType === "application/pdf"
      ? ".pdf"
      : mimeType === "image/png"
        ? ".png"
        : mimeType === "image/webp"
          ? ".webp"
          : ".jpg";
  const ext = (name.match(/\.[a-z0-9]{1,8}$/i)?.[0] ?? fallbackExt).toLowerCase();
  const base = name
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${base || "mdf-upload"}${ext}`;
}
