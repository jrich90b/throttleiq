import { NextRequest, NextResponse } from "next/server";
import { apiFetch } from "../../../../lib/apiFetch";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET() {
  const base = process.env.API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  }
  return jsonFromUpstream(await apiFetch(`${base}/warranty-rma/manuals`, { cache: "no-store" }));
}

export async function POST(req: NextRequest) {
  const base = process.env.API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });
  }
  const body = await req.formData();
  const forwarded = new FormData();
  for (const [key, value] of body.entries()) {
    if (value instanceof File) {
      forwarded.append(key, value, safeWarrantyRmaUploadName(value.name, value.type));
    } else {
      forwarded.append(key, value);
    }
  }
  return jsonFromUpstream(
    await apiFetch(`${base}/warranty-rma/manuals`, {
      method: "POST",
      body: forwarded
    })
  );
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

function safeWarrantyRmaUploadName(name: string, mimeType: string) {
  const fallbackExt =
    mimeType === "application/pdf"
      ? ".pdf"
      : mimeType === "image/png"
        ? ".png"
        : mimeType === "image/jpeg"
          ? ".jpg"
          : mimeType === "image/webp"
            ? ".webp"
            : mimeType === "application/json"
              ? ".json"
              : mimeType === "application/xml" || mimeType === "text/xml"
                ? ".xml"
                : mimeType === "text/csv"
                  ? ".csv"
                  : ".txt";
  const ext = (name.match(/\.[a-z0-9]{1,8}$/i)?.[0] ?? fallbackExt).toLowerCase();
  const base = name
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${base || "warranty-rma-document"}${ext}`;
}
