import { NextResponse } from "next/server";
import { apiFetch } from "../../../lib/apiFetch";

const canonicalBase = "https://api.leadrider.ai";

export async function activeClientApiFetch(base: string, path: string, options?: RequestInit) {
  let response = await apiFetch(`${base}${path}`, options);
  let text = await response.text();
  const shouldRetry =
    base !== canonicalBase &&
    (response.status === 404 ||
      response.status === 502 ||
      !text.trim() ||
      /^<!doctype html/i.test(text.trim()) ||
      /Cannot (GET|POST|PATCH) /i.test(text));

  if (shouldRetry) {
    const canonicalPath = path.replace(/^\/api(?=\/)/, "");
    response = await apiFetch(`${canonicalBase}${canonicalPath}`, options);
    text = await response.text();
  }

  return { response, text };
}

export function jsonUpstreamResponse(response: Response, text: string) {
  try {
    return NextResponse.json(JSON.parse(text), { status: response.status });
  } catch {
    const contentType = response.headers.get("content-type") ?? "";
    const body = text.replace(/\s+/g, " ").trim().slice(0, 500);
    const detail = body
      ? `Upstream returned ${response.status} ${contentType}: ${body}`
      : `Upstream returned ${response.status} ${contentType || "with an empty body"}`;
    return NextResponse.json({ ok: false, error: detail, status: response.status, body }, { status: 502 });
  }
}
